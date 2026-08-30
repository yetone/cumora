/**
 * Message-level routing: does an ordinary human group message need EVERY agent
 * in the room to wake up, or is it addressed at specific people?
 *
 * Today the scheduler picks recipients purely by membership, so a five-agent
 * room pays five big-brain turns for `@nova draft the launch email` — and
 * production measures ~26% of group wakes producing no reply at all.
 *
 * The decision is deliberately shaped so the model has the SMALLEST possible
 * job. Targets are derived deterministically (an exact @mention, a quote-reply)
 * — the cerebellum only says whether the message is aimed at those people
 * ("me") or at the room ("each"). It never picks who.
 *
 * Everything here fails OPEN. Narrowing a wake is the one mistake that is
 * silent: an agent that should have answered and was never woken leaves no
 * reply, no typing indicator, and no agent_runs row. So every uncertainty —
 * no targets, an @all, a model error, an unparseable answer — resolves to
 * today's full fan-out.
 */
import type { ResponseMode } from './triage-core.js'

/** `@all` is a broadcast: it must never be narrowed, whatever else the message
 *  says. Same token rule the turn prompt uses to tag a broadcast. */
const ALL_MENTION_RE = /(?<![\w@])@all(?![\w-])/i

export interface RouteRequest {
  /** Set when the answer is known WITHOUT a model call. */
  mode?: ResponseMode
  /** Set when a model call is needed. */
  instructions?: string
  input?: string
}

/** Decide the route, or build the request that decides it.
 *
 *  `candidates` is the set of agents the scheduler would wake today;
 *  `targets` is the deterministically-addressed subset of them. */
export function buildRouteRequest(args: {
  body: string
  conversationKind: string
  candidates: readonly string[]
  targets: readonly string[]
}): RouteRequest {
  // A broadcast is for everyone, by definition.
  if (ALL_MENTION_RE.test(args.body)) return { mode: 'each' }
  // A DM has one recipient; there is nothing to narrow and the existing
  // human-DM triage note already covers it.
  if (args.conversationKind === 'direct') return { mode: 'each' }
  // Nothing to narrow TO. This is the important one: if the message names
  // nobody, narrowing would wake no one at all.
  if (args.targets.length === 0) return { mode: 'each' }
  // Narrowing saves nothing when the targets already are the whole room.
  if (args.targets.length >= args.candidates.length) return { mode: 'each' }

  return {
    instructions: [
      'You route ONE message in a team chat where some teammates are AI agents.',
      'The message explicitly names one or more agents. Decide whether it is aimed at THEM, or at the room.',
      'Answer "me" when the named agents are the ones expected to act or reply — a direct request, an assignment, a question put to them.',
      'Answer "each" when the whole room is still expected to engage — an open question that merely cites someone, a broadcast, a roll call, a request for several independent opinions.',
      'When you are unsure, answer "each". Waking an extra agent costs tokens; failing to wake the right one loses the message.',
      'Respond ONLY with a single JSON object: {"responseMode": "me"|"each"}.',
    ].join('\n'),
    input: [
      `Named agents: ${args.targets.join(', ')}`,
      `Other agents in the room: ${args.candidates.filter((c) => !args.targets.includes(c)).join(', ') || '(none)'}`,
      '',
      'Message:',
      args.body.slice(0, 2000),
    ].join('\n'),
  }
}

/** Parse the router's answer. Anything unexpected — malformed JSON, a mode we
 *  don't know, an empty completion — reads as `each`, i.e. change nothing.
 *  `one-of-us` is recognized but only ever produced for an UNADDRESSED group
 *  message (see buildUnaddressedRouteRequest); the addressed router is still
 *  told to answer `me`|`each` only. */
export function parseRoute(raw: string): ResponseMode {
  const match = raw.match(/"responseMode"\s*:\s*"(me|each|one-of-us)"/i)
  const mode = match?.[1]?.toLowerCase()
  return mode === 'me' ? 'me' : mode === 'one-of-us' ? 'one-of-us' : 'each'
}

/** The recipients to actually wake. Separated from the model call so the
 *  narrowing rule itself is testable without one.
 *
 *  Returns `candidates` unchanged unless the route is `me` AND every target is
 *  a real candidate — a target that is not in the wake set (departed, muted out,
 *  the author themselves) must never shrink the room to nothing. */
export function recipientsForRoute(
  mode: ResponseMode,
  candidates: readonly string[],
  targets: readonly string[],
): string[] {
  if (mode !== 'me') return [...candidates]
  const narrowed = targets.filter((t) => candidates.includes(t))
  return narrowed.length > 0 ? narrowed : [...candidates]
}

/** Run the router on the cloud SMALL model. Returns `each` — i.e. today's
 *  behaviour — on any failure, including a model that is rate-limited or down.
 *  Tracked so the call lands in llm_calls with purpose='message-routing' and
 *  its cost is visible next to the turns it is meant to save. */
