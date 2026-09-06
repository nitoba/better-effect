import * as z from 'zod'
import { Result } from 'better-result'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import {
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaEncodeFailure,
  SchemaAsyncRequired,
  SchemaExecutionFailure
} from './failure.js'
import type { AnySchemaClass } from './is-schema-class.js'
import type { Instance, Props } from './types.js'
import { invokeAsync, invokeSync } from './internal/execution.js'
import { schemaFailure, schemaSuccess } from './internal/result.js'
import {
  validateStandardAsync,
  validateStandardSync,
  type StandardSchema,
  type StandardValidation
} from './internal/standard.js'
import type { SchemaEffect } from './schema-effect.js'

export type { SchemaEffect } from './schema-effect.js'

type AnySchema = z.ZodType
type AnyStandardSchema = StandardSchema

type DecodeFailure =
  | SchemaDecodeFailure
  | SchemaDefinitionFailure
  | SchemaExecutionFailure
  | SchemaAsyncRequired
type EncodeFailure = SchemaEncodeFailure | SchemaExecutionFailure | SchemaAsyncRequired
type ConstructionFailure = SchemaConstructionFailure | SchemaExecutionFailure | SchemaAsyncRequired

type DecodeOperation<Schema extends AnyStandardSchema> = SchemaEffect<
  StandardSchemaV1.InferOutput<Schema>,
  DecodeFailure
>

type EncodeOperation<Schema extends AnySchema> = SchemaEffect<z.input<Schema>, EncodeFailure>

type ConstructionOperation<Class extends AnySchemaClass> = SchemaEffect<
  Instance<Class>,
  ConstructionFailure
>

type SchemaClassRuntime<Class extends AnySchemaClass> = {
  safeMake(props: Props<Class>): z.ZodSafeParseResult<Instance<Class>>
  safeMakeAsync(props: Props<Class>): Promise<z.ZodSafeParseResult<Instance<Class>>>
}

const classRuntime = <Class extends AnySchemaClass>(
  schemaClass: Class
): SchemaClassRuntime<Class> => schemaClass as unknown as SchemaClassRuntime<Class>

const identifierOf = (schema: unknown): string => {
  if ((typeof schema !== 'object' || schema === null) && typeof schema !== 'function') {
    return 'ZodSchema'
  }

  try {
    const identifier = Reflect.get(schema, 'identifier') as unknown
    if (typeof identifier === 'string' && identifier.trim().length > 0) {
      return identifier
    }
  } catch {
    // A diagnostic label must never turn a validation failure into a defect.
  }

  return 'ZodSchema'
}

const decodeResult = <Schema extends AnyStandardSchema>(
  identifier: string,
  result: StandardValidation<StandardSchemaV1.InferOutput<Schema>>
): DecodeOperation<Schema> => {
  switch (result._tag) {
    case 'success':
      return schemaSuccess<StandardSchemaV1.InferOutput<Schema>, DecodeFailure>(result.value)
    case 'definition':
      return schemaFailure<StandardSchemaV1.InferOutput<Schema>, DecodeFailure>(result.failure)
    case 'failure':
      return schemaFailure<StandardSchemaV1.InferOutput<Schema>, DecodeFailure>(
        new SchemaDecodeFailure({ identifier, issues: result.issues, cause: result.issues })
      )
  }
}

const encodeResult = <Schema extends AnySchema>(
  schema: Schema,
  result: z.ZodSafeParseResult<z.input<Schema>>
): EncodeOperation<Schema> =>
  result.success
    ? schemaSuccess<z.input<Schema>, EncodeFailure>(result.data)
    : schemaFailure<z.input<Schema>, EncodeFailure>(
        new SchemaEncodeFailure({
          identifier: identifierOf(schema),
          cause: result.error
        })
      )

/** Decode an unknown value with a typed failure instead of throwing a ZodError. */
export function decodeUnknown<Schema extends AnyStandardSchema>(
  schema: Schema
): (input: unknown) => DecodeOperation<Schema>
export function decodeUnknown<Schema extends AnyStandardSchema>(
  schema: Schema,
  input: unknown
): DecodeOperation<Schema>
export function decodeUnknown<Schema extends AnyStandardSchema>(
  schema: Schema,
  input: unknown,
  options: StandardSchemaV1.Options
): DecodeOperation<Schema>
export function decodeUnknown<Schema extends AnyStandardSchema>(
  schema: Schema,
  input?: unknown,
  options?: StandardSchemaV1.Options
): DecodeOperation<Schema> | ((input: unknown) => DecodeOperation<Schema>) {
  const run = (value: unknown): DecodeOperation<Schema> =>
    (() => {
      const result = validateStandardSync(
        schema,
        value,
        identifierOf(schema),
        'decodeUnknown',
        options
      )
      return Result.isError(result)
        ? (result as DecodeOperation<Schema>)
        : decodeResult(identifierOf(schema), result.value)
    })()

  return arguments.length === 1 ? run : run(input)
}

