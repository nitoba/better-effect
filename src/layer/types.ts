import type { InferYieldRequirements, ServiceRequirement } from '../effect/types'
import type { AnyServiceToken, ServiceClass, ServiceRequirements } from '../service'
import type { MaybePromise } from '../utils/types'

export interface LayerRegistration {
  readonly service: ServiceClass<any>

  readonly acquire: () => MaybePromise<unknown>
}

export type LayerSpec<
  Provided extends AnyServiceToken,
  Required extends AnyServiceToken = never
> = {
  readonly provided: Provided
  readonly required: Required
}

export type AnyLayerSpec = LayerSpec<AnyServiceToken, AnyServiceToken>

export type LayerGenerator<
  S extends ServiceClass<any>,
  Yield extends ServiceRequirement<AnyServiceToken> = ServiceRequirement<AnyServiceToken>
> = () => AsyncGenerator<Yield, InstanceType<S>, unknown>

export type LayerGeneratorRequirements<
  S extends ServiceClass<any>,
  Yield extends ServiceRequirement<AnyServiceToken>
> = ServiceRequirements<S> | InferYieldRequirements<Yield>
