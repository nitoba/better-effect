import { Result } from 'better-result'

import { BunEffect } from 'better-effect/bun'
import { Effect, Layer, Runtime } from 'better-effect'

const runtime = await Runtime.make(Layer.empty)
const adapter = BunEffect.make(runtime)
const handler = adapter.handler(() =>
  Effect.fn(async function* () {
    yield* []
    return Result.ok(new Response('packed BunEffect', { status: 201 }))
  })
)
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: handler
})

try {
  if (server.port === undefined) {
    throw new Error('Bun did not allocate an ephemeral port')
  }

  const response = await fetch(`http://127.0.0.1:${server.port}/smoke`)

  if (response.status !== 201 || (await response.text()) !== 'packed BunEffect') {
    throw new Error('Packed BunEffect adapter did not execute through Bun.serve')
  }
} finally {
  await server.stop()
  await runtime.dispose()
}

process.stdout.write(
  `${JSON.stringify({ artifact: 'fresh-packed', subpath: 'better-effect/bun', invoked: true })}\n`
)
