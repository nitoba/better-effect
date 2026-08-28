import type {
  RuntimeExecutionEndEvent,
  RuntimeExecutionStartEvent,
  RuntimeObserver,
  RuntimeResourceReleaseEvent,
  RuntimeServiceAcquireEvent,
  RuntimeServiceResolveEvent
} from '../runtime/observer'

/** Every event emitted by a Runtime observer hook. */
export type RuntimeObserverEvent =
  | RuntimeServiceResolveEvent
  | RuntimeServiceAcquireEvent
  | RuntimeExecutionStartEvent
  | RuntimeExecutionEndEvent
  | RuntimeResourceReleaseEvent

/** Immutable views of events recorded by a {@link RecordedRuntimeObserver}. */
export type RecordedRuntimeObserverSnapshot = {
  readonly serviceResolutions: readonly RuntimeServiceResolveEvent[]
  readonly serviceAcquisitions: readonly RuntimeServiceAcquireEvent[]
  readonly executionStarts: readonly RuntimeExecutionStartEvent[]
  readonly executionEnds: readonly RuntimeExecutionEndEvent[]
  readonly resourceReleases: readonly RuntimeResourceReleaseEvent[]
  readonly timeline: readonly RuntimeObserverEvent[]
}

const immutableView = <Event>(events: readonly Event[]): readonly Event[] =>
  Object.freeze([...events])

/** Records Runtime lifecycle events for assertions in tests. */
export class RecordedRuntimeObserver implements RuntimeObserver {
  private readonly serviceResolutionEvents: RuntimeServiceResolveEvent[] = []
  private readonly serviceAcquisitionEvents: RuntimeServiceAcquireEvent[] = []
  private readonly executionStartEvents: RuntimeExecutionStartEvent[] = []
  private readonly executionEndEvents: RuntimeExecutionEndEvent[] = []
  private readonly resourceReleaseEvents: RuntimeResourceReleaseEvent[] = []
  private readonly timelineEvents: RuntimeObserverEvent[] = []

  static make(): RecordedRuntimeObserver {
    return new RecordedRuntimeObserver()
  }

  readonly onServiceResolve = (event: RuntimeServiceResolveEvent): void => {
    this.record(this.serviceResolutionEvents, event)
  }

  readonly onServiceAcquire = (event: RuntimeServiceAcquireEvent): void => {
    this.record(this.serviceAcquisitionEvents, event)
  }

  readonly onExecutionStart = (event: RuntimeExecutionStartEvent): void => {
    this.record(this.executionStartEvents, event)
  }

  readonly onExecutionEnd = (event: RuntimeExecutionEndEvent): void => {
    this.record(this.executionEndEvents, event)
  }

  readonly onResourceRelease = (event: RuntimeResourceReleaseEvent): void => {
    this.record(this.resourceReleaseEvents, event)
  }

  get serviceResolutions(): readonly RuntimeServiceResolveEvent[] {
    return immutableView(this.serviceResolutionEvents)
  }

  get serviceAcquisitions(): readonly RuntimeServiceAcquireEvent[] {
    return immutableView(this.serviceAcquisitionEvents)
  }

  get executionStarts(): readonly RuntimeExecutionStartEvent[] {
    return immutableView(this.executionStartEvents)
  }

  get executionEnds(): readonly RuntimeExecutionEndEvent[] {
    return immutableView(this.executionEndEvents)
  }

  get resourceReleases(): readonly RuntimeResourceReleaseEvent[] {
    return immutableView(this.resourceReleaseEvents)
  }

  get timeline(): readonly RuntimeObserverEvent[] {
    return immutableView(this.timelineEvents)
  }

  clear(): void {
    this.serviceResolutionEvents.length = 0
    this.serviceAcquisitionEvents.length = 0
    this.executionStartEvents.length = 0
    this.executionEndEvents.length = 0
    this.resourceReleaseEvents.length = 0
    this.timelineEvents.length = 0
  }

  snapshot(): RecordedRuntimeObserverSnapshot {
    return Object.freeze({
      serviceResolutions: this.serviceResolutions,
      serviceAcquisitions: this.serviceAcquisitions,
      executionStarts: this.executionStarts,
      executionEnds: this.executionEnds,
      resourceReleases: this.resourceReleases,
      timeline: this.timeline
    })
  }

  private record<Event extends RuntimeObserverEvent>(events: Event[], event: Event): void {
    events.push(event)
    this.timelineEvents.push(event)
  }
}
