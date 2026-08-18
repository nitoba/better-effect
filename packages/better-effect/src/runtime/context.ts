import { RuntimeContextNotConfiguredError } from './errors'

import type { Scope } from '../scope/scope'
import type { AnyServiceToken, ServiceResolver } from '../service'

/** The complete contextual state shared by Service, Scope and Layer resolution. */
export interface RuntimeContext {
  readonly resolver: ServiceResolver
  readonly scope: Scope
  readonly signal?: AbortSignal
  readonly resolutionPath: readonly AnyServiceToken[]
}

/** Host-specific storage for the current RuntimeContext. */
export interface RuntimeContextStorage {
  run<A>(context: RuntimeContext, program: () => A): A
  current(): RuntimeContext
}

const unconfiguredRuntimeContextStorage: RuntimeContextStorage = {
  run: (_context, program) => program(),
  current: () => {
    throw new RuntimeContextNotConfiguredError()
  }
}

/** Build a context while keeping compatibility-only missing channels internal. */
export const makeRuntimeContext = (
  resolver: ServiceResolver | undefined,
  scope: Scope | undefined,
  resolutionPath: readonly AnyServiceToken[],
  signal: AbortSignal | undefined
): RuntimeContext => {
  // SAFETY: ServiceRuntime and ScopeRuntime can be entered independently; the missing channel is rejected by the corresponding bridge before use.
  const context: RuntimeContext = {
    resolver: resolver as ServiceResolver,
    scope: scope as Scope,
    resolutionPath
  }

  if (signal === undefined) {
    return context
  }

  return { ...context, signal }
}

let activeStorage = unconfiguredRuntimeContextStorage

/** Install the host default used by the main Runtime entrypoint. */
export const setDefaultRuntimeContextStorage = (storage: RuntimeContextStorage): void => {
  activeStorage = storage
}

const isPromiseLike = <A>(value: A): value is A & PromiseLike<unknown> =>
  Object(value) === value && 'then' in Object(value)

/** Return the storage currently associated with the executing callback. */
export const activeRuntimeContextStorage = (): RuntimeContextStorage => activeStorage

/** Return the active context, or undefined when the storage has not been entered. */
export const getRuntimeContext = (
  storage: RuntimeContextStorage = activeStorage
): RuntimeContext | undefined => {
  try {
    return storage.current()
  } catch (cause) {
    if (cause instanceof RuntimeContextNotConfiguredError) {
      return undefined
    }

    throw cause
  }
}

/** Return the active context or throw the storage's standard missing-context error. */
export const currentRuntimeContext = (): RuntimeContext => activeStorage.current()

/** Keep a storage discoverable to Service and Scope compatibility bridges. */
export const withActiveRuntimeContextStorage = <A>(
  storage: RuntimeContextStorage,
  program: () => A
): A => {
  const previous = activeStorage
  activeStorage = storage

  const restore = (): void => {
    if (activeStorage === storage) {
      activeStorage = previous
    }
  }

  let value: A

  try {
    value = program()
  } catch (cause) {
    restore()
    throw cause
  }

  if (!isPromiseLike(value)) {
    restore()
    return value
  }

  // SAFETY: PromiseLike values are normalized only to restore the storage after settlement; the public generic retains the callback's awaited shape.
  return Promise.resolve(value).then(
    (resolved) => {
      restore()
      return resolved
    },
    (cause) => {
      restore()
      throw cause
    }
  ) as A
}

/** Run a callback in a context while keeping the selected storage discoverable to bridges. */
export const runRuntimeContext = <A>(
  storage: RuntimeContextStorage,
  context: RuntimeContext,
  program: () => A
): A => withActiveRuntimeContextStorage(storage, () => storage.run(context, program))
