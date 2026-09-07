import * as Http from 'better-effect-http'
import { HttpTest } from 'better-effect-http/testing'
import { Effect, Layer, Runtime } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import { Hono } from 'hono'
import { Result } from 'better-result'
import packageJson from 'better-effect-http/package.json' with { type: 'json' }

for (const exportName of ['HttpRequest', 'HttpRequestError', 'HttpClient', 'validateHttpOptions']) {
  if (!(exportName in Http)) {
    throw new Error(`Missing public HTTP foundation export: ${exportName}`)
  }
}

if (packageJson.name !== 'better-effect-http' || packageJson.version !== '0.1.0') {
  throw new Error('The packed HTTP package manifest is not the expected artifact')
}

const scenario = HttpTest.sequence([HttpTest.response(200, { ok: true })])
const response = await scenario.fetch('https://example.test/health')
if (response.status !== 200 || scenario.calls !== 1) {
  throw new Error('The packed HTTP testing subpath is not functional')
}

const encoder = new TextEncoder()
let releaseProxyTail
const proxyTail = new Promise((resolve) => {
  releaseProxyTail = resolve
})
let proxyCancelled = false
const proxyBody = new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode('proxy-head'))
    void proxyTail.then(() => {
      if (proxyCancelled) return
      controller.enqueue(encoder.encode('-proxy-tail'))
      controller.close()
    })
  },
  cancel() {
    proxyCancelled = true
  }
})

const streamingScenario = HttpTest.sequence([
  HttpTest.stream(proxyBody, 200, { 'content-type': 'application/octet-stream' }),
  HttpTest.text(
    200,
    'event: progress\ndata: {"percent":50}\n\nevent: completed\ndata: {"ok":true}\n\n',
    {
      headers: { 'content-type': 'text/event-stream' },
      match: { method: 'GET', url: '/events' }
    }
  ),
  HttpTest.text(
    200,
    'event: delta\ndata: {"text":"hello"}\n\nevent: completed\ndata: {"text":"hello"}\n\n',
    {
      headers: { 'content-type': 'text/event-stream' },
      match: { method: 'POST', url: '/generate' }
    }
  )
])

const streamFromHttp = (upstream, headers, stopAtCompleted = false, isSse = false) =>
  Result.ok({
    headers,
    producer: async function* () {
      let completed = false
      for await (const item of upstream.results()) {
        if (Result.isError(item)) throw item.error
        const message = item.value
        if (!isSse) {
          yield message
          continue
        }
        yield encoder.encode(`event: ${message.event}\ndata: ${message.data}\n\n`)
        if (stopAtCompleted && message.event === 'completed') {
          completed = true
          break
        }
      }
      if (stopAtCompleted && !completed) throw new Error('stream ended before completed')
    }
  })

const streamApp = HonoEffect.app('@external/HonoHttpStreaming', {}, async function* (routes) {
  const app = new Hono()
  app.use('*', yield* routes.middleware())

  app.get(
    '/proxy',
    yield* routes.stream(
      Effect.fn(async function* () {
        const http = yield* Http.HttpClient
        return streamFromHttp(http.stream('/download'), {
          'content-type': 'application/octet-stream'
        })
      })
    )
  )

  app.get(
    '/events',
    yield* routes.stream(
      Effect.fn(async function* () {
        const http = yield* Http.HttpClient
        return streamFromHttp(
          http.sse('/events'),
          { 'content-type': 'text/event-stream; charset=utf-8' },
          true,
          true
        )
      })
    )
  )

  app.post(
    '/generate',
    yield* routes.stream(
      Effect.fn(async function* () {
        const http = yield* Http.HttpClient
        return streamFromHttp(
          http.sse('/generate', {
            method: 'POST',
            body: { prompt: 'hello' },
            reconnect: false
          }),
          { 'content-type': 'text/event-stream; charset=utf-8' },
          true,
          true
        )
      })
    )
  )

  return app
})

const streamingRuntime = await Runtime.make(
  Layer.merge(Http.HttpClient.layer({ fetch: streamingScenario.fetch }), streamApp.layer)
)

try {
  const streamAppResult = await streamingRuntime.run(
    Effect.fn(async function* () {
      return Result.ok(yield* streamApp)
    })
  )
  if (Result.isError(streamAppResult)) throw streamAppResult.error
  const streamingResponseApp = streamAppResult.value

  const proxyResponse = await streamingResponseApp.request('/proxy')
  if (
    proxyResponse.status !== 200 ||
    proxyResponse.headers.get('content-type') !== 'application/octet-stream'
  ) {
    throw new Error('Packed Hono proxy did not preserve its explicit response policy')
  }
  const proxyReader = proxyResponse.body?.getReader()
  if (!proxyReader) throw new Error('Packed Hono proxy did not return a body')
  const proxyHead = await proxyReader.read()
  if (new TextDecoder().decode(proxyHead.value) !== 'proxy-head') {
    throw new Error('Packed Hono proxy buffered or changed the first upstream chunk')
  }
  releaseProxyTail()
  const proxyTailChunk = await proxyReader.read()
  if (new TextDecoder().decode(proxyTailChunk.value) !== '-proxy-tail') {
    throw new Error('Packed Hono proxy did not forward the final upstream chunk')
  }
  if (!(await proxyReader.read()).done) throw new Error('Packed Hono proxy did not finish')

  const eventsResponse = await streamingResponseApp.request('/events')
  const eventsBody = await eventsResponse.text()
  if (!eventsBody.includes('event: progress') || !eventsBody.includes('{"percent":50}')) {
    throw new Error(
      `Packed Hono SSE progress route did not serialize its event: ${eventsResponse.status} ${eventsBody}`
    )
  }

  const generationResponse = await streamingResponseApp.request('/generate', { method: 'POST' })
  const generationBody = await generationResponse.text()
  if (!generationBody.includes('event: delta') || !generationBody.includes('event: completed')) {
    throw new Error('Packed Hono POST generation route did not reach its business terminal')
  }
  const generationRequest = streamingScenario.history[2]
  if (
    generationRequest?.method !== 'POST' ||
    generationRequest.init?.body !== '{"prompt":"hello"}'
  ) {
    throw new Error('Packed Hono POST generation route did not send its request body')
  }
} finally {
  releaseProxyTail()
  await streamingRuntime.dispose()
}

console.log(`better-effect-http external consumer passed with ${packageJson.version}`)
