import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { BunEffect } from '../../src/bun'
import type {
  BunEffectLayer,
  BunEffectOperation,
  BunEffectOptions,
  BunFetchHandler,
  BunServer,
  BunServerToken
} from '../../src/bun'
import type { InferGeneratorYield } from '../../src/bun/types'
import { CurrentAbortSignal, Effect, Layer, Runtime, Service } from '../../src'
import { CurrentRequest } from '../../src/standard-services'

class RootService extends Service<RootService>()('BunTypeRoot') {}
class RequestService extends Service<RequestService>()('BunTypeRequest') {}
class OtherRequestService extends Service<OtherRequestService>()('BunTypeOtherRequest') {}
class IncompatibleCurrentRequest extends Service<IncompatibleCurrentRequest>()('CurrentRequest') {
  readonly incompatible = true
}
class MissingService extends Service<MissingService>()('BunTypeMissing') {}

class HandlerService extends Service<HandlerService>()('BunTypeHandler') {
  declare readonly handler: BunFetchHandler
}

class CustomServerService extends Service<CustomServerService>()('BunTypeCustomServer') {
  declare readonly server: BunServer
}

class ExpectedFailure extends Error {
  readonly kind = 'expected' as const
}

class UnexpectedFailure extends Error {
  readonly kind = 'unexpected' as const
}

const requestLayer = Layer.succeed(RequestService, new RequestService())

const options: BunEffectOptions<ExpectedFailure, typeof requestLayer> = {
  requestLayer: (request) => {
    expectTypeOf(request).toEqualTypeOf<Request>()
    return requestLayer
  },
  onSuccess: ({ value }, request) => {
    expectTypeOf(value).toEqualTypeOf<unknown>()
    expectTypeOf(request).toEqualTypeOf<Request>()
    return Response.json(value)
  },
  onFailure: (error, request) => {
    expectTypeOf(error).toEqualTypeOf<ExpectedFailure>()
    expectTypeOf(request).toEqualTypeOf<Request>()
    return Response.json({ error: error.message }, { status: 422 })
  }
}

const handlerOperation = BunEffect.handler(options, (request, server) => {
  expectTypeOf(request).toEqualTypeOf<Request>()
  expectTypeOf(server).toEqualTypeOf<BunServer>()

  return Effect.fn(async function* () {
    const root = yield* RootService
    const requestValue = yield* RequestService
    const currentRequest = yield* CurrentRequest
    const signal = yield* CurrentAbortSignal

    return Result.ok({ root, requestValue, currentRequest, signal })
  })
})

expectTypeOf(handlerOperation).toEqualTypeOf<BunEffectOperation<BunFetchHandler, RootService>>()

const handlerLayer = Layer.gen(HandlerService, async function* () {
  const handler = yield* handlerOperation
  return HandlerService.of({ handler })
})

expectTypeOf<Layer.Required<typeof handlerLayer>>().toEqualTypeOf<RootService>()

const runtimeLayer = Layer.merge(Layer.succeed(RootService, new RootService()), handlerLayer)
void Runtime.make(runtimeLayer)

const socketHandler = BunEffect.handler<{ readonly id: string }>((request, server) => {
  expectTypeOf(request).toEqualTypeOf<Request>()
  expectTypeOf(server).toEqualTypeOf<Bun.Server<{ readonly id: string }>>()

  return Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok(server)
  })
})

expectTypeOf<Layer.Provided<typeof handlerLayer>>().toEqualTypeOf<
  InstanceType<typeof HandlerService>
>()
expectTypeOf(socketHandler).toEqualTypeOf<
  BunEffectOperation<BunFetchHandler<{ readonly id: string }>, never>
>()

declare const fetchHandler: BunFetchHandler
const serveOptions = { fetch: fetchHandler } satisfies Bun.Serve.Options<undefined>
void serveOptions

const incompatibleCurrentRequestLayer = Layer.succeed(
  IncompatibleCurrentRequest,
  new IncompatibleCurrentRequest()
)
const invalidCurrentRequestCollision = BunEffect.handler(
  // @ts-expect-error A request Layer cannot replace CurrentRequest with an incompatible contract.
  { requestLayer: () => incompatibleCurrentRequestLayer },
  () =>
    // oxlint-disable-next-line require-yield -- this negative fixture keeps the generator-shaped handler API.
    Effect.fn(async function* () {
      return Result.ok(undefined)
    })
)
void invalidCurrentRequestCollision

const otherRequestLayer = Layer.succeed(OtherRequestService, new OtherRequestService())
const requestLayerUnion = Math.random() > 0.5 ? requestLayer : otherRequestLayer
// @ts-expect-error A concrete request Layer union must be narrowed before the Bun boundary.
const invalidConcreteUnion = BunEffect.handler({ requestLayer: () => requestLayerUnion }, () =>
  // oxlint-disable-next-line require-yield -- this negative fixture keeps the generator-shaped handler API.
  Effect.fn(async function* () {
    return Result.ok(undefined)
  })
)
void invalidConcreteUnion

