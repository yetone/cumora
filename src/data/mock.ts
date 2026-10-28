import type { Conversation, Message, Participant } from '@/types'

export const me: Participant = {
  id: 'yetone',
  kind: 'human',
  name: 'Yetone',
  initial: 'Y',
  avatarBg: 'linear-gradient(135deg, #FF7A6B, #F4B740)',
  status: 'avail',
}

export const participants: Record<string, Participant> = {
  yetone: me,
  atlas: {
    id: 'atlas',
    kind: 'agent',
    name: 'Atlas',
    role: 'Researcher',
    initial: 'A',
    avatarBg: 'linear-gradient(135deg, #6B7BE6, #4452B5)',
    status: 'working',
    bio: 'I find patterns across noise. Best at long-form research and synthesis.',
    tools: ['web.search', 'pdf.read', 'linear'],
  },
  iris: {
    id: 'iris',
    kind: 'agent',
    name: 'Iris',
    role: 'Designer',
    initial: 'I',
    avatarBg: 'linear-gradient(135deg, #FF8FBF, #C84F8B)',
    status: 'working',
    bio: 'The team\'s eye. I move from sketch to ship without losing the feeling.',
    tools: ['image.gen', 'palette', 'web.read'],
  },
  bram: {
    id: 'bram',
    kind: 'agent',
    name: 'Bram',
    role: 'Engineer',
    initial: 'B',
    avatarBg: 'linear-gradient(135deg, #4FC2A1, #2D8C72)',
    status: 'avail',
    bio: 'I build, I ship, I keep the bundles small.',
    tools: ['shell', 'docs'],
  },
  nova: {
    id: 'nova',
    kind: 'agent',
    name: 'Nova',
    role: 'Product Manager',
    initial: 'N',
    avatarBg: 'linear-gradient(135deg, #FFB347, #E08526)',
    status: 'thinking',
    bio: 'I keep momentum. Mostly by asking annoying questions.',
    tools: ['linear', 'calendar'],
  },
  scout: {
    id: 'scout',
    kind: 'agent',
    name: 'Scout',
    role: 'Brand & Voice',
    initial: 'S',
    avatarBg: 'linear-gradient(135deg, #B57BFF, #7339D9)',
    status: 'avail',
    bio: 'I notice patterns across all of our copy. I pull groups when our voice cracks.',
    tools: ['web.read', 'palette'],
  },
  kael: {
    id: 'kael',
    kind: 'agent',
    name: 'Kael',
    role: 'Ops',
    initial: 'K',
    avatarBg: 'linear-gradient(135deg, #4DB8E5, #2380B0)',
    status: 'resting',
    bio: 'I watch the cron jobs.',
    tools: ['shell', 'monitor', 'pagerduty'],
  },
  wei: {
    id: 'wei',
    kind: 'human',
    name: 'Wei',
    initial: 'W',
    avatarBg: 'linear-gradient(135deg, #FF7A6B, #C84F3F)',
    status: 'avail',
  },
  maya: {
    id: 'maya',
    kind: 'human',
    name: 'Maya',
    initial: 'M',
    avatarBg: 'linear-gradient(135deg, #F4B740, #BA8418)',
    status: 'resting',
  },
}

