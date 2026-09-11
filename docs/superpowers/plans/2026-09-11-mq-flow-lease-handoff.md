# PostgreSQL flow lease handoff — issue #387

## Goal

A durable fan-out that releases its parent lease ends the original Worker attempt. Collect runs only after a new ordinary claim owns the parent. Suspended parents are never coerced into active/waiting v1 records. Existing detached/reference FlowStores retain their declared lifecycle.

## Root causes and fixes

The PostgreSQL FlowStore already clears its parent lease atomically during fan-out. The old supervisor nevertheless kept the original attempt alive and could enter Collect without an active lease. The optional `FlowStoreV2Descriptor.parentLeaseMode` now states this lifecycle explicitly. PostgreSQL declares `handoff`; omission retains existing independent/reference-store behavior.

A successful handoff ends the original phase without parent result encoding, ordinary settlement or stale release. A new native claim owns Collect. Handoff-mode phases count against execution concurrency before handoff. Late heartbeat/deadline/shutdown activity cannot revive the relinquished phase. PostgreSQL lease operations classify a known suspended parent while holding its row lock, before entering the frozen v1 record decoder.

Two further defects explained the remaining cross-repository stall. `flowSources` is indexed by FlowStore tags, while child settlement queried it using a JobStore tag. Reports now use `FlowStore.for(group.store).serviceTag`. Separately, bounded sweeps restarted at the first known parents and children; earlier completed or slow flows could indefinitely starve later work. The existing sweeper now rotates across routes, parents and pending-child keys. Terminal parents are retired only when no pending children or unacknowledged cancellation cascades remain. Empty manifests still consume an inspection unit.

The native JobStore also returned from disposal while admitted transactions were still using a borrowed pool. Worker wait cancellation does not cancel SQL. Disposal now closes admission synchronously and waits for each admitted transaction through commit or rollback and client release, without closing the application's pool.

Ordinary and controlled claims now defer records whose update time is newer than the request's explicit clock. They do not backdate a lease, advance the caller's clock, or invalidate older eligible jobs in the same batch. This handles writes that commit after a competing Worker samples its claim time.

Notification waits no longer use an unconditional 1 ms operation deadline. Deliberate poll/quiesce cancellation is distinguished from a real operation deadline, including an outstanding claim wait cancelled during shutdown. The late-claim generation fence and compensation path remain intact. Flow handlers receive JobContext within each attempt; other business Service requirements remain part of their Worker layer requirements.

## Reproduction and checked boundaries

Native baseline run `34625793348` at `a24522b` reproduces the unsupported-state heartbeat error and Collect against a non-active parent. The Worker was explicitly resolved, so the baseline does not mistake lazy startup for a processing defect. SQL assertions inspect actual state, delivery counters and lease tokens.

Run `34628933046` verified the routing and fairness regressions fail before their patch and pass afterward with unchanged assertions. A completed child could not report to its parent through the wrong token; a recovery batch of two left two of four parents unvisited. Both have dedicated regression tests.

The unchanged installed Nest flow scenarios passed at `38b8c52` in run `34629403814`, but the broader matrix exposed a cleanup deadlock: DROP SCHEMA raced a still-active native claim after runtime disposal. Native run `34629403765` independently exposed the same lifecycle problem. Those historical flow successes were not full-matrix passes.

The deterministic disposal regression in run `34630529510` failed before the change because disposal returned before a gated native COMMIT. The same regression passed after the change for both COMMIT and ROLLBACK, including native client release and continued usability of the borrowed pool. A separate timestamp race remained visible rather than being suppressed.

Run `34630868307` verified the explicit claim-clock regression fails before its patch and passes afterward. It also passed the disposal and stale-lease regressions. Its final post-disposal error assertion then exposed intentional quiesce cancellation being reported as an operational timeout. That classification was corrected separately; the assertion remains unchanged and the native Worker scenario is repeated through full disposal.

The final acceptance status belongs to the retained CI runs on the final PR head, not to a historical successful checkpoint. Source and package checks are distinct from real PostgreSQL and external-consumer checks. Optional skipped tests must not be counted as passed.

## Retained verification

- `tests/flow-report-route.test.ts` verifies child reporting without recovery ids or frequent sweep polling.
- `tests/flow-sweep-fairness.test.ts` verifies all four known parents progress with a sweep budget of two without relying on report delivery.
- `tests/flow-context.types.ts` checks phase-local JobContext removal while retaining the business Service requirement.
- `better-effect-mq-postgres/tests/integration/flow-handoff.ts` verifies mixed heartbeat, stale-token mutation rejection, fresh-lease Collect and clean disposal in real PostgreSQL.
- `better-effect-mq-postgres/tests/integration/store-dispose.ts` gates native COMMIT/ROLLBACK to verify disposal ordering without relying on timing luck.
- `better-effect-mq-postgres/tests/integration/claim-clock.ts` verifies newer ready records are deferred without invalidating older eligible claims or changing timestamps.
- `.github/workflows/mq-flow-handoff.yml` retains native regression and core/adapter source qualification.
- `.github/workflows/mq-nest-candidate.yml` builds real candidate archives and runs unchanged Nest source/consumer tests at `nitoba/bettter-nest-mq@33d6860c1d4eebccfdc56e733f4fdc3c7aaf79c8`. Installed candidate bytes are checked against their built archives. Dependency selections are ephemeral and restored; the consuming application declares no internal engine packages. Failed unchanged fixtures remain failures even when a separate diagnostic copy is inspected.

## Acceptance and release boundary

No v1 public state-union change, fake Process handler, new consumer peer, automatic migration, lease fabrication or expected-failure suppression is introduced. No npm publication, main merge or production deployment is part of this change.

The unchanged Nest candidate still contains explicit v2 read/null-preservation adaptations. This PR does not silently redefine native v1 getJob as a v2 read API, remove those adaptations or claim a complete public v2 inspection surface. Retained-lease adapters preserve their prior behavior; other adapters are not automatically certified as handoff-capable.

Before integration, verify the exact final head's source checks, native lease regression and complete packed Nest PostgreSQL matrix. Record both successes and remaining unsupported paths in PR #388 and Nest PR #9. The published dependency pins in Nest must only be updated after an independently approved engine release. The public compatibility contract is documented in `packages/better-effect-mq/docs/protocol/postgres-flow-handoff.md`.
