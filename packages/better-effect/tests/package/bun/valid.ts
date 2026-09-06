import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { BunEffect } from 'better-effect/bun'
import type { BunEffectOperation, BunFetchHandler, BunServer } from 'better-effect/bun'
import { Effect, Layer, Runtime, Service } from 'better-effect'

class RootService extends Service<RootService>()('PackedBunRoot') {}
class MissingService extends Service<MissingService>()('PackedBunMissing') {}

class HandlerService extends Service<HandlerService>()('PackedBunHandler') {
  declare readonly handler: BunFetchHandler
}

const operation = BunEffect.handler((request, server) => {
  expectTypeOf(request).toEqualTypeOf<Request>()
  expectTypeOf(server).toEqualTypeOf<BunServer>()

  return Effect.fn(async function* () {
    const root = yield* RootService
    return Result.ok({ root, url: request.url, port: server.port })
  })
})

expectTypeOf(operation).toEqualTypeOf<BunEffectOperation<BunFetchHandler, RootService>>()

const handlerLayer = Layer.gen(HandlerService, async function* () {
  const handler = yield* operation
  return HandlerService.of({ handler })
})

const runtimeLayer = Layer.merge(Layer.succeed(RootService, new RootService()), handlerLayer)
void Runtime.make(runtimeLayer)

// oxlint-disable-next-line require-yield -- this package fixture keeps the generator-shaped server API.
const serverToken = BunEffect.server('@package/PackedBunServer', async function* () {
  return {
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('packed')
  }
})

declare const providedServer: Layer.Provided<typeof serverToken.layer>
const typedServer: BunServer = providedServer
void typedServer
void serverToken

const missingLayer = Layer.gen(HandlerService, async function* () {
  const handler = yield* BunEffect.handler(() =>
    Effect.fn(async function* () {
      const missing = yield* MissingService
      return Result.ok(missing)
    })
  )
  return HandlerService.of({ handler })
})

// @ts-expect-error The packed Bun entrypoint preserves missing Service requirements.
void Runtime.make(missingLayer)

// @ts-expect-error The old Runtime-first BunEffect.make API was removed.
void BunEffect.make
