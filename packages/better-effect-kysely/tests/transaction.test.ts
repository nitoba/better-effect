// oxlint-disable require-yield -- Some transaction fixtures intentionally use pure lazy generators.

import { describe, expect, test } from 'bun:test'
import {
  CurrentAbortSignal,
  Effect,
  Layer,
  Runtime,
  Service,
  type Program,
  type RuntimeRunOptions
} from 'better-effect'
import { Panic, Result } from 'better-result'
import {
  CompiledQuery,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  Kysely,
  type AbortableOperationOptions,
  type DatabaseConnection,
  type Dialect,
  type QueryResult,
  type Driver,
  type Transaction,
  type TransactionSettings
} from 'kysely'

import {
  KyselyEffect,
  KyselyQueryError,
  KyselyTransactionError,
  type KyselyOperation
} from '../src'

interface DatabaseSchema {
  users: {
    id: number
  }
}

type Failure = Error

type DriverFailureMode = 'begin' | 'commit' | 'rollback'

class TransactionDriver implements Driver {
  readonly events: string[] = []
  readonly settings: TransactionSettings[] = []
  readonly queryFailures = new Map<string, Failure>()
  readonly failures = new Map<DriverFailureMode, Failure>()
  readonly connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery, _options?: AbortableOperationOptions) => {
      this.events.push(`query:${query.sql}`)
      const failure = this.queryFailures.get(query.sql)
      if (failure !== undefined) {
        throw failure
      }

      // SAFETY: The scripted driver returns the native QueryResult shape for every requested result.
      return { rows: [] } as QueryResult<R>
    },
    streamQuery: async function* <R>() {
      // SAFETY: The scripted driver returns the native QueryResult shape for every requested result.
      yield { rows: [] } as QueryResult<R>
    }
  }

  async init(_options?: AbortableOperationOptions): Promise<void> {
    this.events.push('init')
  }

  async acquireConnection(_options?: AbortableOperationOptions): Promise<DatabaseConnection> {
    this.events.push('acquire')
    return this.connection
  }

  async releaseConnection(
    _connection: DatabaseConnection,
    _options?: AbortableOperationOptions
  ): Promise<void> {
    this.events.push('release')
  }

  async beginTransaction(
    _connection: DatabaseConnection,
    settings: TransactionSettings
  ): Promise<void> {
    this.events.push('begin')
    this.settings.push(settings)
    this.throwFailure('begin')
  }

  async commitTransaction(_connection: DatabaseConnection): Promise<void> {
    this.events.push('commit')
    this.throwFailure('commit')
  }

  async rollbackTransaction(_connection: DatabaseConnection): Promise<void> {
    this.events.push('rollback')
    this.throwFailure('rollback')
  }

  async destroy(_options?: AbortableOperationOptions): Promise<void> {}

  private throwFailure(mode: DriverFailureMode): void {
    const failure = this.failures.get(mode)
    if (failure !== undefined) {
      throw failure
    }
  }
}

const makeDialect = (driver: TransactionDriver): Dialect => ({
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => driver,
  createIntrospector: (database) => new PostgresIntrospector(database),
  createQueryCompiler: () => new PostgresQueryCompiler()
})

const makeDatabase = (driver = new TransactionDriver()): Kysely<DatabaseSchema> =>
  new Kysely<DatabaseSchema>({ dialect: makeDialect(driver) })

const runOperation = async <A, E>(
  operation: KyselyOperation<A, E>,
  options?: RuntimeRunOptions
): Promise<Result<A, E>> =>
  Runtime.run(
    Layer.merge(),
    Effect.fn(async function* () {
      const value = yield* operation
      return Result.ok(value)
    }),
    options
  )

const runTransaction = <A, E>(
  database: Kysely<DatabaseSchema>,
  body: (transaction: Transaction<DatabaseSchema>) => Program<A, E>,
  options?: RuntimeRunOptions
): Promise<Result<A, E | KyselyTransactionError>> =>
  runOperation(KyselyEffect.transaction(database, body), options)

