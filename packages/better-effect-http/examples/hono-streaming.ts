import { Hono } from 'hono'
import { Effect, Layer, Runtime } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import type { WebEffectStream } from 'better-effect/web'
import { Result } from 'better-result'
import { HttpClient } from 'better-effect-http'
import { HttpTest } from 'better-effect-http/testing'

let releaseTail: (() => void) | undefined
const tail = new Promise<void>((resolve) => {
  releaseTail = resolve
})
let upstreamCancelled = false
const upstream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('head'))
    void tail.then(() => {
      if (upstreamCancelled) return
      controller.enqueue(new TextEncoder().encode('tail'))
      controller.close()
    })
  },
  cancel() {
    upstreamCancelled = true
  }
})
const scenario = HttpTest.sequence([
  HttpTest.stream(upstream, 200, { 'content-type': 'application/octet-stream' })
])

const StreamingApp = HonoEffect.app('@example/HonoStreaming', {}, async function* (routes) {
  const app = new Hono()
  app.use('*', yield* routes.middleware())
  app.get(
    '/proxy',
    yield* routes.stream(
      Effect.fn(async function* () {
        const http = yield* HttpClient
        const source = http.stream('/download')
        const stream: WebEffectStream = {
          headers: { 'content-type': 'application/octet-stream' },
          producer: async function* () {
            for await (const item of source.results()) {
              if (Result.isError(item)) throw item.error
              yield item.value
            }
          }
        }
        return Result.ok(stream)
      })
    )
  )
  return app
})

const runtime = await Runtime.make(
  Layer.merge(HttpClient.layer({ fetch: scenario.fetch }), StreamingApp.layer)
)
try {
  const appResult = await runtime.run(
    Effect.fn(async function* () {
      return Result.ok(yield* StreamingApp)
    })
  )
  if (Result.isError(appResult)) throw appResult.error

  const response = await appResult.value.request('/proxy')
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('proxy did not return a body')
  const first = await reader.read()
  if (new TextDecoder().decode(first.value) !== 'head') throw new Error('proxy buffered upstream')
  await reader.cancel(new Error('client disconnected'))
  await Promise.resolve()
  if (!upstreamCancelled) throw new Error('downstream cancellation did not reach upstream')
  console.log('proxy forwarded the first chunk and closed the upstream on cancel')
} finally {
  releaseTail?.()
  await runtime.dispose()
}
