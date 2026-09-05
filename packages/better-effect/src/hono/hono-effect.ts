import type { InferYieldRequirements, ServiceRequirement } from '../effect/types'
import { Layer } from '../layer'
import type { LayerInput, LayerResult } from '../layer/inference'
import { Service } from '../service'
import type {
  AnyService,
  ServiceContract,
  ServiceIdentity,
  ServiceRequirements,
  ServiceToken
} from '../service'

import { HonoEffectBuilder } from './builder'
import type { DefaultRequestLayer, HonoEffectOptions, HonoRequestLayerChecks } from './types'

type HonoFactoryFor<Builder, Returned extends object> = (
  http: Builder
) =>
  | Generator<ServiceRequirement<unknown>, Returned, unknown>
  | AsyncGenerator<ServiceRequirement<unknown>, Returned, unknown>

type HonoFactory<Builder> = HonoFactoryFor<Builder, object>

type HonoFactoryReturn<Factory> = Factory extends (...arguments_: any[]) => infer Iterator
  ? Iterator extends Generator<any, infer Returned, any>
    ? Returned extends object
      ? Returned
      : never
    : Iterator extends AsyncGenerator<any, infer Returned, any>
      ? Returned extends object
        ? Returned
        : never
      : never
  : never

type HonoFactoryYield<Factory> = Factory extends (...arguments_: any[]) => infer Iterator
  ? Iterator extends Generator<infer Yield, object, any>
    ? Yield
    : Iterator extends AsyncGenerator<infer Yield, object, any>
      ? Yield
      : never
  : never

type HonoLayerResult<
  Service extends ServiceToken<any, any>,
  Yield extends ServiceRequirement<unknown>
> = LayerResult<
  import('../layer/metadata').ProviderEntry<
    InstanceType<Service>,
    Extract<ServiceRequirements<InstanceType<Service>> | InferYieldRequirements<Yield>, AnyService>
  >
>

type HonoApplicationToken<
  Tag extends string,
  App extends object,
  AppLayer extends LayerInput
> = ServiceToken<Tag, App & ServiceIdentity<Tag>> & {
  readonly layer: AppLayer
}

type HonoLiteralTag<Tag extends string> = string extends Tag ? never : Tag extends '' ? never : Tag

const defineLayerProperty = <Token extends object, AppLayer extends LayerInput>(
  token: Token,
  layer: AppLayer
): Token & { readonly layer: AppLayer } => {
  Object.defineProperty(token, 'layer', {
    configurable: false,
    enumerable: true,
    value: layer,
    writable: false
  })

  // SAFETY: The property was defined above as a non-writable value with the exact Layer type.
  return token as Token & { readonly layer: AppLayer }
}

const makeHonoLayer = <
  Service extends ServiceToken<any, any>,
  Failure,
  RequestLayer extends LayerInput,
  Factory extends HonoFactory<HonoEffectBuilder<Failure, RequestLayer>>
>(
  service: Service,
  options: HonoEffectOptions<Failure, RequestLayer>,
  factory: Factory
): HonoLayerResult<Service, Extract<HonoFactoryYield<Factory>, ServiceRequirement<unknown>>> => {
  const layer = Layer.gen(service, () => {
    const builder = new HonoEffectBuilder(options)

    // SAFETY: the public factory is constrained to a Hono Service contract; this erasure only adapts it to Layer.gen's runtime-erased provider storage.
    return factory(builder) as Generator<
      ServiceRequirement<unknown>,
      ServiceContract<InstanceType<Service>>,
      unknown
    >
  })

  // SAFETY: Layer.gen derives the same provider requirements from the factory's yield metadata.
  return layer as HonoLayerResult<
    Service,
    Extract<HonoFactoryYield<Factory>, ServiceRequirement<unknown>>
  >
}

/** Layer-first Hono integration. The application owns the Runtime composition. */
export class HonoEffect {
  private constructor() {}

  /** Create a yieldable Hono application token and its Layer. */
  static app<
    const Tag extends string,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Failure = unknown,
    const Factory extends HonoFactory<HonoEffectBuilder<Failure, RequestLayer>> = HonoFactory<
      HonoEffectBuilder<Failure, RequestLayer>
    >
  >(
    tag: Tag & HonoLiteralTag<Tag>,
    options: HonoEffectOptions<Failure, RequestLayer> & HonoRequestLayerChecks<RequestLayer>,
    factory: Factory
  ): HonoApplicationToken<
    Tag,
    HonoFactoryReturn<Factory>,
    HonoLayerResult<
      ServiceToken<Tag, HonoFactoryReturn<Factory> & ServiceIdentity<Tag>>,
      Extract<HonoFactoryYield<Factory>, ServiceRequirement<unknown>>
    >
  > {
    const literalTag: HonoLiteralTag<Tag> = tag
    const tokenFactory = Service<HonoFactoryReturn<Factory> & ServiceIdentity<Tag>>()<Tag>
    // SAFETY: Service's factory returns the class-backed token; this assertion restores the precise application instance contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the Service factory erases only the application instance contract.
    const token = tokenFactory(literalTag) as unknown as ServiceToken<
      Tag,
      HonoFactoryReturn<Factory> & ServiceIdentity<Tag>
    >
    const layer = makeHonoLayer(token, options, factory)

    // SAFETY: The token and Layer were created together above and the return type mirrors both exact values.
    return defineLayerProperty(token, layer) as HonoApplicationToken<
      Tag,
      HonoFactoryReturn<Factory>,
      HonoLayerResult<
        ServiceToken<Tag, HonoFactoryReturn<Factory> & ServiceIdentity<Tag>>,
        Extract<HonoFactoryYield<Factory>, ServiceRequirement<unknown>>
      >
    >
  }

  /** Provide an application-chosen Service token with a Hono Layer. */
  static layer<
    Service extends ServiceToken<any, any>,
    RequestLayer extends LayerInput = DefaultRequestLayer,
    Failure = unknown,
    const Returned extends ServiceContract<InstanceType<Service>> = ServiceContract<
      InstanceType<Service>
    >,
    const Factory extends HonoFactoryFor<HonoEffectBuilder<Failure, RequestLayer>, Returned> =
      HonoFactoryFor<HonoEffectBuilder<Failure, RequestLayer>, Returned>
  >(
    service: Service,
    options: HonoEffectOptions<Failure, RequestLayer> & HonoRequestLayerChecks<RequestLayer>,
    factory: Factory
  ): HonoLayerResult<Service, Extract<HonoFactoryYield<Factory>, ServiceRequirement<unknown>>> {
    return makeHonoLayer(service, options, factory)
  }
}
