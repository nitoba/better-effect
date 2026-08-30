import { describe, expect, test } from 'bun:test'
import { APIError } from 'better-auth/api'

import { BetterAuthApiError, Unauthenticated } from '../src'

const makeApiError = () => {
  const headers = new Headers({
    'set-cookie': 'session=secret',
    'x-request-id': 'request-1'
  })
  const cause = new Error('database credentials leaked here')
  const error = new APIError(
    'UNAUTHORIZED',
    {
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid credentials',
      cause,
      secret: 'sensitive-body-value'
    },
    headers
  )

  return { cause, error, headers }
}

describe('BetterAuthApiError', () => {
  test('preserves the public Better Auth error data in memory', () => {
    const { cause, error, headers } = makeApiError()
    const normalized = BetterAuthApiError.from<'INVALID_CREDENTIALS'>(error)

    expect(normalized._tag).toBe('BetterAuthApiError')
    expect(normalized.name).toBe('BetterAuthApiError')
    expect(normalized.message).toBe('Invalid credentials')
    expect(normalized.status).toBe('UNAUTHORIZED')
    expect(normalized.statusCode).toBe(401)
    expect(normalized.code).toBe('INVALID_CREDENTIALS')
    expect(normalized.headers).toBe(headers)
    expect(normalized.body).toBe(error.body)
    expect(normalized.cause).toBe(error)
    expect(error.cause).toBe(cause)
  })

  test('preserves a runtime code that is not part of the known type union', () => {
    const error = new APIError('BAD_REQUEST', {
      code: 'FUTURE_PLUGIN_CODE',
      message: 'Future plugin failure'
    })

    expect(BetterAuthApiError.from<'KNOWN_CODE'>(error).code?.toString()).toBe('FUTURE_PLUGIN_CODE')
  })

  test('uses undefined when body.code is absent or is not a string', () => {
    const missing = new APIError('BAD_REQUEST', {
      message: 'Missing code'
    })
    const invalid = new APIError('BAD_REQUEST', {
      message: 'Invalid code'
    })

    Object.defineProperty(invalid, 'body', {
      configurable: true,
      enumerable: true,
      value: {
        code: 42,
        message: 'Invalid code'
      },
      writable: true
    })

    expect(BetterAuthApiError.from(missing).code).toBeUndefined()
    expect(BetterAuthApiError.from(invalid).code).toBeUndefined()
  })

  test('serializes a safe diagnostic envelope without body, headers, cause, or stack', () => {
    const normalized = BetterAuthApiError.from(makeApiError().error)
    const serialized = normalized.toJSON()
    const json = JSON.stringify(normalized)

    expect(serialized).toEqual({
      _tag: 'BetterAuthApiError',
      name: 'BetterAuthApiError',
      message: 'Invalid credentials',
      status: 'UNAUTHORIZED',
      statusCode: 401,
      code: 'INVALID_CREDENTIALS'
    })
    expect(Object.keys(normalized)).not.toContain('body')
    expect(Object.keys(normalized)).not.toContain('headers')
    expect(Object.keys(normalized)).not.toContain('cause')
    expect(json).not.toContain('session=secret')
    expect(json).not.toContain('sensitive-body-value')
    expect(json).not.toContain('database credentials leaked here')
    expect(json).not.toContain('stack')
  })

  test('does not mutate the APIError being normalized', () => {
    const { error } = makeApiError()
    const before = Object.getOwnPropertyDescriptors(error)

    BetterAuthApiError.from(error)

    expect(Object.getOwnPropertyDescriptors(error)).toEqual(before)
  })
})

describe('Unauthenticated', () => {
  test('represents only the explicit required-session failure', () => {
    const error = new Unauthenticated({
      message: 'Authentication is required'
    })

    expect(error._tag).toBe('Unauthenticated')
    expect(error.name).toBe('Unauthenticated')
    expect(error.message).toBe('Authentication is required')
  })
})
