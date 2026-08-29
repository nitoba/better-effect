import { AsyncLocalStorage } from 'node:async_hooks'

import { RuntimeContextNotConfiguredError } from './errors'

import {
  currentRuntimeContextFrame,
  setRuntimeContextFrameCarrier,
  withActiveRuntimeContextStorage
} from './context'

import type {
  ActiveRuntimeContextFrame,
  RuntimeContext,
  RuntimeContextFrameCarrier,
  RuntimeContextStorage
} from './context'

const asyncLocalStorage = new AsyncLocalStorage<ActiveRuntimeContextFrame>()

const frameCarrier: RuntimeContextFrameCarrier = {
  run: (frame, program) => asyncLocalStorage.run(frame, program),
  current: () => asyncLocalStorage.getStore()
}

setRuntimeContextFrameCarrier(frameCarrier)

/** RuntimeContextStorage backed by Node/Bun async context propagation. */
export class NodeRuntimeContextStorage implements RuntimeContextStorage {
  run<A>(context: RuntimeContext, program: () => A): A {
    return withActiveRuntimeContextStorage(this, context, program)
  }

  current(): RuntimeContext {
    const frame = currentRuntimeContextFrame()

    if (!frame || frame.storage !== this) {
      throw new RuntimeContextNotConfiguredError()
    }

    return frame.context
  }
}

/** Shared Node/Bun storage used by the compatibility APIs and default Runtime. */
export const nodeRuntimeContextStorage = new NodeRuntimeContextStorage()

export { RuntimeContextNotConfiguredError } from './errors'

export type { RuntimeContext, RuntimeContextStorage } from './context'
