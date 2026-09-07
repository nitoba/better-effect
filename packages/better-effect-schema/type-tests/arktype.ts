import { type } from 'arktype'
import { Result, type Result as ResultType } from 'better-result'
import type { Effect } from 'better-effect'

import {
  ArkTypeAdapter,
  type ArkTypeEncodedSchema,
  type ArkTypeInput,
  type ArkTypeOutput
} from 'better-effect-schema/arktype'
import {
  Schema,
  SchemaAsyncRequired,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  type SchemaCapabilityFailure
} from 'better-effect-schema'
import type { Equal, Expect } from './helpers.js'

const User = type({ id: 'string', name: 'string' })
const Numeric = type('string').pipe((value) => value.length, type('number'))

type _userInput = Expect<Equal<ArkTypeInput<typeof User>, { id: string; name: string }>>
type _userOutput = Expect<Equal<ArkTypeOutput<typeof User>, { id: string; name: string }>>
type _numericInput = Expect<Equal<ArkTypeInput<typeof Numeric>, string>>
type _numericOutput = Expect<Equal<ArkTypeOutput<typeof Numeric>, number>>

const local = Schema.with(ArkTypeAdapter)
const decoded = local.decode(Numeric, 'hello')
decoded satisfies Effect<
  number,
  SchemaDecodeFailure | SchemaDefinitionFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>

// @ts-expect-error decode keeps ArkType's input type
local.decode(Numeric, 123)

const encoded = local.encoded(Numeric)
encoded satisfies ResultType<ArkTypeEncodedSchema<typeof Numeric>, SchemaCapabilityFailure>

const descriptor = {
  schema: User,
  propsSchema: User,
  construct: (props: { id: string; name: string }) => props
}
const made = local.make(descriptor, { id: '1', name: 'Ada' })
made satisfies ResultType<{ id: string; name: string }, SchemaCapabilityFailure>

const derived = local.derive(User, 'partial')
derived satisfies ResultType<unknown, SchemaCapabilityFailure>

// @ts-expect-error unsupported operation names are excluded from the capability contract
local.derive(User, 'transform')

// @ts-expect-error the ArkType adapter deliberately does not invent an encoder
local.encode

const unsupported = local.derive(User, 'deepPartial')
if (Result.isError(unsupported)) unsupported.error satisfies SchemaCapabilityFailure