declare const partialRequestLayer: Layer<RequestService, any>
const invalidPartialRequestLayer = BunEffect.handler(
  // @ts-expect-error A partially erased request Layer is not an unchecked escape hatch.
  { requestLayer: () => partialRequestLayer },
  () =>
    // oxlint-disable-next-line require-yield -- this negative fixture keeps the generator-shaped handler API.
    Effect.fn(async function* () {
      return Result.ok(undefined)
    })
)
void invalidPartialRequestLayer

const erasedRequestLayer: Layer.Any = requestLayer
const uncheckedOperation = BunEffect.handler({ requestLayer: () => erasedRequestLayer }, () =>
  // oxlint-disable-next-line require-yield -- this fixture keeps the generator-shaped handler API.
  Effect.fn(async function* () {
    return Result.ok(undefined)
  })
)
void uncheckedOperation

const missingProgram = Effect.fn(async function* () {
  const missing = yield* MissingService
  return Result.ok(missing)
})

const invalidMissingLayer = Layer.gen(HandlerService, async function* () {
  const handler = yield* BunEffect.handler(() => missingProgram)
  return HandlerService.of({ handler })
})
expectTypeOf<Layer.Required<typeof invalidMissingLayer>>().toEqualTypeOf<MissingService>()
// @ts-expect-error Bun handlers must provide every Program Service through the enclosing Layer.
void Runtime.make(invalidMissingLayer)

// @ts-expect-error The old Runtime-first BunEffect.make API was removed.
void BunEffect.make

declare const explicitlyErasedRuntime: Runtime
void explicitlyErasedRuntime

const unexpectedProgram = Effect.fn(async function* () {
  yield* Result.await(Promise.resolve(Result.ok(undefined)))
  return Result.err(new UnexpectedFailure())
})

const invalidFailureLayer = Layer.gen(HandlerService, async function* () {
  // @ts-expect-error Bun handlers must fit the configured typed failure policy.
  const handler = yield* BunEffect.handler(options, () => unexpectedProgram)
  return HandlerService.of({ handler })
})
void invalidFailureLayer

const bunServerFactory = async function* () {
  const root = yield* RootService
  void root

  return {
    port: 0,
    fetch: () => new Response('ok'),
    websocket: {
      message: (socket, message) => {
        expectTypeOf(socket.data).toEqualTypeOf<{ readonly id: string }>()
        expectTypeOf(message).toMatchTypeOf<string | ArrayBuffer | Buffer>()
      }
    }
  } satisfies Bun.Serve.Options<{ readonly id: string }>
}

expectTypeOf<InferGeneratorYield<typeof bunServerFactory>>().toEqualTypeOf<
  import('../../src/effect').ServiceRequirement<RootService>
>()

const BunServer = BunEffect.server<
  '@types/BunServer',
  { readonly id: string },
  string,
  typeof bunServerFactory
>('@types/BunServer', bunServerFactory)

expectTypeOf(BunServer).toMatchTypeOf<
  BunServerToken<
    '@types/BunServer',
    { readonly id: string },
    string,
    import('../../src/effect').ServiceRequirement<RootService>
  >
>()
expectTypeOf<InferGeneratorYield<typeof BunServer>>().toBeNever()
declare const providedServer: Layer.Provided<typeof BunServer.layer>
const typedServer: BunServer<{ readonly id: string }> = providedServer
void typedServer
expectTypeOf<Layer.Required<typeof BunServer.layer>>().toEqualTypeOf<RootService>()

const InferredBunServer = BunEffect.server('@types/InferredBunServer', bunServerFactory)
declare const inferredProvidedServer: Layer.Provided<typeof InferredBunServer.layer>
const inferredTypedServer: BunServer<{ readonly id: string }> = inferredProvidedServer
void inferredTypedServer

// oxlint-disable-next-line require-yield -- this fixture keeps the generator-shaped Layer API.
const customServerLayer = BunEffect.layer(CustomServerService, async function* () {
  return {
    options: { port: 0, fetch: () => new Response('ok') },
    map: (server: BunServer) => CustomServerService.of({ server })
  }
})

expectTypeOf(customServerLayer).toMatchTypeOf<BunEffectLayer<typeof CustomServerService, never>>()
expectTypeOf<Layer.Provided<typeof customServerLayer>>().toEqualTypeOf<
  InstanceType<typeof CustomServerService>
>()
expectTypeOf<Layer.Required<typeof customServerLayer>>().toBeNever()

// @ts-expect-error BunEffect.layer must return the contract of its Service token.
// oxlint-disable-next-line require-yield -- this negative fixture keeps the generator-shaped Layer API.
BunEffect.layer(CustomServerService, async function* () {
  return { options: { port: 0, fetch: () => new Response('ok') }, map: () => ({}) }
})
