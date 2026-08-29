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
empty values. They preserve the supplied string exactly: they do not trim,
case-fold, normalize, or otherwise canonicalize a persistent identity.

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
                 |  | admin cancel                 +-- expired recoverStalled --> waiting
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
- Every transition leaving `active` (`complete`, `retry`, `fail`, `cancelled`,
  and `release`) requires the exact current lease token and `now < leaseExpiresAt`.
  Missing, old, or expired tokens return `LeaseLostError` and leave the snapshot
  unchanged.
- `recover-stalled` is the administrative, unfenced path for an active lease
  whose expiry is reached. It increments `stalledCount`, records a `stalled`
  ledger entry, and returns the job to `waiting` without consuming an attempt.
  There is no stalled-recovery budget in this protocol; every expired active
  job can be recovered.
- Cancelling an active job first records a cancellation request while retaining
  its lease. It does not steal the lease. The next active exit is deterministically
  terminal: a `settle` (including complete, retry, fail, or cancelled) becomes
  `cancelled`, and release or stalled recovery becomes `cancelled` instead of
  requeueing the job. A worker must use the current token for a handler
  settlement. A requested cancellation observed by stalled recovery still
  increments `stalledCount`; the cancellation ledger entry does not consume an
  attempt because no handler settled. Waiting and delayed jobs can be cancelled
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

These counters are intentionally different:

- `attemptsMade` counts handler executions that settle as `completed`, `retried`,
  `failed`, or `cancelled`, and is compared with `attemptsMax`. A handler
  `Cancelled` settlement increments it exactly once and its ledger entry uses
  that new attempt number. Release during shutdown and stalled recovery do not
  consume this retry budget. If a cancellation settlement is the first event
  after the configured budget edge, the terminal cancellation is still
  recorded and may make `attemptsMade` one greater than `attemptsMax`; it is not
  retryable and cannot requeue.
- `deliveryCount` counts every successful claim/reservation, including
  redelivery after a release or stalled recovery.
- `stalledCount` counts recoveries of expired active leases, including a recovery
  that terminalizes a pending cancellation.

`AttemptRecord.attempt` and `.delivery` preserve those meanings. `released` and
`stalled` entries remain visible even when no handler returned an outcome; a
cancellation terminalized by release or stalled recovery uses the current
attempt number and records a `cancelled` entry.

## Ordering and time

Adapters must use the same total claim order:

1. higher `priority` first;
2. lower `runAt` first;
3. lower persisted `orderingSequence` first (stable insertion order);
4. compare the JobId UTF-8 byte sequences lexicographically as unsigned bytes:
   at the first differing byte, the lower byte sorts first; when one sequence is
   a prefix of the other, the shorter sequence sorts first. Encode JavaScript
   strings with standard UTF-8 replacement of each unpaired UTF-16 surrogate by
   U+FFFD. This is bytewise UTF-8 order, not JavaScript UTF-16 order or locale
   collation, and every adapter must reproduce it exactly.

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
