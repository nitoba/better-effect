import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import type { SQL } from 'bun'

import { Database } from '../examples/todo-api/database'
import { DatabaseFailure } from '../examples/todo-api/errors'
import { Scope } from '../src/scope'

const makeSql = (): SQL => ({}) as SQL

describe('TODO API Database.run', () => {
  test('uses the current Scope and preserves successful results', async () => {
    const sql = makeSql()
    const database = new Database(sql)
    let finalized = 0

    const result = await Scope.run(async (scope) => {
      const result = await database.run('database.test', (connection) => {
        expect(connection).toBe(sql)
        expect(Scope.current()).toBe(scope)

        scope.addFinalizer(() => {
          finalized++
        })

        return 42
      })

      expect(finalized).toBe(0)

      return result
    })

    expect(result).toEqual(Result.ok(42))
    expect(finalized).toBe(1)
  })

  test('normalizes callback failures as DatabaseFailure', async () => {
    const cause = new Error('query failed')
    const database = new Database(makeSql())

    const result = await Scope.run(() =>
      database.run('database.test', () => {
        throw cause
      })
    )

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(DatabaseFailure)

      if (result.error instanceof DatabaseFailure) {
        expect(result.error.operation).toBe('database.test')
        expect(result.error.cause).toBe(cause)
      }
    }
  })

  test('normalizes missing Scope context as DatabaseFailure', async () => {
    const database = new Database(makeSql())

    const result = await database.run('database.test', () => 42)

    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(DatabaseFailure)
    }
  })
})
