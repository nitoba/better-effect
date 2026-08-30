import { Hono } from 'hono'
import { Result } from 'better-result'
import { Layer, Runtime, Service } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import { CurrentRequest } from 'better-effect/standard-services'

class PackedService extends Service()('PackedHonoService') {
  value() {
    return 'packed'
  }
}

const events = []
const runtime = await Runtime.make(Layer.succeed(PackedService, new PackedService()), {
  observers: [
    {
      onExecutionStart: () => events.push('start'),
      onExecutionEnd: () => events.push('end')
    }
  ]
})
const http = HonoEffect.make(runtime)
const app = new Hono()

app.use('*', http.middleware())
app.use('*', http.middleware())
app.get(
  '/packed-hono',
  http.gen(async function* () {
    const service = yield* PackedService
    const currentRequest = yield* CurrentRequest
    yield* Result.await(Promise.resolve(Result.ok(undefined)))

    return Result.ok({
      service: service.value(),
      url: currentRequest.request.url
    })
  })
)

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