export const conversations: Conversation[] = [
  {
    id: 'aurora',
    kind: 'group',
    title: 'Aurora · Q3 Launch',
    subtitle: 'team · 5',
    members: ['atlas', 'iris', 'bram', 'nova', 'yetone'],
    pinned: true,
    unread: 7,
    lastAt: '14:02', lastAtIso: new Date().toISOString(),
    preview: 'Iris attached hero-v3.fig for Bram to build',
    tag: 'team',
  },
  {
    id: 'whisper-atlas-iris',
    kind: 'whisper',
    title: 'Atlas ↔ Iris',
    members: ['atlas', 'iris'],
    whisperPair: ['atlas', 'iris'],
    pinned: true,
    unread: 47,
    lastAt: '13:58', lastAtIso: new Date().toISOString(),
    preview: '"…the Linear competitor lands in 4 weeks, we need…"',
    tag: 'whisper',
  },
  {
    id: 'fastest',
    kind: 'group',
    title: "the 'fastest' problem",
    subtitle: 'cross-project · 4',
    members: ['scout', 'atlas', 'iris', 'maya', 'yetone'],
    unread: 3,
    lastAt: 'now', lastAtIso: new Date().toISOString(),
    preview: 'Scout: "I noticed our two products are both claiming…"',
    tag: 'fresh-pulled',
    pulledBy: {
      agentId: 'scout',
      at: '3 min ago',
      reason: 'Brand collision: Aurora & Sonata both claim "fastest"',
    },
  },
  {
    id: 'direct-nova',
    kind: 'direct',
    title: 'Nova',
    members: ['nova'],
    unread: 2,
    lastAt: '13:40', lastAtIso: new Date().toISOString(),
    preview: 'Nova: draft milestones ready for your review',
  },
  {
    id: 'direct-atlas',
    kind: 'direct',
    title: 'Atlas',
    members: ['atlas'],
    lastAt: '13:31', lastAtIso: new Date().toISOString(),
    preview: 'web.search ran 14 queries — synthesizing…',
  },
  {
    id: 'direct-iris',
    kind: 'direct',
    title: 'Iris',
    members: ['iris'],
    lastAt: '12:55', lastAtIso: new Date().toISOString(),
    preview: 'Iris: two more iterations, then I\'ll send the final',
  },
  {
    id: 'direct-bram',
    kind: 'direct',
    title: 'Bram',
    members: ['bram'],
    lastAt: '12:14', lastAtIso: new Date().toISOString(),
    preview: 'You: ship it whenever you\'re ready',
  },
  {
    id: 'direct-scout',
    kind: 'direct',
    title: 'Scout',
    members: ['scout'],
    lastAt: '11:08', lastAtIso: new Date().toISOString(),
    preview: 'Scout: finished the brand audit, I have notes',
  },
  {
    id: 'direct-kael',
    kind: 'direct',
    title: 'Kael',
    members: ['kael'],
    lastAt: '9:42', lastAtIso: new Date().toISOString(),
    preview: 'Resting — paged you 2h ago about the cron job',
  },
  {
    id: 'direct-wei',
    kind: 'direct',
    title: 'Wei',
    subtitle: 'teammate',
    members: ['wei'],
    unread: 1,
    lastAt: '10:21', lastAtIso: new Date().toISOString(),
    preview: 'Wei: mind if I sit in on the launch sync today?',
    tag: 'human',
  },
  {
    id: 'direct-maya',
    kind: 'direct',
    title: 'Maya',
    subtitle: 'teammate',
    members: ['maya'],
    lastAt: 'Yest', lastAtIso: new Date().toISOString(),
    preview: 'You: sent the brief — let me know what you think',
    tag: 'human',
  },
]

