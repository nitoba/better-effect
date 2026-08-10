import { LayerGeneratorYieldError } from './errors'

import type { ServiceRequirement } from '../effect/types'
import type { AnyServiceToken, ServiceClass } from '../service'

import type { LayerGenerator } from './types'

export const runLayerGenerator = async <
  S extends ServiceClass<any>,
  Yield extends ServiceRequirement<AnyServiceToken>
>(
  service: S,
  factory: LayerGenerator<S, Yield>
): Promise<InstanceType<S>> => {
  const iterator = factory()

  const state = await iterator.next()

  if (!state.done) {
    try {
      await iterator.return(undefined as InstanceType<S>)
    } finally {
      // oxlint-disable-next-line no-unsafe-finally
      throw new LayerGeneratorYieldError(service)
    }
  }

  return state.value
}
