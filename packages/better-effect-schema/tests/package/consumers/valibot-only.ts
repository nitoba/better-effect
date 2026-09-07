import * as v from 'valibot'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'
import { ValibotAdapter } from 'better-effect-schema/valibot'

const Local = Schema.with(ValibotAdapter)
const User = v.object({ id: v.string(), name: v.optional(v.string(), 'Ada') })

const fields = Local.fields(User)
if (Result.isError(fields) || fields.value.id !== User.entries.id) {
  throw new Error('Valibot fields capability failed')
}

const decoded = Local.decode(User, { id: 'valibot-user' })
if (Result.isError(decoded) || decoded.value.name !== 'Ada') {
  throw new Error('Valibot validation failed')
}

const descriptor = {
  schema: User,
  propsSchema: User,
  construct: (props: v.InferOutput<typeof User>) => ({ ...props, kind: 'valibot' as const })
}
const made = Local.make(descriptor, { id: 'made-user' })
if (Result.isError(made) || made.value.kind !== 'valibot') {
  throw new Error('Valibot construction failed')
}

const derived = Local.derive(User, 'partial')
if (Result.isError(derived)) throw derived.error

console.log('valibot-only: ok')
