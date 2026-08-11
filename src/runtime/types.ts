import type { AnyLayer, LayerProvided } from '../layer'

import type { Runtime } from './runtime'

/** Runtime handle whose provided Services are inferred from a Layer. */
export type RuntimeFor<L extends AnyLayer> = Runtime<LayerProvided<L>>
