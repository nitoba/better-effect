import { ScopeRuntimeNotConfiguredError } from './errors'

import type { Scope } from './scope'

import {
  activeRuntimeContextStorage,
  currentRuntimeContext,
  getRuntimeContext,
  makeRuntimeContext,
  runRuntimeContext
} from '../runtime/context'

import type { RuntimeContextStorage } from '../runtime/context'

const scopeStorages = new WeakMap<object, RuntimeContextStorage>()

/** Bridges the current Scope through async execution context. */
export class ScopeRuntime {
  /** Supply a Scope while invoking a callback. */
  static run<A>(
    scope: Scope,
    program: () => A,
    storage: RuntimeContextStorage = scopeStorages.get(scope) ?? activeRuntimeContextStorage()
  ): A {
    scopeStorages.set(scope, storage)

    const current = getRuntimeContext(storage)
    const context = makeRuntimeContext(
      current?.resolver,
      scope,
      current?.resolutionPath ?? [],
      current?.signal,
      current
    )

    return runRuntimeContext(storage, context, program)
  }

  /** Return the Scope active in the current execution context. */
  static current(): Scope {
    let context

    try {
      context = currentRuntimeContext()
    } catch {
      throw new ScopeRuntimeNotConfiguredError()
    }

    if (!context.scope) {
      throw new ScopeRuntimeNotConfiguredError()
    }

    return context.scope
  }

  /** Associate a Runtime-owned Scope with its context storage. */
  static bind(scope: Scope, storage: RuntimeContextStorage): void {
    scopeStorages.set(scope, storage)
  }
}
