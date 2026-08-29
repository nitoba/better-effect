import { nodeRuntimeContextStorage } from './node-context'

import { setDefaultRuntimeContextStorage } from './context'

/** The Node/Bun storage used by the main Runtime entrypoint. */
export const defaultRuntimeContextStorage = nodeRuntimeContextStorage

setDefaultRuntimeContextStorage(defaultRuntimeContextStorage)
