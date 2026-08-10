import { LayerGeneratorYieldError } from './errors'

import type { ServiceClass } from '../service'

import type { LayerGenerator } from './types'

export const runLayerGenerator = async <S extends ServiceClass<any>>(
  service: S,
  factory: LayerGenerator<S>
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
