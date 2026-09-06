# Flow Protocol v2 Core Design

## Context

Issue #85 introduces parent-child flows whose durable state is a parent-owned
manifest. This first vertical slice must establish a storage-neutral protocol
without changing the existing JobStore protocol v1 or coupling the flow surface
to Runtime, Worker supervision, or a particular database.

## Scope

This change adds:

- explicit protocol-v2 flow DTOs and validators;
- versioned protocol/layout/migration metadata;
- deterministic child IDs using length-prefixed components;
- a pure `Flow.define`/`Flow.children` descriptor surface;
- a small `FlowStoreV2` flow-state contract;
- `MemoryFlowStore` as the synchronous atomic reference implementation;
- runtime and type tests plus protocol documentation.

This change does not add PostgreSQL, Redis, Worker relay/sweeper lifecycle,
FlowRuntime, a parallel container, a second Runtime, Effect Stream, or a
replacement for the existing v1 JobStore APIs.

## Compatibility boundary

The existing `protocolVersion` remains `1`, `JobState` remains the v1 state
union, `JobRecord` remains the v1 snapshot, and `JobStore.Contract` plus
`MemoryJobStore` remain unchanged. Flow v2 exposes `protocolVersionV2 = 2` and
its own descriptor with independent `layoutVersion` and `migration` metadata.
The in-memory implementation is selected explicitly as `MemoryFlowStore`; no
v1 adapter advertises v2 by capability accident.

## Protocol model

`protocol/v2.ts` contains JSON-neutral `ParentEnvelope`, `FlowState`,
`FlowChildSpec`, `FlowChildRecord`, `FlowChildReport`, `FlowOutboxEntry`, and
`FanOutOutcome` definitions. `JobStateV2` adds only `waiting-children` to the
v1 state union, and `JobRecordV2` adds optional parent/flow fields without
changing `JobRecord`.

All DTO validators reject accessors, unsupported fields, non-JSON values,
invalid branded identities, inconsistent child request/spec identity, invalid
counters, and terminal rows with incompatible result/failure fields. The
manifest validator validates every spec before persistence, enforces unique
`childKey` across all groups, and rejects a partial manifest.

Safety limits are explicit and shared by Flow definitions and the store:

- default maximum children: 10,000;
- hard maximum children: 100,000;
- default maximum nesting depth: 8;
- hard maximum nesting depth: 32.

The limits are positive safe integers and a configured limit cannot exceed its
hard bound. Child IDs use a versioned `flow-v2/` prefix followed by the UTF-8
byte length and value of parent store key, flow ID, and child key. This avoids
ambiguous concatenation and makes retries/reconciliation deterministic.

## Pure Flow surface

`Flow.define(name, { parent, children, onChildFailure, maxChildren?, maxDepth? })`
returns an immutable descriptor containing only job definitions, the failure
policy, and validated limits. `Flow.children(job, items)` returns an immutable
batch of payload inputs and child options. It accepts finite readonly arrays,
never captures a Runtime, never invokes Job producer methods, and does not
encode payloads; encoding remains the existing Job preparation boundary.

Child identity duplicates are rejected at definition/manifest boundaries, while
different job kinds may share no `childKey`: the manifest is the global source
of truth for uniqueness.

## FlowStoreV2 and MemoryFlowStore

The v2 flow contract contains only flow-owned persistence operations:

- `fanOut`: validates the active parent lease, validates the complete manifest,
  creates dependency rows and counters atomically, and moves the parent to
  `waiting-children` (or directly to collect-ready `waiting` for an empty
  manifest). A replay of the same materialized manifest is acknowledged without
  duplication; a conflicting replay fails.
- `recordChildResults`: applies pending rows only, updates counters in the same
  critical section, supports `continue` and `fail` policies, and returns
  positional `applied`/`parentSettled` information. Late or duplicate reports
  are ignored idempotently. Fail-fast settles the parent before the pending-zero
  continuation decision and marks remaining rows cancelled/not cascaded.
- `cancel`: changes a waiting flow to cancelled and marks remaining rows for
  cascade without making child-store calls inside the parent mutation.
- `reconcile`: returns bounded deterministic enqueue specs, terminal reports,
  and cascade work from observations; it does not perform cross-store I/O.
- `markCascaded`: acknowledges successful external cancellation per dependency
  row and leaves failed/unacknowledged rows available for another sweep.

The Memory implementation uses nested Maps and one synchronous critical-section
boundary. It stores parent snapshots, dependency rows, and an outbox list in
one unit. It is intentionally a flow reference seam, not a Worker or JobStore
replacement; future adapters can implement the same contract with transactions
and their own layout migration.

## Error and settlement precedence

Validation errors use the existing `JobDefinitionError` boundary. A FanOut
manifest failure occurs before any state is committed. A report for a terminal
row never changes its result. In fail-fast mode the first applied failed report
wins, pending rows become cancelled, and later reports remain harmless. In
continue mode collect readiness occurs only after all rows are terminal. Parent
cancellation is idempotent and exposes pending cascade work through the stored
rows.

## Testing and documentation

Runtime tests cover DTO validation, deterministic IDs, atomic FanOut, replay,
empty manifests, report idempotency, continue/fail-fast ties, cancellation,
cascade acknowledgement, and reconciliation. Type tests cover exact Flow
descriptor/batch inference and the v2 store contract. Existing v1 tests remain
the compatibility guard. Documentation records the independent version axes
and the absence of cross-store transaction guarantees.
