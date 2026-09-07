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
`recordChildResults`, and uncascaded cancelled children for cascade work. The
reconciliation and cascade responses are bounded by the request limit; work
that is not acknowledged with `markCascaded` is returned by a later reconcile.
The contract accepts either an immediate `better-result` `Result` or a
`PromiseLike` of one so in-memory and SQL-backed stores can share the same
protocol without adding a runtime or transaction abstraction.

## Cross-store terminal reports

`FlowStoreV2.appendChildReport` is the durable terminal-report boundary. A
terminal child settlement appends one outbox entry identified by `id`; retries
of the same full payload return `already-applied`, while a conflicting reuse
of the id is a settlement conflict. `peekOutbox` returns an ordered bounded
page without removing entries, so response loss is safe and redelivery is
expected. A relay calls `recordChildResults` in the parent store and calls
`ackOutbox` only with the exact payload confirmed by that parent. A mismatch or
already-removed entry is reported as skipped. These operations are retryable
and do not imply a cross-store transaction.

PostgreSQL performs terminal report insertion in the child settlement
transaction and indexes outbox pages by parent store key. Redis performs the
append and exact-payload acknowledgement in Lua scripts; its bounded peek
reads the ordered outbox without deleting entries. `MemoryFlowStore` is the
reference implementation used by the shared flow-store conformance suite.

PostgreSQL and Redis adapters provide durable flow storage. Cross-store enqueue,
outbox delivery, result aggregation, and Worker supervision remain runner-owned
integration work; this package only defines the storage boundary.

## Worker Layer composition

Flow phases are registered declaratively alongside ordinary Worker handlers and
are started from the same `Runtime` root:

```ts
const DigestRoute = Flow.handle(Digest, { fanOut, collect })

const WorkerLive = AppWorker.layer(() => ({
  handlers: [SendEmailHandler] as const,
  flows: [DigestRoute] as const
}))

const AppLive = Layer.complete(
  Layer.merge(
    JobStoreLive,
    Layer.succeed(FlowStore, FlowStore.of(MemoryFlowStore.make())),
    WorkerLive
  )
)
```

`FlowStore.for(parent.store)` is the associated v2 capability for a flow's
parent store. The Worker Layer requirement includes the phase callback
Services, the parent and child JobStore tokens, and that associated FlowStore
token. Startup resolves and validates all of them before polling. Flow names
must be unique within one Worker, and a flow parent cannot also be registered
as a plain Worker handler.

This is a composition and validation slice. The Worker does not yet execute
fan-out/collect phases or own relay and sweeper loops because the current public
v1 JobStore contract does not expose the required atomic parent settlement,
outbox scan/ack, and child terminal-report operations. No cross-store
transaction is implied: adapters retain ownership of those future operations.
