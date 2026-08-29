export type RuntimeExecutionIdGenerator = () => string

export type RuntimeMonotonicClock = () => number

/** Per-Runtime host capabilities used to correlate and time executions. */
export type RuntimeExecutionDependencies = {
  readonly createExecutionId: RuntimeExecutionIdGenerator
  readonly now: RuntimeMonotonicClock
}

export type RuntimeExecutionDependencyOverrides = {
  readonly createExecutionId?: RuntimeExecutionIdGenerator
  readonly now?: RuntimeMonotonicClock
}

const hostMonotonicNow = (): number => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- feature-detect the optional host clock.
  if (typeof globalThis.performance?.now === 'function') {
    const value = globalThis.performance.now()

    if (Number.isFinite(value)) {
      return value
    }
  }

  const wallClock = Date.now()
  return Number.isFinite(wallClock) ? wallClock : 0
}

const makeMonotonicClock = (): RuntimeMonotonicClock => {
  let previous = 0

  return () => {
    previous = Math.max(previous, hostMonotonicNow())
    return previous
  }
}

let fallbackExecutionSequence = 0

const makeExecutionIdGenerator = (): RuntimeExecutionIdGenerator => () => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- feature-detect the optional host ID source.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  fallbackExecutionSequence += 1

  return `execution-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${fallbackExecutionSequence.toString(36)}`
}

/** Create isolated execution capabilities for one Runtime handle. */
export const makeRuntimeExecutionDependencies = (
  overrides: RuntimeExecutionDependencyOverrides = {}
): RuntimeExecutionDependencies => ({
  createExecutionId: overrides.createExecutionId ?? makeExecutionIdGenerator(),
  now: overrides.now ?? makeMonotonicClock()
})
