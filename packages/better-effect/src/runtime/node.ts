import { AsyncLocalStorage } from 'node:async_hooks'

import { RuntimeContextNotConfiguredError } from './errors'

import { withActiveRuntimeContextStorage } from './context'

import type { RuntimeContext, RuntimeContextStorage } from './context'

const storage = new AsyncLocalStorage<RuntimeContext>()

/** RuntimeContextStorage backed by Node/Bun async context propagation. */
export class NodeRuntimeContextStorage implements RuntimeContextStorage {
  run<A>(context: RuntimeContext, program: () => A): A {
    return withActiveRuntimeContextStorage(this, () => storage.run(context, program))
  }

  current(): RuntimeContext {
    const context = storage.getStore()

    if (!context) {
      throw new RuntimeContextNotConfiguredError()
    }

    return context
  }
}

/** Shared Node/Bun storage used by the compatibility APIs and default Runtime. */
export const nodeRuntimeContextStorage = new NodeRuntimeContextStorage()

export { RuntimeContextNotConfiguredError } from './errors'

export type { RuntimeContext, RuntimeContextStorage } from './context'
