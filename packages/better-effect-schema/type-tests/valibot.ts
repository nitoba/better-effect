import { Result, type Result as ResultType } from 'better-result'
import * as v from 'valibot'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import {
  Schema,
  type SchemaAdapter,
  type SchemaCapabilityFailure,
  type SchemaDescriptor,
  type SchemaFieldMap,
  type SchemaInput,
  type SchemaOutput
} from '../src/index.js'
import { ValibotAdapter } from '../src/valibot.js'
import type { Equal, Expect } from './helpers.js'

const User = v.object({
  id: v.string(),
  name: v.optional(v.string(), 'Ada')
})

type UserInput = v.InferInput<typeof User>
type UserOutput = v.InferOutput<typeof User>
type _Input = Expect<Equal<SchemaInput<typeof User>, UserInput>>
type _Output = Expect<Equal<SchemaOutput<typeof User>, UserOutput>>

const local = Schema.with(ValibotAdapter)
const readResult = local.read(User)
readResult satisfies ResultType<typeof User, SchemaCapabilityFailure>
const fieldsResult = local.fields(User)
fieldsResult satisfies ResultType<SchemaFieldMap, SchemaCapabilityFailure>
const encodedResult = local.encoded(User)
encodedResult satisfies ResultType<StandardSchemaV1<UserInput, UserInput>, SchemaCapabilityFailure>
const derivedResult = local.derive(User, 'partial')
derivedResult satisfies ResultType<StandardSchemaV1, SchemaCapabilityFailure>

const pipeline = v.pipe(
  v.string(),
  v.transform((value) => value.length)
)
type _PipelineInput = Expect<Equal<v.InferInput<typeof pipeline>, string>>
type _PipelineOutput = Expect<Equal<v.InferOutput<typeof pipeline>, number>>
const projectedPipeline = local.encoded(pipeline)
projectedPipeline satisfies ResultType<StandardSchemaV1<string, string>, SchemaCapabilityFailure>

// @ts-expect-error ValibotAdapter intentionally has no implicit encoder.
local.encode

// @ts-expect-error JSON Schema conversion is not provided without a converter.
local.toJSONSchema

const encoder = <Input, Output>(_schema: StandardSchemaV1<Input, Output>, value: Output): Input =>
  value as unknown as Input

const configured = Schema.with(ValibotAdapter.withEncoder(encoder))
const encodedValue = configured.encode(User, { id: 'u1', name: 'Ada' })
encodedValue satisfies ResultType<UserInput, SchemaCapabilityFailure>

// @ts-expect-error A sync-only explicit encoder does not expose encodeAsync.
configured.encodeAsync

// @ts-expect-error The explicit encoder receives the schema output, not arbitrary data.
configured.encode(User, { id: 1 })

type PropsInput = { readonly id: string }
type Props = { readonly id: number }
type Model = { readonly id: number; readonly label: string }
const propsSchema = v.pipe(
  v.object({ id: v.string() }),
  v.transform((value): Props => ({ id: Number(value.id) }))
)
const descriptor: SchemaDescriptor<UserInput, UserOutput, Props, Model, PropsInput> = {
  schema: User,
  propsSchema,
  construct: (props) => ({ id: props.id, label: `#${props.id}` })
}

const propsResult = local.props(descriptor)
propsResult satisfies ResultType<StandardSchemaV1<PropsInput, Props>, SchemaCapabilityFailure>
const modelResult = local.make(descriptor, { id: '42' })
modelResult satisfies ResultType<Model, SchemaCapabilityFailure>

const asyncConfigured = Schema.with(
  ValibotAdapter.withEncoder(
    encoder,
    async <Input, Output>(
      _schema: StandardSchemaV1<Input, Output>,
      value: Output
    ): Promise<Input> => value as unknown as Input
  )
)
const asyncEncodedValue = asyncConfigured.encodeAsync(User, {
  id: 'u1',
  name: 'Ada'
})
asyncEncodedValue satisfies
  | ResultType<UserInput, SchemaCapabilityFailure>
  | PromiseLike<ResultType<UserInput, SchemaCapabilityFailure>>

const adapter: SchemaAdapter = ValibotAdapter
if (adapter.read !== undefined) {
  const checked = Result.isOk(adapter.read.read(User))
  checked satisfies boolean
}
