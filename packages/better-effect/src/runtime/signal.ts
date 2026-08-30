import { currentRuntimeContext } from './context'

const neverAbortedSignal = new AbortController().signal

type SignalListener = readonly [AbortSignal, () => void]

export type AbortSignalLink = {
  readonly signal: AbortSignal
  readonly dispose: () => void
}

/** Link caller, Runtime and shutdown signals without owning the caller's controller. */
export const linkAbortSignals = (
  ...signals: readonly (AbortSignal | undefined)[]
): AbortSignalLink => {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)

  if (active.length === 0) {
    return { signal: neverAbortedSignal, dispose: () => {} }
  }

  if (active.length === 1) {
    return { signal: active[0]!, dispose: () => {} }
  }

  const controller = new AbortController()
  const listeners: SignalListener[] = []
  let disposed = false

  const dispose = (): void => {
    if (disposed) {
      return
    }

    disposed = true

    for (const [source, listener] of listeners) {
      source.removeEventListener('abort', listener)
    }

    listeners.length = 0
  }

  const abortFrom = (source: AbortSignal): void => {
    if (controller.signal.aborted) {
      return
    }

    controller.abort(source.reason)
    dispose()
  }

  for (const source of active) {
    if (source.aborted) {
      abortFrom(source)
      break
    }

    const listener = (): void => abortFrom(source)
    listeners.push([source, listener])
    source.addEventListener('abort', listener, { once: true })
  }

  return { signal: controller.signal, dispose }
}

/** Return the current cooperative-cancellation signal. */
export const currentAbortSignal = (): AbortSignal =>
  currentRuntimeContext().signal ?? neverAbortedSignal

/** Return the Runtime-owned signal used for shutdown coordination. */
export const currentRuntimeAbortSignal = (): AbortSignal => {
  const context = currentRuntimeContext()

  return context.runtimeSignal ?? context.signal ?? neverAbortedSignal
}

/** Yieldable access to the caller signal of the current Runtime execution. */
export const CurrentAbortSignal = {
  // oxlint-disable-next-line require-yield
  *[Symbol.iterator](): Generator<never, AbortSignal, unknown> {
    return currentAbortSignal()
  }
} as const

/** Yieldable access to the Runtime-owned shutdown signal. */
export const CurrentRuntimeAbortSignal = {
  // oxlint-disable-next-line require-yield
  *[Symbol.iterator](): Generator<never, AbortSignal, unknown> {
    return currentRuntimeAbortSignal()
  }
} as const
