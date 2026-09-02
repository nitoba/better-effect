import type { JobEvent } from '../observability'
import type { JobObserver } from '../observability/observer'

/** A detached immutable view returned by {@link RecordedJobObserver.snapshot}. */
export type RecordedJobObserverSnapshot = readonly JobEvent[]

const immutableView = <Event>(events: readonly Event[]): readonly Event[] =>
  Object.freeze([...events])

/** Records storage-neutral MQ events for deterministic tests. */
export class RecordedJobObserver implements JobObserver {
  private readonly recordedEvents: JobEvent[] = []

  static make(): RecordedJobObserver {
    return new RecordedJobObserver()
  }

  readonly onEvent = (event: JobEvent): void => {
    // SAFETY: the observer contract is a readonly event snapshot; freezing here also
    // protects direct test calls that did not use an internal event constructor.
    Object.freeze(event)
    this.recordedEvents.push(event)
  }

  get events(): readonly JobEvent[] {
    return immutableView(this.recordedEvents)
  }

  get timeline(): readonly JobEvent[] {
    return this.events
  }

  snapshot(): RecordedJobObserverSnapshot {
    return this.events
  }

  clear(): void {
    this.recordedEvents.length = 0
  }
}
