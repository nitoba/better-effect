import { Result } from 'better-result'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { CurrentRequest } from 'better-effect/standard-services'
import { WebEffect } from 'better-effect/web'

class RequestId extends Service()('PackedWebRequestId') {}

const runtime = await Runtime.make(Layer.empty)
let requestLayerCalls = 0
let released = 0

try {
  const response = await WebEffect.handle(
    runtime,
    new Request('https://example.test/packed-web'),
    Effect.fn(async function* () {
      const currentRequest = yield* CurrentRequest
      const requestId = yield* RequestId

      return Result.ok({
        url: currentRequest.request.url,
        requestId
      })
    }),
    {
      requestLayer: () => {
        requestLayerCalls += 1
        return Layer.scoped(
          RequestId,
          () => new RequestId(),
          () => {
            released += 1
          }
        )
      },
      onSuccess: ({ value }) => Response.json({ data: value })
    }
  )

  const body = await response.json()

  if (
    response.status !== 200 ||
    JSON.stringify(body) !==
      JSON.stringify({
        data: {
          url: 'https://example.test/packed-web',
          requestId: {}
        }
      }) ||
    requestLayerCalls !== 1 ||
    released !== 1
  ) {
    throw new Error(
      `Unexpected packed WebEffect result: ${JSON.stringify({ response: response.status, body, requestLayerCalls, released })}`
    )
  }

  process.stdout.write(
    `${JSON.stringify({ artifact: process.env.BETTER_EFFECT_EXPECTED_ARTIFACT, status: response.status, requestLayerCalls, released })}\n`
  )
} finally {
  await runtime.dispose()
}
