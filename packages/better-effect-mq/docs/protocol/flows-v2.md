# Flow protocol v2

This document describes the first v2 flow slice. It is explicit and additive:
the existing `JobStore` and protocol v1 state machine remain unchanged.

## Version, layout, and migration

Flow records use `protocolVersion: 2`. The flow tables/collections use an
independent `layoutVersion`, currently `1`, and expose a separate `migration`
descriptor. A driver must inspect all three values; a v1 store must not infer
`waiting-children` or flow fields from a v1 record.

The core package does not perform migrations. A later adapter can report a
required or in-progress migration without changing the wire contracts in this
slice.

## JSON-neutral contracts

The v2 protocol adds:

- `JobStateV2`, including `waiting-children`;
- `ParentEnvelope`, which carries `flowName`, `flowId`, `childKey`,
  `parentStoreKey`, and bounded nesting `depth`;
- `FlowState`, with `pending`, `completed`, `failed`, and `cancelled` counters;
- `FlowChildSpec`, `FlowChildRecord`, and `FlowChildReport`;
- `SettlementOutcomeV2`, whose `FanOut` variant contains `failFast` and a
  validated child manifest.

All persisted flow values are strings, numbers, booleans, or JSON values.
Validators reject unknown fields, unsafe values, duplicate `childKey` values,
invalid counters, and manifests above both the configured and hard limits.
Nested flows use an explicit positive depth with a default of 8 and a hard cap
of 32.

Child IDs are derived from the parent store key, flow ID, and child key with a
versioned, length-prefixed encoding. This keeps keys such as `ab` + `c` and
`a` + `bc` distinct without relying on ambiguous concatenation.

## Pure flow descriptors

`Flow.define` and `Flow.children` only validate and freeze descriptors. They do
not resolve a `Runtime`, call a producer, enqueue jobs, or create a parallel
container.

```ts
const Digest = Flow.define('daily-digest', {
  parent: ParentJob,
  children: [EmailJob],
  onChildFailure: 'continue',
  maxChildren: 1_000,
  maxDepth: 4
})

const children = Flow.children(EmailJob, [{ key: 'user:42', payload: { userId: '42' } }])
```

The child group preserves the job payload input type. Child keys are unique
within a group and options contain only the storage-neutral enqueue settings.

## Memory reference store

`MemoryFlowStore` implements the flow-only `FlowStoreV2` contract. It is kept
separate from the v1 `MemoryJobStore` so existing v1 behavior and exports do
not gain implicit flow semantics.

`fanOut` validates the complete manifest before mutating state and atomically
creates the parent flow counters plus all pending child rows. Repeating the
same manifest returns `already-applied`; a conflicting manifest returns a
settlement conflict. Child jobs are not inserted into another job store by
this operation: `reconcile` returns deterministic `FlowChildSpec` values for a
driver to enqueue and later acknowledge.

`recordChildResults` is pending-only and idempotent. In continue mode the parent
returns to `waiting` only after `pending` reaches zero. In fail-fast mode the
first failed report settles the parent as failed and marks the remaining rows
cancelled. `cancel` performs the corresponding local cascade without calling a
child store. `markCascaded` acknowledges each child at most once.

`reconcile` reports missing children for enqueue, terminal observations for
`recordChildResults`, and uncascaded cancelled children for cascade work. These
operations are synchronous and return `better-result` `Result` values; they do
not add a runtime or transaction abstraction.

PostgreSQL, Redis, cross-store enqueue/outbox delivery, result aggregation,
and Worker supervision are intentionally left to later waves.
