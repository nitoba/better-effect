import { expect, test } from 'bun:test'

import * as KyselyEffect from '../src/index.ts'

test('publishes the Service factory and namespace without unrelated exports', () => {
  expect(Object.keys(KyselyEffect).sort()).toEqual([
    'KyselyEffect',
    'KyselyQueryError',
    'KyselyTransactionError'
  ])
  expect(KyselyEffect.KyselyEffect.service).toBeTypeOf('function')
  expect(KyselyEffect.KyselyEffect.execute).toBeTypeOf('function')
  expect(KyselyEffect.KyselyEffect.executeWith).toBeTypeOf('function')
  expect(KyselyEffect.KyselyEffect.executeTakeFirst).toBeTypeOf('function')
  expect(KyselyEffect.KyselyEffect.executeTakeFirstWith).toBeTypeOf('function')
  expect(KyselyEffect.KyselyEffect.executeTakeFirstOrFail).toBeTypeOf('function')
  expect(KyselyEffect.KyselyEffect.executeTakeFirstOrFailWith).toBeTypeOf('function')
  expect(KyselyEffect.KyselyEffect.executeQuery).toBeTypeOf('function')
  expect(KyselyEffect.KyselyEffect.transaction).toBeTypeOf('function')
  expect(KyselyEffect.KyselyQueryError).toBeTypeOf('function')
  expect(KyselyEffect.KyselyTransactionError).toBeTypeOf('function')
})
