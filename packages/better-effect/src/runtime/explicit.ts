import { RuntimeContextNotConfiguredError, RuntimeContextOverlapError } from './errors'

import {
  currentRuntimeContextFrame,
  getRuntimeContextLineage,
  inheritRuntimeContextLineage,
  isDerivedRuntimeContext,
  isRuntimeContextFrameCarrierInstalled,
  setRuntimeContextLineage,
  withActiveRuntimeContextStorage
} from './context'

import { isPromiseLike } from '../utils/runtime'

import type { ActiveRuntimeContextFrame, RuntimeContext, RuntimeContextStorage } from './context'

type ExplicitRunState = {
  readonly frame: ActiveRuntimeContextFrame
  readonly context: RuntimeContext
  readonly parent: ExplicitRunState | undefined
  activeChild: ExplicitRunState | undefined
  invoking: boolean
}

// Without async-local propagation, separate explicit storages share one mutable
// frame and must not hold root leases concurrently.
let fallbackRootLease = false

/**
 * RuntimeContextStorage for hosts without transparent async context support.
 *
 * Nested derived contexts are supported, but unrelated root or lineage runs
 * cannot overlap safely on one mutable storage instance. Use
 * NodeRuntimeContextStorage when concurrent async branches need isolation.
 */
export class ExplicitRuntimeContextStorage implements RuntimeContextStorage {
  private readonly states = new WeakMap<ActiveRuntimeContextFrame, ExplicitRunState>()

  private rootState: ExplicitRunState | undefined

  run<A>(context: RuntimeContext, program: () => A): A {
    return withActiveRuntimeContextStorage(this, context, () => {
      const frame = currentRuntimeContextFrame()

      if (!frame || frame.storage !== this) {
        throw new RuntimeContextOverlapError()
      }

      const existing = this.states.get(frame)

      if (existing?.context === context) {
        if (
          existing.activeChild !== undefined ||
          (!isRuntimeContextFrameCarrierInstalled() && !existing.invoking)
        ) {
          throw new RuntimeContextOverlapError()
        }

        return program()
      }

      const state = this.enter(frame, context)
      state.invoking = true
      const restore = (): void => this.exit(state)

      try {
        const value = program()
        state.invoking = false
        return this.settle(value, restore)
      } catch (cause) {
        state.invoking = false
        restore()
        throw cause
      }
    })
  }

  private enter(frame: ActiveRuntimeContextFrame, context: RuntimeContext): ExplicitRunState {
    const parentFrame = frame.parent
    const parent = parentFrame ? this.states.get(parentFrame) : undefined

    if (parent === undefined) {
      if (
        this.rootState !== undefined ||
        (!isRuntimeContextFrameCarrierInstalled() && fallbackRootLease)
      ) {
        throw new RuntimeContextOverlapError()
      }

      setRuntimeContextLineage(context)

      const state: ExplicitRunState = {
        frame,
        context,
        parent: undefined,
        activeChild: undefined,
        invoking: false
      }
      this.states.set(frame, state)
      this.rootState = state

      if (!isRuntimeContextFrameCarrierInstalled()) {
        fallbackRootLease = true
      }

      return state
    }

    if (parent.activeChild !== undefined) {
      throw new RuntimeContextOverlapError()
    }

    const contextLineage = getRuntimeContextLineage(context)
    const parentLineage = getRuntimeContextLineage(parent.context) ?? parent.context
    const nested =
      context !== parent.context &&
      ((contextLineage !== undefined && contextLineage === parentLineage) ||
        (contextLineage === undefined && isDerivedRuntimeContext(parent.context, context)))

    if (
      !nested ||
      (!isRuntimeContextFrameCarrierInstalled() && parent.parent !== undefined && !parent.invoking)
    ) {
      throw new RuntimeContextOverlapError()
    }

    inheritRuntimeContextLineage(context, parent.context)

    const state: ExplicitRunState = {
      frame,
      context,
      parent,
      activeChild: undefined,
      invoking: false
    }
    this.states.set(frame, state)
    parent.activeChild = state

    return state
  }

  private exit(state: ExplicitRunState): void {
    if (this.states.get(state.frame) !== state) {
      return
    }

    this.states.delete(state.frame)

    if (state.parent !== undefined) {
      if (state.parent.activeChild === state) {
        state.parent.activeChild = undefined
      }
      return
    }

    if (this.rootState === state) {
      this.rootState = undefined

      if (fallbackRootLease) {
        fallbackRootLease = false
      }
    }
  }

  private settle<A>(value: A, restore: () => void): A {
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

  current(): RuntimeContext {
    const frame = currentRuntimeContextFrame()
    const state = frame && frame.storage === this ? this.states.get(frame) : undefined

    if (!state) {
      throw new RuntimeContextNotConfiguredError()
    }

    return state.context
  }
}

export { RuntimeContextNotConfiguredError, RuntimeContextOverlapError } from './errors'

export type { RuntimeContext, RuntimeContextStorage } from './context'
