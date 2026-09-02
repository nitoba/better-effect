// oxlint-disable anti-slop/no-unknown-parameters -- test doubles are erased at Kysely's class boundary.

import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Runtime, type RuntimeRunOptions } from 'better-effect'
import { Panic, Result } from 'better-result'
import {
  CompiledQuery,
  type AbortableQueryOptions,
  type Compilable,
  type Kysely,
  type QueryResult
} from 'kysely'

import { KyselyEffect, KyselyQueryError } from '../src'
import type { KyselyExecutionOptions, KyselyOperation } from '../src'

type OperationResult<A, E> = Result<A, E>

const runOperation = <A, E>(
  operation: KyselyOperation<A, E>,
  options?: RuntimeRunOptions
): Promise<OperationResult<A, E>> =>
  Runtime.run(
    Layer.merge(),
    Effect.fn(async function* () {
      const value = yield* operation
      return Result.ok(value)
    }),
    options
  )

class NativeExecutable<A> {
  #value: A
  #identity = true

  calls = 0
  receivedOptions: AbortableQueryOptions | undefined

  constructor(value: A) {
    this.#value = value
  }

  execute(options?: AbortableQueryOptions): PromiseLike<A> {
    if (!this.#identity) {
      throw new Error('receiver was lost')
    }

    this.calls += 1
    this.receivedOptions = options
    return Promise.resolve(this.#value)
  }
}

class NativeTakeFirstExecutable<A> {
  #value: A
  #identity = true

  calls = 0
  receivedOptions: AbortableQueryOptions | undefined

  constructor(value: A) {
    this.#value = value
  }

  executeTakeFirst(options?: AbortableQueryOptions): PromiseLike<A> {
    if (!this.#identity) {
      throw new Error('receiver was lost')
    }

    this.calls += 1
    this.receivedOptions = options
    return Promise.resolve(this.#value)
  }
}

describe('Kysely query terminals', () => {
  test('execute is lazy, preserves the native receiver, and returns the exact value', async () => {
    const value = Object.freeze({ rows: Object.freeze([{ id: 1 }]) })
    const executable = new NativeExecutable(value)
    const operation = KyselyEffect.execute(executable)

    expect(executable.calls).toBe(0)
    const result = await runOperation(operation)

    expect(executable.calls).toBe(1)
    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
      expect(result.value).toBe(value)
    }
  })

  test('execute preserves void results from DDL-style executables', async () => {
    const executable = new NativeExecutable<void>(undefined)
    const result = await runOperation(KyselyEffect.execute(executable))

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
      expect(result.value).toBeUndefined()
    }
  })

  test('executeWith captures caller options without mutating them', async () => {
    const callerOptions: KyselyExecutionOptions = {
      inflightQueryAbortStrategy: 'kill session'
    }
    const controller = new AbortController()
    const executable = new NativeExecutable('rows')
    const operation = KyselyEffect.executeWith(callerOptions)(executable)

    const result = await runOperation(operation, { signal: controller.signal })

    expect(Result.isOk(result)).toBe(true)
    expect(executable.receivedOptions?.inflightQueryAbortStrategy).toBe('kill session')
    expect(executable.receivedOptions?.signal).toBeDefined()
    expect(executable.receivedOptions?.signal).not.toBe(controller.signal)
    expect(callerOptions).toEqual({ inflightQueryAbortStrategy: 'kill session' })
  })

  test('reuses configured terminals with isolated invocation options', async () => {
    const terminal = KyselyEffect.executeWith({
      inflightQueryAbortStrategy: 'cancel query'
    })
    const first = new NativeExecutable('first')
    const second = new NativeExecutable('second')
    const firstController = new AbortController()
    const secondController = new AbortController()

    const results = await Promise.all([
      runOperation(terminal(first), { signal: firstController.signal }),
      runOperation(terminal(second), { signal: secondController.signal })
    ])

    expect(Result.isOk(results[0])).toBe(true)
    expect(Result.isOk(results[1])).toBe(true)
    expect(first.receivedOptions).not.toBe(second.receivedOptions)
    expect(first.receivedOptions?.signal).not.toBe(second.receivedOptions?.signal)
    expect(first.receivedOptions?.signal).not.toBe(firstController.signal)
    expect(second.receivedOptions?.signal).not.toBe(secondController.signal)
    expect(first.receivedOptions?.inflightQueryAbortStrategy).toBe('cancel query')
    expect(second.receivedOptions?.inflightQueryAbortStrategy).toBe('cancel query')
  })

  test('execute normalizes a synchronous native throw as KyselyQueryError', async () => {
    const cause = new Error('execute failed')
    const executable = {
      execute: (): PromiseLike<never> => {
        throw cause
      }
    }

    const result = await runOperation(KyselyEffect.execute(executable))

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(KyselyQueryError)
      expect(result.error.operation).toBe('execute')
      expect(result.error.cause).toBe(cause)
    }
  })

