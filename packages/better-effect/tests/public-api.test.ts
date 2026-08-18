import { expect, test } from 'bun:test'

import * as BetterEffect from '../src'
import * as LayerApi from '../src/layer'

test('exposes Runtime as the managed Layer entry point', () => {
  expect(BetterEffect.Runtime).toBeDefined()
  expect(BetterEffect.Effect.fn).toBeDefined()
  expect(BetterEffect.pipe).toBeDefined()
  expect('buildLayer' in BetterEffect).toBe(false)
  expect('BuiltLayerDisposedError' in BetterEffect).toBe(false)
})

test('does not expose deprecated low-level Layer APIs', () => {
  expect('buildLayer' in LayerApi).toBe(false)
  expect('BuiltLayerDisposedError' in LayerApi).toBe(false)
})
