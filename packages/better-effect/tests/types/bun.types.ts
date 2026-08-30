import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { BunEffect } from '../../src/bun'
import type { BunEffectOptions, BunFetchHandler, BunServer } from '../../src/bun'
import { CurrentAbortSignal, Effect, Layer, Runtime, Service } from '../../src'
import { CurrentRequest } from '../../src/standard-services'

class RootService extends Service<RootService>()('BunTypeRoot') {}
class IncompatibleRootService extends Service<IncompatibleRootService>()('BunTypeRoot') {
  readonly incompatible = true
}
class RequestService extends Service<RequestService>()('BunTypeRequest') {}
class OtherRequestService extends Service<OtherRequestService>()('BunTypeOtherRequest') {}
class IncompatibleCurrentRequest extends Service<IncompatibleCurrentRequest>()('CurrentRequest') {
  readonly incompatible = true
}
class MissingService extends Service<MissingService>()('BunTypeMissing') {}
class ExpectedFailure extends Error {
  readonly kind = 'expected' as const
}
class UnexpectedFailure extends Error {
  readonly kind = 'unexpected' as const
}

// SAFETY: This declaration-only fixture never executes a Runtime.
const runtime = {} as Runtime<RootService>

const requestLayer = Layer.gen(RequestService, async function* () {
  const currentRequest = yield* CurrentRequest
  void currentRequest
  return new RequestService()
})

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

const http = BunEffect.make(runtime, options)
const handler = http.handler((request, server) => {
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

expectTypeOf(handler).toEqualTypeOf<BunFetchHandler>()
const serveOptions = { fetch: handler } satisfies Bun.Serve.Options<undefined>
void serveOptions

const incompatibleRootLayer = Layer.succeed(IncompatibleRootService, new IncompatibleRootService())
// @ts-expect-error A request Layer cannot replace a root Service with an incompatible same-tag contract.
const invalidRootCollision = BunEffect.make(runtime, {
  requestLayer: () => incompatibleRootLayer
})
void invalidRootCollision

const incompatibleCurrentRequestLayer = Layer.succeed(
  IncompatibleCurrentRequest,
  new IncompatibleCurrentRequest()
)
// @ts-expect-error A request Layer cannot replace CurrentRequest with an incompatible same-tag contract.
const invalidCurrentRequestCollision = BunEffect.make(runtime, {
  requestLayer: () => incompatibleCurrentRequestLayer
})
void invalidCurrentRequestCollision

const otherRequestLayer = Layer.succeed(OtherRequestService, new OtherRequestService())
const requestLayerUnion = Math.random() > 0.5 ? requestLayer : otherRequestLayer
// @ts-expect-error A concrete request Layer union must be narrowed before the Bun boundary.
const invalidConcreteUnion = BunEffect.make(runtime, {
  requestLayer: () => requestLayerUnion
})
void invalidConcreteUnion

declare const partialRequestLayer: Layer<RequestService, any>
// @ts-expect-error A partially erased request Layer is not an unchecked escape hatch.
const invalidPartialRequestLayer = BunEffect.make(runtime, {
  requestLayer: () => partialRequestLayer
})
void invalidPartialRequestLayer

const erasedRequestLayer: Layer.Any = requestLayer
const uncheckedHttp = BunEffect.make(runtime, {
  requestLayer: () => erasedRequestLayer
})
void uncheckedHttp

const socketHandler = http.handler<{ readonly id: string }>((request, server) => {
  expectTypeOf(request).toEqualTypeOf<Request>()
  expectTypeOf(server).toEqualTypeOf<Bun.Server<{ readonly id: string }>>()

  return Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok(server)
  })
})

expectTypeOf(socketHandler).toEqualTypeOf<BunFetchHandler<{ readonly id: string }>>()

const missingProgram = Effect.fn(async function* () {
  const missing = yield* MissingService
  return Result.ok(missing)
})

// @ts-expect-error Bun handlers must provide every Program Service through the Runtime or request Layer.
const invalidMissing = http.handler(() => missingProgram)
void invalidMissing

// A plain BunEffect annotation must remain safe rather than defaulting its Runtime environment to any.
declare const plainHttp: BunEffect
// @ts-expect-error A plain BunEffect does not erase unavailable Program Services.
const invalidPlainMissing = plainHttp.handler(() => missingProgram)
void invalidPlainMissing

declare const erasedRuntime: Runtime
const erasedHttp = BunEffect.make(erasedRuntime)
const explicitlyErased = erasedHttp.handler(() => missingProgram)
void explicitlyErased

const uncheckedHandler = uncheckedHttp.handler(() => missingProgram)
void uncheckedHandler

const unexpectedProgram = Effect.fn(async function* () {
  yield* Result.await(Promise.resolve(Result.ok(undefined)))
  return Result.err(new UnexpectedFailure())
})

const configuredHttp = BunEffect.make<RootService, ExpectedFailure, typeof requestLayer>(
  runtime,
  options
)

// @ts-expect-error Bun handlers must fit the configured typed failure policy.
const invalidFailure = configuredHttp.handler(() => unexpectedProgram)
void invalidFailure