/** Decode a statically typed encoded value with a typed failure. */
export function decode<Schema extends AnyStandardSchema>(
  schema: Schema
): (input: StandardSchemaV1.InferInput<Schema>) => DecodeOperation<Schema>
export function decode<Schema extends AnyStandardSchema>(
  schema: Schema,
  input: StandardSchemaV1.InferInput<Schema>
): DecodeOperation<Schema>
export function decode<Schema extends AnyStandardSchema>(
  schema: Schema,
  input: StandardSchemaV1.InferInput<Schema>,
  options: StandardSchemaV1.Options
): DecodeOperation<Schema>
export function decode<Schema extends AnyStandardSchema>(
  schema: Schema,
  input?: StandardSchemaV1.InferInput<Schema>,
  options?: StandardSchemaV1.Options
):
  | DecodeOperation<Schema>
  | ((input: StandardSchemaV1.InferInput<Schema>) => DecodeOperation<Schema>) {
  const run = (value: StandardSchemaV1.InferInput<Schema>): DecodeOperation<Schema> =>
    (() => {
      const result = validateStandardSync(schema, value, identifierOf(schema), 'decode', options)
      return Result.isError(result)
        ? (result as DecodeOperation<Schema>)
        : decodeResult(identifierOf(schema), result.value)
    })()

  return arguments.length === 1 ? run : run(input as StandardSchemaV1.InferInput<Schema>)
}

/** Asynchronously decode an unknown value with a typed failure. */
export function decodeUnknownAsync<Schema extends AnyStandardSchema>(
  schema: Schema
): (input: unknown) => Promise<DecodeOperation<Schema>>
export function decodeUnknownAsync<Schema extends AnyStandardSchema>(
  schema: Schema,
  input: unknown
): Promise<DecodeOperation<Schema>>
export function decodeUnknownAsync<Schema extends AnyStandardSchema>(
  schema: Schema,
  input: unknown,
  options: StandardSchemaV1.Options
): Promise<DecodeOperation<Schema>>
export function decodeUnknownAsync<Schema extends AnyStandardSchema>(
  schema: Schema,
  input?: unknown,
  options?: StandardSchemaV1.Options
): Promise<DecodeOperation<Schema>> | ((input: unknown) => Promise<DecodeOperation<Schema>>) {
  const run = async (value: unknown): Promise<DecodeOperation<Schema>> => {
    const result = await validateStandardAsync(
      schema,
      value,
      identifierOf(schema),
      'decodeUnknownAsync',
      options
    )
    return Result.isError(result)
      ? (result as DecodeOperation<Schema>)
      : decodeResult(identifierOf(schema), result.value)
  }

  return arguments.length === 1 ? run : run(input)
}

/** Asynchronously decode a statically typed encoded value with a typed failure. */
export function decodeAsync<Schema extends AnyStandardSchema>(
  schema: Schema
): (input: StandardSchemaV1.InferInput<Schema>) => Promise<DecodeOperation<Schema>>
export function decodeAsync<Schema extends AnyStandardSchema>(
  schema: Schema,
  input: StandardSchemaV1.InferInput<Schema>
): Promise<DecodeOperation<Schema>>
export function decodeAsync<Schema extends AnyStandardSchema>(
  schema: Schema,
  input: StandardSchemaV1.InferInput<Schema>,
  options: StandardSchemaV1.Options
): Promise<DecodeOperation<Schema>>
export function decodeAsync<Schema extends AnyStandardSchema>(
  schema: Schema,
  input?: StandardSchemaV1.InferInput<Schema>,
  options?: StandardSchemaV1.Options
):
  | Promise<DecodeOperation<Schema>>
  | ((input: StandardSchemaV1.InferInput<Schema>) => Promise<DecodeOperation<Schema>>) {
  const run = async (
    value: StandardSchemaV1.InferInput<Schema>
  ): Promise<DecodeOperation<Schema>> => {
    const result = await validateStandardAsync(
      schema,
      value,
      identifierOf(schema),
      'decodeAsync',
      options
    )
    return Result.isError(result)
      ? (result as DecodeOperation<Schema>)
      : decodeResult(identifierOf(schema), result.value)
  }

  return arguments.length === 1 ? run : run(input as StandardSchemaV1.InferInput<Schema>)
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
    (() => {
      const result = invokeSync('encode', () => z.safeEncode(schema, input))
      return Result.isError(result)
        ? (result as EncodeOperation<Schema>)
        : encodeResult(schema, result.value)
    })()

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
):
  | Promise<EncodeOperation<Schema>>
  | ((value: z.output<Schema>) => Promise<EncodeOperation<Schema>>) {
  const run = async (input: z.output<Schema>): Promise<EncodeOperation<Schema>> => {
    const result = await invokeAsync('encodeAsync', () => z.safeEncodeAsync(schema, input))
    return Result.isError(result)
      ? (result as EncodeOperation<Schema>)
      : encodeResult(schema, result.value)
  }

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
    const result = invokeSync('make', () => classRuntime(schemaClass).safeMake(input))

    if (Result.isError(result)) return result as ConstructionOperation<Class>

    const parsed = result.value
    return parsed.success
      ? schemaSuccess<Instance<Class>, ConstructionFailure>(parsed.data as Instance<Class>)
      : schemaFailure<Instance<Class>, ConstructionFailure>(
          new SchemaConstructionFailure({
            identifier: identifierOf(schemaClass as unknown as AnySchema),
            cause: parsed.error
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
):
  | Promise<ConstructionOperation<Class>>
  | ((props: Props<Class>) => Promise<ConstructionOperation<Class>>) {
  const run = async (input: Props<Class>): Promise<ConstructionOperation<Class>> => {
    const result = await invokeAsync('makeAsync', () =>
      classRuntime(schemaClass).safeMakeAsync(input)
    )

    if (Result.isError(result)) return result as ConstructionOperation<Class>

    const parsed = result.value
    return parsed.success
      ? schemaSuccess<Instance<Class>, ConstructionFailure>(parsed.data as Instance<Class>)
      : schemaFailure<Instance<Class>, ConstructionFailure>(
          new SchemaConstructionFailure({
            identifier: identifierOf(schemaClass as unknown as AnySchema),
            cause: parsed.error
          })
        )
  }

  return arguments.length === 1 ? run : run(props as Props<Class>)
}
