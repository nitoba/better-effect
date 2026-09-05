import { NextEffect } from 'better-effect/next'

if (NextEffect.managed === undefined || NextEffect.fromCurrent === undefined) {
  throw new Error('better-effect/next did not expose both ownership modes')
}

if (NextEffect.make !== undefined) {
  throw new Error('better-effect/next exposed the removed legacy make API')
}

console.log('better-effect/next packed subpath imported successfully')
