import { RuntimeContextNotConfiguredError } from './errors'

import type { Scope } from '../scope/scope'
import type { AnyServiceToken, ServiceResolver } from '../service'
import { isPromiseLike } from '../utils/runtime'

/** Contextual state shared by Service, Scope and Layer resolution. */
export interface RuntimeContext {
  readonly resolver?: ServiceResolver
  readonly scope?: Scope
  readonly signal?: AbortSignal
  readonly resolutionPath: readonly AnyServiceToken[]
}

/** A context with both channels required by a Runtime execution. */
export type CompleteRuntimeContext = RuntimeContext & {
  readonly resolver: ServiceResolver
  readonly scope: Scope
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

const contextLineages = new WeakMap<object, RuntimeContext>()

/** Associate a derived context with the root context of its execution lineage. */
export const inheritRuntimeContextLineage = (
  context: RuntimeContext,
  parent: RuntimeContext
): RuntimeContext => {
  const lineage = contextLineages.get(parent) ?? parent
  contextLineages.set(context, lineage)
  return context
}

/** Return the root context associated with a contextual value, when known. */
export const getRuntimeContextLineage = (context: RuntimeContext): RuntimeContext | undefined =>
  contextLineages.get(context)

/** Associate a newly-entered root context with itself. */
export const setRuntimeContextLineage = (context: RuntimeContext): RuntimeContext => {
  contextLineages.set(context, context)
  return context
}

const hasPathPrefix = (
  parent: readonly AnyServiceToken[],
  child: readonly AnyServiceToken[]
): boolean =>
  child.length >= parent.length && parent.every((token, index) => child[index] === token)

/** Recognize contexts created by a nested Service, Scope, or Layer operation. */
export const isDerivedRuntimeContext = (parent: RuntimeContext, child: RuntimeContext): boolean =>
  parent.resolver !== undefined &&
  child.resolver === parent.resolver &&
  parent.resolutionPath.length > 0 &&
  hasPathPrefix(parent.resolutionPath, child.resolutionPath) &&
  (child.resolutionPath.length > parent.resolutionPath.length || child.scope !== parent.scope)

/** Build a context while retaining only channels that are actually available. */
export function makeRuntimeContext(
  resolver: ServiceResolver,
  scope: Scope,
  resolutionPath: readonly AnyServiceToken[],
  signal: AbortSignal | undefined,
  parent?: RuntimeContext
): CompleteRuntimeContext
export function makeRuntimeContext(
  resolver: ServiceResolver | undefined,
  scope: Scope | undefined,
  resolutionPath: readonly AnyServiceToken[],
  signal: AbortSignal | undefined,
  parent?: RuntimeContext
): RuntimeContext
export function makeRuntimeContext(
  resolver: ServiceResolver | undefined,
  scope: Scope | undefined,
  resolutionPath: readonly AnyServiceToken[],
  signal: AbortSignal | undefined,
  parent?: RuntimeContext
): RuntimeContext {
  const context: RuntimeContext = { resolutionPath }

  if (resolver !== undefined) {
    Object.assign(context, { resolver })
  }

  if (scope !== undefined) {
    Object.assign(context, { scope })
  }

  if (signal !== undefined) {
    Object.assign(context, { signal })
  }

  if (parent !== undefined) {
    inheritRuntimeContextLineage(context, parent)
  }

  return context
}

type ActiveStorageFrame = {
  readonly storage: RuntimeContextStorage
  readonly previous: ActiveStorageFrame | undefined
  active: boolean
}

let defaultStorage = unconfiguredRuntimeContextStorage
let activeFrame: ActiveStorageFrame | undefined

const restoreActiveStorageFrame = (frame: ActiveStorageFrame): void => {
  frame.active = false

  if (activeFrame !== frame) {
    return
  }

  let previous = frame.previous

  while (previous !== undefined && !previous.active) {
    previous = previous.previous
  }

  activeFrame = previous
}

const settleWithRuntimeStorage = <A>(value: A, restore: () => void): A => {
  let promiseLike: boolean

  try {
    promiseLike = isPromiseLike(value)
  } catch (cause) {
    restore()
    throw cause
  }

  if (!promiseLike) {
    restore()
    return value
  }

  try {
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
  } catch (cause) {
    restore()
    throw cause
  }
}

/** Install the host default used by the main Runtime entrypoint. */
export const setDefaultRuntimeContextStorage = (storage: RuntimeContextStorage): void => {
  defaultStorage = storage
}

/** Return the storage currently associated with the executing callback. */
export const activeRuntimeContextStorage = (): RuntimeContextStorage =>
  activeFrame?.storage ?? defaultStorage

/** Return the active context, or undefined when the storage has not been entered. */
export const getRuntimeContext = (
  storage: RuntimeContextStorage = activeRuntimeContextStorage()
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
export const currentRuntimeContext = (): RuntimeContext => activeRuntimeContextStorage().current()

/** Keep a storage discoverable to Service and Scope compatibility bridges. */
export const withActiveRuntimeContextStorage = <A>(
  storage: RuntimeContextStorage,
  program: () => A
): A => {
  const frame: ActiveStorageFrame = {
    storage,
    previous: activeFrame,
    active: true
  }
  activeFrame = frame

  const restore = (): void => restoreActiveStorageFrame(frame)

  try {
    return settleWithRuntimeStorage(program(), restore)
  } catch (cause) {
    restore()
    throw cause
  }
}

/** Run a callback in a context while keeping the selected storage discoverable to bridges. */
export const runRuntimeContext = <A>(
  storage: RuntimeContextStorage,
  context: RuntimeContext,
  program: () => A
): A => {
  const current = getRuntimeContext(storage)
  const contextual =
    current !== undefined && isDerivedRuntimeContext(current, context)
      ? inheritRuntimeContextLineage(context, current)
      : context

  return withActiveRuntimeContextStorage(storage, () => storage.run(contextual, program))
}
