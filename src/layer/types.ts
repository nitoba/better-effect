import type { InferYieldRequirements, ServiceRequirement } from '../effect/types'
import type { AnyServiceToken, ServiceClass, ServiceRequirements } from '../service'
import type { MaybePromise } from '../utils/types'

/** Runtime-facing provider registration supplied by a Layer backend. */
export interface LayerRegistration {
  /** The class-backed Service token provided by this registration. */
  readonly service: ServiceClass<any, any>

  /** Lazily acquire the Service instance. */
  readonly acquire: () => MaybePromise<unknown>
}

/** Type-level description of one Layer provider and its Service requirements. */
export type LayerSpec<
  Provided extends AnyServiceToken,
  Required extends AnyServiceToken = never
> = {
  /** Service constructor provided by the Layer. */
  readonly provided: Provided
  /** Service constructors required while acquiring the provider. */
  readonly required: Required
}

/** Widened Layer specification used by generic Layer utilities. */
export type AnyLayerSpec = LayerSpec<AnyServiceToken, AnyServiceToken>

/** Generator shape used by `Layer.gen` and `Layer.scopedGen`. */
export type LayerGenerator<
  S extends ServiceClass<any, any>,
  Yield extends ServiceRequirement<AnyServiceToken> = ServiceRequirement<AnyServiceToken>
> = () => AsyncGenerator<Yield, InstanceType<S>, unknown>

/** Service requirements inferred from a provider's methods and generator. */
export type LayerGeneratorRequirements<
  S extends ServiceClass<any, any>,
  Yield extends ServiceRequirement<AnyServiceToken>
> = ServiceRequirements<S> | InferYieldRequirements<Yield>
