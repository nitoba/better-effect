# PostgreSQL flow lease handoff — issue #387

## Goal

A durable fan-out that releases its parent lease ends the original Worker attempt. Collect runs only after a new ordinary claim owns the parent. Suspended parents are never coerced into active/waiting v1 records. Existing detached/reference FlowStores retain their declared lifecycle.

## Root causes and fixes

The PostgreSQL FlowStore already clears its parent lease atomically during fan-out. The old supervisor nevertheless kept the original attempt alive and could enter Collect without an active lease. The optional `FlowStoreV2Descriptor.parentLeaseMode` now states this lifecycle explicitly. PostgreSQL declares `handoff`; omission retains existing independent/reference-store behavior.

A successful handoff ends the original phase without parent result encoding, ordinary settlement or stale release. A new native claim owns Collect. Handoff-mode phases count against execution concurrency before handoff. Late heartbeat/deadline/shutdown activity cannot revive the relinquished phase. PostgreSQL lease operations classify a known suspended parent while holding its row lock, before entering the frozen v1 record decoder.

Two further defects explained the remaining cross-repository stall. `flowSources` is indexed by FlowStore tags, while child settlement queried it using a JobStore tag. Reports now use `FlowStore.for(group.store).serviceTag`. Separately, bounded sweeps restarted at the first known parents and children; earlier completed or slow flows could indefinitely starve later work. The existing sweeper now rotates across routes, parents and pending-child keys. Terminal parents are retired only when no pending children or unacknowledged cancellation cascades remain. Empty manifests still consume an inspection unit.

Notification waits no longer use an unconditional 1 ms operation deadline. Deliberate poll/quiesce cancellation is distinguished from a real operation deadline. Flow handlers receive JobContext within each attempt; other business Service requirements remain part of their Worker layer requirements.

## Reproduction and checked boundaries

Native baseline run `34625793348` at `a24522b` reproduces the unsupported-state heartbeat error and Collect against a non-active parent. The Worker was explicitly resolved, so the baseline does not mistake lazy startup for a processing defect. SQL assertions inspect actual state, delivery counters and lease tokens.

Run `34627491460`, executing source commit `933555b`, passed native PostgreSQL mixed-heartbeat fencing, stale release/settlement rejection, concurrency-one mixed child failure, empty fan-out, different Collect lease/delivery and clean shutdown. At that checkpoint, core qualification passed 415 tests with no failures plus types/lint/format. PostgreSQL qualification reported 209 tests including 68 skipped, with no failures plus types/lint/format. Skipped adapter tests are not claimed verified.

Run `34628933046` verified the new routing and fairness regressions fail before their patch and pass afterward with unchanged assertions. A completed child could not report to its parent through the wrong token; a recovery batch of two left two of four parents unvisited. Both now have dedicated regression tests. The subsequent type check found two new-code/test setup issues, corrected separately without widening v1 state types.

The final acceptance status belongs to the retained CI runs on the final PR head, not to a historical successful checkpoint. Source and package checks are distinct from real PostgreSQL and external-consumer checks.

## Retained verification

- `tests/flow-report-route.test.ts` verifies child reporting without recovery ids or frequent sweep polling.
- `tests/flow-sweep-fairness.test.ts` verifies all four known parents progress with a sweep budget of two without relying on report delivery.
- `tests/flow-context.types.ts` checks phase-local JobContext removal while retaining the business Service requirement.
- `better-effect-mq-postgres/tests/integration/flow-handoff.ts` verifies mixed heartbeat, stale-token mutation rejection and fresh-lease Collect in real PostgreSQL.
- `.github/workflows/mq-flow-handoff.yml` retains native regression and core/adapter source qualification.
- `.github/workflows/mq-nest-candidate.yml` builds real candidate archives and runs unchanged Nest source/consumer tests at `nitoba/bettter-nest-mq@33d6860c1d4eebccfdc56e733f4fdc3c7aaf79c8`. Installed candidate bytes are checked against their built archives. Dependency selections are ephemeral and restored; the consuming application declares no internal engine packages. Failed unchanged fixtures remain failures even when a separate diagnostic copy is inspected.

## Acceptance and release boundary

No v1 public state-union change, fake Process handler, new consumer peer, automatic migration, lease fabrication or expected-failure suppression is introduced. No npm publication, main merge or production deployment is part of this change.

The unchanged Nest candidate still contains explicit v2 read/null-preservation adaptations. This PR does not silently redefine native v1 getJob as a v2 read API, remove those adaptations or claim a complete public v2 inspection surface. Retained-lease adapters preserve their prior behavior; other adapters are not automatically certified as handoff-capable.

Before integration, verify the exact final head's source checks, native lease regression and complete packed Nest PostgreSQL matrix. Record both successes and remaining unsupported paths in PR #388 and Nest PR #9. The published dependency pins in Nest must only be updated after an independently approved engine release.
