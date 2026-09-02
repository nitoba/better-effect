import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Runtime, Service, ServiceRuntime } from 'better-effect'
import { Panic, Result } from 'better-result'
import { CompiledQuery, sql, type KyselyPlugin, type LogEvent } from 'kysely'

import { KyselyEffect, KyselyQueryError, type KyselyOperation } from '../src'
import {
  fixtures,
  type IntegrationDatabase,
  type IntegrationFixture,
  type IntegrationFixtureDatabase,
  type IntegrationFixtureOptions,
  type IntegrationSchema
} from './integration/fixtures'

const Database = KyselyEffect.service<IntegrationSchema>()('@integration/Database')
class TransactionContext extends Service<TransactionContext>()('@integration/TransactionContext') {
  readonly value = 'transaction-context'
}
type IntegrationRuntime = Runtime<ReturnType<typeof Database.of>>

type ResultValue<A, E> = Result<A, E>

const expectOk = <A, E>(result: ResultValue<A, E>): A => {
  expect(Result.isOk(result)).toBe(true)
  if (Result.isError(result)) throw result.error
  return result.value
}

const runOperation = <A, E>(runtime: IntegrationRuntime, operation: KyselyOperation<A, E>) =>
  runtime.run(
    Effect.fn(async function* () {
      const value = yield* operation
      return Result.ok(value)
    })
  )

const createSchema = async (runtime: IntegrationRuntime): Promise<void> => {
  const result = await runtime.run(
    Effect.fn(async function* () {
      const database = yield* Database
      yield* database.schema
        .createTable('users')
        .addColumn('id', 'integer', (column) => column.primaryKey())
        .addColumn('email', 'text', (column) => column.notNull())
        .addColumn('active', 'integer', (column) => column.notNull())
        .addColumn('nullable', 'text')
        .$call(KyselyEffect.execute)
      yield* database.schema
        .createTable('posts')
        .addColumn('id', 'integer', (column) => column.primaryKey())
        .addColumn('user_id', 'integer', (column) => column.notNull())
        .addColumn('title', 'text', (column) => column.notNull())
        .$call(KyselyEffect.execute)
      yield* database.schema
        .createIndex('users_email_idx')
        .on('users')
        .column('email')
        .$call(KyselyEffect.execute)
      return Result.ok(undefined)
    })
  )

  expectOk(result)
}

const withOwnedDatabase = async <A>(
  fixture: IntegrationFixture,
  callback: (
    database: IntegrationDatabase,
    runtime: IntegrationRuntime,
    created: IntegrationFixtureDatabase
  ) => Promise<A>,
  options?: IntegrationFixtureOptions
): Promise<A> => {
  const created = await fixture.make(options)
  const runtime = await Runtime.make(Database.layer(() => created.database))

  try {
    return await callback(created.database, runtime, created)
  } finally {
    await runtime.dispose()
  }
}

const seedUsers = async (runtime: IntegrationRuntime): Promise<void> => {
  const result = await runtime.run(
    Effect.fn(async function* () {
      const database = yield* Database
      const values = Object.freeze([
        Object.freeze({ id: 1, email: 'ada@example.test', active: 1, nullable: null }),
        Object.freeze({ id: 2, email: 'grace@example.test', active: 0, nullable: 'present' })
      ])
      yield* database.insertInto('users').values(values).$call(KyselyEffect.execute)
      yield* database
        .insertInto('posts')
        .values([
          { id: 1, user_id: 1, title: 'first' },
          { id: 2, user_id: 1, title: 'second' }
        ])
        .$call(KyselyEffect.execute)
      return Result.ok(undefined)
    })
  )

  expectOk(result)
}

