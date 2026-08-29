import { expect, test } from 'bun:test'

import * as core from '../../src/index'
import * as testing from '../../src/testing/index'

test('the core entrypoint is inert and exposes no provisional APIs', () => {
  expect(Object.keys(core)).toEqual([])
})

test('the testing entrypoint is inert and exposes no provisional APIs', () => {
  expect(Object.keys(testing)).toEqual([])
})
