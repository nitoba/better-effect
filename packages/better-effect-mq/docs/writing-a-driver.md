# Writing a `JobStore` driver

This guide is the procedural companion to the normative protocol-v1 documents.
A driver implements the storage-neutral `JobStore.Contract`; it owns
persistence, transactions, indexes, wake delivery, migrations, and connection
lifecycle. The core must not import a database client, scheduler, or driver.

Read these first:

- [JobStore contract](./protocol/job-store-v1.md)
- [state machine](./protocol/state-machine-v1.md)
- [atomicity](./protocol/operation-atomicity-v1.md)
- [errors](./protocol/errors-v1.md)
- [ordering and cursors](./protocol/cursors-and-ordering-v1.md)
- [time and leases](./protocol/time-and-leases-v1.md)
- [capabilities](./protocol/capabilities-v1.md)
- [compatibility](./protocol/compatibility-v1.md)

## 1. Package and ownership boundary

Declare `better-effect-mq`, `better-effect`, and `better-result` as peers. A
backend client such as `pg` or `redis` is an optional peer and must be loaded
only when the adapter creates a client from configuration. A caller-supplied
pool/client is borrowed and must not be closed; a client created by the adapter
is owned and must be closed exactly once. Keep backend types and identifiers
inside the adapter package.

A normal Layer supplies the default or a named token:

```ts
import { Layer } from 'better-effect'
import { JobStore } from 'better-effect-mq'
import { MyJobStore } from './store'

const Durable = JobStore.named('durable')
const StoreLive = Layer.succeed(Durable, Durable.of(MyJobStore.contract))
```

A config-backed Layer may acquire and release owned resources with
`Layer.scoped`. Do not register a provider release callback in the backend's
own disposer; Runtime/Scope owns Layer resources.

## 2. Implement the public boundary

Implement every method in `JobStore.Contract`. Return a completed
`better-result` `Result` or a `PromiseLike` of one and return the focused error
union. Validate requests and decoded records before using them. Persist only
JSON-safe payload/result data, string metadata, retry data, identity values,
integer timestamps/counters, leases, and `SerializedJobFailure`. Never persist
live `Result`, `Error`, Promise, connection, request, stack, cause, or lease
objects. Reject unknown fields, accessors, cycles, unsafe integers, malformed
JSON, and unpaired surrogate identities.

Use the caller's one `now` value for every time-sensitive part of an operation.
Do not mix application, SQL, Redis-server, and test clocks. Use the exact claim
order and keyset cursor rules from the normative documents.

## 3. Publish one immutable descriptor

Expose one frozen descriptor and a frozen nested capability object. `adapter`
and `adapterVersion` identify the implementation; `layoutVersion` identifies
its private schema/index/script layout. Do not expose mutable top-level aliases
for capabilities or protocol version.

```ts
const descriptor = Object.freeze({
  protocolVersion: 1,
  adapter: 'my-backend',
  adapterVersion: '0.1.0',
  layoutVersion: 1,
  capabilities: Object.freeze({
    queueFilteredNotifications: false,
    nativeBatchEnqueue: false,
    nativeBatchClaim: true,
    metadataIndex: 'none',
    transactionalEnqueue: false,
    durableChangeFeed: false,
    globalConcurrency: false,
    rateLimiting: false
  })
})
```

Declare only guarantees the adapter actually provides. Capability flags are
not permission to skip validation or transitions. Wake notifications are an
optimization over persisted versions and must remain safe when unavailable.
Pass the complete capability manifest to `jobStoreContract`, including every
`false` flag, and require the resolved descriptor to match it. A declared-true
`durableChangeFeed`, `globalConcurrency`, or `rateLimiting` capability needs a
separate extension Service/interface and an `extensions` scenario; these flags
do not add optional methods to `JobStore` v1. The suite reports such a true
capability in `capabilitiesNotTested` until its executable scenario is present.

## 4. Make transitions atomic

The following must be one compare-and-set/transaction/script boundary:

- identity/idempotency lookup plus enqueue insertion and indexes;
- due promotion, total ordering, delivery increment, and lease reservation;
- settlement fencing, cancellation precedence, state update, ledger append, and
  indexes/counters;
- fenced release and heartbeat;
- expired-lease recovery and its ledger entry;
- administrative state transitions and queue controls.

If a response can be lost after a settlement commit, retry the same Job ID,
token, and canonical outcome. Return `already-applied` without a second attempt;
return `SettlementConflictError` for a different outcome. Never rerun the
handler to resolve an uncertain ACK.

## 5. Wake, migrations, and errors

Register `awaitWake` before the caller's empty-claim check can be invalidated.
Advance the persisted wake token/version in the same mutation that makes work
visible. Signals may be dropped, duplicated, delayed, or spurious. Payloads
must not include job payloads, metadata, idempotency keys, lease tokens, or
arbitrary causes. Polling must remain correct.

Validate the private layout independently and fail closed on an incompatible or
newer migration. Do not silently downgrade, delete, or rewrite data. A layout
failure is distinct from `JobStoreProtocolMismatchError`, which is the public
v1 descriptor handshake failure before Worker startup.

Map backend failures to bounded `JobStoreFailure` messages with a retryable
classification. Do not expose SQL, URLs, credentials, full Redis keys, ARGV,
payloads, stacks, or raw backend causes in protocol errors.

## 6. Run conformance and release gates

Register the runner-neutral suite with the adapter's runner:

```ts
import { jobStoreContract } from 'better-effect-mq/testing'

const suite = jobStoreContract({
  capabilities: MyJobStore.descriptor.capabilities,
  makeRuntime: (context) => makeRealTestRuntime(context.id),
  setup: (context) => migrate(context.id),
  reset: (context) => clearTestNamespace(context.id)
})
```

The suite reports `version === 1`, `protocolVersion === 1`, the resolved
descriptor, executed/passed/failed IDs, skipped capability scenarios, and
`capabilitiesNotTested`. Use fresh isolated storage per scenario. Add real
backend tests for concurrent enqueue/claim/settle, rollback, reconnect,
owned-vs-borrowed cleanup, lost responses, and layout migration. Use failpoints
around every transaction/script commit and wake registration boundary.

Before publishing, run typecheck and declarations with the project compiler and
the current TypeScript 7.x compiler, the complete `bun:test` suite, build, lint, format check,
publint, package boundaries, and the external tarball consumer. Inspect the
archive and ensure it contains no source, tests, credentials, private client
identifiers, or workspace/file references.
