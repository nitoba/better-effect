import type { AnyLayer, LayerProvided } from '../layer'

import type { Runtime } from './runtime'

/**
 * Name a Runtime type from a concrete Layer without repeating its provided
 * Service constructor union.
 *
 * @example
 * ```ts
 * type AppRuntime = RuntimeFor<typeof AppLive>
 * ```
 */
export type RuntimeFor<L extends AnyLayer> = Runtime<LayerProvided<L>>
