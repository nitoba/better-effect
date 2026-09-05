import type {
  RuntimeExecutionEndEvent,
  RuntimeExecutionStartEvent,
  RuntimeLifecycleEndEvent,
  RuntimeLifecycleReleaseEvent,
  RuntimeLifecycleStartEvent,
  RuntimeObserver,
  RuntimeResourceReleaseEvent,
  RuntimeServiceAcquireEvent,
  RuntimeServiceResolveEvent,
  RuntimeTaskEndEvent,
  RuntimeTaskStartEvent
} from '../runtime/observer'

/** Every event emitted by a Runtime observer hook. */
export type RuntimeObserverEvent =
  | RuntimeServiceResolveEvent
  | RuntimeServiceAcquireEvent
  | RuntimeExecutionStartEvent
  | RuntimeExecutionEndEvent
  | RuntimeTaskStartEvent
  | RuntimeTaskEndEvent
  | RuntimeResourceReleaseEvent
  | RuntimeLifecycleStartEvent
  | RuntimeLifecycleEndEvent
  | RuntimeLifecycleReleaseEvent

/** Immutable views of events recorded by a {@link RecordedRuntimeObserver}. */
export type RecordedRuntimeObserverSnapshot = {
  readonly serviceResolutions: readonly RuntimeServiceResolveEvent[]
  readonly serviceAcquisitions: readonly RuntimeServiceAcquireEvent[]
  readonly executionStarts: readonly RuntimeExecutionStartEvent[]
  readonly executionEnds: readonly RuntimeExecutionEndEvent[]
  readonly taskStarts: readonly RuntimeTaskStartEvent[]
  readonly taskEnds: readonly RuntimeTaskEndEvent[]
  readonly resourceReleases: readonly RuntimeResourceReleaseEvent[]
  readonly lifecycleStarts: readonly RuntimeLifecycleStartEvent[]
  readonly lifecycleEnds: readonly RuntimeLifecycleEndEvent[]
  readonly lifecycleReleases: readonly RuntimeLifecycleReleaseEvent[]
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
  private readonly taskStartEvents: RuntimeTaskStartEvent[] = []
  private readonly taskEndEvents: RuntimeTaskEndEvent[] = []
  private readonly resourceReleaseEvents: RuntimeResourceReleaseEvent[] = []
  private readonly lifecycleStartEvents: RuntimeLifecycleStartEvent[] = []
  private readonly lifecycleEndEvents: RuntimeLifecycleEndEvent[] = []
  private readonly lifecycleReleaseEvents: RuntimeLifecycleReleaseEvent[] = []
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

  readonly onTaskStart = (event: RuntimeTaskStartEvent): void => {
    this.record(this.taskStartEvents, event)
  }

  readonly onTaskEnd = (event: RuntimeTaskEndEvent): void => {
    this.record(this.taskEndEvents, event)
  }

  readonly onResourceRelease = (event: RuntimeResourceReleaseEvent): void => {
    this.record(this.resourceReleaseEvents, event)
  }

  readonly onLifecycleStart = (event: RuntimeLifecycleStartEvent): void => {
    this.record(this.lifecycleStartEvents, event)
  }

  readonly onLifecycleEnd = (event: RuntimeLifecycleEndEvent): void => {
    this.record(this.lifecycleEndEvents, event)
  }

  readonly onLifecycleRelease = (event: RuntimeLifecycleReleaseEvent): void => {
    this.record(this.lifecycleReleaseEvents, event)
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

  get taskStarts(): readonly RuntimeTaskStartEvent[] {
    return immutableView(this.taskStartEvents)
  }

  get taskEnds(): readonly RuntimeTaskEndEvent[] {
    return immutableView(this.taskEndEvents)
  }

  get resourceReleases(): readonly RuntimeResourceReleaseEvent[] {
    return immutableView(this.resourceReleaseEvents)
  }

  get lifecycleStarts(): readonly RuntimeLifecycleStartEvent[] {
    return immutableView(this.lifecycleStartEvents)
  }

  get lifecycleEnds(): readonly RuntimeLifecycleEndEvent[] {
    return immutableView(this.lifecycleEndEvents)
  }

  get lifecycleReleases(): readonly RuntimeLifecycleReleaseEvent[] {
    return immutableView(this.lifecycleReleaseEvents)
  }

  get timeline(): readonly RuntimeObserverEvent[] {
    return immutableView(this.timelineEvents)
  }

  clear(): void {
    this.serviceResolutionEvents.length = 0
    this.serviceAcquisitionEvents.length = 0
    this.executionStartEvents.length = 0
    this.executionEndEvents.length = 0
    this.taskStartEvents.length = 0
    this.taskEndEvents.length = 0
    this.resourceReleaseEvents.length = 0
    this.lifecycleStartEvents.length = 0
    this.lifecycleEndEvents.length = 0
    this.lifecycleReleaseEvents.length = 0
    this.timelineEvents.length = 0
  }

  snapshot(): RecordedRuntimeObserverSnapshot {
    return Object.freeze({
      serviceResolutions: this.serviceResolutions,
      serviceAcquisitions: this.serviceAcquisitions,
      executionStarts: this.executionStarts,
      executionEnds: this.executionEnds,
      taskStarts: this.taskStarts,
      taskEnds: this.taskEnds,
      resourceReleases: this.resourceReleases,
      lifecycleStarts: this.lifecycleStarts,
      lifecycleEnds: this.lifecycleEnds,
      lifecycleReleases: this.lifecycleReleases,
      timeline: this.timeline
    })
  }

  private record<Event extends RuntimeObserverEvent>(events: Event[], event: Event): void {
    events.push(event)
    this.timelineEvents.push(event)
  }
}
