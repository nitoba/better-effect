import { expect, test } from 'bun:test'

import * as publicApi from '../src'

test('publishes only the implemented runtime API', () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    'BetterAuth',
    'BetterAuthApiError',
    'Unauthenticated'
  ])
})
