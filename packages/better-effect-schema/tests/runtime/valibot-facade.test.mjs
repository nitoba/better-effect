import assert from 'node:assert/strict'
import { test } from 'bun:test'
import * as v from 'valibot'
import { Result } from 'better-result'

import { Schema } from '../../dist/esm/valibot.js'

const User = v.object({ id: v.string(), name: v.optional(v.string(), 'Ada') })

test('Valibot subpath exports a preconfigured Schema facade', () => {
  const decoded = Schema.decode(User, { id: 'valibot-user' })

  assert.equal(Result.isOk(decoded), true)
  if (Result.isError(decoded)) return
  assert.deepEqual(decoded.value, { id: 'valibot-user', name: 'Ada' })

  const fields = Schema.fields(User)
  assert.equal(Result.isOk(fields), true)
  if (Result.isError(fields)) return
  assert.equal(fields.value.id, User.entries.id)
})

test('Valibot subpath facade exposes configured derivation operations', () => {
  const partial = Schema.derive(User, 'partial')

  assert.equal(Result.isOk(partial), true)
  if (Result.isError(partial)) return
  assert.equal(v.safeParse(partial.value, {}).success, true)
})
