import { NextEffect } from 'better-effect/next'

if (NextEffect.make === undefined) {
  throw new Error('better-effect/next did not expose NextEffect.make')
}

if (NextEffect.prototype.handler === undefined) {
  throw new Error('better-effect/next did not expose the handler API')
}

console.log('better-effect/next packed subpath imported successfully')
