import * as z from 'zod'
import { Result, type Result as ResultType } from 'better-result'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import { Schema, type SchemaCapabilityFailure, type SchemaDescriptor } from '../src/index.js'
import { ZodAdapter } from '../src/adapters/zod/index.js'
import type { Equal, Expect } from './helpers.js'

const local = Schema.with(ZodAdapter)

const dateCodec = z.codec(z.string(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

const encoded = local.encoded(dateCodec)
encoded satisfies ResultType<StandardSchemaV1<string, string>, SchemaCapabilityFailure>

const encodedValue = local.encode(dateCodec, new Date())
encodedValue satisfies ResultType<string, SchemaCapabilityFailure>

const bridged = local.bridge(dateCodec)
bridged satisfies ResultType<StandardSchemaV1<string, Date>, SchemaCapabilityFailure>

const construction = {
  input: z.object({ value: z.string() }),
  props: z.codec(z.object({ value: z.string() }), z.object({ value: z.number() }), {
    decode: ({ value }) => ({ value: Number(value) }),
    encode: ({ value }) => ({ value: String(value) })
  })
}

type ConstructionInput = z.input<typeof construction.input>
type Props = z.output<typeof construction.props>
type Model = { readonly value: number }

const descriptor: SchemaDescriptor<string, Date, Props, Model, ConstructionInput> = {
  schema: dateCodec,
  propsSchema: construction.props,
  construct: (props) => props
}

const props = local.props(descriptor)
props satisfies ResultType<StandardSchemaV1<ConstructionInput, Props>, SchemaCapabilityFailure>

const model = local.make(descriptor, { value: '1' })
model satisfies ResultType<Model, SchemaCapabilityFailure>

const fields = local.fields(z.object({ id: z.string() }))
fields satisfies ResultType<Readonly<Record<string, StandardSchemaV1>>, SchemaCapabilityFailure>

type _Input = Expect<Equal<z.input<typeof dateCodec>, string>>
type _Output = Expect<Equal<z.output<typeof dateCodec>, Date>>
type _ConstructionInput = Expect<Equal<ConstructionInput, { value: string }>>
type _Props = Expect<Equal<Props, { value: number }>>

Result.ok(encodedValue)
