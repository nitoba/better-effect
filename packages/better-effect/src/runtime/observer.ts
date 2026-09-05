import type { AnyServiceToken } from '../service'
import type { Scope } from '../scope'
import type { ScopeCloseError, ScopeOutcome } from '../scope'
import type { MaybePromise } from '../utils/types'
import type { ScopedTaskState } from '../effect/task'

/** Event emitted after a Service resolution attempt settles. */
export type RuntimeServiceResolveEvent = {
  readonly service: AnyServiceToken
  readonly resolutionPath: readonly AnyServiceToken[]
  readonly outcome: ScopeOutcome
  /** Runtime execution owner, omitted for warmup and other root activity. */
  readonly executionId?: string
}

/** Event emitted after a provider acquisition attempt settles. */
export type RuntimeServiceAcquireEvent = {
  readonly service: AnyServiceToken
  readonly resolutionPath: readonly AnyServiceToken[]
  readonly outcome: ScopeOutcome
  /** Runtime execution owner, omitted for warmup and other root activity. */
  readonly executionId?: string
}

/** Values supplied to one Runtime execution for diagnostic correlation. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- attributes intentionally accept caller-defined values.
export type RuntimeExecutionAttributes = Readonly<Record<string, unknown>>

/** Metadata shared by the start and end events for one execution. */
export type RuntimeExecutionMetadata = {
  readonly executionId: string
  readonly name?: string
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- preserve the caller-defined attribute contract.
  readonly attributes?: RuntimeExecutionAttributes
  /** Monotonic host timestamp captured immediately before the Program starts. */
  readonly startedAt: number
}

/** Event emitted immediately before a program starts in an execution Scope. */
export type RuntimeExecutionStartEvent = RuntimeExecutionMetadata & {
  readonly scope: Scope
}

/** Event emitted after a program and its execution Scope settle. */
export type RuntimeExecutionEndEvent = RuntimeExecutionMetadata & {
  readonly scope: Scope
  /** The program outcome used to run execution-scope cleanup. */
  readonly outcome: ScopeOutcome
  /** Execution-scope cleanup failure, without changing the primary program outcome. */
  readonly cleanupFailure?: ScopeCloseError
  /** Monotonic elapsed time for the Program and its execution cleanup. */
  readonly durationMs: number
}

/** Metadata shared by the start and end events for one Scope-owned task. */
export type RuntimeTaskMetadata = {
  readonly taskId: string
  /** The execution that created the task, omitted for root lifecycle tasks. */
  readonly parentExecutionId?: string
  readonly name?: string
  readonly startedAt: number
}

/** Event emitted immediately before a Scope-owned task starts. */
export type RuntimeTaskStartEvent = RuntimeTaskMetadata & {
  readonly state: 'running'
}

/** Event emitted after a Scope-owned task settles and its child Scope closes. */
export type RuntimeTaskEndEvent = RuntimeTaskMetadata & {
  readonly state: Exclude<ScopedTaskState, 'running'>
  /** Child Scope cleanup failure, without changing the task's primary state. */
  readonly cleanupFailure?: ScopeCloseError
}

/** Event emitted after a Layer provider release callback settles. */
export type RuntimeResourceReleaseEvent = {
  readonly service: AnyServiceToken
  readonly outcome: ScopeOutcome
  readonly error?: unknown
  /** Runtime execution owner, omitted for Runtime-root cleanup. */
  readonly executionId?: string
}

/** Metadata shared by lifecycle-only Layer events. */
export type RuntimeLifecycleEventMetadata = {
  readonly kind: 'lifecycle'
  /** Stable identity for one lifecycle entry; no acquired resource is retained. */
  readonly lifecycleId: symbol
  readonly name?: string
}

/** Event emitted immediately before a lifecycle-only entry is acquired. */
export type RuntimeLifecycleStartEvent = RuntimeLifecycleEventMetadata

/** Event emitted after a lifecycle-only entry's acquisition settles. */
export type RuntimeLifecycleEndEvent = RuntimeLifecycleEventMetadata & {
  readonly outcome: ScopeOutcome
  readonly error?: unknown
}

/** Event emitted after a lifecycle-only entry's release callback settles. */
export type RuntimeLifecycleReleaseEvent = RuntimeLifecycleEventMetadata & {
  readonly outcome: ScopeOutcome
  readonly error?: unknown
}

/** Optional best-effort hooks for Runtime lifecycle and resolution events. */
export type RuntimeObserver = {
  readonly onServiceResolve?: (event: RuntimeServiceResolveEvent) => MaybePromise<void>
  readonly onServiceAcquire?: (event: RuntimeServiceAcquireEvent) => MaybePromise<void>
  readonly onExecutionStart?: (event: RuntimeExecutionStartEvent) => MaybePromise<void>
  readonly onExecutionEnd?: (event: RuntimeExecutionEndEvent) => MaybePromise<void>
  readonly onTaskStart?: (event: RuntimeTaskStartEvent) => MaybePromise<void>
  readonly onTaskEnd?: (event: RuntimeTaskEndEvent) => MaybePromise<void>
  readonly onResourceRelease?: (event: RuntimeResourceReleaseEvent) => MaybePromise<void>
  readonly onLifecycleStart?: (event: RuntimeLifecycleStartEvent) => MaybePromise<void>
  readonly onLifecycleEnd?: (event: RuntimeLifecycleEndEvent) => MaybePromise<void>
  readonly onLifecycleRelease?: (event: RuntimeLifecycleReleaseEvent) => MaybePromise<void>
}

/** Compose best-effort Runtime observers into one observer. */
export const RuntimeObserver = {
  compose: (...observers: readonly RuntimeObserver[]): RuntimeObserver => ({
    onServiceResolve: (event) => {
      notifyRuntimeObservers(observers, (observer) => observer.onServiceResolve, event)
    },
    onServiceAcquire: (event) => {
      notifyRuntimeObservers(observers, (observer) => observer.onServiceAcquire, event)
    },
    onExecutionStart: (event) => {
      notifyRuntimeObservers(observers, (observer) => observer.onExecutionStart, event)
    },
    onExecutionEnd: (event) => {
      notifyRuntimeObservers(observers, (observer) => observer.onExecutionEnd, event)
    },
    onTaskStart: (event) => {
      notifyRuntimeObservers(observers, (observer) => observer.onTaskStart, event)
    },
    onTaskEnd: (event) => {
      notifyRuntimeObservers(observers, (observer) => observer.onTaskEnd, event)
    },
    onResourceRelease: (event) => {
      notifyRuntimeObservers(observers, (observer) => observer.onResourceRelease, event)
    },
    onLifecycleStart: (event) => {
      notifyRuntimeObservers(observers, (observer) => observer.onLifecycleStart, event)
    },
    onLifecycleEnd: (event) => {
      notifyRuntimeObservers(observers, (observer) => observer.onLifecycleEnd, event)
    },
    onLifecycleRelease: (event) => {
      notifyRuntimeObservers(observers, (observer) => observer.onLifecycleRelease, event)
    }
  })
}

export const notifyRuntimeObservers = <Event>(
  observers: readonly RuntimeObserver[],
  select: (observer: RuntimeObserver) => ((event: Event) => MaybePromise<void>) | undefined,
  event: Event
): void => {
  for (const observer of observers) {
    const callback = select(observer)

    if (!callback) {
      continue
    }

    try {
      void Promise.resolve(callback(event)).catch(() => {})
    } catch {
      // Observability must never change the Runtime result.
    }
  }
}
