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
