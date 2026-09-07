import { expect, test } from 'bun:test'

import * as Http from '../src/index.ts'

test('the initial entrypoint has no placeholder HTTP API', () => {
  expect(Object.keys(Http)).toEqual([])
})
