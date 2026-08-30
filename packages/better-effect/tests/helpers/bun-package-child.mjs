import { BunEffect } from 'better-effect/bun'

const adapter = BunEffect.make({})

if (adapter.handler === undefined) {
  throw new Error('Packed BunEffect adapter did not expose handler')
}

process.stdout.write(
  `${JSON.stringify({ artifact: 'fresh-packed', subpath: 'better-effect/bun' })}\n`
)
