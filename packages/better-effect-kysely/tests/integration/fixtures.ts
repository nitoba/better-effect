import { Database as BunSqliteDatabase } from 'bun:sqlite'
import { PGlite } from '@electric-sql/pglite'
import {
  Kysely,
  PGliteDialect,
  SqliteDialect,
  type Dialect,
  type KyselyConfig,
  type KyselyPlugin,
  type Logger
} from 'kysely'

export interface IntegrationSchema {
  users: {
    id: number
    email: string
    active: number
    nullable: string | null
  }
  posts: {
    id: number
    user_id: number
    title: string
  }
}

export type IntegrationDatabase = Kysely<IntegrationSchema>

export interface IntegrationFixtureOptions {
  readonly plugins?: readonly KyselyPlugin[]
  readonly log?: Logger
}

export interface IntegrationFixtureDatabase {
  readonly database: IntegrationDatabase
  readonly isClosed: () => boolean
}

export interface IntegrationFixture {
  readonly name: string
  readonly make: (options?: IntegrationFixtureOptions) => Promise<IntegrationFixtureDatabase>
}

interface MutableKyselyConfig {
  dialect: Dialect
  plugins?: KyselyPlugin[]
  log?: Logger
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

class BunSqliteDialectDatabase {
  #closed = false

  constructor(private readonly database: BunSqliteDatabase) {}

  get isClosed(): boolean {
    return this.#closed
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.database.close()
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
}

const config = (dialect: Dialect, options: IntegrationFixtureOptions): KyselyConfig => {
  const value: MutableKyselyConfig = { dialect }
  if (options.plugins !== undefined) value.plugins = [...options.plugins]
  if (options.log !== undefined) value.log = options.log
  return value
}

const makeSqlite = async (
  options: IntegrationFixtureOptions = {}
): Promise<IntegrationFixtureDatabase> => {
  const native = new BunSqliteDialectDatabase(new BunSqliteDatabase(':memory:'))
  const database = new Kysely<IntegrationSchema>({
    ...config(
      new SqliteDialect({
        database: native
      }),
      options
    )
  })

  return { database, isClosed: () => native.isClosed }
}

const makePglite = async (
  options: IntegrationFixtureOptions = {}
): Promise<IntegrationFixtureDatabase> => {
  const native = await PGlite.create('memory://')
  const database = new Kysely<IntegrationSchema>({
    ...config(new PGliteDialect({ pglite: native }), options)
  })

  return { database, isClosed: () => native.closed }
}

export const fixtures: readonly IntegrationFixture[] = [
  { name: 'SQLite via Bun', make: makeSqlite },
  { name: 'PostgreSQL via PGlite', make: makePglite }
]
