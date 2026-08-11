import { expect, test } from 'bun:test'

import * as BetterEffect from '../src'

test('exposes Runtime as the managed Layer entry point', () => {
  expect(BetterEffect.Runtime).toBeDefined()
  expect('buildLayer' in BetterEffect).toBe(false)
})
