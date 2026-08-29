import { SQL } from 'bun'
import { Result, UnhandledException, type Result as ResultType } from 'better-result'

import { Service } from './better-effect'
import { DatabaseFailure } from './errors'

/**
 * SQLite connections in Bun do not use a connection pool, so `SQL.reserve()`
 * is not available for this adapter. The SQL client itself is the connection
 * used by each operation.
 */
export type DatabaseConnection = SQL

export class Database extends Service<Database>()('Database') {
  constructor(readonly sql: SQL) {
    super()
  }

  async initialize(): Promise<void> {
    await this.sql`
      PRAGMA foreign_keys = ON
    `

    await this.sql`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `

    await this.sql`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id)
          REFERENCES users(id)
          ON DELETE CASCADE
      )
    `

    await this.sql`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id)
          REFERENCES users(id)
          ON DELETE CASCADE
      )
    `
  }

  async run<A>(
    operation: string,
    use: (connection: DatabaseConnection) => A | PromiseLike<A>
  ): Promise<ResultType<A, DatabaseFailure>> {
    const normalizeFailure = (cause: unknown): DatabaseFailure => {
      if (cause instanceof DatabaseFailure) {
        return cause
      }

      return new DatabaseFailure({
        operation,
        cause: cause instanceof UnhandledException ? cause.cause : cause,
        message: `Database operation failed: ${operation}`
      })
    }

    return Result.tryPromise({
      try: () => Promise.resolve(use(this.sql)),
      catch: normalizeFailure
    })
  }

  async close(): Promise<void> {
    await this.sql.close()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}
