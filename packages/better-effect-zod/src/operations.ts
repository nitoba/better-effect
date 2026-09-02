import * as z from "zod"

import {
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaEncodeFailure
} from "./failure.js"
import type { AnySchemaClass } from "./is-schema-class.js"
import type { Instance, Props } from "./types.js"
import { schemaFailure, schemaSuccess } from "./internal/result.js"
import type { SchemaEffect } from "./schema-effect.js"

export type { SchemaEffect } from "./schema-effect.js"

type AnySchema = z.ZodType

type DecodeOperation<Schema extends AnySchema> = SchemaEffect<
  z.output<Schema>,
  SchemaDecodeFailure
>

type EncodeOperation<Schema extends AnySchema> = SchemaEffect<
  z.input<Schema>,
  SchemaEncodeFailure
>

type ConstructionOperation<Class extends AnySchemaClass> = SchemaEffect<
  Instance<Class>,
  SchemaConstructionFailure
>

type SchemaClassRuntime<Class extends AnySchemaClass> = {
  safeMake(props: Props<Class>): z.ZodSafeParseResult<Instance<Class>>
  safeMakeAsync(
    props: Props<Class>
  ): Promise<z.ZodSafeParseResult<Instance<Class>>>
}

const classRuntime = <Class extends AnySchemaClass>(
  schemaClass: Class
): SchemaClassRuntime<Class> =>
  schemaClass as unknown as SchemaClassRuntime<Class>

const identifierOf = (schema: AnySchema): string => {
  try {
    const identifier = Reflect.get(schema, "identifier") as unknown
    if (typeof identifier === "string" && identifier.trim().length > 0) {
      return identifier
    }
  } catch {
    // A diagnostic label must never turn a validation failure into a defect.
  }

  return "ZodSchema"
}

const decodeResult = <Schema extends AnySchema>(
  schema: Schema,
  result: z.ZodSafeParseResult<z.output<Schema>>
): DecodeOperation<Schema> => result.success
  ? schemaSuccess<z.output<Schema>, SchemaDecodeFailure>(result.data)
  : schemaFailure<z.output<Schema>, SchemaDecodeFailure>(
      new SchemaDecodeFailure({
        identifier: identifierOf(schema),
        cause: result.error
      })
    )

const encodeResult = <Schema extends AnySchema>(
  schema: Schema,
  result: z.ZodSafeParseResult<z.input<Schema>>
): EncodeOperation<Schema> => result.success
  ? schemaSuccess<z.input<Schema>, SchemaEncodeFailure>(result.data)
  : schemaFailure<z.input<Schema>, SchemaEncodeFailure>(
      new SchemaEncodeFailure({
        identifier: identifierOf(schema),
        cause: result.error
      })
    )

/** Decode an unknown value with a typed failure instead of throwing a ZodError. */
export function decodeUnknown<Schema extends AnySchema>(
  schema: Schema
): (input: unknown) => DecodeOperation<Schema>
export function decodeUnknown<Schema extends AnySchema>(
  schema: Schema,
  input: unknown
): DecodeOperation<Schema>
export function decodeUnknown<Schema extends AnySchema>(
  schema: Schema,
  input?: unknown
): DecodeOperation<Schema> | ((input: unknown) => DecodeOperation<Schema>) {
  const run = (value: unknown): DecodeOperation<Schema> =>
    decodeResult(schema, z.safeParse(schema, value))

  return arguments.length === 1 ? run : run(input)
}

/** Decode a statically typed encoded value with a typed failure. */
export function decode<Schema extends AnySchema>(
  schema: Schema
): (input: z.input<Schema>) => DecodeOperation<Schema>
export function decode<Schema extends AnySchema>(
  schema: Schema,
  input: z.input<Schema>
): DecodeOperation<Schema>
export function decode<Schema extends AnySchema>(
  schema: Schema,
  input?: z.input<Schema>
): DecodeOperation<Schema> | ((input: z.input<Schema>) => DecodeOperation<Schema>) {
  const run = (value: z.input<Schema>): DecodeOperation<Schema> =>
    decodeResult(schema, z.safeDecode(schema, value))

  return arguments.length === 1 ? run : run(input as z.input<Schema>)
}

/** Asynchronously decode an unknown value with a typed failure. */
export function decodeUnknownAsync<Schema extends AnySchema>(
  schema: Schema
): (input: unknown) => Promise<DecodeOperation<Schema>>
export function decodeUnknownAsync<Schema extends AnySchema>(
  schema: Schema,
  input: unknown
): Promise<DecodeOperation<Schema>>
export function decodeUnknownAsync<Schema extends AnySchema>(
  schema: Schema,
  input?: unknown
): Promise<DecodeOperation<Schema>> | ((input: unknown) => Promise<DecodeOperation<Schema>>) {
  const run = async (value: unknown): Promise<DecodeOperation<Schema>> =>
    decodeResult(schema, await z.safeParseAsync(schema, value))

  return arguments.length === 1 ? run : run(input)
}

