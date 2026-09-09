import assert from 'node:assert/strict'
import { test } from 'bun:test'
import * as z from 'zod'
import { Result } from 'better-result'

import { Schema } from '../../dist/esm/zod.js'

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class User extends Schema.Class('runtime/ZodFacadeUser')({
  id: z.uuid(),
  createdAt: DateFromISOString
}) {}

const encoded = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  createdAt: '2026-09-09T00:00:00.000Z'
}

test('Zod subpath exports a preconfigured Schema facade', () => {
  const decoded = Schema.decode(User, encoded)

  assert.equal(Result.isOk(decoded), true)
  if (Result.isError(decoded)) return
  assert.ok(decoded.value instanceof User)
  assert.ok(decoded.value.createdAt instanceof Date)

  const encodedResult = Schema.encode(DateFromISOString, decoded.value.createdAt)
  assert.equal(Result.isOk(encodedResult), true)
  if (Result.isError(encodedResult)) return
  assert.equal(encodedResult.value, encoded.createdAt)
})

test('Zod subpath facade exposes configured bridge operations', () => {
  const bridged = Schema.bridge({ id: z.string() })

  assert.equal(Result.isOk(bridged), true)
  if (Result.isError(bridged)) return
  assert.deepEqual(bridged.value.parse({ id: 'one' }), { id: 'one' })
})