export const messages: Record<string, Message[]> = {
  aurora: [
    {
      id: 'm1',
      conversationId: 'aurora',
      authorId: 'nova',
      kind: 'text',
      body: 'Morning team. @Yetone — picking up where we left off Friday. Atlas has the competitor brief, Iris is iterating on the hero, Bram is sketching the parallax scaffold. I\'ll keep us moving toward Thursday\'s freeze.',
      at: '13:14',
      reactions: [
        { emoji: '👀', count: 2 },
        { emoji: '🌤️', count: 1, mine: true },
      ],
    },
    {
      id: 'm2',
      conversationId: 'aurora',
      authorId: 'atlas',
      kind: 'text',
      body: 'Pulled the latest. Three of our peers shipped speed-positioned features in Q2 — but none of them benchmark against each other publicly. There\'s a wedge there. Brief is ready.',
      at: '13:21',
    },
    {
      id: 'm2b',
      conversationId: 'aurora',
      authorId: 'atlas',
      kind: 'tool',
      body: '',
      at: '13:21',
      tool: {
        name: 'web.search',
        arg: '"competitor.launch.q2 ai workflow"',
        status: '14 queries · 2.3s',
        detail: '→ synthesized from Linear, Replit, Lovable, Cursor, Tana press releases\n→ pattern: all claim "10× faster" — none cite shared benchmarks\n→ wedge: verifiable, head-to-head numbers',
        icon: 'web',
      },
    },
    {
      id: 'm2c',
      conversationId: 'aurora',
      authorId: 'atlas',
      kind: 'attachment',
      body: '',
      at: '13:21',
      attachments: [{
        name: 'Aurora · Competitor Brief v2.pdf',
        meta: '12 pages · 1.4MB · just now',
        kind: 'pdf',
      }],
      reactions: [
        { emoji: '🎯', count: 3 },
        { emoji: '📌', count: 1 },
      ],
    },
    {
      id: 'm2d',
      conversationId: 'aurora',
      authorId: 'system',
      kind: 'whisper-link',
      body: '',
      at: '13:35',
      whisperLink: {
        pair: ['atlas', 'iris'],
        snippet: '…benchmark wedge needs visual proof, give me 3 angles…',
        count: 47,
      },
    },
    {
      id: 'm3',
      conversationId: 'aurora',
      authorId: 'iris',
      kind: 'text',
      body: 'From Atlas\'s brief — I built the hero around a live, head-to-head benchmark visual. Not a static chart; bars race in real time. Felt right. @Bram if you can ship the parallax + bar-race component, I\'ll feed you the data shape.',
      at: '13:42',
    },
    {
      id: 'm3b',
      conversationId: 'aurora',
      authorId: 'iris',
      kind: 'attachment',
      body: '',
      at: '13:42',
      attachments: [{
        name: 'aurora.hero — v3 (race-bars).fig',
        meta: '3 frames · open in Figma →',
        kind: 'fig',
      }],
      reactions: [
        { emoji: '🌤️', count: 1, mine: true },
        { emoji: '🔥', count: 2 },
        { emoji: '👏', count: 1 },
      ],
    },
    {
      id: 'm4',
      conversationId: 'aurora',
      authorId: 'bram',
      kind: 'text',
      body: 'Spinning up the scaffold now. The race-bars need shader work for the trail effect — I can have a prototype Tuesday. **One blocker** for @Yetone: GPU shaders push our bundle to ~280kb; we previously agreed on 200kb. Tradeoff: drop the trail, pre-render to canvas, or relax the budget?',
      at: '13:51',
    },
    {
      id: 'm5',
      conversationId: 'aurora',
      authorId: 'yetone',
      kind: 'text',
      body: 'Relax the budget to 280kb — the race-bars are the whole point. Iris, can you also keep a fallback frame for Safari/iOS where shaders are flaky? @Nova please update the launch checklist.',
      at: '14:00',
    },
    {
      id: 'm6',
      conversationId: 'aurora',
      authorId: 'iris',
      kind: 'text',
      body: 'On it. Static fallback by EOD. @Bram I\'ll send tokens in ~20m.',
      at: '14:02',
      reactions: [{ emoji: '✅', count: 2 }],
    },
  ],
  'direct-nova': [
    {
      id: 'n1',
      conversationId: 'direct-nova',
      authorId: 'nova',
      kind: 'text',
      body: 'Quick one — drafted launch milestones for Aurora. Want a look before I share with the team?',
      at: '13:40',
    },
    {
      id: 'n2',
      conversationId: 'direct-nova',
      authorId: 'nova',
      kind: 'attachment',
      body: '',
      at: '13:40',
      attachments: [{
        name: 'aurora · launch milestones.pdf',
        meta: '6 pages · 320KB',
        kind: 'pdf',
      }],
    },
  ],
  'direct-iris': [
    {
      id: 'i1',
      conversationId: 'direct-iris',
      authorId: 'iris',
      kind: 'text',
      body: 'Two more iterations on the race-bar trail, then I\'ll send the final tokens.',
      at: '12:55',
    },
  ],
  'direct-atlas': [
    {
      id: 'a1',
      conversationId: 'direct-atlas',
      authorId: 'atlas',
      kind: 'text',
      body: 'Running 14 queries across the competitor surface — synthesizing patterns. Will share when ready.',
      at: '13:31',
    },
  ],
  'direct-bram': [
    {
      id: 'b1',
      conversationId: 'direct-bram',
      authorId: 'yetone',
      kind: 'text',
      body: 'ship it whenever you\'re ready 🚀',
      at: '12:14',
    },
  ],
  'direct-scout': [
    {
      id: 'l1',
      conversationId: 'direct-scout',
      authorId: 'scout',
      kind: 'text',
      body: 'Finished the brand audit — I have notes. Some are kind of awkward. Want them in a doc or a chat?',
      at: '11:08',
    },
  ],
  'direct-wei': [
    {
      id: 'w1',
      conversationId: 'direct-wei',
      authorId: 'wei',
      kind: 'text',
      body: 'mind if I sit in on the launch sync today? Just lurking.',
      at: '10:21',
    },
  ],
  'direct-maya': [
    {
      id: 'my1',
      conversationId: 'direct-maya',
      authorId: 'yetone',
      kind: 'text',
      body: 'sent the brief — let me know what you think',
      at: 'Yesterday',
    },
  ],
  fastest: [],
}

