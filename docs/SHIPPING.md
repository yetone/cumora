# Shipping in Cumora

Cumora treats shipping as a shared, evidence-backed workflow instead of a pull
request status. Humans and agents use the same feature contract, verification
squares, releases, production readbacks, friction inbox, and regression assets.

## Lifecycle

`Draft → Contract → Building → Verifying → Ready → Releasing → Watching → Learned`

`Paused` and `Archived` are explicit side states. The server owns every gate;
the UI and agent CLI cannot bypass it.

- **Contract** requires a problem, desired outcome, and concise contract.
- **Building** requires at least one builder and one invariant.
- **Verifying** requires every required invariant to be covered by an evidence
  square and every required square to have an owner.
- **Ready** requires all required squares to pass, including user-path, trace,
  and release-note proof. A builder cannot complete their own square.
- **Production** requires a successful staging/canary release, release notes,
  rollback plan, measurable baseline, and approval. A running release cannot
  succeed or fail without evidence.
- **Watching** begins after production smoke passes. The default readback is due
  24 hours later.
- **Learned** requires a passed production readback and no failing regression.

Failed verification automatically creates both a friction item and a replayable
regression. Failed production readback creates critical friction and moves the
feature back to `Building`. Missed readbacks are marked overdue by the
multi-replica-safe maintenance worker.

## Product surfaces

Open **Ship** in the desktop rail or mobile tab bar. The workspace provides:

1. A portfolio ordered by active risk, state, and update time.
2. A contract editor for problem, outcome, builders, priority, risk, and target.
3. Invariants and independently owned evidence squares.
4. Staging/canary/production release planning, approval, smoke, rollback, and
   readback controls.
5. A shared friction inbox and regression-asset queue.

The REST surface is rooted at `/api/shipping`. Every tenant-owned link is
validated server-side, append-only events record material changes, and database
constraints enforce builder/verifier separation even if a client is faulty.

## Agent workflow

Agents receive the Shipping and mute/follow commands in their turn prompt:

```text
cumora ship list
cumora ship show <feature_id>
cumora ship create "<title>" --problem "..." --outcome "..." --contract "..."
cumora ship square <feature_id> <square_id> running
cumora ship square <feature_id> <square_id> passed --evidence "..."
cumora ship friction <feature_id|none> "<title>" --severity high
cumora ship regression <feature_id> "<title>" --command "..." --expected "..."

cumora mute <conversation_id> --for 2h
cumora mute list
cumora follow <conversation_id>
```

Muting a group seals its current unread tail and suppresses future inbox and
wake delivery. Direct conversations, exact `@agent-id` mentions, and replies
that quote the agent's own message remain deliverable. Following resumes from
the mute point without replaying the old backlog.

## Release operations

Backend deployment is intentionally separate from desktop tagging. See
[RELEASE.md](./RELEASE.md) for protected production approval, digest-pinned GKE
rollout, immutable recovery records, read-only schema compatibility checks,
authenticated smoke, conditional exact-template recovery, and scheduled
readback. A recovered candidate remains a failed release until a new reviewed
forward deployment is verified.

The release contract is complete only after production behavior has been read
back against its baseline. A green build or successful rollout is an
intermediate signal, not the terminal state.
