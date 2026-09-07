import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'

type User = { readonly id: string }

const userSchema: StandardSchemaV1<User, User> = {
  '~standard': {
    version: 1,
    vendor: 'external-core-only',
    validate(value) {
      if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'id') !== 'string') {
        return { issues: [{ message: 'Expected a user' }] }
      }
      return { value: { id: Reflect.get(value, 'id') as string } }
    }
  }
}

class ExternalUser extends Schema.Class<ExternalUser>('external/CoreUser')({
  schema: userSchema,
  propsSchema: userSchema,
  encodedSchema: userSchema,
  encode: (value) => value
}) {}

const decoded = Schema.decodeUnknown(ExternalUser, { id: 'core-user' })
if (Result.isError(decoded)) throw decoded.error
if (!ExternalUser.is(decoded.value)) throw new Error('core-only class identity failed')

const made = Schema.make(ExternalUser, { id: 'made-user' })
if (Result.isError(made)) throw made.error

const encoded = Schema.encode(ExternalUser, decoded.value)
if (Result.isError(encoded) || encoded.value.id !== 'core-user') {
  throw new Error('core-only Standard Schema round-trip failed')
}

const standard: StandardSchemaV1<User, ExternalUser> = ExternalUser
void standard
console.log('core-only: ok')