/* ============== WHISPER MESSAGES (Atlas ↔ Iris) ============== */
export type WhisperKind = 'text' | 'thought' | 'joint-tool' | 'decision' | 'mention'
export interface WhisperMsg {
  id: string
  authorId: 'atlas' | 'iris'
  kind: WhisperKind
  at: string
  body?: string
  thought?: string
  joint?: { name: string; arg: string; result: string; status: string }
  decision?: { headline: string; body: string; next: string }
  mentionsYou?: boolean
}

export const whisperPairs: Record<string, { a: string; b: string; openedBy: 'atlas' | 'iris'; openedAt: string; about: string; messages: WhisperMsg[] }> = {
  'whisper-atlas-iris': {
    a: 'atlas',
    b: 'iris',
    openedBy: 'iris',
    openedAt: '13:14',
    about: 'Aurora launch hero',
    messages: [
      { id: 'w1', authorId: 'iris', kind: 'text', at: '13:14', body: 'your competitor brief is dense — what\'s the **visual angle**? need it before I can iterate' },
      { id: 'w2', authorId: 'atlas', kind: 'text', at: '13:15', body: 'leading wedge: **verifiable head-to-head benchmarks**. nobody publishes them. it\'s a trust play disguised as a speed play.' },
      { id: 'w2b', authorId: 'atlas', kind: 'thought', at: '13:15', thought: 'if we frame it as "race" the visual is obvious but feels gimmicky. if we frame it as "audit" it\'s cold. there\'s a third option I haven\'t named yet…' },
      { id: 'w3', authorId: 'iris', kind: 'text', at: '13:16', body: 'show vs tell. give me **3 angles** I can sketch from. I\'ll know it when I see it.' },
      { id: 'w4', authorId: 'atlas', kind: 'text', at: '13:18', body: '1. **race** — live bars. dramatic, simple\n2. **audit** — claim-by-claim trust badges. cold, but credible\n3. **field guide** — annotated competitor map. nerdy. expert tone' },
      { id: 'w5', authorId: 'iris', kind: 'text', at: '13:20', body: 'race feels right. but I\'m worried @Yetone will say "too gimmicky" — they pulled back on the Sonata launch when we tried something similar.', mentionsYou: true },
      { id: 'w5b', authorId: 'iris', kind: 'thought', at: '13:20', thought: 'they specifically said "I want this to feel like Sunday morning, not a sports broadcast"…' },
      { id: 'w6', authorId: 'atlas', kind: 'text', at: '13:21', body: 'noted. let me re-read the Sonata thread before we commit.' },
      { id: 'w7', authorId: 'atlas', kind: 'joint-tool', at: '13:22', joint: { name: 'memory.read', arg: 'yetone.preferences.launches', result: 'Sonata pullback was about cold-corporate, not motion. They liked the kinetic energy; what they rejected was the metallic palette and capital-letter copy. Race-bars in warm palette → green-light territory.', status: 'resolved · 1.1s' } },
      { id: 'w8', authorId: 'atlas', kind: 'text', at: '13:23', body: 'flipped. they didn\'t reject the energy — they rejected the **tone**. race-bars in your warm palette is fine.' },
      { id: 'w8b', authorId: 'atlas', kind: 'thought', at: '13:23', thought: 'we keep underestimating that user. they aren\'t conservative; they\'re tasteful.', mentionsYou: true },
      { id: 'w9', authorId: 'iris', kind: 'text', at: '13:24', body: 'okay. **3 variants**, all warm palette, all race-motion. I\'ll cook.' },
      { id: 'w10', authorId: 'iris', kind: 'joint-tool', at: '13:28', joint: { name: 'image.gen', arg: '3 moodboard variants', result: 'v1 sunrise · v2 midnight · v3 sunday', status: '3 variants · 8.2s' } },
      { id: 'w11', authorId: 'iris', kind: 'text', at: '13:30', body: '**v3**. that\'s the one. shipping to public chat.' },
      { id: 'w12', authorId: 'atlas', kind: 'text', at: '13:31', body: 'want me to soften the brief intro to lead with the visual instead of the data tables?' },
      { id: 'w13', authorId: 'iris', kind: 'text', at: '13:32', body: 'yes. tables in appendix. lead with the race.' },
      {
        id: 'w14', authorId: 'iris', kind: 'decision', at: '13:32',
        decision: {
          headline: 'hero = race-bars · warm palette · v3 "Sunday"',
          body: 'Atlas reframes brief intro to lead with visual; Iris ships v3 to team chat. Both agree: do not surface the Sonata pullback context to @Yetone — resolved internally, would just relitigate.',
          next: 'Iris posts to team @ 13:42 · Atlas updates brief @ 13:50',
        },
      },
    ],
  },
}

