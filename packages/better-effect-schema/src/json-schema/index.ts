export {
  createSchemaMetadata,
  freezeSchemaAnnotations,
  mergeSchemaAnnotations
} from './metadata.js'
export type { SchemaAnnotations, SchemaMetadata } from './metadata.js'
export { toJSONSchema } from './consumer.js'
export type {
  JSONSchemaConversionFailure,
  JSONSchemaEffect,
  JSONSchemaModel,
  JSONSchemaSource,
  JsonSchemaDocument,
  JsonSchemaSide,
  ToJSONSchemaOptions
} from './types.js'
