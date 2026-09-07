import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { HttpClient } from 'better-effect-http'

import { boolean, object, schema, string, streamResponse, withLocalServer } from './support'

const delta = schema((value) => {
  const text = string(object(value)?.['text'])
  return text === undefined ? undefined : { text }
})
const completed = schema((value) => {
  const ok = boolean(object(value)?.['ok'])
  return ok === undefined ? undefined : { ok }
})

await withLocalServer(
  async (request) => {
    if (request.method !== 'POST') return new Response('method must be POST', { status: 405 })
    const body = object(await request.json())
    if (string(body?.['prompt']) !== 'hello') return new Response('bad prompt', { status: 422 })
    return streamResponse(
      [
        'event: delta\ndata: {"text":"hello "}\n\n',
        'event: delta\ndata: {"text":"world"}\n\n',
        'event: completed\ndata: {"ok":true}\n\n'
      ],
      { 'content-type': 'text/event-stream' }
    )
  },
  async (baseURL) => {
    const runtime = await Runtime.make(HttpClient.layer({ baseURL }))
    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const http = yield* HttpClient
          const pieces: string[] = []
          let completedEvent = false
          yield* http
            .sse('/generate', {
              method: 'POST',
              body: { prompt: 'hello' },
              reconnect: false,
              events: { delta, completed }
            })
            .forEach((message) => {
              if (message.event === 'delta') pieces.push(message.data.text)
              if (message.event === 'completed') completedEvent = message.data.ok
              return Result.ok(undefined)
            })
          if (!completedEvent) return Result.err(new Error('generation ended before completed'))
          return Result.ok(pieces.join(''))
        })
      )

      if (Result.isError(result)) throw result.error
      if (result.value !== 'hello world') throw new Error('generation output mismatch')
      console.log(result.value)
    } finally {
      await runtime.dispose()
    }
  }
)
