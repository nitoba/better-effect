import { type } from 'arktype'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'
import { ArkTypeAdapter } from 'better-effect-schema/arktype'

const Local = Schema.with(ArkTypeAdapter)
const User = type({ id: 'string', name: 'string' })
const Length = type('string').pipe((value) => value.length, type('number'))

const decoded = Local.decode(Length, 'arktype-morph')
if (Result.isError(decoded) || decoded.value !== 'arktype-morph'.length) {
  throw new Error('ArkType morph failed')
}

const fields = Local.fields(User)
if (Result.isError(fields) || fields.value.id === undefined) {
  throw new Error('ArkType fields capability failed')
}

const made = Local.make(
  { schema: User, propsSchema: User, construct: (props: { id: string; name: string }) => props },
  { id: 'arktype-user', name: 'Ada' }
)
if (Result.isError(made) || made.value.name !== 'Ada') {
  throw new Error('ArkType construction failed')
}

const derived = Local.derive(User, 'partial')
if (Result.isError(derived)) throw derived.error

console.log('arktype-only: ok')
