import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { BunEffect } from '../../src/bun'
import type { BunEffectOptions, BunFetchHandler, BunServer } from '../../src/bun'
import { CurrentAbortSignal, Effect, Layer, Runtime, Service } from '../../src'
import { CurrentRequest } from '../../src/standard-services'

class RootService extends Service<RootService>()('BunTypeRoot') {}
class RequestService extends Service<RequestService>()('BunTypeRequest') {}
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