/** Asynchronously decode a statically typed encoded value with a typed failure. */
export function decodeAsync<Schema extends AnySchema>(
  schema: Schema
): (input: z.input<Schema>) => Promise<DecodeOperation<Schema>>
export function decodeAsync<Schema extends AnySchema>(
  schema: Schema,
  input: z.input<Schema>
): Promise<DecodeOperation<Schema>>
export function decodeAsync<Schema extends AnySchema>(
  schema: Schema,
  input?: z.input<Schema>
): Promise<DecodeOperation<Schema>> | ((input: z.input<Schema>) => Promise<DecodeOperation<Schema>>) {
  const run = async (value: z.input<Schema>): Promise<DecodeOperation<Schema>> =>
    decodeResult(schema, await z.safeDecodeAsync(schema, value))

  return arguments.length === 1 ? run : run(input as z.input<Schema>)
}

/** Encode a decoded value with a typed failure instead of throwing a ZodError. */
export function encode<Schema extends AnySchema>(
  schema: Schema
): (value: z.output<Schema>) => EncodeOperation<Schema>
export function encode<Schema extends AnySchema>(
  schema: Schema,
  value: z.output<Schema>
): EncodeOperation<Schema>
export function encode<Schema extends AnySchema>(
  schema: Schema,
  value?: z.output<Schema>
): EncodeOperation<Schema> | ((value: z.output<Schema>) => EncodeOperation<Schema>) {
  const run = (input: z.output<Schema>): EncodeOperation<Schema> =>
    encodeResult(schema, z.safeEncode(schema, input))

  return arguments.length === 1 ? run : run(value as z.output<Schema>)
}

/** Asynchronously encode a decoded value with a typed failure. */
export function encodeAsync<Schema extends AnySchema>(
  schema: Schema
): (value: z.output<Schema>) => Promise<EncodeOperation<Schema>>
export function encodeAsync<Schema extends AnySchema>(
  schema: Schema,
  value: z.output<Schema>
): Promise<EncodeOperation<Schema>>
export function encodeAsync<Schema extends AnySchema>(
  schema: Schema,
  value?: z.output<Schema>
): Promise<EncodeOperation<Schema>> | ((value: z.output<Schema>) => Promise<EncodeOperation<Schema>>) {
  const run = async (input: z.output<Schema>): Promise<EncodeOperation<Schema>> =>
    encodeResult(schema, await z.safeEncodeAsync(schema, input))

  return arguments.length === 1 ? run : run(value as z.output<Schema>)
}

/** Construct a schema class from decoded props with a typed failure. */
export function make<Class extends AnySchemaClass>(
  schemaClass: Class
): (props: Props<Class>) => ConstructionOperation<Class>
export function make<Class extends AnySchemaClass>(
  schemaClass: Class,
  props: Props<Class>
): ConstructionOperation<Class>
export function make<Class extends AnySchemaClass>(
  schemaClass: Class,
  props?: Props<Class>
): ConstructionOperation<Class> | ((props: Props<Class>) => ConstructionOperation<Class>) {
  const run = (input: Props<Class>): ConstructionOperation<Class> => {
    const result = classRuntime(schemaClass).safeMake(input)

    return result.success
      ? schemaSuccess<Instance<Class>, SchemaConstructionFailure>(
          result.data as Instance<Class>
        )
      : schemaFailure<Instance<Class>, SchemaConstructionFailure>(
          new SchemaConstructionFailure({
            identifier: schemaClass.identifier,
            cause: result.error
          })
        )
  }

  return arguments.length === 1 ? run : run(props as Props<Class>)
}

/** Asynchronously construct a schema class from decoded props with a typed failure. */
export function makeAsync<Class extends AnySchemaClass>(
  schemaClass: Class
): (props: Props<Class>) => Promise<ConstructionOperation<Class>>
export function makeAsync<Class extends AnySchemaClass>(
  schemaClass: Class,
  props: Props<Class>
): Promise<ConstructionOperation<Class>>
export function makeAsync<Class extends AnySchemaClass>(
  schemaClass: Class,
  props?: Props<Class>
): Promise<ConstructionOperation<Class>> | ((props: Props<Class>) => Promise<ConstructionOperation<Class>>) {
  const run = async (input: Props<Class>): Promise<ConstructionOperation<Class>> => {
    const result = await classRuntime(schemaClass).safeMakeAsync(input)

    return result.success
      ? schemaSuccess<Instance<Class>, SchemaConstructionFailure>(
          result.data as Instance<Class>
        )
      : schemaFailure<Instance<Class>, SchemaConstructionFailure>(
          new SchemaConstructionFailure({
            identifier: schemaClass.identifier,
            cause: result.error
          })
        )
  }

  return arguments.length === 1 ? run : run(props as Props<Class>)
}
