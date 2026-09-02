import { describe, expect, test } from 'bun:test'
import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { Database as BunSqliteDatabase } from 'bun:sqlite'
import { Kysely, SqliteDialect } from 'kysely'

import { KyselyEffect } from '../src'

interface DatabaseSchema {
  users: {
    id: number
    email: string
  }
}

const Database = KyselyEffect.service<DatabaseSchema>()('@tests/SqliteDatabase')

type BunSqliteStatement = {
  readonly columnNames: readonly string[]
  all(...parameters: unknown[]): unknown[]
  run(...parameters: unknown[]): {
    readonly changes: number | bigint
    readonly lastInsertRowid: number | bigint
  }
  iterate(...parameters: unknown[]): IterableIterator<unknown>
}

interface KyselySqliteStatement {
  readonly reader: boolean
  all(parameters: ReadonlyArray<unknown>): unknown[]
  run(parameters: ReadonlyArray<unknown>): {
    readonly changes: number | bigint
    readonly lastInsertRowid: number | bigint
  }
  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>
}

class BunSqliteDatabaseAdapter {
  constructor(private readonly database: BunSqliteDatabase) {}

  close(): void {
    this.database.close()
  }

  prepare(sql: string): KyselySqliteStatement {
    // SAFETY: Bun's Statement methods are the same runtime boundary Kysely's SQLite dialect needs; only parameter typing differs.
    const statement = this.database.prepare(sql) as BunSqliteStatement

    return {
      reader: statement.columnNames.length > 0,
      all: (parameters) => statement.all(...parameters),
      run: (parameters) => statement.run(...parameters),
      iterate: (parameters) => statement.iterate(...parameters)
    }
  }
}

const makeDatabase = async (): Promise<Kysely<DatabaseSchema>> => {
  const database = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new BunSqliteDatabaseAdapter(new BunSqliteDatabase(':memory:'))
    })
  })

  await database.schema
    .createTable('users')
    .addColumn('id', 'integer', (column) => column.primaryKey())
    .addColumn('email', 'text', (column) => column.notNull())
    .execute()

  return database
}

const makeRuntime = async (): Promise<{
  readonly database: Kysely<DatabaseSchema>
  readonly runtime: Runtime<ReturnType<typeof Database.of>>
}> => {
  const database = await makeDatabase()
  const runtime = await Runtime.make(Database.layer(() => database))
  return { database, runtime }
}

describe('Kysely SQLite transaction atomicity', () => {
  test('persists inserts from a successful transaction and releases the owned database', async () => {
    const { database, runtime } = await makeRuntime()
    const result = await runtime.run(
      Effect.fn(async function* () {
        const db = yield* Database
        const user = yield* KyselyEffect.transaction(db, (transaction) =>
          Effect.fn(async function* () {
            const user = { id: 1, email: 'ok@example.test' }
            yield* transaction.insertInto('users').values(user).$call(KyselyEffect.execute)
            return Result.ok(user)
          })
        )
        return Result.ok(user)
      })
    )

    expect(Result.isOk(result)).toBe(true)
    expect(await database.selectFrom('users').selectAll().execute()).toEqual([
      { id: 1, email: 'ok@example.test' }
    ])

    await runtime.dispose()
    expect(() => database.selectFrom('users').selectAll().compile()).not.toThrow()
    // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
    await expect(database.selectFrom('users').selectAll().execute()).rejects.toThrow()
  })

  test('rolls back a typed failure and does not persist either insert', async () => {
    const { database, runtime } = await makeRuntime()
    const failure = new Error('do not commit')

    const result = await runtime.run(
      Effect.fn(async function* () {
        const db = yield* Database
        const value = yield* KyselyEffect.transaction(db, (transaction) =>
          Effect.fn(async function* () {
            yield* transaction
              .insertInto('users')
              .values({ id: 1, email: 'first@example.test' })
              .$call(KyselyEffect.execute)
            yield* transaction
              .insertInto('users')
              .values({ id: 2, email: 'second@example.test' })
              .$call(KyselyEffect.execute)
            return Result.err(failure)
          })
        )
        return Result.ok(value)
      })
    )

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(result.error).toBe(failure)
    }
    expect(await database.selectFrom('users').selectAll().execute()).toEqual([])

    await runtime.dispose()
  })

  test('uses the native transaction connection for first-row terminals', async () => {
    const { database, runtime } = await makeRuntime()
    await database.insertInto('users').values({ id: 1, email: 'existing@example.test' }).execute()

    const result = await runtime.run(
      Effect.fn(async function* () {
        const db = yield* Database
        const row = yield* KyselyEffect.transaction(db, (transaction) =>
          Effect.fn(async function* () {
            const row = yield* transaction
              .selectFrom('users')
              .selectAll()
              .$call(KyselyEffect.executeTakeFirst)
            return Result.ok(row)
          })
        )
        return Result.ok(row)
      })
    )

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
      expect(result.value).toEqual({ id: 1, email: 'existing@example.test' })
    }

    await runtime.dispose()
  })
})
