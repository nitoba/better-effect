import { expect, test } from 'bun:test'

import * as publicApi from '../src'

test('does not publish provisional runtime symbols', () => {
  expect(Object.keys(publicApi)).toEqual([])
})
