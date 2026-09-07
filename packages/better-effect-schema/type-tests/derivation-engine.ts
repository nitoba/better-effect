import { Result, type Result as ResultType } from 'better-result'

import {
  createDerivationEngine,
  type DerivationFailure,
  type DerivationFieldMap,
  type DerivationMask
} from '../src/derivation/index.js'
import type { Equal, Expect } from './helpers.js'

type Field = {
  readonly kind: string
}

type Schema = {
  readonly fields: DerivationFieldMap<Field>
  readonly label: string
}

const fields: DerivationFieldMap<Field> = {
  id: { kind: 'number' },
  name: { kind: 'string' }
}

const source: Schema = { fields, label: 'source' }
const mask: DerivationMask = { name: true }

const engine = createDerivationEngine<Schema, Field>({
  structure: {
    fields: (schema) => Result.ok(schema.fields),
    policy: (schema, _policy) => Result.ok(schema)
  },
  derivation: {
    derive: (schema) => Result.ok(schema)
  }
})

const picked = engine.pick(source, mask, { protectedKeys: [] })
picked satisfies ResultType<Schema, DerivationFailure>

type _PickValue = Expect<Equal<typeof picked, ResultType<Schema, DerivationFailure>>>

const extended = engine.extend(source, { active: { kind: 'boolean' } })
extended satisfies ResultType<Schema, DerivationFailure>

engine.partial(source)
engine.exactPartial(source, mask)
engine.deepPartial(source)
engine.required(source, mask)
engine.strict(source)
engine.loose(source)
engine.strip(source)
engine.catchall(source, { kind: 'unknown' })

// @ts-expect-error masks contain only literal true values
engine.pick(source, { name: false })

// @ts-expect-error catchall requires a field capability value
engine.catchall(source)
