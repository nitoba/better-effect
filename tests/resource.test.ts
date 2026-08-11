import { describe, expect, mock, test } from 'bun:test'

import { Result, type Result as ResultType } from 'better-result'

import { Resource, ResourceReleaseFailure } from '../src/resource'

type TestResource = {
  readonly value: number
}

describe('Resource.acquireUseRelease', () => {
  test('acquires, uses and releases the resource', async () => {
    const events: string[] = []

    const result = await Resource.acquireUseRelease({
      name: 'database',

      acquire: () => {
        events.push('acquire')

        return Result.ok({
          value: 42
        })
      },

      use: (resource) => {
        events.push('use')

        return Result.ok(resource.value)
      },

      release: () => {
        events.push('release')
      }
    })

    expect(Result.isOk(result)).toBe(true)

    if (Result.isOk(result)) {
      expect(result.value).toBe(42)
    }

    expect(events).toEqual(['acquire', 'use', 'release'])
  })

  test('does not run use or release when acquire returns Err', async () => {
    const use = mock((_resource: TestResource) => Result.ok(1))

    const release = mock((_resource: TestResource) => undefined)

    const acquire = (): ResultType<TestResource, 'acquire-failure'> => Result.err('acquire-failure')

    const result = await Resource.acquireUseRelease({
      name: 'database',
      acquire,
      use,
      release
    })

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBe('acquire-failure')
    }

    expect(use).not.toHaveBeenCalled()

    expect(release).not.toHaveBeenCalled()
  })

  test('captures exceptions during acquire', async () => {
    const cause = new Error('connection failed')

    const release = mock((_resource: TestResource) => undefined)

    const result = await Resource.acquireUseRelease<TestResource, number, never, never>({
      name: 'database',

      acquire: () => {
        throw cause
      },

      use: (resource) => Result.ok(resource.value),

      release
    })

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      const error = result.error as {
        cause?: unknown
      }

      expect(error.cause).toBe(cause)
    }

    expect(release).not.toHaveBeenCalled()
  })

  test('always releases after use returns Err', async () => {
    const release = mock(() => undefined)

    const result = await Resource.acquireUseRelease({
      name: 'database',

      acquire: () =>
        Result.ok({
          value: 42
        }),

      use: () => Result.err<number, 'use-failure'>('use-failure'),

      release
    })

    expect(release).toHaveBeenCalledTimes(1)

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBe('use-failure')
    }
  })

  test('always releases when use throws', async () => {
    const cause = new Error('operation exploded')

    const release = mock(() => undefined)

    const result = await Resource.acquireUseRelease({
      name: 'database',

      acquire: () =>
        Result.ok({
          value: 42
        }),

      use: () => {
        throw cause
      },

      release
    })

    expect(release).toHaveBeenCalledTimes(1)

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      const error = result.error as {
        cause?: unknown
      }

      expect(error.cause).toBe(cause)
    }
  })

  test('always releases when use rejects', async () => {
    const cause = new Error('operation rejected')

    const release = mock(() => undefined)

    const result = await Resource.acquireUseRelease({
      name: 'database',

      acquire: () =>
        Result.ok({
          value: 42
        }),

      use: async () => {
        throw cause
      },

      release
    })

    expect(release).toHaveBeenCalledTimes(1)

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      const error = result.error as {
        cause?: unknown
      }

      expect(error.cause).toBe(cause)
    }
  })

  test('converts a thrown release error to ResourceReleaseFailure', async () => {
    const cause = new Error('close failed')

    const result = await Resource.acquireUseRelease({
      name: 'database',

      acquire: () =>
        Result.ok({
          value: 42
        }),

      use: (resource) => Result.ok(resource.value),

      release: () => {
        throw cause
      }
    })

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(ResourceReleaseFailure)

      if (result.error instanceof ResourceReleaseFailure) {
        expect(result.error.resource).toBe('database')

        expect(result.error.cause).toBe(cause)

        expect(result.error.message).toBe('Failed to release resource: database')
      }
    }
  })

  test('converts a rejected release error to ResourceReleaseFailure', async () => {
    const cause = new Error('async close failed')

    const result = await Resource.acquireUseRelease({
      name: 'database',

      acquire: () =>
        Result.ok({
          value: 42
        }),

      use: (resource) => Result.ok(resource.value),

      release: async () => {
        throw cause
      }
    })

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(ResourceReleaseFailure)

      if (result.error instanceof ResourceReleaseFailure) {
        expect(result.error.cause).toBe(cause)
      }
    }
  })

  test('converts an Err returned by release to ResourceReleaseFailure', async () => {
    const result = await Resource.acquireUseRelease({
      name: 'database',

      acquire: () =>
        Result.ok({
          value: 42
        }),

      use: (resource) => Result.ok(resource.value),

      release: () => Result.err<void, string>('close-failure')
    })

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result) && result.error instanceof ResourceReleaseFailure) {
      expect(result.error.cause).toBe('close-failure')
    }
  })

  test('preserves the use error when use and release both fail', async () => {
    const result = await Resource.acquireUseRelease({
      name: 'database',

      acquire: () =>
        Result.ok({
          value: 42
        }),

      use: () => Result.err<number, 'use-failure'>('use-failure'),

      release: () => Result.err<void, 'release-failure'>('release-failure')
    })

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBe('use-failure')
    }
  })

  test('uses Symbol.dispose automatically', async () => {
    const dispose = mock(() => undefined)

    const resource = {
      value: 42,

      [Symbol.dispose]: dispose
    }

    const result = await Resource.acquireUseRelease({
      name: 'resource',

      acquire: () => Result.ok(resource),

      use: (value) => Result.ok(value.value)
    })

    expect(Result.isOk(result)).toBe(true)

    expect(dispose).toHaveBeenCalledTimes(1)
  })

  test('prefers Symbol.asyncDispose over Symbol.dispose', async () => {
    const dispose = mock(() => undefined)

    const asyncDispose = mock(async () => undefined)

    const resource = {
      value: 42,

      [Symbol.dispose]: dispose,

      [Symbol.asyncDispose]: asyncDispose
    }

    await Resource.acquireUseRelease({
      name: 'resource',

      acquire: () => Result.ok(resource),

      use: (value) => Result.ok(value.value)
    })

    expect(asyncDispose).toHaveBeenCalledTimes(1)

    expect(dispose).not.toHaveBeenCalled()
  })
})
