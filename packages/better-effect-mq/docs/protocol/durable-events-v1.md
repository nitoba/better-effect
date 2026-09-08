# Durable Job Events v1

`JobEventStore` is an optional, append-only operational extension of a
`JobStore`. It is a yieldable Service token and is provided through a Layer;
the extension does not change the producer or worker API when it is absent.

`MemoryJobEventStore` is the reference implementation for this contract. To
connect it to `MemoryJobStore`, create one event store and pass that same
instance to `MemoryJobStore.make({ eventStore })`. The JobStore appends in the
same synchronous critical sections that commit enqueue, claim, settlement,
release, recovery, administrative transitions, removal, and queue pause or
resume.

## Versioned transition taxonomy

The public `DurableJobEventType` union is append-only. The original 14 v1 job
types remain unchanged; extension types are namespaced by their owning
contract and are described by `durableJobEventTypeDescriptors` and
`durableJobEventTaxonomies`.

The first extension slice deliberately has one event type per operation in the
existing contracts. It does not add aliases or imply that an adapter has wired
the operation yet:

| Family   | Version | Event types                                                                                                                            | Existing operation                                                                                                      |
| -------- | ------: | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Flow     |       2 | `flow-fan-out`, `flow-child-results-recorded`, `flow-cancelled`, `flow-cascaded`, `flow-outbox-appended`                               | `fanOut`, `recordChildResults`, `cancel`, `markCascaded`, outbox append/ack boundary                                    |
| Schedule |       1 | `schedule-upserted`, `schedule-removed`, `schedule-ticked`, `schedule-paused`, `schedule-resumed`                                      | `upsertSchedule`, `removeSchedule`, `tickSchedule`, `pauseSchedule`, `resumeSchedule`                                   |
| Controls |       3 | `controls-reconciled`, `controls-claimed`, `controls-settled`, `controls-released`, `controls-stalled-recovered`, `controls-cancelled` | `reconcile`, `claimControlled`, `settleControlled`, `releaseControlled`, `recoverStalledControlled`, `cancelControlled` |

The descriptor's protocol version is the version of the owning contract, not
the event-store extension version. A future protocol can add a new explicitly
versioned family or event name; readers must retain their unknown-event
fallback rather than reinterpret an existing name.

## Cursor and pages

`JobEventCursor` is an opaque, monotonically advancing value scoped to one
event store. `read({ after })` is exclusive and returns events in ascending
cursor order. A page's `nextCursor` is the last event examined, not merely the
last event matching a filter. This lets a consumer move past filtered events
without repeatedly scanning them. Filters can therefore change between page
reads without changing the cursor's meaning.

Retention may remove the position requested by a reader. In that case reads
return `JobEventCursorExpiredError` with an `oldestAvailableCursor` from which
the reader can resume. `JobEventStore.awaitEvents` is a wake boundary only: it
does not process events, own checkpoints, or provide a Stream abstraction.

## Safe event shape

Events carry transition identity, state, attempt/delivery summaries, worker
identity when it is available, and bounded string attributes. The reference
Memory integration does not persist payload, result, complete failure data or
message, arbitrary metadata, dispatch/idempotency keys, stack traces, or
causes. A Job or Attempt lookup remains the source of detailed execution data.

Duplicate enqueue acknowledgements, heartbeat renewals, and
`already-applied` settlements do not append a second durable event. The
process-local observer remains independent and best-effort.

Extension events use the same safe event shape and bounded attributes as v1.
They are transition markers and wake hints, not serialized Flow child
payloads, schedule payloads, control metadata, outbox contents, result values,
or failure causes. Detailed data remains available only through the owning
public store operation and its authorization/redaction policy. This contract
slice defines names and validation only; adapter wiring for Flow, Schedule,
and Controls transitions remains a later step.
