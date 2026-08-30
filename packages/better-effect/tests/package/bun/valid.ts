import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { BunEffect } from 'better-effect/bun'
import type { BunFetchHandler, BunServer } from 'better-effect/bun'
import { Effect, Layer, Runtime, Service } from 'better-effect'

class RootService extends Service<RootService>()('PackedBunRoot') {}
class IncompatibleRootService extends Service<IncompatibleRootService>()('PackedBunRoot') {
  readonly incompatible = true
}
class RequestService extends Service<RequestService>()('PackedBunRequest') {}
class OtherRequestService extends Service<OtherRequestService>()('PackedBunOtherRequest') {}
class IncompatibleCurrentRequest extends Service<IncompatibleCurrentRequest>()('CurrentRequest') {
  readonly incompatible = true
}
class MissingService extends Service<MissingService>()('PackedBunMissing') {}
class ExpectedFailure extends Error {
  readonly kind = 'expected' as const
}
class UnexpectedFailure extends Error {
  readonly kind = 'unexpected' as const
}

// SAFETY: This declaration-only fixture never executes a Runtime.
const runtime = {} as Runtime<RootService>
const requestLayer = Layer.succeed(RequestService, new RequestService())
const http = BunEffect.make<RootService, ExpectedFailure, typeof requestLayer>(runtime, {
  requestLayer: () => requestLayer,
  onFailure: (error, request) => {
    expectTypeOf(error).toEqualTypeOf<ExpectedFailure>()
    expectTypeOf(request).toEqualTypeOf<Request>()
    return new Response(error.message)
  }
})

const handler = http.handler((request, server) => {
  expectTypeOf(request).toEqualTypeOf<Request>()
  expectTypeOf(server).toEqualTypeOf<BunServer>()

  return Effect.fn(async function* () {
    const root = yield* RootService
    const requestValue = yield* RequestService
    return Result.ok({ root, requestValue })
  })
})

expectTypeOf(handler).toEqualTypeOf<BunFetchHandler>()
const options = { fetch: handler } satisfies Bun.Serve.Options<undefined>
void options

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

const missingProgram = Effect.fn(async function* () {
  const missing = yield* MissingService
  return Result.ok(missing)
})

// @ts-expect-error Bun handlers must provide every Program Service through the Runtime or request Layer.
const invalidMissing = http.handler(() => missingProgram)
void invalidMissing

// A plain BunEffect annotation must not erase unavailable Program Services.
declare const plainHttp: BunEffect
// @ts-expect-error A plain BunEffect does not default to an unchecked environment.
const invalidPlainMissing = plainHttp.handler(() => missingProgram)
void invalidPlainMissing

// SAFETY: Declaration-only fixture intentionally models an explicitly erased Runtime boundary.
const explicitlyErasedRuntime = {} as Runtime
const explicitlyErasedHttp = BunEffect.make(explicitlyErasedRuntime)
const explicitlyErasedHandler = explicitlyErasedHttp.handler(() => missingProgram)
void explicitlyErasedHandler

const uncheckedHandler = uncheckedHttp.handler(() => missingProgram)
void uncheckedHandler

const unexpectedProgram = Effect.fn(async function* () {
  yield* Result.await(Promise.resolve(Result.ok(undefined)))
  return Result.err(new UnexpectedFailure())
})

// @ts-expect-error Bun handlers must fit the configured typed failure policy.
const invalidFailure = http.handler(() => unexpectedProgram)
void invalidFailure
