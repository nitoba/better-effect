# better-effect-mq

**Experimental durable message-queue protocol foundations for `better-effect`.**

`better-effect-mq` defines the storage-neutral protocol used by future queue,
store, and worker packages. Version 0.1 exposes the protocol model and a small
portable Codec boundary: JSON-safe records, nominal identities, deterministic
claim ordering, persisted failure envelopes, pure state transitions, explicit
JSON/Standard Schema conversion, and the storage-neutral `JobStore` Service
contract. It does not open connections, start workers, or provide an adapter.

The package uses [`better-effect`](https://github.com/nitoba/better-effect)'s
Service type and [`better-result`](https://github.com/nitoba/better-result)'s
Result model; it does not depend on the full Effect library.

## Protocol version and delivery guarantee

```ts
import { protocolVersion } from 'better-effect-mq'

protocolVersion // 1
```

`protocolVersion` is the experimental durable wire/state contract and is `1` in
v0.1. `better-effect-mq` offers **at-least-once delivery**: a job confirmed under
the current lease is not delivered again by the normal protocol; a job whose
settlement was not persisted may be delivered again.

A handler can perform an external side effect and crash before its settlement
(or ACK) is persisted. That side-effect-before-ACK window is expected, not a
transactional guarantee. Handlers must make external effects idempotent, usually
with the job ID or an application idempotency key. A lease token prevents an
old worker from settling a newer delivery, but it cannot undo an already
executed external effect.

## Storage-neutral records

`JobRecord`, `AttemptRecord`, `PersistedBackoff`, and `SerializedJobFailure`
contain only strings, numbers, enums, and `JsonValue`. Brands are
declaration-only; their persisted representation is still a string. No live
`Error`, `Result`, `Service`, driver, connection, request, headers, cause, or
stack is part of a persisted DTO.

```ts
import { JobId, QueueName, WorkerId } from 'better-effect-mq'

const id = JobId.make('email-123')
const queue = QueueName.make('emails')
const worker = WorkerId.make('worker-a')
```

Identity constructors return a `better-result` `Result` and reject non-string or
empty values. `JobId` additionally requires well-formed Unicode scalar text:
unpaired UTF-16 surrogates are rejected rather than replaced. Accepted identity
strings are preserved exactly: they are not trimmed, case-folded, normalized, or
otherwise canonicalized. `metadata` is stricter than a general JSON value: it
must be a non-null plain object whose own enumerable string keys all map to
strings. Primitive values, arrays, null, symbols, inherited fields, and unsafe
accessors are rejected.

`SerializedJobFailure` has a deliberately small whitelist:

- `kind`: `typed`, `defect`, `timeout`, `decode`, `stalled`, or `cancelled`;
- optional safe `code`;
- redacted safe `message`;
- optional JSON-safe `data` selected by the application;
- `retryable`;
- integer epoch-millisecond `recordedAt`.

The protocol never calls `TaggedError.toJSON()` to create this envelope and has
no generic `fromError` copier. `JobCodecFailure` remains exported for
protocol compatibility. Portable codec operations use the more specific
`JobEncodeFailure` and `JobDecodeFailure`
errors; all three errors are tagged and can be identified by their `_tag` even
when values came from a duplicated package copy.

All public DTO validators accept untrusted persistence values, reject unknown
own top-level fields, and return a canonical copy. JSON payloads, metadata, and
failure data are recursively copied and frozen; functions, live errors, symbols,
accessor failures, and other non-JSON values are rejected as
`JobDefinitionError` without mutating the input.

## Portable codecs and trust boundaries

`Codec` is deliberately storage-neutral and requirement-free in v0.1: its
encode/decode callbacks cannot yield a `Service`. Custom callbacks return a
completed `Result` or requirement-free better-effect `Effect`, optionally
wrapped in a `PromiseLike`; raw values are not part of the callback contract.
Keep contextual I/O outside the codec and pass a completed result to
`Codec.make`.

```ts
import { Codec } from 'better-effect-mq'

const payload = Codec.json<{
  readonly recipient: string
  readonly attempts: number
}>()

const encoded = payload.encode({ recipient: 'ada@example.test', attempts: 1 })
const decoded = payload.decode({ recipient: 'ada@example.test', attempts: 1 })
```

The primitive representations are identity strings, finite numbers, booleans,
`null`, and `undefined` only after decoding `Codec.void` from persisted `null`.
`Codec.json()` validates an object/array graph iteratively, rejects accessors,
cycles, class instances, `Date`, `Map`, `Set`, `Error`, non-finite numbers, and
other non-JSON values, and accepts at most 1,024 structural levels. It reads
only own data descriptors, then returns a detached, deeply frozen JSON-safe
clone; it never returns an untrusted input object or proxy. There is no
payload-size limit in this first API; put large payloads in external storage
and persist a reference instead.

Standard Schema is structural and has no validator dependency. A transformed
schema whose output is not JSON-safe must provide an explicit encoder; no
`Date` or class serialization is inferred:

```ts
import { Result } from 'better-result'

const dateCodec = Codec.standardSchema({
  schema: DateFromIsoSchema,
  encode: (date) => Result.ok(date.toISOString())
})
```

Codec failures contain only bounded safe diagnostics, sanitized JSON-safe
paths/codes, and no payload, stack, arbitrary cause, or validator message that
could echo a secret. Codec identity belongs to a Job’s `name + version`; change
a codec without a version change only for a documented backward-compatible
wire change. Upcasters, registries, and persisted job definitions are outside
this issue’s scope.

## Queue and versioned Job definitions

The primary definition API is `Queue.define(...).job(...)`. It creates an inert,
immutable descriptor; it does not create a worker, resolve a Service, open a
connection, or register anything globally. The persisted identity is exactly the
literal queue, job name, and positive integer version. Function and class names
never participate in identity.

At definition time, a codec's `encode` and `decode` methods are captured with a
new frozen receiver. For a user-supplied structural or class codec, the Job
boundary clones and freezes the supported string-keyed own/prototype data graph,
including ordinary prototype helpers, without retaining the source receiver or
prototype graph. Receiver state must use finite primitives, `null`, `undefined`,
or recursively plain records and arrays; callable state other than
`encode`/`decode`, accessors, symbols, proxies, class instances, cycles, and
oversized or unreadable graphs are rejected as `JobDefinitionError`.

Codec operations themselves remain direct functions. Their lexical closures and
default-parameter expressions therefore keep normal JavaScript behavior. Job
does not clone external closure state; callers must treat captured state as
callback behavior, not descriptor data. A later mutation of captured application
state may consequently affect codec results, while mutation of the source
receiver's supported fields or prototype helpers cannot. Methods containing
`super`, private names/brands, direct `eval(...)`, or `new.target`, methods with
non-intrinsic mutable properties, and methods whose source cannot be inspected are rejected
because their receiver semantics cannot be safely detached. This is a narrow
receiver-safety check, not a free-variable or closure restriction.

The package's `Codec.*` constructors provide an operation-level contract without
a user receiver and use a private process-local capability. Values from another
package copy and all structural codecs still take the receiver-validation route;
a forgeable global marker cannot bypass it. Use a portable `Codec.*` codec or a
structurally safe class when receiver state is needed.

```ts
import { Codec, Job, JobRegistry, Queue, makePersistedBackoff } from 'better-effect-mq'

const Emails = Queue.define('emails')
const payload = Codec.json<{
  readonly messageId: string
  readonly tenantId: string
  readonly recipient: string
}>()
const failure = Codec.json<{ readonly code: string }>()
const backoff = makePersistedBackoff({
  type: 'exponential',
  delayMs: 1_000,
  maxDelayMs: 60_000
}).unwrap()

const SendEmailV1 = Emails.job('send-email', {
  version: 1,
  payload,
  failure,
  defaults: { attempts: 5, backoff, timeoutMs: 30_000, priority: 0 },
  idempotencyKey: ({ messageId }) => messageId,
  metadata: ({ tenantId }) => ({ tenantId }),
  retryable: ({ code }) => code !== 'recipient-blocked'
})
const SendEmailV2 = Job.define('send-email', {
  queue: Emails,
  version: 2,
  payload,
  failure
})

const Jobs = JobRegistry.make([SendEmailV1, SendEmailV2] as const)
Jobs.acceptedClaimIdentities // both versions, in definition order
Jobs.lookup({ queue: 'emails', name: 'send-email', version: 1 }) // Result<..., JobDefinitionError>
```

`retryable` is a synchronous definition-layer predicate. When a worker-side
caller evaluates it through `runRetryable`, a thrown predicate is deliberately
fail-open and becomes `true` (retryable) without retaining the thrown error or
failure payload. An untyped rejected Promise is also observed and normalized to
`true`; Promise results are not awaited. Non-boolean, non-Promise results remain
invalid predicate results.

`Job.define` is optional direct-call sugar over the same `Queue.job` implementation;
`Queue.define(...).job(...)` is the documented ergonomic form. `Job.PayloadInput`
is `Codec.Input` (the schema/input side), while `Job.Payload` is `Codec.Value`
(the decoded handler value). Idempotency and metadata callbacks receive
`Job.Payload`, and are not called while defining a job. Their later producer-side
outputs can be safely normalized with `normalizeIdempotencyKey` and
`normalizeMetadata`; invalid or throwing callbacks become a redacted
`JobDefinitionError` rather than exposing payload details.

`defaults.attempts` is a positive safe integer, `defaults.timeoutMs` is an
optional positive finite safe-integer millisecond duration, `priority` defaults
to the safe integer `0`, and `backoff` uses the existing `PersistedBackoff`
shape. Retention fields such as `keep` and `retain` are intentionally not part of
this v0.1 descriptor. Result and failure codecs are optional; when absent,
the corresponding `Job.Success` or `Job.Failure` type is `never`, and this
package performs no result persistence or worker execution.

`Job.is` and `Queue.is` use stable `Symbol.for` TypeIds and bounded, accessor-free
checks, so descriptors from duplicate package copies can be recognized safely.
The registry is local and immutable: duplicate queue/name/version identities are
rejected, unknown lookups return an explicit error Result, and no handlers are
registered. Enqueue, storage, retry scheduling, and worker execution are separate features.

## JobStore Service contract

`JobStore` is the only storage seam in this package. It is a yieldable
`better-effect` Service, not a CRUD repository, query builder, SQL abstraction,
or worker. An adapter supplies a structural `JobStore.Contract` through a Layer;
the core never imports a driver or inspects a backend kind.

```ts
import { Effect, Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { Codec, JobStore, Queue } from 'better-effect-mq'

const DurableStore = JobStore.named('durable')
const Emails = Queue.define('emails')
const SendEmail = Emails.job('send', {
  version: 1,
  payload: Codec.json<{ readonly to: string }>(),
  store: DurableStore
})

const layer = Layer.succeed(DurableStore, DurableStore.of(adapterContract))
const program = () =>
  Effect.gen(async function* () {
    const store = yield* DurableStore
    return Result.ok(store.capabilities)
  })

await Runtime.run(layer, program)
```

The default token is `JobStore` (tag `@better-effect/mq/JobStore`). Named tokens
are lightweight handles identified by their complete literal tag,
`@better-effect/mq/JobStore/<name>`. Repeated calls for one name have compatible
types and tags but are not referentially cached; keep a token value when
referential equality matters. This avoids a process-global name registry and
allows multiple stores to be provided in one Runtime without resolving the
wrong store. A Job defaults to `JobStore`; pass `store` in its definition or
use `bindJob(job, DurableStore)` / `Job.bind` to select a named token. The
binding is immutable and does not register the Job or create a provider.

Every operation returns a `JobStoreOperation<Success, Failure>`: a completed
`better-effect` Result facade or a `PromiseLike` of one. Adapters may therefore
perform asynchronous I/O without changing the consumer boundary; await the
operation and feed it to `Result.await` inside an Effect generator. Each method
uses its own focused failure union, while `JobStoreError` remains the aggregate
compatibility alias.

A store implements these atomic operations:

- `enqueue` and `enqueueMany`: explicit or idempotency-derived uniqueness is a
  no-op reported as `{ duplicate: true }`; due jobs are waiting and future jobs
  are delayed. Batch results retain input order. Batch units are independently
  replayable rather than an all-or-nothing application transaction.
- `claim`: atomically promotes due delayed jobs, orders candidates, reserves at
  most `limit`, creates exclusive fencing leases, increments delivery counts,
  and returns active snapshots. `ClaimRequestFor<Registry>` narrows accepted
  versions to a local immutable `JobRegistry`.
- `settle`: validates the lease, records one attempt, clears the lease, and
  applies `complete`, `retry`, `fail`, or `cancelled` as one transition.
- `release`, `heartbeat`, and `recoverStalled`: release returns a job to
  waiting without consuming an attempt; heartbeat reports every lost lease and
  cancellation request; stalled recovery never takes a still-valid lease and
  persists requeue/fail plus its ledger entry atomically.
- `awaitWake`: waits for a version/token change for the selected queues. It may
  resolve spuriously, but the token prevents a wake between an empty claim and
  waiting from being lost. Aborting the signal returns
  `JobStoreWakeAbortedError`; polling-only stores may wait until abort because a
  worker also uses a timeout.
- `getJob`, `getAttempts`, `list`, and `counts` provide inspection. `list` uses
  the stable `(createdAt, orderingSequence, id)` keyset cursor.
- `redrive`, `cancel`, `requestCancellation`, `promote`, `remove`, `pause`,
  `resume`, and `pausedQueues` provide the small administrative surface.
  Unsupported filter combinations return `UnsupportedJobStoreOperationError`;
  they never silently trigger a full scan.

The portable inspection support matrix is intentionally fixed:

| Operation               | Supported filters/order                                                                               | Cursor                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------- |
| `getJob`, `getAttempts` | one `jobId`                                                                                           | none                   |
| `list`                  | optional `queue`, `name`, and one state or state list; ordered by `(createdAt, orderingSequence, id)` | optional keyset cursor |
| `counts`                | optional `queue` and `name`; returns every state bucket                                               | none                   |
| `pausedQueues`          | no filter                                                                                             | none                   |

There is no arbitrary predicate, offset pagination, provider-specific sort, or
implicit full scan in this contract. An adapter that cannot implement one of
the listed shapes returns `UnsupportedJobStoreOperationError` explicitly.

An enqueue may supply an explicit `jobId`, an `idempotencyKey`, or neither;
the store then derives a deterministic key or generates an ID according to its
adapter policy. Uniqueness is scoped by store, queue, and Job identity
(name/version), and a key collision is an observable duplicate rather than a
second job. ID/token collisions must be bounded and reported as
`JobStoreFailure`, never handled by an unbounded retry loop.

Every operation receives an explicit `now` where time affects state. A
`JobStoreFailure` describes infrastructure failure and state-specific tagged
errors describe invalid transitions or lost fencing leases. Store capabilities
(`notifications`, `batchClaim`, `transactionalEnqueue`, and `changeFeed`) are
immutable performance hints: false never changes correctness or makes a basic
operation unavailable. Wake semantics remain on `JobStore` rather than a
separate notifier so token/version consistency cannot be split across Services.

No adapter, backend, producer, worker, retry scheduler, or generic persistence
API is included here.

## Runner-agnostic JobStore conformance

The `better-effect-mq/testing` entrypoint publishes stable JobStore scenarios,
without importing Bun, Vitest, Jest, or any other test runner. The adapter owns
the runtime and storage setup:

```ts
import { Runtime } from 'better-effect'
import { jobStoreContract } from 'better-effect-mq/testing'

const scenarios = jobStoreContract({
  makeRuntime: async (context) => {
    const runtime = await Runtime.make(
      MyStore.layer({
        database: databaseFor(context.id)
      })
    )

    return {
      run: (program) => runtime.run(program),
      dispose: () => runtime.dispose()
    }
  },
  setup: async (context) => createSchema(context.id),
  reset: async (context) => resetDatabase(context.id),
  capabilities: { notifications: true, batchClaim: true }
})
```

Register the same scenarios with any runner. For Bun:

```ts
import { test } from 'bun:test'

for (const scenario of scenarios) {
  test(scenario.name, scenario.run)
}
```

For Vitest:

```ts
import { describe, it } from 'vitest'

describe('MyStore JobStore contract', () => {
  for (const scenario of scenarios) {
    it(scenario.name, scenario.run)
  }
})
```

Each scenario gets fresh controls, runs `setup`, then creates its runtime, and
always disposes every runtime opened by the scenario (including extension
clients) before `reset`.
Cleanup is attempted after assertion failures, and the primary scenario error
is preserved when cleanup also fails. `makeRuntime` is the only adapter-specific
hook; the kit uses the public `JobStore.Contract` surface and never accesses
tables, keys, drivers, or private adapter methods.

Built-in scenarios cover enqueue identity and independent batch replay,
ordering and atomic claims, leases/fencing/stalls, settlement ledgers,
administration, keyset listing, controlled time, and wake-up abort/token
semantics. `capabilities` is immutable metadata: false never skips a basic
correctness scenario. Optional notification and batch-claim scenarios are
returned only when their capability is declared; unsupported scenarios appear
in `suite.report().skipped`. The report also includes `executed`, `passed`,
`failed`, and `capabilitiesNotTested` so CI can make capability coverage
explicit.

The context exposes a deterministic `clock`, `ids`, `barrier`, and checkpoint
hooks for distributed or crash extensions. Supply a controls factory when each
scenario needs separate state. Extensions can call `openClient()` to obtain a
second runtime over the same adapter storage; the kit does not provision
Testcontainers or require real sleeps. Unsupported list shapes must return
`UnsupportedJobStoreOperationError` according to the fixed support matrix above.

## State machine

The only v0.1 states are `waiting`, `delayed`, `active`, `completed`, `failed`,
and `cancelled`.

```text
                         claim (when due)
                 +------------------------------+
                 |                              v
             +---------+     claim          +--------+
             | delayed | -----------------> | active |
             +---------+                    +--------+
                 ^                           |  |  |  |
                 | retry (future)             |  |  |  +-- fenced Cancelled --> cancelled
                 |                           |  |  +----- fenced Fail -------> failed
             +---------+ <------------------+  +--------+
             | waiting |  retry (due) / release   |
             +---------+                          +-- fenced Complete --> completed
                 |  ^                              |
                 |  | admin cancel                 +-- expired recoverStalled --> waiting (or terminal failed/cancelled at counter edge)
                 +-> cancelled

             failed/cancelled -- explicit admin redrive --> waiting or delayed
```

A claim promotes a due delayed job directly to `active`; there is no public
`delayed -> waiting` mutation in the claim path. Legal transition preconditions
are:

- `waiting` is claimable when its `runAt` is due; `delayed` is claimable only
  when `runAt <= now`.
- Claim supplies a new non-empty lease token, worker ID, and an expiry strictly
  later than `now`.
- `promote` is a separate explicit administrative schedule override for a
  `delayed` job. It is allowed even when the original `runAt` is in the future,
  sets `runAt` to `now`, and moves the job to `waiting` without claiming it or
  changing its attempt/delivery counters. It emits no attempt ledger entry;
  ordinary claim still requires the delayed job's `runAt` to be due.
- Every transition leaving `active` (`complete`, `retry`, `fail`, `cancelled`,
  and `release`) requires the exact current lease token and `now < leaseExpiresAt`.
  Missing, old, or expired tokens return `LeaseLostError` and leave the snapshot
  unchanged.
- `recover-stalled` is the administrative, unfenced path for an active lease
  whose expiry is reached. While `stalledCount` is below its non-negative safe
  integer maximum, it increments the counter, records a `stalled` ledger entry,
  and returns the job to `waiting` without consuming an attempt. At the maximum,
  recovery is still atomic: a pending cancellation terminalizes as `cancelled`
  while preserving the saturated count; otherwise the job terminalizes as
  `failed` with a non-retryable `stalled` failure and one `stalled` ledger entry.
  `failed` is the resulting `JobRecord.state`, while `stalled` is the ledger
  outcome: no handler returned `failed`, and `attemptsMade` is unchanged. It
  never wraps the counter or leaves a saturated active job waiting forever.
- Cancelling an active job first records a cancellation request while retaining
  its lease. It does not steal the lease. The next active exit is deterministically
  terminal: a `settle` (including complete, retry, fail, or cancelled) becomes
  `cancelled`, and release or stalled recovery becomes `cancelled` instead of
  requeueing the job. A worker must use the current token for a handler
  settlement. A requested cancellation observed by stalled recovery increments
  `stalledCount` while possible and preserves a saturated count at the numeric
  maximum; the cancellation ledger entry does not consume an attempt because no
  handler settled. Waiting and delayed jobs can be cancelled
  by an administrative cancel command.
- `completed`, `failed`, and `cancelled` are terminal. They never silently
  revive. `redrive` is the explicit administrative transition for a failed or
  cancelled job; it preserves delivery and attempt history in the external
  attempt ledger. If the retry budget was exhausted, redrive starts a fresh
  budget; otherwise it preserves the current attempt counter.
- Future states such as `waiting-children` require a protocol revision.

The reducer is pure and immutable. `reduceJob` returns the new record and, when
appropriate, the `AttemptRecord` that an adapter should persist atomically with
it. Storage adapters own the transaction; this package does not implement one.

## Attempts, deliveries, and stalls

These counters are intentionally different, and all use safe integer
representations:

- Every `JobRecord` satisfies `attemptsMade <= deliveryCount`. An `active`
  record additionally requires `deliveryCount >= 1` and
  `attemptsMade < deliveryCount`, representing a claim that has not settled.
- `attemptsMax` is a positive safe integer. `attemptsMade` counts handler
  executions that settle as `completed`, `retried`, `failed`, or `cancelled`,
  and is compared with `attemptsMax`. `waiting`, `delayed`, and `active` records
  must have `attemptsMade < attemptsMax`, reserving one safe execution-counter
  slot before a job can be claimed. A handler `cancelled` settlement increments
  `attemptsMade` exactly once, including when that slot reaches `attemptsMax`;
  it never overflows or creates an `attemptsMax + 1` record. Release during
  shutdown and stalled recovery do not consume this retry budget. A record at
  the budget edge must be terminal or explicitly redriven before it can run
  again.
- `deliveryCount` counts every successful claim/reservation, including
  redelivery after a release or stalled recovery. A claim at its safe-integer
  maximum is rejected rather than wrapping.
- `stalledCount` counts recoveries of expired active leases, including a recovery
  that terminalizes a pending cancellation. It increments while possible and
  saturates at its safe-integer maximum; the saturated recovery behavior is
  defined above.

`AttemptRecord.attempt` and `.delivery` preserve those meanings, and every
ledger entry satisfies `attempt <= delivery`. `released` and `stalled` entries
remain visible even when no handler returned an outcome; a
cancellation terminalized by release or stalled recovery uses the current
attempt number and records a `cancelled` entry. In particular, saturated stalled
recovery pairs a terminal `failed` JobRecord with a `stalled` ledger outcome; the
state and ledger outcome are distinct and adapters must not treat that event as a
handler failure or consume an attempt.

## Ordering and time

Adapters must use the same total claim order:

1. higher `priority` first;
2. lower `runAt` first;
3. lower persisted `orderingSequence` first (stable insertion order);
4. compare the JobId UTF-8 byte sequences lexicographically as unsigned bytes:
   at the first differing byte, the lower byte sorts first; when one sequence is
   a prefix of the other, the shorter sequence sorts first. JobId validation
   rejects unpaired UTF-16 surrogates, so accepted IDs encode each Unicode scalar
   exactly with standard UTF-8; no replacement or canonicalization is performed.
   This is bytewise UTF-8 order, not JavaScript UTF-16 order or locale collation,
   and every adapter must reproduce it exactly.

All protocol timestamps and durations are validated before reaching a store.
Timestamps are non-negative safe integer epoch milliseconds. Durations are
non-negative safe integer milliseconds; lease expiry is separately required to
be strictly in the future. Protocol calculations receive one coherent `now`
from the configured clock. This package never calls `Date.now()` and adapters
must not silently mix application, SQL, Redis, or test clocks in one operation.

## Version policy

`protocolVersion = 1` is experimental but explicit. A breaking change to state
semantics, persisted field meaning, transition preconditions, ordering, or safe
failure representation requires a new protocol version, a changelog entry in
this package, and coordinated adapter updates. Backward-compatible additions
may be made within a version when existing records and adapters retain their
meaning. Future codecs and job definitions may carry their own `name + version`
identity, but they must not change this protocol silently.

## Installation

```bash
bun add better-effect-mq better-effect better-result
```

TypeScript `5.7` or newer is supported, together with the Node.js and Bun
runtime matrix used by this repository.

### Repository validation

Run `bun run check` from the repository root for the canonical package check.
Turbo builds the workspace `better-effect` dependency before this package
checks its public declarations, so the command is safe from a clean checkout.
A package-local `bun run check` does not orchestrate sibling workspace builds;
when running it directly, build the dependency first:

```bash
(cd ../better-effect && bun run build)
bun run check
```

## License

MIT
