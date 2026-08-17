import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import type { SQL } from 'bun'

import { Database } from '../examples/todo-api/database'
import { DatabaseFailure } from '../examples/todo-api/errors'

// SAFETY: The database tests never execute the SQL client; an empty object is sufficient for identity checks.
const makeSql = (): SQL => ({}) as SQL

describe('TODO API Database.run', () => {
  test('uses the shared SQL client and preserves successful results', async () => {
    const sql = makeSql()
    const database = new Database(sql)

    const result = await database.run('database.test', (connection) => {
      expect(connection).toBe(sql)

      return 42
    })

    expect(result).toEqual(Result.ok(42))
  })

  test('normalizes callback failures as DatabaseFailure', async () => {
    const cause = new Error('query failed')
    const database = new Database(makeSql())

    const result = await database.run('database.test', () => {
      throw cause
    })

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(DatabaseFailure)

      if (result.error instanceof DatabaseFailure) {
        expect(result.error.operation).toBe('database.test')
        expect(result.error.cause).toBe(cause)
      }
    }
  })

  test('normalizes rejected callbacks as DatabaseFailure', async () => {
    const cause = new Error('query rejected')
    const database = new Database(makeSql())

    const result = await database.run('database.test', () => Promise.reject(cause))

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(DatabaseFailure)

      if (result.error instanceof DatabaseFailure) {
        expect(result.error.cause).toBe(cause)
      }
    }
  })
})
