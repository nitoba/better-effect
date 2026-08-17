import type { InferYieldRequirements, ServiceRequirement } from '../effect/types'
import type {
  AnyService,
  AnyServiceToken,
  ServiceClass,
  ServiceContract,
  ServiceRequirements,
  ServiceTokenOf
} from '../service'
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
  out Provided extends AnyService,
  out Required extends AnyService = never,
  out Token extends AnyServiceToken = ServiceTokenOf<Provided>
> = {
  /** Branded Service instance provided by the Layer. */
  readonly provided: Provided
  /** Branded Service instances required while acquiring the provider. */
  readonly required: Required
  /** Exact constructor retained for registration and override diagnostics. */
  readonly token: Token
}

/** Widened Layer specification used by generic Layer utilities. */
export type AnyLayerSpec = LayerSpec<AnyService, AnyService, AnyServiceToken>

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
