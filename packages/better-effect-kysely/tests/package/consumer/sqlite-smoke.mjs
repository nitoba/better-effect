import { Kysely, SqliteDialect } from 'kysely'
import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { KyselyEffect } from 'better-effect-kysely'

const runtimeName = process.argv[2] ?? 'bun'
if (runtimeName !== 'bun' && runtimeName !== 'node') {
  throw new Error(`Unsupported SQLite smoke runtime: ${runtimeName}`)
}

class BunSqliteDatabase {
  #closed = false

  constructor(Database) {
    this.database = new Database(':memory:')
  }

  get closed() {
    return this.#closed
  }

  prepare(sql) {
    const statement = this.database.prepare(sql)
    return {
      reader: statement.columnNames.length > 0,
      all: (parameters) => statement.all(...parameters),
      run: (parameters) => statement.run(...parameters),
      iterate: (parameters) => statement.iterate(...parameters)
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.database.close()
  }
}

class BetterSqlite3Database {
  constructor(Database) {
    this.database = new Database(':memory:')
  }

  get closed() {
    return !this.database.open
  }

  prepare(sql) {
    const statement = this.database.prepare(sql)
    return {
      reader: statement.reader,
      all: (parameters) => statement.all(...parameters),
      run: (parameters) => statement.run(...parameters),
      iterate: (parameters) => statement.iterate(...parameters)
    }
  }

  close() {
    if (!this.database.open) return
    this.database.close()
  }
}

const makeDatabase = async () => {
  if (runtimeName === 'bun') {
    const { Database: BunDatabase } = await import('bun:sqlite')
    const native = new BunSqliteDatabase(BunDatabase)
    return { native, database: new Kysely({ dialect: new SqliteDialect({ database: native }) }) }
  }

  const { default: BetterSqlite3 } = await import('better-sqlite3')
  const native = new BetterSqlite3Database(BetterSqlite3)
  return { native, database: new Kysely({ dialect: new SqliteDialect({ database: native }) }) }
}

const { native, database } = await makeDatabase()
const Database = KyselyEffect.service()('@external-sqlite/Database')
const runtime = await Runtime.make(Database.layer(() => database))

const result = await runtime.run(
  Effect.fn(async function* () {
    const resolved = yield* Database
    yield* resolved.schema
      .createTable('users')
      .addColumn('id', 'integer', (column) => column.primaryKey())
      .addColumn('email', 'text', (column) => column.notNull())
      .$call(KyselyEffect.execute)
    const inserted = yield* resolved
      .insertInto('users')
      .values({ id: 1, email: `${runtimeName}@example.test` })
      .returningAll()
      .$call(KyselyEffect.execute)
    const rows = yield* resolved
      .selectFrom('users')
      .select(['id', 'email'])
      .$call(KyselyEffect.execute)
    return Result.ok({ inserted, rows })
  })
)

if (
  !Result.isOk(result) ||
  result.value.inserted[0]?.email !== `${runtimeName}@example.test` ||
  result.value.rows.length !== 1
) {
  throw new Error(`The external ${runtimeName} SQLite smoke query failed`)
}

const rollbackError = { type: 'external-sqlite-rollback' }
const rollback = await runtime.run(
  Effect.fn(async function* () {
    const resolved = yield* Database
    yield* KyselyEffect.transaction(resolved, (transaction) =>
      Effect.fn(async function* () {
        yield* transaction
          .insertInto('users')
          .values({ id: 2, email: 'rolled-back@example.test' })
          .$call(KyselyEffect.execute)
        return Result.err(rollbackError)
      })
    )
    return Result.ok('unreachable')
  })
)
if (!Result.isError(rollback) || rollback.error !== rollbackError) {
  throw new Error(`The external ${runtimeName} SQLite smoke transaction did not roll back`)
}

const persisted = await database.selectFrom('users').selectAll().execute()
if (persisted.length !== 1 || persisted[0]?.id !== 1) {
  throw new Error(`The external ${runtimeName} SQLite smoke committed a rolled-back row`)
}
await runtime.dispose()
const closed = native.closed
if (!closed) {
  throw new Error(`The owned external ${runtimeName} SQLite database was not destroyed`)
}

console.log(`better-effect-kysely external ${runtimeName} SQLite smoke passed`)