for (const fixture of fixtures) {
  describe(fixture.name, () => {
    test('executes DDL, frozen DML, joins, CTEs, aggregates, updates, and deletes', async () => {
      await withOwnedDatabase(fixture, async (database, runtime) => {
        await createSchema(runtime)
        await seedUsers(runtime)

        const result = await runtime.run(
          Effect.fn(async function* () {
            const rows = yield* database
              .selectFrom('users')
              .select(['id', 'email', 'nullable'])
              .orderBy('id')
              .$call(KyselyEffect.execute)
            const joined = yield* database
              .selectFrom('users')
              .innerJoin('posts', 'posts.user_id', 'users.id')
              .select(['users.email', 'posts.title'])
              .orderBy('posts.id')
              .$call(KyselyEffect.execute)
            const cte = yield* database
              .with('active_users', (query) =>
                query.selectFrom('users').select(['id', 'email']).where('active', '=', 1)
              )
              .selectFrom('active_users')
              .selectAll()
              .$call(KyselyEffect.execute)
            const aggregate = yield* database
              .selectFrom('posts')
              .select(({ fn }) => fn.countAll().as('count'))
              .$call(KyselyEffect.execute)
            const updated = yield* database
              .updateTable('users')
              .set({ email: 'ada+updated@example.test' })
              .where('id', '=', 1)
              .$call(KyselyEffect.execute)
            const deleted = yield* database
              .deleteFrom('users')
              .where('id', '=', 2)
              .$call(KyselyEffect.execute)

            return Result.ok({ rows, joined, cte, aggregate, updated, deleted })
          })
        )

        const value = expectOk(result)
        expect(value.rows).toEqual([
          { id: 1, email: 'ada@example.test', nullable: null },
          { id: 2, email: 'grace@example.test', nullable: 'present' }
        ])
        expect(value.rows.every((row) => Object.getPrototypeOf(row) === Object.prototype)).toBe(
          true
        )
        expect(value.joined).toEqual([
          { email: 'ada@example.test', title: 'first' },
          { email: 'ada@example.test', title: 'second' }
        ])
        expect(value.cte).toEqual([{ id: 1, email: 'ada@example.test' }])
        expect(String(value.aggregate[0]?.count)).toBe('2')
        expect(String(value.updated[0]?.numUpdatedRows)).toBe('1')
        expect(String(value.deleted[0]?.numDeletedRows)).toBe('1')
        expect(await database.selectFrom('users').selectAll().execute()).toEqual([
          { id: 1, email: 'ada+updated@example.test', active: 1, nullable: null }
        ])
      })
    })

    test('executes raw and compiled queries and preserves first-row semantics', async () => {
      await withOwnedDatabase(fixture, async (database, runtime) => {
        await createSchema(runtime)
        await seedUsers(runtime)

        const compiled = database
          .selectFrom('users')
          .select(['id', 'email'])
          .where('id', '=', 1)
          .compile()
        const compiledSql = compiled.sql
        const compiledParameters = [...compiled.parameters]
        const result = await runtime.run(
          Effect.fn(async function* () {
            const raw = yield* KyselyEffect.executeQuery(
              database,
              sql<{ value: number }>`select ${1} as value`
            )
            const compiledResult = yield* KyselyEffect.executeQuery(database, compiled)
            const first = yield* database
              .selectFrom('users')
              .selectAll()
              .where('id', '=', 1)
              .$call(KyselyEffect.executeTakeFirst)
            const missing = yield* database
              .selectFrom('users')
              .selectAll()
              .where('id', '=', 999)
              .$call(KyselyEffect.executeTakeFirst)
            return Result.ok({ raw, compiledResult, first, missing })
          })
        )

        const value = expectOk(result)
        expect(value.raw.rows).toHaveLength(1)
        expect(String(value.raw.rows[0]?.value)).toBe('1')
        expect(value.compiledResult.rows).toEqual([{ id: 1, email: 'ada@example.test' }])
        expect(value.first).toEqual({ id: 1, email: 'ada@example.test', active: 1, nullable: null })
        expect(value.missing).toBeUndefined()
        expect(compiled.sql).toBe(compiledSql)
        expect(compiled.parameters).toEqual(compiledParameters)

        const missingError = new Error('missing user')
        const missingResult = await runOperation(
          runtime,
          database
            .selectFrom('users')
            .selectAll()
            .where('id', '=', 999)
            .$call(KyselyEffect.executeTakeFirstOrFail(() => missingError))
        )
        expect(Result.isError(missingResult)).toBe(true)
        if (Result.isError(missingResult)) expect(missingResult.error).toBe(missingError)
      })
    })

    test('normalizes real query failures without leaking SQL or parameters', async () => {
      await withOwnedDatabase(fixture, async (database, runtime) => {
        await createSchema(runtime)
        const result = await runtime.run(
          Effect.fn(async function* () {
            yield* KyselyEffect.executeQuery(
              database,
              sql`select * from table_that_does_not_exist where secret = ${'value'}`
            )
            return Result.ok(undefined)
          })
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
          expect(result.error).toBeInstanceOf(KyselyQueryError)
          expect(JSON.stringify(result.error)).not.toContain('table_that_does_not_exist')
          expect(JSON.stringify(result.error)).not.toContain('value')
        }
      })
    })

    test('preserves plugin and logger behavior for effectful execution', async () => {
      const pluginEvents: string[] = []
      const loggerEvents: LogEvent[] = []
      const plugin: KyselyPlugin = {
        transformQuery: ({ node }) => {
          pluginEvents.push('transformQuery')
          return node
        },
        transformResult: async ({ result }) => {
          pluginEvents.push('transformResult')
          return result
        }
      }
      const options: IntegrationFixtureOptions = {
        log: (event) => {
          loggerEvents.push(event)
        }
      }

      await withOwnedDatabase(
        fixture,
        async (database, runtime) => {
          await createSchema(runtime)
          await seedUsers(runtime)
          const instrumented = database.withPlugin(plugin)
          const query = instrumented.selectFrom('users').selectAll().where('id', '=', 1)

          pluginEvents.length = 0
          loggerEvents.length = 0
          const nativeRows = await query.execute()
          expect(pluginEvents).toEqual(['transformQuery', 'transformResult'])
          expect(loggerEvents.filter((event) => event.level === 'query')).toHaveLength(1)

          pluginEvents.length = 0
          loggerEvents.length = 0
          const effectResult = await runtime.run(
            Effect.fn(async function* () {
              const rows = yield* query.$call(KyselyEffect.execute)
              return Result.ok(rows)
            })
          )

          expect(expectOk(effectResult)).toEqual(nativeRows)
          expect(pluginEvents).toEqual(['transformQuery', 'transformResult'])
          expect(loggerEvents.filter((event) => event.level === 'query')).toHaveLength(1)

          pluginEvents.length = 0
          loggerEvents.length = 0
          const rawResult = await runtime.run(
            Effect.fn(async function* () {
              const result = yield* KyselyEffect.executeQuery(
                database,
                sql<{ value: number }>`select ${1} as value`.withPlugin(plugin)
              )
              return Result.ok(result)
            })
          )

          expect(expectOk(rawResult).rows).toHaveLength(1)
          expect(pluginEvents).toEqual(['transformQuery', 'transformResult'])
          expect(loggerEvents.filter((event) => event.level === 'query')).toHaveLength(1)
        },
        options
      )
    })

    test('commits, rolls back typed failures, and remains usable after rollback', async () => {
      await withOwnedDatabase(fixture, async (database, runtime) => {
        await createSchema(runtime)
        const committed = await runtime.run(
          Effect.fn(async function* () {
            const value = yield* KyselyEffect.transaction(database, (transaction) =>
              Effect.fn(async function* () {
                const rows = yield* transaction
                  .insertInto('users')
                  .values({ id: 1, email: 'commit@example.test', active: 1, nullable: null })
                  .returningAll()
                  .$call(KyselyEffect.execute)
                return Result.ok(rows)
              })
            )
            return Result.ok(value)
          })
        )
        expect(expectOk(committed)).toEqual([
          { id: 1, email: 'commit@example.test', active: 1, nullable: null }
        ])

        const failure = new Error('rollback this transaction')
        const rolledBack = await runtime.run(
          Effect.fn(async function* () {
            const value = yield* KyselyEffect.transaction(database, (transaction) =>
              Effect.fn(async function* () {
                yield* transaction
                  .insertInto('users')
                  .values({ id: 2, email: 'rollback@example.test', active: 1, nullable: null })
                  .$call(KyselyEffect.execute)
                return Result.err(failure)
              })
            )
            return Result.ok(value)
          })
        )
        expect(Result.isError(rolledBack)).toBe(true)
        if (Result.isError(rolledBack)) expect(rolledBack.error).toBe(failure)
        expect(await database.selectFrom('users').selectAll().execute()).toEqual([
          { id: 1, email: 'commit@example.test', active: 1, nullable: null }
        ])
      })
    })

    test('retains additional Runtime Services in a real transaction body', async () => {
      const created = await fixture.make()
      const context = new TransactionContext()
      const runtime = await Runtime.make(
        Layer.merge(
          Database.layer(() => created.database),
          Layer.succeed(TransactionContext, context)
        )
      )

      try {
        const result = await runtime.run(
          Effect.fn(async function* () {
            const database = yield* Database
            yield* database.schema
              .createTable('users')
              .addColumn('id', 'integer', (column) => column.primaryKey())
              .addColumn('email', 'text', (column) => column.notNull())
              .addColumn('active', 'integer', (column) => column.notNull())
              .addColumn('nullable', 'text')
              .$call(KyselyEffect.execute)
            const value = yield* KyselyEffect.transaction(database, (transaction) =>
              Effect.fn(async function* () {
                const resolved = yield* TransactionContext
                yield* transaction
                  .insertInto('users')
                  .values({
                    id: 1,
                    email: resolved.value,
                    active: 1,
                    nullable: null
                  })
                  .$call(KyselyEffect.execute)
                return Result.ok(resolved)
              })
            )
            return Result.ok(value)
          })
        )

        expect(expectOk(result)).toBe(context)
        expect(await created.database.selectFrom('users').selectAll().execute()).toEqual([
          { id: 1, email: context.value, active: 1, nullable: null }
        ])
      } finally {
        await runtime.dispose()
      }
    })

    test('rolls back defects and query failures on a real transaction', async () => {
      await withOwnedDatabase(fixture, async (database, runtime) => {
        await createSchema(runtime)
        const defect = new Error('real transaction defect')
        let caught: unknown
        try {
          await runtime.run(
            Effect.fn(async function* () {
              yield* KyselyEffect.transaction(database, (transaction) =>
                Effect.fn(async function* () {
                  yield* transaction
                    .insertInto('users')
                    .values({ id: 1, email: 'defect@example.test', active: 1, nullable: null })
                    .$call(KyselyEffect.execute)
                  throw defect
                })
              )
              return Result.ok(undefined)
            })
          )
        } catch (cause) {
          caught = cause
        }
        expect(caught).toBeInstanceOf(Panic)

        const queryResult = await runtime.run(
          Effect.fn(async function* () {
            const value = yield* KyselyEffect.transaction(database, (transaction) =>
              Effect.fn(async function* () {
                yield* transaction
                  .insertInto('users')
                  .values({ id: 2, email: 'query-failure@example.test', active: 1, nullable: null })
                  .$call(KyselyEffect.execute)
                yield* KyselyEffect.executeQuery<IntegrationSchema, never>(
                  transaction,
                  sql<never>`select * from missing_table`
                )
                return Result.ok(undefined)
              })
            )
            return Result.ok(value)
          })
        )
        expect(Result.isError(queryResult)).toBe(true)
        if (Result.isError(queryResult)) expect(queryResult.error).toBeInstanceOf(KyselyQueryError)
        expect(await database.selectFrom('users').selectAll().execute()).toEqual([])
      })
    })

    test('owns and destroys only databases provided through layer', async () => {
      const owned = await fixture.make()
      const ownedRuntime = await Runtime.make(Database.layer(() => owned.database))
      await ownedRuntime.run(async () => {
        const database = await ServiceRuntime.resolve(Database)
        await database.executeQuery(CompiledQuery.raw('select 1'))
      })
      await ownedRuntime.dispose()
      expect(owned.isClosed()).toBe(true)

      const borrowed = await fixture.make()
      const borrowedRuntime = await Runtime.make(Database.succeed(borrowed.database))
      await borrowedRuntime.run(async () => {
        const database = await ServiceRuntime.resolve(Database)
        await database.executeQuery(CompiledQuery.raw('select 1'))
      })
      await borrowedRuntime.dispose()
      expect(borrowed.isClosed()).toBe(false)
      await borrowed.database.destroy()
      expect(borrowed.isClosed()).toBe(true)
    })
  })
}
