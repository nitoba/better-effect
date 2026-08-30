import { describe, expect, test } from 'bun:test'
import { APIError } from 'better-auth/api'
import { Result, UnhandledException } from 'better-result'

import { BetterAuthApiError } from '../../src'
import { fromBetterAuthPromise } from '../../src/internal/from-better-auth-promise'

const runOperation = <A>(operation: () => PromiseLike<A>) =>
  Result.gen(async function* () {
    const value = yield* fromBetterAuthPromise(operation)

    return Result.ok(value)
  })

describe('fromBetterAuthPromise', () => {
  test('returns the exact successful value and invokes the operation once', async () => {
    const value = { authenticated: true }
    let calls = 0

    const result = await runOperation(() => {
      calls += 1
      return Promise.resolve(value)
    })

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
      expect(result.value).toBe(value)
    }
    expect(calls).toBe(1)
  })

  test('normalizes a rejected APIError', async () => {
    const cause = new APIError('FORBIDDEN', {
      code: 'ACCOUNT_DISABLED',
      message: 'Account disabled'
    })
    const result = await runOperation(() => Promise.reject(cause))

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(BetterAuthApiError.is(result.error)).toBe(true)
      expect(result.error.cause).toBe(cause)
    }
  })

  test('normalizes a synchronous throw as UnhandledException', async () => {
    const cause = new Error('configuration defect')
    const result = await runOperation(() => {
      throw cause
    })

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(UnhandledException.is(result.error)).toBe(true)
      expect(result.error.cause).toBe(cause)
    }
  })

  test('normalizes an ordinary rejection as UnhandledException', async () => {
    const cause = new Error('adapter defect')
    const result = await runOperation(() => Promise.reject(cause))

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(UnhandledException.is(result.error)).toBe(true)
      expect(result.error.cause).toBe(cause)
    }
  })

  test('preserves a non-Error thrown value as the defect cause', async () => {
    const cause = { kind: 'unexpected-value' } as const
    const result = await runOperation(() => Promise.reject(cause))

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(UnhandledException.is(result.error)).toBe(true)
      expect(result.error.cause).toBe(cause)
    }
  })

  test('keeps a non-2xx Response in the successful channel', async () => {
    const response = Response.json(
      { error: 'Unauthorized' },
      {
        status: 401
      }
    )
    const result = await runOperation(() => Promise.resolve(response))

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
      expect(result.value).toBe(response)
      expect(result.value.status).toBe(401)
    }
  })
})
