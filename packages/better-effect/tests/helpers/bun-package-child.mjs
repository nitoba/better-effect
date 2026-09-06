import { Result } from 'better-result'

import { BunEffect } from 'better-effect/bun'
import { Effect, Runtime, ServiceRuntime } from 'better-effect'

const serverToken = BunEffect.server('@package/PackedBunServer', async function* () {
  const fetch = yield* BunEffect.handler(() =>
    // oxlint-disable-next-line require-yield -- the packed smoke program intentionally needs no Services.
    Effect.fn(async function* () {
      return Result.ok(new Response('packed BunEffect', { status: 201 }))
    })
  )

  return {
    hostname: '127.0.0.1',
    port: 0,
    fetch
  }
})

const runtime = await Runtime.make(serverToken.layer)
const server = await runtime.run(() => ServiceRuntime.resolve(serverToken))

try {
  if (server.port === undefined) {
    throw new Error('Bun did not allocate an ephemeral port')
  }

  const response = await fetch(`http://127.0.0.1:${server.port}/smoke`)

  if (response.status !== 201 || (await response.text()) !== 'packed BunEffect') {
    throw new Error('Packed BunEffect adapter did not execute through Bun.serve')
  }
} finally {
  await runtime.dispose()
}

process.stdout.write(
  `${JSON.stringify({ artifact: 'fresh-packed', subpath: 'better-effect/bun', invoked: true })}\n`
)
