import { RuntimeContextNotConfiguredError } from './errors'

import { withActiveRuntimeContextStorage } from './context'

import type { RuntimeContext, RuntimeContextStorage } from './context'

const isPromiseLike = <A>(value: A): value is A & PromiseLike<unknown> =>
  Object(value) === value && 'then' in Object(value)

/**
 * RuntimeContextStorage for hosts without transparent async context support.
 *
 * Context remains active until an async callback settles. Callers must avoid
 * overlapping async runs on one instance; use NodeRuntimeContextStorage when
 * concurrent async branches need isolation.
 */
export class ExplicitRuntimeContextStorage implements RuntimeContextStorage {
  private context: RuntimeContext | undefined

  run<A>(context: RuntimeContext, program: () => A): A {
    return withActiveRuntimeContextStorage(this, () => {
      const previous = this.context
      this.context = context

      let value: A

      try {
        value = program()
      } catch (cause) {
        this.context = previous
        throw cause
      }

      if (!isPromiseLike(value)) {
        this.context = previous
        return value
      }

      // ponytail: one mutable slot keeps the explicit adapter tiny; use a host-provided async context for concurrent branches.
      // SAFETY: PromiseLike values are normalized only to restore the storage after settlement; the public generic retains the callback's awaited shape.
      return Promise.resolve(value).then(
        (resolved) => {
          this.context = previous
          return resolved
        },
        (cause) => {
          this.context = previous
          throw cause
        }
      ) as A
    })
  }

  current(): RuntimeContext {
    const context = this.context

    if (!context) {
      throw new RuntimeContextNotConfiguredError()
    }

    return context
  }
}

export { RuntimeContextNotConfiguredError } from './errors'

export type { RuntimeContext, RuntimeContextStorage } from './context'