  test('executeTakeFirst preserves undefined and native values', async () => {
    const missing = new NativeTakeFirstExecutable<number | undefined>(undefined)
    const present = new NativeTakeFirstExecutable<number>(0)

    const missingResult = await runOperation(KyselyEffect.executeTakeFirst(missing))
    const presentResult = await runOperation(KyselyEffect.executeTakeFirst(present))

    expect(Result.isOk(missingResult)).toBe(true)
    expect(Result.isOk(presentResult)).toBe(true)
    if (Result.isOk(missingResult)) {
      expect(missingResult.value).toBeUndefined()
    }
    if (Result.isOk(presentResult)) {
      expect(presentResult.value).toBe(0)
    }
  })

  test('executeTakeFirst normalizes a synchronous native throw as KyselyQueryError', async () => {
    const cause = new Error('first row failed')
    const executable = {
      executeTakeFirst: (): PromiseLike<never> => {
        throw cause
      }
    }

    const result = await runOperation(KyselyEffect.executeTakeFirst(executable))

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(KyselyQueryError)
      expect(result.error.operation).toBe('executeTakeFirst')
      expect(result.error.cause).toBe(cause)
    }
  })

  test('executeTakeFirstWith forwards a fresh Runtime-linked options object', async () => {
    const callerOptions: KyselyExecutionOptions = {
      inflightQueryAbortStrategy: 'cancel query'
    }
    const executable = new NativeTakeFirstExecutable('row')
    const controller = new AbortController()
    const operation = KyselyEffect.executeTakeFirstWith(callerOptions)(executable)

    const result = await runOperation(operation, { signal: controller.signal })

    expect(Result.isOk(result)).toBe(true)
    expect(executable.receivedOptions).not.toBe(callerOptions)
    expect(executable.receivedOptions?.inflightQueryAbortStrategy).toBe('cancel query')
    expect(executable.receivedOptions?.signal).not.toBe(controller.signal)
  })

  test('executeTakeFirstOrFail maps only strict undefined and calls the factory once', async () => {
    const missingError = new Error('missing')
    let factoryCalls = 0
    const missing = new NativeTakeFirstExecutable<number | undefined>(undefined)
    const operation = KyselyEffect.executeTakeFirstOrFail(() => {
      factoryCalls += 1
      return missingError
    })(missing)

    const result = await runOperation(operation)

    expect(factoryCalls).toBe(1)
    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(result.error).toBe(missingError)
    }

    for (const value of [null, false, 0, ''] as const) {
      let calls = 0
      const present = new NativeTakeFirstExecutable(value)
      const presentResult = await runOperation(
        KyselyEffect.executeTakeFirstOrFail(() => {
          calls += 1
          return new Error('unexpected')
        })(present)
      )

      expect(Result.isOk(presentResult)).toBe(true)
      expect(calls).toBe(0)
      if (Result.isOk(presentResult)) {
        expect(presentResult.value).toBe(value)
      }
    }
  })

  test('executeTakeFirstOrFailWith forwards options and remains lazy', async () => {
    const callerOptions: KyselyExecutionOptions = {
      inflightQueryAbortStrategy: 'kill session'
    }
    const executable = new NativeTakeFirstExecutable<number | undefined>(undefined)
    const controller = new AbortController()
    let factoryCalls = 0
    const operation = KyselyEffect.executeTakeFirstOrFailWith(callerOptions, () => {
      factoryCalls += 1
      return 'missing'
    })(executable)

    expect(executable.calls).toBe(0)
    const result = await runOperation(operation, { signal: controller.signal })

    expect(executable.calls).toBe(1)
    expect(factoryCalls).toBe(1)
    expect(executable.receivedOptions?.inflightQueryAbortStrategy).toBe('kill session')
    expect(executable.receivedOptions?.signal).not.toBe(controller.signal)
    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(result.error).toBe('missing')
    }
  })

  test('executeTakeFirstOrFail does not call the factory after a query failure', async () => {
    const cause = new Error('driver failure')
    let factoryCalls = 0
    const executable: KyselyOperationSource<number> = {
      executeTakeFirst: () => Promise.reject(cause)
    }

    const result = await runOperation(
      KyselyEffect.executeTakeFirstOrFail(() => {
        factoryCalls += 1
        return new Error('missing')
      })(executable)
    )

    expect(factoryCalls).toBe(0)
    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(KyselyQueryError)
      expect(result.error.cause).toBe(cause)
    }
  })

  test('executeTakeFirstOrFail leaves a throwing factory as an unwrapped defect', async () => {
    const defect = new Error('factory defect')
    const executable = new NativeTakeFirstExecutable<number | undefined>(undefined)
    let caught: unknown

    try {
      await runOperation(
        KyselyEffect.executeTakeFirstOrFail(() => {
          throw defect
        })(executable)
      )
    } catch (cause) {
      caught = cause
    }

    expect(caught).toBeInstanceOf(Panic)
    if (caught instanceof Panic) {
      expect(caught.cause).toBe(defect)
    }
  })

  test('executeQuery delegates the original query and preserves the complete result', async () => {
    type Row = { id: number }
    type DatabaseSchema = { users: Row }
    // SAFETY: The fixture supplies the row type returned by its fake database.
    const query = CompiledQuery.raw('select 1') as CompiledQuery<Row>
    const queryResult: QueryResult<Row> = {
      rows: [{ id: 1 }],
      numAffectedRows: 1n
    }
    const database = toKysely<DatabaseSchema>(new NativeDatabase(query, queryResult))

    const result = await runOperation(KyselyEffect.executeQuery(database, query))

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
      expect(result.value).toBe(queryResult)
    }
  })

  test('executeQuery delegates Compilable values without compiling them', async () => {
    type Row = { id: number }
    type DatabaseSchema = { users: Row }
    const query: Compilable<Row> = {
      compile: () => {
        throw new Error('integration must not compile')
      }
    }
    const queryResult: QueryResult<Row> = { rows: [{ id: 2 }] }
    const database = toKysely<DatabaseSchema>(new NativeCompilableDatabase(query, queryResult))

    const result = await runOperation(KyselyEffect.executeQuery(database, query))

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
      expect(result.value).toBe(queryResult)
    }
  })

  test('executeQuery does not misclassify a structural Compilable with a raw marker', async () => {
    type Row = { id: number }
    type DatabaseSchema = { users: Row }
    const query: Compilable<Row> & { readonly isRawBuilder: true } = {
      isRawBuilder: true,
      compile: () => {
        throw new Error('integration must not compile')
      }
    }
    const queryResult: QueryResult<Row> = { rows: [{ id: 3 }] }
    const database = toKysely<DatabaseSchema>(new NativeCompilableDatabase(query, queryResult))

    const result = await runOperation(KyselyEffect.executeQuery(database, query))

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
      expect(result.value).toBe(queryResult)
    }
  })

  test('executeQuery normalizes a synchronous native throw as KyselyQueryError', async () => {
    const cause = new Error('query failed synchronously')
    const query = CompiledQuery.raw('select 1')
    const database = toKysely<Record<string, never>>(new ThrowingDatabase(cause))

    const result = await runOperation(KyselyEffect.executeQuery(database, query))

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(KyselyQueryError)
      expect(result.error.operation).toBe('executeQuery')
      expect(result.error.cause).toBe(cause)
    }
  })

  test('executeQuery preserves receiver errors as KyselyQueryError', async () => {
    const cause = new Error('query failed')
    const query = CompiledQuery.raw('select 1')
    const database = toKysely<Record<string, never>>(new RejectingDatabase(cause))

    const result = await runOperation(KyselyEffect.executeQuery(database, query))

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(KyselyQueryError)
      expect(result.error.operation).toBe('executeQuery')
      expect(result.error.cause).toBe(cause)
    }
  })
})

