import { AsyncLocalStorage } from 'node:async_hooks'

import { ScopeRuntimeNotConfiguredError } from './errors'

import type { Scope } from './scope'

const storage = new AsyncLocalStorage<Scope>()

/** Bridges the current Scope through async execution context. */
export class ScopeRuntime {
  /** Supply a Scope while invoking a callback. */
  static run<A>(scope: Scope, program: () => A): A {
    return storage.run(scope, program)
  }

  /** Return the Scope active in the current execution context. */
  static current(): Scope {
    const scope = storage.getStore()

    if (!scope) {
      throw new ScopeRuntimeNotConfiguredError()
    }

    return scope
  }
}
