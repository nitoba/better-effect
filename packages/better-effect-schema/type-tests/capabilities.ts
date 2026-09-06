import { Result, type Result as ResultType } from 'better-result'
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'

import { Schema, SchemaUnsupportedOperation, type SchemaAdapter } from '../src/index.js'

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
