import { expectTypeOf } from 'bun:test'
import {
  Kysely,
  MysqlDialect,
  PostgresDialect,
  PGliteDialect,
  SqliteDialect,
  sql,
  type CompiledQuery,
  type KyselyConfig,
  type MysqlDialectConfig,
  type PGliteDialectConfig,
  type PostgresDialectConfig,
  type QueryResult,
  type SqliteDialectConfig
} from 'kysely'

import { KyselyEffect, KyselyQueryError } from '../../src'
import type { KyselyOperation } from '../../src'

interface DialectSchema {
  users: {
    id: number
    email: string
    nullable: string | null
  }
}

declare const sqliteConfig: SqliteDialectConfig
declare const postgresConfig: PostgresDialectConfig
declare const mysqlConfig: MysqlDialectConfig
declare const pgliteConfig: PGliteDialectConfig

const dialects = [
  new SqliteDialect(sqliteConfig),
  new PostgresDialect(postgresConfig),
  new MysqlDialect(mysqlConfig),
  new PGliteDialect(pgliteConfig)
] as const

const assertDialect = (dialect: KyselyConfig['dialect']): void => {
  const database = new Kysely<DialectSchema>({ dialect })
  const query = database.selectFrom('users').select(['id', 'email', 'nullable'])
  const compiled: CompiledQuery<{ id: number; email: string; nullable: string | null }> =
    query.compile()
  const raw = sql<{ value: number }>`select 1 as value`
  const operation = KyselyEffect.executeQuery(database, compiled)
  const rawOperation = KyselyEffect.executeQuery(database, raw)

  expectTypeOf<Awaited<ReturnType<typeof query.execute>>>().toEqualTypeOf<
    Array<{ id: number; email: string; nullable: string | null }>
  >()
  expectTypeOf(operation).toEqualTypeOf<
    KyselyOperation<
      QueryResult<{ id: number; email: string; nullable: string | null }>,
      KyselyQueryError
    >
  >()
  expectTypeOf(rawOperation).toEqualTypeOf<
    KyselyOperation<QueryResult<{ value: number }>, KyselyQueryError>
  >()
}

for (const dialect of dialects) assertDialect(dialect)
