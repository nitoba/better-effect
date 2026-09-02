import { Database as BunSqliteDatabase } from 'bun:sqlite'
import { Kysely, SqliteDialect } from 'kysely'

export interface ExampleSchema {
  users: {
    id: number
    email: string
  }
}

interface BunSqliteStatement {
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

class ExampleSqliteDatabase {
  #closed = false

  constructor(private readonly database: BunSqliteDatabase) {}

  get closed(): boolean {
    return this.#closed
  }

  prepare(sql: string): KyselySqliteStatement {
    // SAFETY: Bun's Statement methods are the runtime boundary required by Kysely's SQLite dialect.
    const statement = this.database.prepare(sql) as BunSqliteStatement

    return {
      reader: statement.columnNames.length > 0,
      all: (parameters) => statement.all(...parameters),
      run: (parameters) => statement.run(...parameters),
      iterate: (parameters) => statement.iterate(...parameters)
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.database.close()
  }
}

export interface ExampleSqliteFixture {
  readonly database: Kysely<ExampleSchema>
  readonly native: ExampleSqliteDatabase
}

export const makeSqliteDatabase = (): ExampleSqliteFixture => {
  const native = new ExampleSqliteDatabase(new BunSqliteDatabase(':memory:'))
  const database = new Kysely<ExampleSchema>({
    dialect: new SqliteDialect({ database: native })
  })

  return { database, native }
}
