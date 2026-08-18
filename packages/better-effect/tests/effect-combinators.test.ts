import { expect, test } from 'bun:test'

import { Result, type Result as ResultType } from 'better-result'

import { Effect } from '../src/effect'

const expectResult = (result: ResultType<any, any>, expected: ResultType<any, any>) =>
  expect(result).toEqual(expected)

test('Effect tap helpers preserve the original Result and select one branch', () => {
  const events: string[] = []
  const success = Result.ok(1)

  expectResult(
    Effect.tapBoth(
      Effect.tap(success, (value) => events.push(`ok:${value}`)),
      {
        ok: (value) => events.push(`both-ok:${value}`),
        err: () => events.push('both-err')
      }
    ),
    success
  )

  const failure = Result.err<number, string>('failed')
  expectResult(
    Effect.tapError(failure, (error) => events.push(`err:${error}`)),
    failure
  )
  expect(events).toEqual(['ok:1', 'both-ok:1', 'err:failed'])
})

test('Effect recovery bypasses success and supports async fallback Results', async () => {
  let recovered = 0
  const success = Result.ok(1)

  expectResult(
    Effect.recover(success, () => {
      recovered++
      return Result.ok(2)
    }),
    success
  )
  expect(recovered).toBe(0)

  expectResult(
    Effect.recover(Result.err<number, string>('missing'), (error) => Result.ok(error)),
    Result.ok('missing')
  )
  expectResult(
    await Effect.recoverAsync(Result.err<number, string>('missing'), async (error) =>
      Result.ok(error.length)
    ),
    Result.ok(7)
  )
})

test('Effect value transforms preserve errors and flatten one Result layer', () => {
  const nested = Result.ok(Result.ok(42))

  expectResult(Effect.flatten(nested), Result.ok(42))
  expectResult(Effect.as(Result.ok(42), 'done'), Result.ok('done'))
  expectResult(Effect.asVoid(Result.ok(42)), Result.ok(undefined))
  expectResult(Effect.as(Result.err<number, string>('failed'), 'done'), Result.err('failed'))
})

test('Effect.match invokes only the selected branch for values and Effects', () => {
  const events: string[] = []

  expect(
    Effect.match(Result.ok(1), {
      ok: (value) => {
        events.push(`ok:${value}`)
        return 'success'
      },
      err: () => {
        events.push('err')
        return 'failure'
      }
    })
  ).toBe('success')

  expectResult(
    Effect.match(Result.err<number, string>('failed'), {
      ok: () => Result.ok('unexpected'),
      err: (error) => Result.ok(error.length)
    }),
    Result.ok(6)
  )
  expect(events).toEqual(['ok:1'])
})
