import { expect, test } from 'bun:test'

import * as publicApi from '../src'

test('publishes only the implemented runtime error constructors', () => {
  expect(Object.keys(publicApi).sort()).toEqual(['BetterAuthApiError', 'Unauthenticated'])
})
