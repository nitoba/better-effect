import { expect, test } from 'bun:test'

import * as publicApi from '../src'
import * as honoApi from '../src/hono'

test('publishes only the implemented runtime API', () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    'BetterAuth',
    'BetterAuthApiError',
    'Unauthenticated'
  ])
  expect(Object.keys(honoApi).sort()).toEqual(['BetterAuthHono'])
})
