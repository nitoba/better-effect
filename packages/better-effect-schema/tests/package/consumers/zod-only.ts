import * as z from 'zod'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'

const Local = Schema.with(ZodAdapter)
const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class ExternalEvent extends Local.Class<ExternalEvent>('external/ZodEvent')({
  id: z.uuid(),
  createdAt: DateFromISOString
}) {}

const decoded = Schema.decodeUnknown(ExternalEvent, {
  id: '550e8400-e29b-41d4-a716-446655440000',
  createdAt: '2026-09-07T00:00:00.000Z'
})
if (Result.isError(decoded)) throw decoded.error

const encoded = Schema.encode(ExternalEvent, decoded.value)
if (Result.isError(encoded) || encoded.value.createdAt !== '2026-09-07T00:00:00.000Z') {
  throw new Error('Zod codec round-trip failed')
}

const bridged = Local.bridge(z.object({ id: z.uuid() }))
if (Result.isError(bridged)) throw bridged.error

console.log('zod-only: ok')