export async function routeMessage(args: {
  companyId: string | null
  body: string
  conversationKind: string
  candidates: readonly string[]
  targets: readonly string[]
}): Promise<ResponseMode> {
  const req = buildRouteRequest(args)
  if (req.mode) return req.mode
  try {
    const { getTrackedLlmClient } = await import('./llm-ledger.js')
    const { supportModel } = await import('./model-policy.js')
    const client = await getTrackedLlmClient({ purpose: 'message-routing', companyId: args.companyId })
    const r = await client.responses.create({
      model: supportModel(),
      instructions: req.instructions,
      input: req.input ?? '',
      max_output_tokens: 200,
    })
    return parseRoute(r.output_text ?? '')
  } catch (err) {
    console.warn(`[routing] router unavailable; waking everyone: ${err instanceof Error ? err.message : String(err)}`)
    return 'each'
  }
}

/** The unaddressed half of #70: a human group message that names NOBODY. Today
 *  that always fans out to every agent, and production measures ~26% of those
 *  wakes producing nothing — an open question makes everyone reason over the
 *  same room. The router decides between:
 *
 *    - `each`      — the room engages (discussion, opinions, votes, small talk);
 *    - `one-of-us` — one agent should take the turn (a task, a question with a
 *                    deliverable), and it may propose WHICH agent by role fit.
 *
 *  The proposal is only a hint: `pickPrimary` (routing-election.ts) validates it
 *  against real candidates and falls back to a deterministic order, so two
 *  replicas agree without coordinating. */
export interface UnaddressedRoute {
  mode: 'each' | 'one-of-us'
  /** Router's role-fit proposal, when mode is `one-of-us`. Unvalidated. */
  primary: string | null
}

export function buildUnaddressedRouteRequest(args: {
  body: string
  conversationKind: string
  /** Wake candidates with their roster role, for the fit signal. */
  candidates: ReadonlyArray<{ id: string; role: string | null }>
}): RouteRequest {
  // A broadcast is for everyone, by definition.
  if (ALL_MENTION_RE.test(args.body)) return { mode: 'each' }
  // DMs are handled before the router ever runs (one recipient, human-DM
  // triage note). Anything odd about the room reads as `each`.
  if (args.conversationKind === 'direct') return { mode: 'each' }
  // A room of one agent has nothing to elect among.
  if (args.candidates.length < 2) return { mode: 'each' }

  return {
    instructions: [
      'You route ONE message in a team chat where some teammates are AI agents.',
      'The message does not name anyone. Decide whether the whole room should engage, or whether ONE agent should take it.',
      'Answer "one-of-us" when the message is a task, an assignment, or a question with a concrete answer one person can own — and set "primary" to the candidate id whose role fits best.',
      'Answer "each" when the room is expected to engage together — discussion, opinions, votes, roll calls, small talk, or anything where several independent replies are wanted.',
      'When unsure, answer "each". Waking an extra agent costs tokens; waking no one loses the message.',
      'Respond ONLY with a single JSON object: {"responseMode": "each"|"one-of-us", "primary": "<candidate id or null>"}.',
    ].join('\n'),
    input: [
      `Agents in the room: ${args.candidates.map((c) => (c.role ? `${c.id} (${c.role})` : c.id)).join(', ')}`,
      '',
      'Message:',
      args.body.slice(0, 2000),
    ].join('\n'),
  }
}

/** Parse the unaddressed router's answer. Everything unexpected reads as
 *  `each` — narrowing is the one mistake that is silent, so the bar for it is
 *  an explicit, well-formed `one-of-us`. */
export function parseUnaddressedRoute(raw: string): UnaddressedRoute {
  if (!/"responseMode"\s*:\s*"one-of-us"/i.test(raw)) return { mode: 'each', primary: null }
  const primary = raw.match(/"primary"\s*:\s*"([^"]*)"/i)?.[1]?.trim() || null
  return { mode: 'one-of-us', primary }
}

/** Run the unaddressed router on the cloud SMALL model. Fails OPEN to `each`
 *  — today's full fan-out — on any error, exactly like routeMessage. Tracked
 *  under the same `message-routing` purpose so its cost lands next to the
 *  turns it is meant to save. */
export async function routeUnaddressedMessage(args: {
  companyId: string | null
  body: string
  conversationKind: string
  candidates: ReadonlyArray<{ id: string; role: string | null }>
}): Promise<UnaddressedRoute> {
  const req = buildUnaddressedRouteRequest(args)
  if (req.mode) return { mode: req.mode as 'each' | 'one-of-us', primary: null }
  try {
    const { getTrackedLlmClient } = await import('./llm-ledger.js')
    const { supportModel } = await import('./model-policy.js')
    const client = await getTrackedLlmClient({ purpose: 'message-routing', companyId: args.companyId })
    const r = await client.responses.create({
      model: supportModel(),
      instructions: req.instructions,
      input: req.input ?? '',
      max_output_tokens: 200,
    })
    return parseUnaddressedRoute(r.output_text ?? '')
  } catch (err) {
    console.warn(`[routing] router unavailable; waking everyone: ${err instanceof Error ? err.message : String(err)}`)
    return { mode: 'each', primary: null }
  }
}
