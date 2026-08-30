import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { BunEffect } from 'better-effect/bun'
import type { BunFetchHandler, BunServer } from 'better-effect/bun'
import { Effect, Layer, Runtime, Service } from 'better-effect'

class RootService extends Service<RootService>()('PackedBunRoot') {}
class RequestService extends Service<RequestService>()('PackedBunRequest') {}
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

// @ts-expect-error Bun handlers must fit the configured typed failure policy.
const invalidFailure = http.handler(() => unexpectedProgram)
void invalidFailure
