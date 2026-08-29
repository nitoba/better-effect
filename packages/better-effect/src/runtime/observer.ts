import type { AnyServiceToken } from '../service'
import type { Scope } from '../scope'
import type { ScopeOutcome } from '../scope'
import type { MaybePromise } from '../utils/types'

/** Event emitted after a Service resolution attempt settles. */
export type RuntimeServiceResolveEvent = {
  readonly service: AnyServiceToken
  readonly resolutionPath: readonly AnyServiceToken[]
  readonly outcome: ScopeOutcome
}

/** Event emitted after a provider acquisition attempt settles. */
export type RuntimeServiceAcquireEvent = {
  readonly service: AnyServiceToken
  readonly resolutionPath: readonly AnyServiceToken[]
  readonly outcome: ScopeOutcome
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
  readonly outcome: ScopeOutcome
  /** Monotonic elapsed time for the Program and its execution cleanup. */
  readonly durationMs: number
}

/** Event emitted after a Layer provider release callback settles. */
export type RuntimeResourceReleaseEvent = {
  readonly service: AnyServiceToken
  readonly outcome: ScopeOutcome
  readonly error?: unknown
}

/** Optional best-effort hooks for Runtime lifecycle and resolution events. */
export type RuntimeObserver = {
  readonly onServiceResolve?: (event: RuntimeServiceResolveEvent) => MaybePromise<void>
  readonly onServiceAcquire?: (event: RuntimeServiceAcquireEvent) => MaybePromise<void>
  readonly onExecutionStart?: (event: RuntimeExecutionStartEvent) => MaybePromise<void>
  readonly onExecutionEnd?: (event: RuntimeExecutionEndEvent) => MaybePromise<void>
  readonly onResourceRelease?: (event: RuntimeResourceReleaseEvent) => MaybePromise<void>
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
    onResourceRelease: (event) => {
      notifyRuntimeObservers(observers, (observer) => observer.onResourceRelease, event)
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
