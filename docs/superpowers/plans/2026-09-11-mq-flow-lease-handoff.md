# PostgreSQL flow lease handoff — issue #387

## Goal

A durable fan-out that releases its parent lease ends the original Worker attempt. Collect runs only after a new ordinary claim owns the parent. Suspended parents are never coerced into active/waiting v1 records. Existing detached/reference FlowStores retain their declared lifecycle.

## Evidence before the fix

Native PostgreSQL regression run 34625793348 at a24522b reproduces the unsupported-state heartbeat error. With the Worker explicitly acquired, it also observes a Collect invocation against a non-active parent, stale settlement and supervisor errors. Assertions inspect real SQL state and different lease tokens, not only final values.

## Implementation sequence

1. Add an explicit optional FlowStore descriptor parentLeaseMode. Default retained preserves existing adapter behavior; PostgreSQL declares handoff because its atomic fan-out already clears the job lease.
2. Mark a confirmed handoff in the attempt before child publication; end without result encoding, ordinary settlement or stale release. Exclude late heartbeats/deadlines/shutdown cancellation from that completed phase. Handoff-mode phases count against concurrency until the phase has ended.
3. Fence suspended parents in PostgreSQL heartbeat/release/settle while holding row locks, before using the frozen v1 decoder. Preserve ordinary-job paths and unknown-state errors.
4. Skip reconciliation for a known empty manifest; no missing-parent error may be invented for a valid zero-child flow.
5. Run native PostgreSQL mixed heartbeat, stale mutations, concurrency-one typed-failure and empty-flow regressions; run existing core/adapter tests, types, lint and formatting.
6. Check packed upstream candidates against the exact Nest PR head without publishing or changing production dependency versions. Record any remaining unsupported v2 read, nesting, cancellation or restart path explicitly.

## Acceptance and release boundary

No changes to the v1 public state union, no fake Process handlers, no new consumer peers, no automatic migrations, no lease fabrication, no expected-failure suppression. No npm publication, main merge or deployment in this task. The exact passing source/test commit and any remaining failing scenario must be recorded in both PRs.
