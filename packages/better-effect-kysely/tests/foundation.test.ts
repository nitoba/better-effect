import { expect, test } from 'bun:test'

import * as KyselyEffect from '../src/index.ts'

test('the package foundation does not publish unimplemented runtime symbols', () => {
  expect(Object.keys(KyselyEffect)).toEqual([])
})
