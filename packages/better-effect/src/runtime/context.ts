import { RuntimeContextNotConfiguredError } from './errors'

import type { Scope } from '../scope/scope'
import type { AnyServiceToken, ServiceResolver } from '../service'
import { isPromiseLike } from '../utils/runtime'

/** Contextual state shared by Service, Scope and Layer resolution. */
export interface RuntimeContext {
  readonly resolver?: ServiceResolver
  readonly scope?: Scope
  /** Signal supplied by the current caller or execution boundary. */
  readonly signal?: AbortSignal
  /** Runtime-owned signal used for shutdown coordination. */
  readonly runtimeSignal?: AbortSignal
  readonly resolutionPath: readonly AnyServiceToken[]
  /** Runtime execution owner, omitted for warmup and Runtime-root activity. */
  readonly executionId?: string
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
  parent?: RuntimeContext,
  executionId?: string,
  runtimeSignal?: AbortSignal
): CompleteRuntimeContext
export function makeRuntimeContext(
  resolver: ServiceResolver | undefined,
  scope: Scope | undefined,
  resolutionPath: readonly AnyServiceToken[],
  signal: AbortSignal | undefined,
  parent?: RuntimeContext,
  executionId?: string,
  runtimeSignal?: AbortSignal
): RuntimeContext
export function makeRuntimeContext(
  resolver: ServiceResolver | undefined,
  scope: Scope | undefined,
  resolutionPath: readonly AnyServiceToken[],
  signal: AbortSignal | undefined,
  parent?: RuntimeContext,
  executionId?: string,
  runtimeSignal?: AbortSignal
): RuntimeContext {
  const context: RuntimeContext = { resolutionPath }
  const ownerExecutionId = executionId ?? parent?.executionId
  const ownerRuntimeSignal = runtimeSignal ?? parent?.runtimeSignal

  if (resolver !== undefined) {
    Object.assign(context, { resolver })
  }

  if (scope !== undefined) {
    Object.assign(context, { scope })
  }

  if (signal !== undefined) {
    Object.assign(context, { signal })
  }

  if (ownerRuntimeSignal !== undefined) {
    Object.assign(context, { runtimeSignal: ownerRuntimeSignal })
  }

  if (ownerExecutionId !== undefined) {
    Object.assign(context, { executionId: ownerExecutionId })
  }

  if (parent !== undefined) {
    inheritRuntimeContextLineage(context, parent)
  }

  return context
}

/** A context frame selected for one logical Runtime execution branch. */
export type ActiveRuntimeContextFrame = {
  readonly storage: RuntimeContextStorage
  readonly context: RuntimeContext
  readonly parent?: ActiveRuntimeContextFrame
}

/** Host-provided propagation for Runtime context frames. */
export interface RuntimeContextFrameCarrier {
  run<A>(frame: ActiveRuntimeContextFrame, program: () => A): A
  current(): ActiveRuntimeContextFrame | undefined
}

let defaultStorage = unconfiguredRuntimeContextStorage
let fallbackFrame: ActiveRuntimeContextFrame | undefined
const fallbackFrames = new Set<ActiveRuntimeContextFrame>()

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

const restoreFallbackFrame = (frame: ActiveRuntimeContextFrame): void => {
  fallbackFrames.delete(frame)

  if (fallbackFrame !== frame) {
    return
  }

  let parent = frame.parent

  while (parent !== undefined && !fallbackFrames.has(parent)) {
    parent = parent.parent
  }

  fallbackFrame = parent
}

const fallbackRuntimeContextFrameCarrier: RuntimeContextFrameCarrier = {
  run<A>(frame: ActiveRuntimeContextFrame, program: () => A): A {
    fallbackFrames.add(frame)
    fallbackFrame = frame
    const restore = (): void => restoreFallbackFrame(frame)

    try {
      return settleWithRuntimeStorage(program(), restore)
    } catch (cause) {
      restore()
      throw cause
    }
  },

  current: () => fallbackFrame
}

let runtimeContextFrameCarrier: RuntimeContextFrameCarrier = fallbackRuntimeContextFrameCarrier

/** Install host async-context propagation for Runtime context frames. */
export const setRuntimeContextFrameCarrier = (carrier: RuntimeContextFrameCarrier): void => {
  runtimeContextFrameCarrier = carrier
}

/** Return whether a host async-context carrier has been installed. */
export const isRuntimeContextFrameCarrierInstalled = (): boolean =>
  runtimeContextFrameCarrier !== fallbackRuntimeContextFrameCarrier

/** Return the frame associated with the executing callback. */
export const currentRuntimeContextFrame = (): ActiveRuntimeContextFrame | undefined =>
  runtimeContextFrameCarrier.current()

/** Install the host default used by the main Runtime entrypoint. */
export const setDefaultRuntimeContextStorage = (storage: RuntimeContextStorage): void => {
  defaultStorage = storage
}

/** Return the storage currently associated with the executing callback. */
export const activeRuntimeContextStorage = (): RuntimeContextStorage =>
  currentRuntimeContextFrame()?.storage ?? defaultStorage

/** Return the active context, or undefined when the storage has not been entered. */
export const getRuntimeContext = (
  storage: RuntimeContextStorage = activeRuntimeContextStorage()
): RuntimeContext | undefined => {
  const frame = currentRuntimeContextFrame()

  if (frame?.storage === storage) {
    return frame.context
  }

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
export const currentRuntimeContext = (): RuntimeContext => {
  const frame = currentRuntimeContextFrame()

  return frame?.context ?? defaultStorage.current()
}

/** Keep a storage discoverable to Service and Scope compatibility bridges. */
export const withActiveRuntimeContextStorage = <A>(
  storage: RuntimeContextStorage,
  context: RuntimeContext,
  program: () => A
): A => {
  const current = currentRuntimeContextFrame()

  if (current?.storage === storage && current.context === context) {
    return program()
  }

  const frame: ActiveRuntimeContextFrame =
    current === undefined ? { storage, context } : { storage, context, parent: current }

  return runtimeContextFrameCarrier.run(frame, program)
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

  return storage.run(contextual, () =>
    withActiveRuntimeContextStorage(storage, contextual, program)
  )
}
