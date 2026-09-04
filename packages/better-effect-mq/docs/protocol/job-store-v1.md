# JobStore protocol v1

This document defines the storage-neutral `JobStore.Contract` for
`protocolVersion = 1`. A store is a `better-effect` Service and the only
persistence seam used by Jobs and Workers. The core does not know whether the
adapter uses SQL, Redis, or another backend.

## Descriptor and result boundary

Every store exposes one immutable `descriptor`:

```ts
{
  protocolVersion: 1,
  adapter: string,
  adapterVersion: string,
  layoutVersion: number | string,
  capabilities: JobStoreCapabilities
}
```

`capabilities` is also immutable. The Worker validates this descriptor before
starting; see [compatibility](./compatibility-v1.md). Every operation returns a
completed `better-result` `Result` or a `PromiseLike` of one. Adapters must
return focused protocol errors rather than leaking backend exceptions.

## Operations

The contract exposes `enqueue`, `enqueueMany`, `claim`, `settle`, `release`,
`heartbeat`, `recoverStalled`, `awaitWake`, `getJob`, `getAttempts`, `list`,
`counts`, `retry`, `cancel`, `requestCancellation`, `promote`, `remove`,
`pause`, `resume`, and `pausedQueues`.

All time-sensitive DTOs carry a validated, coherent `now`. The adapter must
not substitute a database or server clock for that value during the operation.

### Enqueue

A job identity is `(queue, name, version)`. An enqueue may provide an explicit
ID, an idempotency key, or neither. Explicit IDs have precedence. When the
producer API receives an idempotency key without an explicit ID, it derives the
ID as the lowercase hexadecimal SHA-256 digest prefixed with `idem-v1-` over
this exact UTF-8 string (the fields cannot contain NUL):

```text
better-effect-mq/idempotency/v1\0<queue>\0<name>\0<version>\0<idempotencyKey>
```

This derivation is deterministic across processes and adapters. Raw
`JobStore.enqueue` callers may still supply an idempotency key directly; the
producer API is the boundary that applies the deterministic-ID precedence.
Uniqueness is scoped by store, queue, and identity. A duplicate returns the
existing logical job with `duplicate: true`.
`enqueueMany` preserves input order. Its chunks/units are independently
replayable unless the descriptor explicitly declares `transactionalEnqueue`.

### Claim and lease lifecycle

`claim` atomically promotes due delayed jobs, applies the total claim order,
reserves at most `limit` jobs, increments `deliveryCount`, and persists a
non-empty fencing lease. Only accepted `(queue, name, version)` identities may
be claimed. `settle` requires the exact current lease token and atomically
records one attempt while applying `complete`, `retry`, `fail`, or `cancelled`.

`release` returns active work to `waiting` without consuming handler-attempt
budget. `heartbeat` renews each valid lease and reports each lost lease.
`recoverStalled` acts only on expired leases, increments `stalledCount`, and
requeues or terminalizes according to adapter policy. A pending cancellation is
terminalized as `cancelled`.

A settlement response can be lost after the transition is committed. Retrying
the same Job ID and token with the same canonical outcome returns
`status: 'already-applied'` and does not append another attempt. Reusing that
token with a different outcome returns `SettlementConflictError`. This is
required for safe at-least-once callers.

### Wake and inspection

`awaitWake` waits for a persisted queue wake token/version. Signals are only an
optimization and may be delayed, duplicated, omitted, or spurious. The token
check must close the empty-claim-to-wait race. Aborting the signal returns
`JobStoreWakeAbortedError`; polling remains correct without notifications.

`getJob` and `getAttempts` inspect one Job ID. `list` supports only the fixed
queue/name/version/metadata/state filters, the documented ordering fields and
keyset cursor. `counts` supports queue and name filters and returns every state
bucket. Unsupported shapes return `UnsupportedJobStoreOperationError`; an
adapter must not silently perform an unbounded scan.

### Administration

`retry` applies only to failed or cancelled jobs, reuses the Job ID, and
preserves attempt history. `cancel` handles waiting and delayed jobs;
active cancellation is requested cooperatively with `requestCancellation` and
must later be fenced by the active worker. `promote` makes delayed work due
without claiming it. `remove`, `pause`, `resume`, and `pausedQueues` are
explicit administrative operations.

The complete preconditions, transitions, atomicity, errors, ordering, time,
capabilities, and compatibility rules are normative in the companion documents
in this directory.
