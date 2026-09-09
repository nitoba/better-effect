import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Result } from 'better-result'
import { type } from 'arktype'

import { Schema } from '../../dist/esm/arktype.js'

const User = type({ id: 'string', name: 'string' })

test('ArkType subpath exports a preconfigured Schema facade', () => {
  const decoded = Schema.decode(User, { id: 'ark-user', name: 'Ada' })

  assert.equal(Result.isOk(decoded), true)
  if (Result.isError(decoded)) return
  assert.deepEqual(decoded.value, { id: 'ark-user', name: 'Ada' })

  const fields = Schema.fields(User)
  assert.equal(Result.isOk(fields), true)
  if (Result.isError(fields)) return
  assert.equal(fields.value.id('ark-user') instanceof type.errors, false)
})

test('ArkType subpath facade exposes configured derivation operations', () => {
  const partial = Schema.derive(User, 'partial')

  assert.equal(Result.isOk(partial), true)
  if (Result.isError(partial)) return
  assert.equal(partial.value({}).id, undefined)
})
