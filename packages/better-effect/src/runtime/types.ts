import type { Layer } from '../layer/layer'
import type { LayerInput } from '../layer/inference'

import type { Runtime } from './runtime'

/**
 * Name a Runtime type from a concrete Layer without repeating its provided
 * branded Service instance union.
 *
 * @example
 * ```ts
 * type AppRuntime = RuntimeFor<typeof AppLive>
 * ```
 */
export type RuntimeFor<L extends LayerInput> = Runtime<Layer.Provided<L>>
