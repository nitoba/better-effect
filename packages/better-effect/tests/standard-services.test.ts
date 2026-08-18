import { expect, test } from 'bun:test'

import { Result, type Result as ResultType } from 'better-result'

import { Effect, Layer, Runtime } from '../src'
import {
  Clock,
  ClockTest,
  CurrentAbortSignal,
  CurrentRequest,
  Logger,
  LoggerTest,
  Random,
  RandomSeeded
} from '../src/standard-services'

const expectResult = (result: ResultType<any, any>, expected: ResultType<any, any>) =>
  expect(result).toEqual(expected)

test('ClockTest controls time and pending waits', async () => {
  const clock = new ClockTest(new Date('2025-01-01T00:00:00.000Z'))
  let completed = false
  const waiting = clock.sleep(100).then(() => {
    completed = true
  })

  await Promise.resolve()
  expect(completed).toBe(false)
  clock.advance(100)
  await waiting
  expect(completed).toBe(true)
  expect(clock.now()).toEqual(new Date('2025-01-01T00:00:00.100Z'))

  const runtime = await Runtime.make(ClockTest.layer(new Date('2025-01-01T00:00:00.000Z')))
  try {
    const observed = await runtime.run(
      Effect.fn(async function* () {
        const current = yield* Clock
        return Result.ok(current.now())
      })
    )
    expectResult(observed, Result.ok(new Date('2025-01-01T00:00:00.000Z')))
  } finally {
    await runtime.dispose()
  }
})

test('RandomSeeded repeats sequences without shared state', () => {
  const first = new RandomSeeded(42)
  const second = new RandomSeeded(42)

  expect([first.next(), first.next(), first.nextInt(10)]).toEqual([
    second.next(),
    second.next(),
    second.nextInt(10)
  ])
  expect(new Random().next()).toBeGreaterThanOrEqual(0)
})

test('LoggerTest captures structured events in order', () => {
  const logger = new LoggerTest()

  logger.info('started', { requestId: 'r1' })
  logger.error('failed')

  expect(logger.events).toEqual([
    { level: 'info', message: 'started', data: { requestId: 'r1' } },
    { level: 'error', message: 'failed' }
  ])
  expect(new Logger()).toBeInstanceOf(Logger)
})

test('CurrentRequest and CurrentAbortSignal remain execution-local', async () => {
  const runtime = await Runtime.make(Layer.merge())
  const requestProgram = Effect.fn(async function* () {
    const request = yield* CurrentRequest
    const signal = yield* CurrentAbortSignal
    return Result.ok({ value: request.value, aborted: signal.aborted })
  })

  try {
    const [first, second] = await Promise.all([
      runtime.runWith(CurrentRequest.layer('first'), requestProgram),
      runtime.runWith(CurrentRequest.layer('second'), requestProgram)
    ])

    expectResult(first, Result.ok({ value: 'first', aborted: false }))
    expectResult(second, Result.ok({ value: 'second', aborted: false }))
  } finally {
    await runtime.dispose()
  }
})

void LoggerTest.layer
