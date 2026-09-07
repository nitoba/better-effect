import type { StandardSchemaV1 } from 'better-effect-schema'

export type HttpSchema = StandardSchemaV1<unknown, unknown>
export type HttpResponseSchemas = Readonly<Record<number, HttpSchema>>

export type SchemaOutput<S extends HttpSchema> = StandardSchemaV1.InferOutput<S>

export type SchemaOptions<S extends HttpSchema = HttpSchema> = Readonly<{
  readonly schema: S
  readonly responses?: never
}>

export type ResponsesOptions<R extends HttpResponseSchemas = HttpResponseSchemas> = Readonly<{
  readonly responses: R
  readonly schema?: never
}>

export type HttpDecodeOptions<
  S extends HttpSchema = HttpSchema,
  R extends HttpResponseSchemas = HttpResponseSchemas
> = SchemaOptions<S> | ResponsesOptions<R>

export type ResponseData<R extends HttpResponseSchemas> = {
  readonly [Status in keyof R & number]: {
    readonly status: Status
    readonly statusText: string
    readonly headers: Headers
    readonly url: string
    readonly data: SchemaOutput<R[Status]>
  }
}[keyof R & number]
