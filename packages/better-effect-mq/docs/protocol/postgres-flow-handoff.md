# PostgreSQL flow handoff

This document describes the candidate protocol composition in PR #388. It is not a claim that the currently published packages include these changes. Check the exact PR head's native and external-consumer CI before integrating it.

## Parent lease lifecycle

`FlowStoreV2Descriptor.parentLeaseMode` is optional. Omission or `retained` preserves the existing independent/reference FlowStore lifecycle. A store declaring `handoff` must atomically relinquish the parent job lease when it commits fan-out. PostgreSQL declares this mode because its fan-out transaction already clears that lease.

After acknowledged handoff, the Worker stops the original phase. It does not encode the fan-out return value as the parent's result, settle or release the old lease, or continue heartbeat and execution-deadline handling for that phase. The persisted manifest remains authoritative if publication of a child needs recovery.

Collect runs only after a new native claim owns the parent. The parent must be active and have zero pending children. Its new claimed lease and delivery are used for execution; the manifest's archival fan-out token is not a replacement for that lease. Executing handoff-mode phases participate in ordinary concurrency limits.

Native heartbeat classifies a suspended parent's relinquished lease as lost without rejecting the other leases in the batch. Release and settlement reject that old token under a row lock. No suspended record is rewritten into a v1 active or waiting record to achieve compatibility.

## Reports and bounded recovery

Child reports are routed through the associated FlowStore service tag, not the JobStore tag. The authoritative recovery sweep remains independent from fast report delivery.

A bounded sweep rotates across routes, parents and pending children instead of restarting from the same prefix. Empty manifests consume an inspection unit but do not require child reconciliation. A terminal parent is retired from process-local recovery only after pending children and outstanding cancellation cascades are resolved.

These mechanisms do not promise exactly-once external side effects or SQL cursor streaming. A handler can be delivered again after a failure; its external operations still need appropriate idempotency.

## Clock and disposal boundaries

A claim's explicit clock is not silently advanced to a record's later timestamp. PostgreSQL leaves ready jobs with a newer `updatedAt` for a subsequent claim, allowing other eligible jobs to proceed. It does not backdate leases or weaken reducer timestamp checks.

Store disposal closes admission and drains that store's admitted transactions through commit or rollback and client release. Cancelling a Worker's wait is not equivalent to cancelling SQL already executing in PostgreSQL. A borrowed application pool is not closed to accomplish the drain and remains available to its owner.

## Scope of compatibility

The frozen v1 JobRecord/state union remains unchanged. In particular, native v1 `getJob` is not advertised as a v2 suspended-parent inspection API. `FlowStore.getFlow` reads the manifest; the tested Nest candidate retains its explicit v2 job-read and JSON-null-preservation adaptations. Removing those adaptations requires a separate supported native v2 inspection surface.

Other adapters do not become handoff-capable by inference. Their implementation must satisfy the advertised lifecycle and pass appropriate conformance and Worker tests.

## Verification

The native integration scripts in `better-effect-mq-postgres/tests/integration` cover lease fencing, fresh-lease collection, explicit clock eligibility, and commit/rollback draining on a borrowed pool. Core regressions separately cover report routing without sweep recovery and bounded recovery without report delivery.

The retained cross-repository workflow packs the candidate MQ and PostgreSQL packages, verifies their installed bytes, and runs unchanged Nest source and installed-consumer scenarios against a pinned Nest commit. Local archive selections exist only in that disposable test checkout; they are not release versions or new dependencies that consuming applications must declare.
