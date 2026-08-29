import { expect, test } from 'bun:test'

import { Panic, Result, TaggedError, type Result as ResultType } from 'better-result'

import { Effect } from '../src/effect'

const expectSameResult = (
  result: ResultType<unknown, unknown>,
  expected: ResultType<unknown, unknown>
) => expect(result).toBe(expected)

test('async taps preserve the exact Result and run only their active branch', async () => {
  const events: string[] = []
  const success = Result.ok(42)
  const failure = Result.err<number, string>('failed')

  expectSameResult(
    await Effect.tapAsync(success, async (value) => {
      events.push(`ok:${value}`)
    }),
    success
  )
  expectSameResult(
    await Effect.tapErrorAsync(success, async () => {
      events.push('unexpected-error')
    }),
    success
  )
  expectSameResult(
    await Effect.tapAsync(failure, async () => {
      events.push('unexpected-success')
    }),
    failure
  )
  expectSameResult(
    await Effect.tapErrorAsync(failure, async (error) => {
      events.push(`err:${error}`)
    }),
    failure
  )
  expectSameResult(
    await Effect.tapBothAsync(success, {
      ok: async (value) => {
        events.push(`both-ok:${value}`)
      },
      err: async () => {
        events.push('both-err')
      }
    }),
    success
  )
  expectSameResult(
    await Effect.tapBothAsync(failure, {
      ok: async () => {
        events.push('both-ok-unexpected')
      },
      err: async (error) => {
        events.push(`both-err:${error}`)
      }
    }),
    failure
  )

  expect(events).toEqual(['ok:42', 'err:failed', 'both-ok:42', 'both-err:failed'])
})

test('async tap observer defects follow better-result Panic semantics', async () => {
  const syncCause = new Error('sync observer failure')
  const syncDefect = await Effect.tapAsync(Result.ok(1), () => {
    throw syncCause
  }).then(
    () => undefined,
    (error) => error
  )

  expect(syncDefect).toBeInstanceOf(Panic)
  if (syncDefect instanceof Panic) {
    expect(syncDefect.cause).toBe(syncCause)
  }

  const rejectedCause = new Error('rejected observer failure')
  const rejectedDefect = await Effect.tapErrorAsync(Result.err('failed'), () =>
    Promise.reject(rejectedCause)
  ).then(
    () => undefined,
    (error) => error
  )

  expect(rejectedDefect).toBeInstanceOf(Panic)
  if (rejectedDefect instanceof Panic) {
    expect(rejectedDefect.cause).toBe(rejectedCause)
  }
})

class UserNotFound extends TaggedError('UserNotFound')<{
  readonly id: string
  readonly message: string
}> {}

class AccessDenied extends TaggedError('AccessDenied')<{
  readonly message: string
}> {}

class HttpNotFound extends TaggedError('HttpNotFound')<{
  readonly message: string
}> {}

type OptionalUserNotFoundHandlers = {
  UserNotFound?: (error: UserNotFound) => HttpNotFound
}

test('tagged error matching maps exhaustive and partial error branches', async () => {
  const notFound = new UserNotFound({ id: 'u1', message: 'missing' })
  const denied = new AccessDenied({ message: 'denied' })
  const source = Result.err<number, UserNotFound | AccessDenied>(notFound)

  const mapped = Effect.matchError(source, {
    UserNotFound: (error) => new HttpNotFound({ message: `not found: ${error.id}` }),
    AccessDenied: (error) => new HttpNotFound({ message: `forbidden: ${error.message}` })
  })

  expect(Result.isError(mapped)).toBe(true)
  if (Result.isError(mapped)) {
    expect(mapped.error).toBeInstanceOf(HttpNotFound)
    expect(mapped.error.message).toBe('not found: u1')
  }

  const partialUnhandled = Effect.matchErrorPartial(
    Result.err<number, UserNotFound | AccessDenied>(denied),
    { UserNotFound: (error) => new HttpNotFound({ message: error.message }) }
  )

  expect(Result.isError(partialUnhandled)).toBe(true)
  if (Result.isError(partialUnhandled)) {
    expect(partialUnhandled.error).toBe(denied)
  }

  const partialHandled = await Effect.matchErrorPartial(Promise.resolve(source), {
    UserNotFound: (error) => new HttpNotFound({ message: error.message })
  })

  expect(Result.isError(partialHandled)).toBe(true)
  if (Result.isError(partialHandled)) {
    expect(partialHandled.error).toBeInstanceOf(HttpNotFound)
    expect(partialHandled.error.message).toBe('missing')
  }

  const optionalHandlers: OptionalUserNotFoundHandlers = {}
  const optionalUnhandled = Effect.matchErrorPartial(
    Result.err<number, UserNotFound | AccessDenied>(notFound),
    optionalHandlers
  )

  expect(Result.isError(optionalUnhandled)).toBe(true)
  if (Result.isError(optionalUnhandled)) {
    expect(optionalUnhandled.error).toBe(notFound)
  }

  optionalHandlers.UserNotFound = (error) => new HttpNotFound({ message: error.message })
  const optionalHandled = Effect.matchErrorPartial(
    Result.err<number, UserNotFound | AccessDenied>(notFound),
    optionalHandlers
  )

  expect(Result.isError(optionalHandled)).toBe(true)
  if (Result.isError(optionalHandled)) {
    expect(optionalHandled.error).toBeInstanceOf(HttpNotFound)
  }
})
