import { LayerGeneratorYieldError } from './errors'

import type { ServiceRequirement } from '../effect/types'
import type { ServiceToken } from '../service'

import type { LayerGenerator } from './types'

export const runLayerGenerator = async <
  S extends ServiceToken<any, any>,
  Yield extends ServiceRequirement<unknown>
>(
  service: S,
  factory: LayerGenerator<S, Yield>
): Promise<InstanceType<S>> => {
  const iterator = factory()

  const state = await iterator.next()

  if (!state.done) {
    try {
      // SAFETY: The iterator is closed only to discard an invalid yield; its return value is ignored.
      await iterator.return(undefined as never)
    } finally {
      // oxlint-disable-next-line no-unsafe-finally
      throw new LayerGeneratorYieldError(service)
    }
  }

  // SAFETY: The public generator boundary accepts only the requested Service contract.
  return state.value as InstanceType<S>
}