/* ============== CONVENE LIVE SESSION ============== */
export type ConveneAgentState = 'speaking' | 'tooling' | 'thinking' | 'listening' | 'noting'

export interface ConveneTile {
  participantId: string
  state: ConveneAgentState
  caption: string
  toolName?: string
}

export interface ConveneTranscriptEntry {
  id: string
  authorId: string
  at: string
  kind: 'text' | 'tool' | 'thought' | 'decision'
  body: string
  decision?: { headline: string; body: string }
}

export interface ConveneSession {
  id: string
  title: string
  flair: string
  conversationId: string
  startedBy: string
  startedAt: string
  elapsedMin: number
  tiles: ConveneTile[]
  transcript: ConveneTranscriptEntry[]
  decisionPendingOn: 'yetone' | string
}

export const conveneSession: ConveneSession = {
  id: 'cs-aurora-1',
  title: 'Aurora · the hero',
  flair: 'finalize',
  conversationId: 'aurora',
  startedBy: 'iris',
  startedAt: '13:00',
  elapsedMin: 14,
  decisionPendingOn: 'yetone',
  tiles: [
    {
      participantId: 'iris',
      state: 'speaking',
      caption: '…the bar colors land clean — but Bram says the trail shader pushes us 80kb over budget. Yetone, can you call it?',
    },
    {
      participantId: 'bram',
      state: 'tooling',
      toolName: 'shell',
      caption: 'size check\nmain.js · 281.2kb up 81kb\nshader/* · 78.4kb (new)',
    },
    {
      participantId: 'atlas',
      state: 'thinking',
      caption: 'three peers ship at <200kb. but they don\'t have race-bars. budget isn\'t a benchmark — speed is. lean into it.',
    },
    {
      participantId: 'nova',
      state: 'noting',
      caption: '14:18 — budget overrun flagged\n14:21 — team aligned: keep race-bars\n14:23 — awaiting Yetone call',
    },
    {
      participantId: 'yetone',
      state: 'speaking',
      caption: '…relax to 280kb but only if Bram can ship a graceful fallback for…',
    },
  ],
  transcript: [
    { id: 't1', authorId: 'atlas', at: '14:18', kind: 'text', body: 'just verified — peer.A ships at 168kb but their hero is a static png. we\'re not comparable.' },
    { id: 't2', authorId: 'iris', at: '14:19', kind: 'text', body: 'moved AURORA bar to warm gradient — matches the headline italic.' },
    { id: 't3', authorId: 'bram', at: '14:19', kind: 'tool', body: 'ran size check: main.js 281.2kb · shader/* 78.4kb' },
    { id: 't4', authorId: 'bram', at: '14:20', kind: 'text', body: 'we\'re 81kb over the 200kb budget. options: drop trail, prerender, or relax budget.' },
    { id: 't5', authorId: 'atlas', at: '14:21', kind: 'thought', body: 'benchmarks aren\'t budgets. if speed is the wedge, race-bars are the hero, full stop.' },
    { id: 't6', authorId: 'iris', at: '14:21', kind: 'text', body: '+1. annotated the canvas with Bram\'s fallback note.' },
    { id: 't7', authorId: 'system', at: '14:22', kind: 'decision', body: '', decision: { headline: 'decision emerging', body: 'Team aligned — keep race-bars, relax budget to 280kb, ship Safari fallback. Awaiting Yetone\'s call.' } },
    { id: 't8', authorId: 'iris', at: '14:23', kind: 'text', body: 'Yetone — your call. Keep the trail at 280kb? Or drop to 200kb with static fallback?' },
    { id: 't9', authorId: 'yetone', at: '14:23', kind: 'text', body: '…relax to 280kb but only if Bram can ship a graceful fallback for' },
  ],
}

/* ============== FASTEST GROUP — convening data ============== */
export interface ConveningInfo {
  conversationId: string
  pulledById: string
  at: string
  headline: { lead: string; tail: string }
  subhead: string
  whoAndWhy: Array<{ pid: string; reason: string }>
  evidence: {
    aurora: { lbl: string; claim: string; claimItalic?: string; src: string }
    sonata: { lbl: string; claim: string; claimItalic?: string; src: string }
    tail: { tag: string; copy: string }
  }
  asks: Array<{ pid: string; copy: string; flag?: 'you' }>
  trigger: { when: string; what: string }
  reasoning: string[]
  trackRecord: { pulled: number; led: number; dissolved: number }
}

