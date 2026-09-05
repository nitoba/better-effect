import { Hono } from 'hono'
import { Result } from 'better-result'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import { CurrentRequest } from 'better-effect/standard-services'

class PackedService extends Service()('PackedHonoService') {
  value() {
    return 'packed'
  }
}

const events = []
const App = HonoEffect.app('@packed/HonoApp', {}, async function* (http) {
  const app = new Hono()

  app.use('*', yield* http.middleware())
  app.use('*', yield* http.middleware())
  app.get(
    '/packed-hono',
    yield* http.gen(async function* () {
      const service = yield* PackedService
      const currentRequest = yield* CurrentRequest
      yield* Result.await(Promise.resolve(Result.ok(undefined)))

      return Result.ok({
        service: service.value(),
        url: currentRequest.request.url
      })
    })
  )

  return app
})
const runtime = await Runtime.make(
  Layer.merge(Layer.succeed(PackedService, new PackedService()), App.layer),
  {
    observers: [
      {
        onExecutionStart: () => events.push('start'),
        onExecutionEnd: () => events.push('end')
      }
    ]
  }
)
const appResult = await runtime.run(
  Effect.fn(async function* () {
    return Result.ok(yield* App)
  })
)
if (Result.isError(appResult))
  throw new Error(`Packed Hono app acquisition failed: ${String(appResult.error)}`)
const app = appResult.value
events.length = 0

try {
  const response = await app.request('/packed-hono')
  const body = await response.json()
  const expected = {
    data: {
      service: 'packed',
      url: 'http://localhost/packed-hono'
    }
  }

  if (
    response.status !== 200 ||
    JSON.stringify(body) !== JSON.stringify(expected) ||
    JSON.stringify(events) !== JSON.stringify(['start', 'end'])
  ) {
    throw new Error(
      `Unexpected packed Hono result: ${JSON.stringify({ response: response.status, body, events })}`
    )
  }

  process.stdout.write(
    `${JSON.stringify({ artifact: process.env.BETTER_EFFECT_EXPECTED_ARTIFACT, status: response.status, events })}\n`
  )
} finally {
  await runtime.dispose()
}
