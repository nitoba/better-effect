import { LayerGeneratorYieldError } from './errors'

import { ServiceRuntime } from '../service'
import { captureServiceTag } from '../service/tag'

import type { ServiceRequirement } from '../effect/types'
import type { AnyServiceToken, ServiceClass } from '../service'

import type { LayerGenerator } from './types'

export const runLayerGenerator = async <
  S extends ServiceClass<any, any>,
  Yield extends ServiceRequirement<unknown>
>(
  service: S,
  factory: LayerGenerator<S, Yield>
): Promise<InstanceType<S>> => {
  const iterator = factory()

  let state = await iterator.next()

  while (!state.done) {
    const token = serviceTokenFromYield(state.value)

    if (token === undefined) {
      try {
        // SAFETY: The iterator is closed only to discard an invalid yield; its return value is ignored.
        await iterator.return(undefined as never)
      } finally {
        // oxlint-disable-next-line no-unsafe-finally
        throw new LayerGeneratorYieldError(service)
      }
    }

    state = await iterator.next(await ServiceRuntime.resolve(token))
  }

  // SAFETY: The public generator boundary accepts only the requested Service contract.
  return state.value as InstanceType<S>
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Sync Layer generators expose Service tokens only through a runtime-erased yield.
const serviceTokenFromYield = (value: unknown): AnyServiceToken | undefined => {
  try {
    captureServiceTag(value)

    // SAFETY: A valid Service token is the only runtime value emitted by the sync Service iterator.
    return value as AnyServiceToken
  } catch {
    return undefined
  }
}
