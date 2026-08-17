import type { InferYieldRequirements, ServiceRequirement } from '../effect/types'
import type { ServiceClass, ServiceContract, ServiceRequirements } from '../service'
import type { MaybePromise } from '../utils/types'

/** Runtime-facing provider registration supplied by a Layer backend. */
export interface LayerRegistration {
  /** The class-backed Service token provided by this registration. */
  readonly service: ServiceClass<any, any>

  /** Lazily acquire the Service instance; concrete types are erased at this backend boundary. */
  readonly acquire: () => MaybePromise<unknown>
}

/** Generator shape used by `Layer.gen` and `Layer.scopedGen`. */
export type LayerGenerator<
  S extends ServiceClass<any, any>,
  Yield extends ServiceRequirement<unknown> = ServiceRequirement<unknown>
> = () => AsyncGenerator<Yield, ServiceContract<InstanceType<S>>, unknown>

/** Service requirements inferred from a provider's methods and generator. */
export type LayerGeneratorRequirements<
  S extends ServiceClass<any, any>,
  Yield extends ServiceRequirement<unknown>
> = ServiceRequirements<InstanceType<S>> | InferYieldRequirements<Yield>
