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

/** Event emitted immediately before a program starts in an execution Scope. */
export type RuntimeExecutionStartEvent = {
  readonly scope: Scope
}

/** Event emitted after a program and its execution Scope settle. */
export type RuntimeExecutionEndEvent = {
  readonly scope: Scope
  readonly outcome: ScopeOutcome
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
