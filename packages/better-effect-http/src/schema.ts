import type { StandardSchemaV1 } from 'better-effect-schema'

export type HttpSchema = StandardSchemaV1
export type HttpResponseSchemas = Readonly<Record<number, HttpSchema>>

export type SchemaOptions<S extends HttpSchema = HttpSchema> = Readonly<{
  readonly schema: S
  readonly responses?: never
}>

export type ResponsesOptions<R extends HttpResponseSchemas = HttpResponseSchemas> = Readonly<{
  readonly responses: R
  readonly schema?: never
}>

export type HttpDecodeOptions<S extends HttpSchema = HttpSchema, R extends HttpResponseSchemas = HttpResponseSchemas> =
  | SchemaOptions<S>
  | ResponsesOptions<R>

