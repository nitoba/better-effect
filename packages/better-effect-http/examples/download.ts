import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { HttpClient } from 'better-effect-http'

import { streamResponse, withLocalServer } from './support'

const decoder = new TextDecoder()

await withLocalServer(
  () =>
    streamResponse(['first-chunk\n', 'second-chunk\n'], {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="demo.txt"'
    }),
  async (baseURL) => {
    const runtime = await Runtime.make(HttpClient.layer({ baseURL }))
    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const http = yield* HttpClient
          const chunks: Uint8Array[] = []
          const sink = new WritableStream<Uint8Array>({
            write(chunk) {
              chunks.push(chunk)
            }
          })
          yield* http.stream('/download').pipeTo(sink)
          return Result.ok(chunks.map((chunk) => decoder.decode(chunk)).join(''))
        })
      )

      if (Result.isError(result)) throw result.error
      if (result.value !== 'first-chunk\nsecond-chunk\n') throw new Error('download mismatch')
      console.log(result.value)
    } finally {
      await runtime.dispose()
    }
  }
)
