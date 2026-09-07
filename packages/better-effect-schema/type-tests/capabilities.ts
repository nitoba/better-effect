import { Result, type Result as ResultType } from 'better-result'
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'

import {
  Schema,
  SchemaUnsupportedOperation,
  type SchemaAdapter,
  type SchemaDescriptor,
  type SchemaInput,
  type SchemaOutput
} from '../src/index.js'
import type { Equal, Expect } from './helpers.js'

const adapter = {
  encoding: {
    encode: <Input, Output>(
      _schema: StandardSchemaV1<Input, Output>,
      value: Output
    ): ResultType<Input, SchemaUnsupportedOperation> => Result.ok(value as unknown as Input)
  }
} satisfies SchemaAdapter

const local = Schema.with(adapter)
const encoded = local.encode({} as StandardSchemaV1<string, number>, 1)
encoded satisfies ResultType<string, SchemaUnsupportedOperation>

// @ts-expect-error an absent capability does not add a phantom method
local.derive

const grouped = Schema.with({
  capabilities: {
    jsonSchema: {
      toJSONSchema: <Input, Output>(
        _schema: StandardSchemaV1<Input, Output>,
        _options: StandardJSONSchemaV1.Options
      ) => Result.ok({ type: 'object' })
    }
  }
})

grouped.toJSONSchema({} as StandardSchemaV1, { target: 'draft-2020-12' })

type WireInput = { readonly raw: string }
type DecodedOutput = { readonly id: number }
type ConstructionInput = { readonly id: string }
type NormalizedProps = { readonly id: number }
type Model = { readonly id: number; readonly label: string }

declare const schema: StandardSchemaV1<WireInput, DecodedOutput>
declare const propsSchema: StandardSchemaV1<ConstructionInput, NormalizedProps>

const descriptor: SchemaDescriptor<
  WireInput,
  DecodedOutput,
  NormalizedProps,
  Model,
  ConstructionInput
> = {
  schema,
  propsSchema,
  construct: (props) => ({ ...props, label: String(props.id) })
}

type _Input = Expect<Equal<SchemaInput<typeof schema>, WireInput>>
type _Output = Expect<Equal<SchemaOutput<typeof schema>, DecodedOutput>>
type _ConstructionInput = Expect<
  Equal<SchemaInput<typeof descriptor.propsSchema>, ConstructionInput>
>
type _Props = Expect<Equal<SchemaOutput<typeof descriptor.propsSchema>, NormalizedProps>>

const propsAdapter = {
  props: {
    props: <Input, Output, Props, Self, InputProps = Props>(
      received: SchemaDescriptor<Input, Output, Props, Self, InputProps>
    ): ResultType<StandardSchemaV1<InputProps, Props>, SchemaUnsupportedOperation> =>
      Result.ok(received.propsSchema),
    make: <Input, Output, Props, Self, InputProps = Props>(
      received: SchemaDescriptor<Input, Output, Props, Self, InputProps>,
      _input: InputProps
    ): ResultType<Self, SchemaUnsupportedOperation> => Result.ok(null as unknown as Self)
  }
} satisfies SchemaAdapter

const propsLocal = Schema.with(propsAdapter)
const propsResult = propsLocal.props(descriptor)
propsResult satisfies ResultType<
  StandardSchemaV1<ConstructionInput, NormalizedProps>,
  SchemaUnsupportedOperation
>
const modelResult = propsLocal.make(descriptor, { id: '1' })
modelResult satisfies ResultType<Model, SchemaUnsupportedOperation>
