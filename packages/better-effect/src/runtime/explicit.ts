import { RuntimeContextNotConfiguredError, RuntimeContextOverlapError } from './errors'

import {
  getRuntimeContextLineage,
  inheritRuntimeContextLineage,
  isDerivedRuntimeContext,
  setRuntimeContextLineage,
  withActiveRuntimeContextStorage
} from './context'

import { isPromiseLike } from '../utils/runtime'

import type { RuntimeContext, RuntimeContextStorage } from './context'

/**
 * RuntimeContextStorage for hosts without transparent async context support.
 *
 * Nested derived contexts are supported, but unrelated root or lineage runs
 * cannot overlap safely on one mutable storage instance. Use
 * NodeRuntimeContextStorage when concurrent async branches need isolation.
 */
export class ExplicitRuntimeContextStorage implements RuntimeContextStorage {
  private context: RuntimeContext | undefined

  private lineage: RuntimeContext | undefined

  run<A>(context: RuntimeContext, program: () => A): A {
    return withActiveRuntimeContextStorage(this, () => {
      const restore = this.enter(context)

      try {
        return this.settle(program(), restore)
      } catch (cause) {
        restore()
        throw cause
      }
    })
  }

  private enter(context: RuntimeContext): () => void {
    const previous = this.context
    const previousLineage = this.lineage
    let currentLineage: RuntimeContext

    if (previous === undefined) {
      currentLineage = setRuntimeContextLineage(context)
    } else {
      const contextLineage = getRuntimeContextLineage(context)
      const nested =
        context !== previous &&
        ((contextLineage !== undefined && contextLineage === previousLineage) ||
          (contextLineage === undefined && isDerivedRuntimeContext(previous, context)))

      if (!nested) {
        throw new RuntimeContextOverlapError()
      }

      currentLineage = previousLineage ?? previous
      inheritRuntimeContextLineage(context, previous)
    }

    this.context = context
    this.lineage = currentLineage

    return () => {
      this.context = previous
      this.lineage = previousLineage
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
    const context = this.context

    if (!context) {
      throw new RuntimeContextNotConfiguredError()
    }

    return context
  }
}

export { RuntimeContextNotConfiguredError, RuntimeContextOverlapError } from './errors'

export type { RuntimeContext, RuntimeContextStorage } from './context'
