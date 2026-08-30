# better-effect-mq

**Experimental durable message-queue protocol foundations for `better-effect`.**

`better-effect-mq` defines the storage-neutral protocol used by future queue,
codec, store, and worker packages. Version 0.1 intentionally exposes only the
protocol model: JSON-safe records, nominal identities, deterministic claim
ordering, persisted failure envelopes, and pure state transitions. It does not
open connections, start workers, implement codecs, or provide a `JobStore`.

The package is built on [`better-result`](https://github.com/nitoba/better-result)
and is not an Effect dependency.

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
no generic `fromError` copier. `JobCodecFailure` is the single tagged runtime
error placeholder exposed by this package; the detailed encode/decode issue
surface belongs to the later Codec API and is not exported here. This package
does not implement a codec.

All public DTO validators accept untrusted persistence values, reject unknown
own top-level fields, and return a canonical copy. JSON payloads, metadata, and
failure data are recursively copied and frozen; functions, live errors, symbols,
accessor failures, and other non-JSON values are rejected as
`JobDefinitionError` without mutating the input.

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

## License

MIT
