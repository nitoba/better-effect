import { expect, test } from 'bun:test'

import * as KyselyEffect from '../src/index.ts'

test('publishes the Service factory and namespace without unrelated exports', () => {
  expect(Object.keys(KyselyEffect).sort()).toEqual(['KyselyEffect'])
  expect(KyselyEffect.KyselyEffect.service).toBeTypeOf('function')
})
