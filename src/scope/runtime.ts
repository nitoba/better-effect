import { AsyncLocalStorage } from 'node:async_hooks'

import { ScopeRuntimeNotConfiguredError } from './errors'

import type { Scope } from './scope'

const storage = new AsyncLocalStorage<Scope>()

export class ScopeRuntime {
  static run<A>(scope: Scope, program: () => A): A {
    return storage.run(scope, program)
  }

  static current(): Scope {
    const scope = storage.getStore()

    if (!scope) {
      throw new ScopeRuntimeNotConfiguredError()
    }

    return scope
  }
}
