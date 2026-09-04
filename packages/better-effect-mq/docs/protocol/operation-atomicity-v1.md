# Operation atomicity v1

Atomicity is defined at the protocol transition boundary, not by a particular
storage engine. Concurrent writers must not observe or create a partial state
transition. A successful response means the listed durable effects are already
committed; an uncertain response must be handled as possibly committed.

## Required operation boundaries

| Operation                                                                        | Preconditions and atomic effects                                                                                                                                    | Success / failure behavior                                                                                                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enqueue`                                                                        | Validate identity/idempotency and insert the record, indexes, counters, and wake version as one unit.                                                               | A duplicate returns the existing job with `duplicate: true`; collisions or unsafe counters return a bounded `JobStoreFailure`.                                            |
| `enqueueMany`                                                                    | Each bounded unit validates, deduplicates, inserts, indexes, counters, and wakes atomically.                                                                        | Results retain input order. A complete call is all-or-nothing only when `transactionalEnqueue` is declared; otherwise a later failure may follow committed earlier units. |
| `claim`                                                                          | Due promotion, deterministic candidate selection, delivery increment, lease reservation, indexes, counters, and returned wake token share one reservation boundary. | No job is returned active unless its current lease is durable. Concurrent claims cannot reserve one job twice.                                                            |
| `settle`                                                                         | Exact-token fencing, cancellation precedence, state transition, attempt-ledger append, lease removal, indexes, counters, and wake version commit together.          | The first response is `applied`. A same-token/equivalent replay is `already-applied`; a different outcome is `SettlementConflictError`.                                   |
| `release`                                                                        | Exact-token fencing, active-to-waiting (or cancellation) transition, lease removal, indexes, counters, and ledger entry commit together.                            | Release does not consume handler-attempt budget. A stale token changes nothing.                                                                                           |
| `heartbeat`                                                                      | Check every supplied lease against the same `now`; renew valid leases and report lost leases independently.                                                         | The result reports all `renewed`, `lost`, and cancellation-requested entries; one bad lease must not hide the others.                                                     |
| `recoverStalled`                                                                 | Lock/check expiry, increment `stalledCount`, apply configured requeue/terminal policy, append the ledger entry, and update indexes/counters together.               | A still-valid lease is never recovered. Recovery is bounded and never loops on a collision.                                                                               |
| `awaitWake`                                                                      | Register a waiter against the persisted token/version before waiting; mutations advance that token in the same commit that makes work visible.                      | Signals may be omitted or spurious. The token check is authoritative; abort returns `JobStoreWakeAbortedError`.                                                           |
| `getJob`, `getAttempts`, `list`, `counts`, `pausedQueues`                        | Read a coherent committed view and enforce the fixed portable filter/order shapes.                                                                                  | They never mutate state or silently replace an unsupported query with an unbounded scan.                                                                                  |
| `retry`, `cancel`, `requestCancellation`, `promote`, `remove`, `pause`, `resume` | Validate identity/state and commit the transition, indexes, counters, and wake version as one unit.                                                                 | Invalid state or stale expectations return a focused error and leave the record unchanged.                                                                                |

A driver may use a database transaction, a Lua script, compare-and-set, or an
equivalent mechanism. The protocol does not require one storage primitive; it
requires the observable boundary.

## Lost responses and replay

A caller must assume that a network failure after submission may have followed a
commit. For settlement, retry with the same Job ID, lease token, and canonical
outcome. Do not invoke the handler again merely because the response was lost.
The persisted record and attempt ledger are authoritative. Same-token replay
must not append another attempt, and a digest mismatch must not be accepted as
a duplicate.

For `enqueueMany` without `transactionalEnqueue`, retry each deterministic item
or idempotency-keyed unit independently. Do not claim that a whole oversized
batch is atomic when the adapter processes bounded chunks.

## Delivery and external effects

The protocol provides at-least-once delivery, not exactly-once external side
effects. A handler can perform an external effect and fail before settlement is
committed. Applications must make those effects idempotent, normally using the
Job ID or an application idempotency key.

`awaitWake` notifications are advisory. They must never be the only durable
record of visibility and must not contain payloads, metadata, idempotency keys,
lease tokens, or arbitrary causes. Polling and a fresh claim remain the
correctness path.
