import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'

import { KyselyQueryError, KyselyTransactionError } from '../src'

describe('Kysely integration errors', () => {
  test('keeps query causes private while exposing safe JSON metadata', () => {
    const cause = new Error('select secret from credentials where token = secret-token')
    const error = new KyselyQueryError({ cause, operation: 'execute' })

    expect(error._tag).toBe('KyselyQueryError')
    expect(error.name).toBe('KyselyQueryError')
    expect(error.message).toBe('Kysely query execution failed.')
    expect(error.operation).toBe('execute')
    expect(error.cause).toBe(cause)
    expect(Object.keys(error)).not.toContain('cause')
    expect(error.toJSON()).toEqual({
      _tag: 'KyselyQueryError',
      message: 'Kysely query execution failed.',
      name: 'KyselyQueryError',
      operation: 'execute'
    })

    const json = JSON.stringify(error)
    const logged = inspect(error)
    expect(json).not.toContain('secret-token')
    expect(json).not.toContain('cause')
    expect(json).not.toContain('stack')
    expect(error.stack).not.toContain('secret-token')
    expect(logged).not.toContain('secret-token')
  })

  test('keeps transaction causes and body failures private', () => {
    const cause = new Error('rollback leaked SQL parameters')
    const bodyFailure = { secret: 'domain details' }
    const error = new KyselyTransactionError({ cause, bodyFailure })

    expect(error._tag).toBe('KyselyTransactionError')
    expect(error.name).toBe('KyselyTransactionError')
    expect(error.message).toBe('Kysely transaction failed.')
    expect(error.cause).toBe(cause)
    expect(error.bodyFailure).toBe(bodyFailure)
    expect(Object.keys(error)).not.toContain('cause')
    expect(Object.keys(error)).not.toContain('bodyFailure')
    expect(error.toJSON()).toEqual({
      _tag: 'KyselyTransactionError',
      message: 'Kysely transaction failed.',
      name: 'KyselyTransactionError'
    })

    const json = JSON.stringify(error)
    const logged = inspect(error)
    expect(json).not.toContain('rollback leaked SQL parameters')
    expect(json).not.toContain('domain details')
    expect(json).not.toContain('bodyFailure')
    expect(error.stack).not.toContain('rollback leaked SQL parameters')
    expect(logged).not.toContain('domain details')
  })

  test('omits body failure metadata when it was not observed', () => {
    const error = new KyselyTransactionError({ cause: new Error('native failure') })

    expect('bodyFailure' in error).toBe(false)
    expect(error.toJSON()).toEqual({
      _tag: 'KyselyTransactionError',
      message: 'Kysely transaction failed.',
      name: 'KyselyTransactionError'
    })
  })
})
