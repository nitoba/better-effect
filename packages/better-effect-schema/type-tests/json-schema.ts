import type { StandardJSONSchemaV1 } from '@standard-schema/spec'
import type { Effect } from 'better-effect'

import { Schema, type ClassAnnotations } from '../src/index.js'
import {
  createSchemaMetadata,
  toJSONSchema,
  type JSONSchemaConversionFailure,
  type JSONSchemaModel,
  type JsonSchemaDocument,
  type SchemaAnnotations
} from '../src/json-schema/index.js'
import {
  SchemaAsyncRequired,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../src/index.js'

type ConversionErrors =
  | SchemaAsyncRequired
  | SchemaDefinitionFailure
  | SchemaExecutionFailure
  | SchemaUnsupportedOperation

type _FailureAlias = JSONSchemaConversionFailure extends ConversionErrors ? true : false

const jsonOnly = {
  '~standard': {
    version: 1,
    vendor: 'type-fixture',
    jsonSchema: {
      input: (_options: StandardJSONSchemaV1.Options) => ({ type: 'string' }),
      output: (_options: StandardJSONSchemaV1.Options) => ({ type: 'number' })
    }
  }
} satisfies StandardJSONSchemaV1<string, number>

const explicitModel = {
  jsonSchema: {
    input: (_options: StandardJSONSchemaV1.Options) => ({ type: 'string' }),
    output: (_options: StandardJSONSchemaV1.Options) => ({ type: 'number' })
  }
} satisfies JSONSchemaModel

const input = Schema.toJSONSchema(jsonOnly, {
  side: 'input',
  target: 'draft-2020-12',
  libraryOptions: { refs: 'preserve' }
})
input satisfies Effect<JsonSchemaDocument, ConversionErrors, never>

const output = toJSONSchema(explicitModel, { side: 'output', target: 'draft-07' })
output satisfies Effect<JsonSchemaDocument, ConversionErrors, never>

// @ts-expect-error the side selects only the two Standard JSON Schema representations
toJSONSchema(jsonOnly, { side: 'encoded', target: 'draft-07' })

// @ts-expect-error a target is required by the Standard JSON Schema converter contract
toJSONSchema(jsonOnly, {})

const annotations = {
  title: 'User',
  description: 'A portable model',
  examples: [{ id: 1 }]
} satisfies SchemaAnnotations

annotations satisfies ClassAnnotations
createSchemaMetadata('User', annotations)
