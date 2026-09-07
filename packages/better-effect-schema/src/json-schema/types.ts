import type { StandardJSONSchemaV1 } from '@standard-schema/spec'

import type {
  SchemaAsyncRequired,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../failure.js'
import type { SchemaEffect } from '../schema-effect.js'

/** A validated JSON Schema document returned by the safe consumer. */
export type JsonSchemaDocument = Readonly<Record<string, unknown>>

export type JsonSchemaSide = 'input' | 'output'

/** Standard JSON Schema options plus the representation to describe. */
export type ToJSONSchemaOptions = StandardJSONSchemaV1.Options & {
  readonly side?: JsonSchemaSide
}

/** A provider-neutral explicit converter for models without Standard Schema validation. */
export interface JSONSchemaConverter {
  readonly input: (options: StandardJSONSchemaV1.Options) => Record<string, unknown>
  readonly output: (options: StandardJSONSchemaV1.Options) => Record<string, unknown>
}

/** A model may provide only JSON Schema conversion; validation is not required. */
export interface JSONSchemaModel {
  readonly jsonSchema: JSONSchemaConverter
}

export type JSONSchemaSource = StandardJSONSchemaV1 | JSONSchemaModel

export type JSONSchemaConversionFailure =
  | SchemaDefinitionFailure
  | SchemaExecutionFailure
  | SchemaUnsupportedOperation
  | SchemaAsyncRequired

export type JSONSchemaEffect = SchemaEffect<JsonSchemaDocument, JSONSchemaConversionFailure>