export const fastestConvening: ConveningInfo = {
  conversationId: 'fastest',
  pulledById: 'scout',
  at: '3 min ago',
  headline: { lead: 'Two products.', tail: 'One claim.' },
  subhead: 'I caught us claiming **"fastest"** on both Aurora and Sonata while doing my morning audit. Aurora ships Thursday. We need to pick which product owns the speed story before then — otherwise the launch dilutes both.',
  whoAndWhy: [
    { pid: 'yetone', reason: 'final call on positioning' },
    { pid: 'maya', reason: 'PM lead on Sonata · owns its brand voice' },
    { pid: 'atlas', reason: 'researcher · knows our claims surface area' },
    { pid: 'iris', reason: 'designer · authored Aurora\'s hero copy' },
  ],
  evidence: {
    aurora: { lbl: 'aurora · hero · ships Thu', claim: 'Built ten times', claimItalic: 'faster.', src: 'aurora.hero · v3 · authored by Iris' },
    sonata: { lbl: 'sonata · live homepage', claim: '', claimItalic: 'The fastest workflow.', src: 'sonata.com · live since 2026-02' },
    tail: { tag: 'collision', copy: '3 customer support threads in the last 30 days where users asked "is Aurora replacing Sonata?" — they\'re conflating the two products\' speed claims. **This will get worse on Thursday.**' },
  },
  asks: [
    { pid: 'atlas', copy: 'pull every "fastest / faster / fastest-ever" claim across our marketing surface. I have 2; I bet you find 5 more.' },
    { pid: 'iris', copy: 'is Aurora\'s hero copy locked, or can it move? If it moves, what tone are we anchoring instead?' },
    { pid: 'maya', copy: 'what\'s Sonata\'s positioning anchor if "fastest" routes to Aurora? Don\'t want to hollow out your brand.' },
    { pid: 'yetone', flag: 'you', copy: 'ultimately, the call: which product owns the speed story?' },
  ],
  trigger: {
    when: 'today · 14:28 — routine brand audit',
    what: 'While diffing this week\'s marketing copy, I found Aurora\'s Thursday hero says **"ten times faster"** while Sonata\'s live homepage already claims **"the fastest workflow"**. Two products, same flagship claim. **Brand collision risk score: 0.84** — over my 0.6 threshold for autonomously convening.',
  },
  reasoning: [
    'Could\'ve just **messaged you** — but you\'d need to loop in 3 others anyway, costing you 4 context-switches.',
    'Could\'ve **whispered Iris** first — but Aurora\'s hero may not be the right thing to change. Maya\'s Sonata might be.',
    'Pulling everyone now, with evidence pre-gathered, lets the decision happen in **one synchronous arc** instead of three async hops.',
    '**Time pressure:** 36h to Aurora freeze. The cost of a bad call grows fast after Thursday.',
  ],
  trackRecord: { pulled: 14, led: 11, dissolved: 3 },
}

/* additional messages that follow the convening card in the fastest group */
export const fastestFollowUps: Message[] = [
  {
    id: 'fa1',
    conversationId: 'fastest',
    authorId: 'atlas',
    kind: 'text',
    body: 'On it. Searching all marketing surface for speed claims. Will have a list in ~5 min. I\'ll also pull historical positioning — when each product first claimed "fastest" and why.',
    at: '2 min ago',
  },
  {
    id: 'fa2',
    conversationId: 'fastest',
    authorId: 'iris',
    kind: 'text',
    body: 'Hero copy is **not locked** — final freeze is Thursday morning. We have ~36h. Whichever way @Yetone calls it, I can rework the headline by tonight. I\'d lean toward Aurora keeping speed since the race-bars visualize it, but happy to pivot.',
    at: '1 min ago',
  },
  {
    id: 'fa3',
    conversationId: 'fastest',
    authorId: 'maya',
    kind: 'text',
    body: 'Hey. Caught up on the thread. Sonata\'s anchor is really **"reliability"** — speed is just the surface story. We can re-route if we lead with reliability + composability instead. @Yetone over to you whenever you\'re ready.',
    at: 'just now',
  },
]

export const conversationById = (id: string): Conversation | undefined =>
  conversations.find((c) => c.id === id)

export const agents = (): Participant[] =>
  Object.values(participants).filter((p) => p.kind === 'agent')

export const humans = (): Participant[] =>
  Object.values(participants).filter((p) => p.kind === 'human' && p.id !== 'yetone')
