import { expect, test } from 'bun:test'

import { Result, type Result as ResultType } from 'better-result'

import { Effect, Program } from '../src/effect'

const expectResult = (result: ResultType<any, any>, expected: ResultType<any, any>) =>
  expect(result).toEqual(expected)

test('Program.all is lazy, bounded, and preserves tuple order', async () => {
  let active = 0
  let maximum = 0
  let started = 0

  const programs = [0, 1, 2, 3, 4].map((value) =>
    Effect.fn(async function* () {
      yield* []
      started++
      active++
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active--
      return Result.ok(value)
    })
  )

  const collected = Program.all(programs, { concurrency: 2 })
  expect(started).toBe(0)

  expectResult(await collected(), Result.ok([0, 1, 2, 3, 4]))
  expect(started).toBe(5)
  expect(maximum).toBe(2)
})

test('Program.all validates concurrency before execution', () => {
  const program = Effect.fn(async function* () {
    yield* []
    return Result.ok(true)
  })

  expect(() => Program.all([program], { concurrency: 0 })).toThrow(RangeError)
  expect(() => Program.all([program], { concurrency: 1.5 })).toThrow(RangeError)
})
