import { describe, expect, test } from 'bun:test'

import {
  CurrentAbortSignal,
  Effect,
  Layer,
  Runtime,
  RuntimeContextNotConfiguredError,
  type RuntimeRunOptions
} from 'better-effect'
import { Result } from 'better-result'

import type { AbortableQueryOptions } from 'kysely'

import { KyselyQueryError } from '../src'
import type { KyselyExecutionOptions, KyselyOperation } from '../src'

import { fromKyselyPromise } from '../src/internal/from-kysely-promise'

type OperationResult<A> = Result<A, KyselyQueryError>

const runOperation = <A>(
  operation: KyselyOperation<A, KyselyQueryError>,
  options?: RuntimeRunOptions
): Promise<OperationResult<A>> =>
  Runtime.run(
    Layer.merge(),
    Effect.fn(async function* () {
      const value = yield* operation
      return Result.ok(value)
    }),
    options
  )

describe('fromKyselyPromise', () => {
  test('is lazy, preserves the resolved reference, and forwards the Runtime signal', async () => {
    const value = Object.freeze({ rows: Object.freeze([{ id: 1 }]) })
    const controller = new AbortController()
    let calls = 0
    let received: AbortableQueryOptions | undefined
    let currentSignal: AbortSignal | undefined

    const operation = fromKyselyPromise('execute', (options) => {
      calls += 1
      received = options
      return Promise.resolve(value)
    })

    expect(calls).toBe(0)

    const result = await Runtime.run(
      Layer.merge(),
      Effect.fn(async function* () {
        currentSignal = yield* CurrentAbortSignal
        const resolved = yield* operation
        return Result.ok(resolved)
      }),
      { signal: controller.signal }
    )

    expect(calls).toBe(1)
    expect(Result.isOk(result)).toBe(true)
    expect(received).toBeDefined()
    expect(received?.signal).toBe(currentSignal)
    expect(received?.signal).not.toBe(controller.signal)

    if (Result.isOk(result)) {
      expect(result.value).toBe(value)
    }
  })

  test('creates invocation-local options without mutating caller options', async () => {
    const callerOptions: KyselyExecutionOptions = {
      inflightQueryAbortStrategy: 'cancel query'
    }
    let received: AbortableQueryOptions | undefined

    const result = await runOperation(
      fromKyselyPromise(
        'execute',
        (options) => {
          received = options
          return Promise.resolve('ok')
        },
        callerOptions
      )
    )

    expect(Result.isOk(result)).toBe(true)
    expect(received).toEqual({
      inflightQueryAbortStrategy: 'cancel query',
      signal: received?.signal
    })
    expect(received).not.toBe(callerOptions)
    expect(callerOptions).toEqual({ inflightQueryAbortStrategy: 'cancel query' })
  })

  test('keeps concurrent invocation options and signals isolated', async () => {
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstOptions: KyselyExecutionOptions = {
      inflightQueryAbortStrategy: 'cancel query'
    }
    const secondOptions: KyselyExecutionOptions = {
      inflightQueryAbortStrategy: 'kill session'
    }
    const seen: AbortableQueryOptions[] = []
    let resolveStarted!: () => void
    let finish!: (value: string) => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const pending = new Promise<string>((resolve) => {
      finish = resolve
    })
    const execute = (options: AbortableQueryOptions) => {
      seen.push(options)
      if (seen.length === 2) {
        resolveStarted()
      }
      return pending
    }

    const first = runOperation(fromKyselyPromise('execute', execute, firstOptions), {
      signal: firstController.signal
    })
    const second = runOperation(fromKyselyPromise('execute', execute, secondOptions), {
      signal: secondController.signal
    })

    await started
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
    expect(seen[0]?.signal).not.toBe(seen[1]?.signal)
    expect(seen[0]?.signal).not.toBe(firstController.signal)
    expect(seen[1]?.signal).not.toBe(secondController.signal)
    expect(seen[0]?.inflightQueryAbortStrategy).toBe('cancel query')
    expect(seen[1]?.inflightQueryAbortStrategy).toBe('kill session')

    finish('done')
    const results = await Promise.all([first, second])
    expect(Result.isOk(results[0])).toBe(true)
    expect(Result.isOk(results[1])).toBe(true)
  })

  test('normalizes Promise rejections while preserving the exact cause', async () => {
    const cause = new Error('driver SQL=secret parameters=secret-token')
    let calls = 0

    const result = await runOperation(
      fromKyselyPromise('execute', () => {
        calls += 1
        return Promise.reject(cause)
      })
    )

    expect(calls).toBe(1)
    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(KyselyQueryError)
      expect(result.error.cause).toBe(cause)
      expect(result.error.operation).toBe('execute')
    }
  })

  test('normalizes synchronous throws from the external boundary', async () => {
    const cause = { sql: 'select secret', parameters: ['secret-token'] }

    const result = await runOperation(fromKyselyPromise('executeQuery', () => throwCause(cause)))

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(KyselyQueryError)
      expect(result.error.cause).toBe(cause)
      expect(result.error.operation).toBe('executeQuery')
    }
  })

  test('passes an already-aborted Runtime signal to the external boundary', async () => {
    const reason = { type: 'cancelled', secret: 'not serialized' }
    const controller = new AbortController()
    controller.abort(reason)
    let received: AbortableQueryOptions | undefined

    const result = await runOperation(
      fromKyselyPromise('execute', (options) => {
        received = options
        return Promise.reject(reason)
      }),
      { signal: controller.signal }
    )

    expect(received?.signal?.aborted).toBe(true)
    expect(received?.signal?.reason).toBe(reason)
    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error.cause).toBe(reason)
    }
  })

  test('does not capture missing Runtime context as a query failure', async () => {
    let calls = 0
    const operation = fromKyselyPromise('execute', () => {
      calls += 1
      return Promise.resolve('unreachable')
    })

    const rejected = await operation.next().then(
      () => false,
      (error) => error instanceof RuntimeContextNotConfiguredError
    )

    expect(rejected).toBe(true)
    expect(calls).toBe(0)
  })
})

const throwCause = (cause: unknown): PromiseLike<never> => {
  throw cause
}
