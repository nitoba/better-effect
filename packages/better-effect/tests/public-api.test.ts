import { expect, test } from 'bun:test'

import * as BetterEffect from '../src'
import * as LayerApi from '../src/layer'

test('exposes Runtime as the managed Layer entry point', () => {
  expect(BetterEffect.Runtime).toBeDefined()
  expect(BetterEffect.MapLayerBackend).toBeDefined()
  expect('empty' in BetterEffect.Layer).toBe(true)
  expect('alias' in BetterEffect.Layer).toBe(true)
  expect(BetterEffect.CurrentAbortSignal).toBeDefined()
  expect(BetterEffect.CircularDependencyError).toBeDefined()
  expect(BetterEffect.ServiceAcquisitionError).toBeDefined()
  expect(BetterEffect.Effect.fn).toBeDefined()
  expect(BetterEffect.Effect.acquireReleaseResult).toBeDefined()
  expect(BetterEffect.Effect.acquireDisposable).toBeDefined()
  expect('scopedDisposable' in BetterEffect.Layer).toBe(true)
  expect(BetterEffect.Effect.tapAsync).toBeDefined()
  expect(BetterEffect.Effect.tapErrorAsync).toBeDefined()
  expect(BetterEffect.Effect.tapBothAsync).toBeDefined()
  expect(BetterEffect.Effect.matchError).toBeDefined()
  expect(BetterEffect.Effect.matchErrorPartial).toBeDefined()
  expect(BetterEffect.Program.named).toBeDefined()
  expect(BetterEffect.Program.all).toBeDefined()
  expect(BetterEffect.Program.forEach).toBeDefined()
  expect(BetterEffect.Program.allResults).toBeDefined()
  expect(BetterEffect.Program.map).toBeDefined()
  expect(BetterEffect.Program.mapError).toBeDefined()
  expect(BetterEffect.Program.andThen).toBeDefined()
  expect(BetterEffect.Program.tap).toBeDefined()
  expect(BetterEffect.Program.tapError).toBeDefined()
  expect(BetterEffect.Program.recover).toBeDefined()
  expect('warmup' in BetterEffect.Runtime.prototype).toBe(true)
  expect(BetterEffect.pipe).toBeDefined()
  expect('buildLayer' in BetterEffect).toBe(false)
  expect('BuiltLayerDisposedError' in BetterEffect).toBe(false)
})

test('does not expose deprecated low-level Layer APIs', () => {
  expect('buildLayer' in LayerApi).toBe(false)
  expect('BuiltLayerDisposedError' in LayerApi).toBe(false)
})
