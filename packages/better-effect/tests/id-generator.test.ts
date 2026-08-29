import { expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Effect, Layer, Runtime, ServiceRuntime } from '../src'
import {
  IdGenerator,
  IdGeneratorExhaustedError,
  IdGeneratorLive,
  IdGeneratorTest,
  IdGeneratorUnavailableError
} from '../src/standard-services'
import { TestRuntime } from '../src/testing'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

test('IdGeneratorLive uses the host crypto.randomUUID implementation', async () => {
  const runtime = await Runtime.make(IdGeneratorLive)

  try {
    const result = await runtime.run(
      Effect.fn(async function* () {
        const ids = yield* IdGenerator
        return Result.ok([ids.next(), ids.next()])
      })
    )

    expect(Result.isOk(result)).toBe(true)

    if (Result.isOk(result)) {
      expect(result.value).toHaveLength(2)
      expect(result.value.every((id) => uuidPattern.test(id))).toBe(true)
      expect(result.value[0]).not.toBe(result.value[1])
    }
  } finally {
    await runtime.dispose()
  }
})

test('IdGenerator reports unavailable host crypto with a focused error', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')

  if (descriptor?.configurable !== true) {
    return
  }

  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {},
    writable: true
  })

  try {
    expect(() => new IdGenerator().next()).toThrow(IdGeneratorUnavailableError)
  } finally {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'crypto')
    } else {
      Object.defineProperty(globalThis, 'crypto', descriptor)
    }
  }
})

test('IdGeneratorTest returns queue values FIFO and rejects exhaustion', () => {
  const ids = new IdGeneratorTest(['user-1', 'user-2'])

  expect(ids.generated).toBe(0)
  expect(ids.remaining).toBe(2)
  expect(ids.next()).toBe('user-1')
  expect(ids.next()).toBe('user-2')
  expect(ids.generated).toBe(2)
  expect(ids.remaining).toBe(0)
  expect(() => ids.next()).toThrow(IdGeneratorExhaustedError)
  expect(() => ids.next()).toThrow(IdGeneratorExhaustedError)
  expect(ids.generated).toBe(2)
})

test('IdGeneratorTest.from uses isolated monotonic zero-based indexes', () => {
  const first = IdGeneratorTest.from((index) => `first-${index}`)
  const second = IdGeneratorTest.from((index) => `second-${index}`)

  expect([first.next(), first.next(), second.next(), first.next(), second.next()]).toEqual([
    'first-0',
    'first-1',
    'second-0',
    'first-2',
    'second-1'
  ])
  expect(first.generated).toBe(3)
  expect(second.generated).toBe(2)
  expect(first.remaining).toBe(Infinity)
  expect(second.remaining).toBe(Infinity)
})

test('IdGeneratorTest.layer resolves the exact test instance', async () => {
  const ids = new IdGeneratorTest(['layer-id'])
  const runtime = await Runtime.make(IdGeneratorTest.layer(ids))

  try {
    const result = await runtime.run(async () => {
      const resolved = await ServiceRuntime.resolve(IdGenerator)
      return { id: resolved.next(), same: Object.is(resolved, ids) }
    })

    expect(result).toEqual({ id: 'layer-id', same: true })
  } finally {
    await runtime.dispose()
  }
})

test('TestRuntime isolates IdGeneratorTest options across concurrent runtimes', async () => {
  const firstIds = new IdGeneratorTest(['first-id'])
  const secondIds = new IdGeneratorTest(['second-id'])
  const [first, second] = await Promise.all([
    TestRuntime.make(Layer.merge(), { idGenerator: firstIds }),
    TestRuntime.make(Layer.merge(), { idGenerator: secondIds })
  ])

  try {
    const program = Effect.fn(async function* () {
      const ids = yield* IdGenerator
      return Result.ok(ids.next())
    })
    const [firstResult, secondResult] = await Promise.all([first.run(program), second.run(program)])

    expect(Result.isOk(firstResult) && firstResult.value === 'first-id').toBe(true)
    expect(Result.isOk(secondResult) && secondResult.value === 'second-id').toBe(true)
    expect(firstIds.generated).toBe(1)
    expect(secondIds.generated).toBe(1)
    expect(first.idGenerator).toBe(firstIds)
    expect(second.idGenerator).toBe(secondIds)
  } finally {
    await Promise.all([first.dispose(), second.dispose()])
  }
})
