import { type } from 'arktype'
import * as v from 'valibot'
import * as z from 'zod'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'
import { ArkTypeAdapter } from 'better-effect-schema/arktype'
import { ValibotAdapter } from 'better-effect-schema/valibot'
import { ZodAdapter } from 'better-effect-schema/zod'

const zodLocal = Schema.with(ZodAdapter)
const valibotLocal = Schema.with(ValibotAdapter)
const arkTypeLocal = Schema.with(ArkTypeAdapter)
if (zodLocal === valibotLocal || zodLocal === arkTypeLocal || valibotLocal === arkTypeLocal) {
  throw new Error('provider facades must not share global state')
}

class ZodUser extends zodLocal.Class<ZodUser>('external/AllProvidersZodUser')({
  id: z.uuid()
}) {}
const zodUser = Schema.decodeUnknown(ZodUser, { id: '550e8400-e29b-41d4-a716-446655440000' })
if (Result.isError(zodUser) || !(zodUser.value instanceof ZodUser)) {
  throw new Error('all-provider Zod class failed')
}

const valibotFields = valibotLocal.fields(v.object({ id: v.string() }))
if (Result.isError(valibotFields)) throw valibotFields.error

const arkTypeUser = arkTypeLocal.decode(type({ id: 'string' }), { id: 'ark-user' })
if (Result.isError(arkTypeUser) || arkTypeUser.value.id !== 'ark-user') {
  throw new Error('all-provider ArkType decode failed')
}

console.log('all-providers: ok')