describe('Kysely transactions', () => {
  test('commits the exact Program value after a successful body', async () => {
    const driver = new TransactionDriver()
    const database = makeDatabase(driver)
    const value = Object.freeze({ id: 1 })
    let bodyCalls = 0

    const result = await runTransaction(database, (_transaction) => {
      bodyCalls += 1
      return Effect.fn(async function* () {
        return Result.ok(value)
      })
    })

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
      expect(result.value).toBe(value)
    }
    expect(bodyCalls).toBe(1)
    expect(driver.events).toEqual(['init', 'acquire', 'begin', 'commit', 'release'])
  })

  test('rolls back and preserves the exact typed body error', async () => {
    const driver = new TransactionDriver()
    const database = makeDatabase(driver)
    const failure = new Error('typed body failure')

    const result = await runTransaction(database, (_transaction) =>
      Effect.fn(async function* () {
        return Result.err(failure)
      })
    )

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(result.error).toBe(failure)
    }
    expect(driver.events).toEqual(['init', 'acquire', 'begin', 'rollback', 'release'])
  })

  test('rolls back query failures from the body without remapping them', async () => {
    const driver = new TransactionDriver()
    const database = makeDatabase(driver)
    const queryFailure = new Error('driver query failure')
    driver.queryFailures.set('body query', queryFailure)

    // SAFETY: The scripted driver returns no rows for this untyped test query.
    const query = CompiledQuery.raw('body query') as CompiledQuery<never>
    const result = await runTransaction(database, (transaction) =>
      Effect.fn(async function* () {
        const queryResult = yield* KyselyEffect.executeQuery<DatabaseSchema, never>(
          transaction,
          query
        )
        return Result.ok(queryResult)
      })
    )

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      const error = result.error
      expect(error).toBeInstanceOf(KyselyQueryError)
      if (error instanceof KyselyQueryError) {
        expect(error.cause).toBe(queryFailure)
      }
    }
    expect(driver.events).toEqual([
      'init',
      'acquire',
      'begin',
      'query:body query',
      'rollback',
      'release'
    ])
  })

  test('rolls back a body factory defect and preserves its cause', async () => {
    const driver = new TransactionDriver()
    const database = makeDatabase(driver)
    const defect = new Error('body factory defect')
    let caught: unknown

    try {
      await runTransaction(database, () => {
        throw defect
      })
    } catch (cause) {
      caught = cause
    }

    expect(caught).toBeInstanceOf(Panic)
    if (caught instanceof Panic) {
      expect(caught.cause).toBe(defect)
    }
    expect(driver.events).toEqual(['init', 'acquire', 'begin', 'rollback', 'release'])
  })

  test('wraps native begin and commit failures as transaction errors', async () => {
    const beginFailure = new Error('begin failure')
    const beginDriver = new TransactionDriver()
    beginDriver.failures.set('begin', beginFailure)
    const beginResult = await runTransaction(makeDatabase(beginDriver), (_transaction) =>
      Effect.fn(async function* () {
        return Result.ok('never')
      })
    )

    expect(Result.isError(beginResult)).toBe(true)
    if (Result.isError(beginResult)) {
      const error = beginResult.error
      expect(error).toBeInstanceOf(KyselyTransactionError)
      if (error instanceof KyselyTransactionError) {
        expect(error.cause).toBe(beginFailure)
      }
    }
    expect(beginDriver.events).toEqual(['init', 'acquire', 'begin', 'release'])

    const commitFailure = new Error('commit failure')
    const commitDriver = new TransactionDriver()
    commitDriver.failures.set('commit', commitFailure)
    const commitResult = await runTransaction(makeDatabase(commitDriver), (_transaction) =>
      Effect.fn(async function* () {
        return Result.ok('not committed')
      })
    )

    expect(Result.isError(commitResult)).toBe(true)
    if (Result.isError(commitResult)) {
      const error = commitResult.error
      expect(error).toBeInstanceOf(KyselyTransactionError)
      if (error instanceof KyselyTransactionError) {
        expect(error.cause).toBe(commitFailure)
      }
    }
    expect(commitDriver.events).toEqual([
      'init',
      'acquire',
      'begin',
      'commit',
      'rollback',
      'release'
    ])
  })

  test('preserves a typed body failure when rollback fails', async () => {
    const rollbackFailure = new Error('rollback failure')
    const bodyFailure = new Error('body failure')
    const driver = new TransactionDriver()
    driver.failures.set('rollback', rollbackFailure)

    const result = await runTransaction(makeDatabase(driver), (_transaction) =>
      Effect.fn(async function* () {
        return Result.err(bodyFailure)
      })
    )

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      const error = result.error
      expect(error).toBeInstanceOf(KyselyTransactionError)
      if (error instanceof KyselyTransactionError) {
        expect(error.cause).toBe(rollbackFailure)
        expect(error.bodyFailure).toBe(bodyFailure)
      }
    }
    expect(driver.events).toEqual(['init', 'acquire', 'begin', 'rollback', 'release'])
  })

  test('composes body defects and rollback failures in body-first order', async () => {
    const defect = new Error('body defect')
    const rollbackFailure = new Error('rollback failure')
    const driver = new TransactionDriver()
    driver.failures.set('rollback', rollbackFailure)
    let caught: unknown

    try {
      await runTransaction(makeDatabase(driver), () => {
        throw defect
      })
    } catch (cause) {
      caught = cause
    }

    expect(caught).toBeInstanceOf(Panic)
    if (caught instanceof Panic) {
      expect(caught.cause).toBeInstanceOf(AggregateError)
      if (caught.cause instanceof AggregateError) {
        expect(caught.cause.errors).toEqual([defect, rollbackFailure])
      }
    }
    expect(driver.events).toEqual(['init', 'acquire', 'begin', 'rollback', 'release'])
  })

  test('does not begin an already-aborted transaction', async () => {
    const driver = new TransactionDriver()
    const database = makeDatabase(driver)
    const controller = new AbortController()
    const reason = new Error('already aborted')
    controller.abort(reason)
    let bodyCalls = 0

    let caught: unknown
    try {
      await runTransaction(
        database,
        () => {
          bodyCalls += 1
          return Effect.fn(async function* () {
            return Result.ok('never')
          })
        },
        { signal: controller.signal }
      )
    } catch (cause) {
      caught = cause
    }

    expect(caught).toBeInstanceOf(Panic)
    if (caught instanceof Panic) {
      expect(caught.cause).toBe(reason)
    }
    expect(bodyCalls).toBe(0)
    expect(driver.events).toEqual([])
  })

  test('checks cancellation after begin and before returning body success', async () => {
    const driver = new TransactionDriver()
    const database = makeDatabase(driver)
    const controller = new AbortController()
    const reason = new Error('cancelled')

    let caught: unknown
    try {
      await runTransaction(
        database,
        (_transaction) =>
          Effect.fn(async function* () {
            controller.abort(reason)
            return Result.ok('not committed')
          }),
        { signal: controller.signal }
      )
    } catch (cause) {
      caught = cause
    }

    expect(caught).toBeInstanceOf(Panic)
    if (caught instanceof Panic) {
      expect(caught.cause).toBe(reason)
    }
    expect(driver.events).toEqual(['init', 'acquire', 'begin', 'rollback', 'release'])
  })

  test('forwards the exterior Runtime context and signal to a transaction body', async () => {
    class AuditClock extends Service<AuditClock>()('@transaction/AuditClock') {
      now(): number {
        return 42
      }
    }

    const driver = new TransactionDriver()
    const database = makeDatabase(driver)
    const controller = new AbortController()
    let bodySignal: AbortSignal | undefined

    const result = await Runtime.run(
      Layer.succeed(AuditClock, new AuditClock()),
      Effect.fn(async function* () {
        const value = yield* KyselyEffect.transaction(database, (_transaction) =>
          Effect.fn(async function* () {
            const clock = yield* AuditClock
            bodySignal = yield* CurrentAbortSignal
            return Result.ok(clock.now())
          })
        )
        return Result.ok(value)
      }),
      { signal: controller.signal }
    )

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
      expect(result.value).toBe(42)
    }
    expect(bodySignal).toBeDefined()
    expect(bodySignal).not.toBe(controller.signal)
  })

  test('applies only defined native transaction settings', async () => {
    const driver = new TransactionDriver()

    await runOperation(
      KyselyEffect.transaction(
        makeDatabase(driver),
        {
          isolationLevel: 'serializable',
          accessMode: 'read write'
        },
        (_transaction) =>
          Effect.fn(async function* () {
            return Result.ok(undefined)
          })
      )
    )

    expect(driver.settings).toEqual([
      {
        isolationLevel: 'serializable',
        accessMode: 'read write'
      }
    ])
  })
})