const toKysely = <DB>(value: unknown): Kysely<DB> => {
  // SAFETY: Test doubles implement only the executeQuery boundary under test.
  return value as Kysely<DB>
}

type KyselyOperationSource<A> = {
  executeTakeFirst(options?: AbortableQueryOptions): PromiseLike<A>
}

class NativeDatabase<R> {
  #query: CompiledQuery<R>
  #result: QueryResult<R>
  #identity = true

  constructor(query: CompiledQuery<R>, result: QueryResult<R>) {
    this.#query = query
    this.#result = result
  }

  executeQuery(query: CompiledQuery<R>, _options?: AbortableQueryOptions): Promise<QueryResult<R>> {
    if (!this.#identity || query !== this.#query) {
      throw new Error('query or receiver was changed')
    }

    return Promise.resolve(this.#result)
  }
}

class NativeCompilableDatabase<R> {
  #query: Compilable<R>
  #result: QueryResult<R>

  constructor(query: Compilable<R>, result: QueryResult<R>) {
    this.#query = query
    this.#result = result
  }

  executeQuery(
    query: Compilable<R> | CompiledQuery<R>,
    _options?: AbortableQueryOptions
  ): Promise<QueryResult<R>> {
    if (query !== this.#query) {
      throw new Error('query identity was changed')
    }

    return Promise.resolve(this.#result)
  }
}

class ThrowingDatabase {
  #cause: Error

  constructor(cause: Error) {
    this.#cause = cause
  }

  executeQuery(
    _query: CompiledQuery<unknown>,
    _options?: AbortableQueryOptions
  ): PromiseLike<never> {
    throw this.#cause
  }
}

class RejectingDatabase {
  #cause: unknown

  constructor(cause: unknown) {
    this.#cause = cause
  }

  executeQuery(
    _query: CompiledQuery<unknown>,
    _options?: AbortableQueryOptions
  ): PromiseLike<never> {
    return Promise.reject(this.#cause)
  }
}
