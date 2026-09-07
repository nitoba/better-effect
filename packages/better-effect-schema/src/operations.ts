import * as z from 'zod'
import { Result } from 'better-result'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import {
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaEncodeFailure,
  SchemaAsyncRequired,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from './failure.js'
import {
  isGenericSchemaClass,
  type AnyGenericSchemaClass,
  type AnySchemaClass
} from './is-schema-class.js'
import { encodeCodec, encodeCodecAsync } from './codecs/operations.js'
import type { AnySchemaCodec, CodecEncoded, CodecOutput } from './codecs/index.js'
import { findGenericDescriptor } from './internal/generic-descriptor.js'
import type {
  GenericClassConstructorInput,
  GenericClassDefinition,
  GenericClassEncoded,
  GenericClassFailure,
  GenericSchemaClass
} from './types/generic-class.js'
import type { Instance, Props } from './types.js'
import { invokeAsync, invokeSync } from './internal/execution.js'
import { schemaFailure, schemaSuccess } from './internal/result.js'
import {
  validateStandardAsync,
  validateStandardSync,
  type StandardValidation
} from './internal/standard.js'
import type { SchemaEffect } from './schema-effect.js'

export type { SchemaEffect } from './schema-effect.js'

type AnyStandardSchema = StandardSchemaV1

type DecodeFailure =
  | SchemaDecodeFailure
  | SchemaDefinitionFailure
  | SchemaExecutionFailure
  | SchemaAsyncRequired
type ConstructionFailure = SchemaConstructionFailure | SchemaExecutionFailure | SchemaAsyncRequired

type GenericClassOf<Class> =
  Class extends GenericSchemaClass<unknown, infer Definition> ? Definition : never

type GenericConstructionOperation<Class extends AnyGenericSchemaClass> = SchemaEffect<
  Instance<Class>,
  GenericClassFailure
>

type GenericDecodeFailure = DecodeFailure | SchemaConstructionFailure

type GenericDecodeOperation<Class extends AnyGenericSchemaClass> = SchemaEffect<
  Instance<Class>,
  GenericDecodeFailure
>

type GenericEncodeFailure =
  | SchemaEncodeFailure
  | SchemaDefinitionFailure
  | SchemaExecutionFailure
  | SchemaAsyncRequired
  | import('./failure.js').SchemaUnsupportedOperation

type GenericEncodeOperation<Class extends AnyGenericSchemaClass> = SchemaEffect<
  GenericClassEncoded<GenericClassOf<Class>>,
  GenericEncodeFailure
>

type CodecEncodeOperation<Codec extends AnySchemaCodec> = ReturnType<typeof encodeCodec<Codec>>

type CodecEncodeAsyncOperation<Codec extends AnySchemaCodec> = ReturnType<
  typeof encodeCodecAsync<Codec>
>

type LegacySchemaCodec = AnySchemaClass & {
  readonly schema: StandardSchemaV1
  readonly encodedSchema: StandardSchemaV1
  readonly encode: (...args: never[]) => unknown
}

type LegacyEncodeOperation<Schema extends LegacySchemaCodec> = SchemaEffect<
  CodecEncoded<Schema>,
  SchemaEncodeFailure | SchemaExecutionFailure | SchemaAsyncRequired
>

type DecodeOperation<Schema extends AnyStandardSchema> = SchemaEffect<
  StandardSchemaV1.InferOutput<Schema>,
  DecodeFailure
>

type ConstructionOperation<Class extends AnySchemaClass> = SchemaEffect<
  Instance<Class>,
  ConstructionFailure
>

type SchemaClassRuntime<Class extends AnySchemaClass> = {
  safeMake(props: Props<Class>): z.ZodSafeParseResult<Instance<Class>>
  safeMakeAsync(props: Props<Class>): Promise<z.ZodSafeParseResult<Instance<Class>>>
}

const classRuntime = (schemaClass: AnySchemaClass): SchemaClassRuntime<AnySchemaClass> =>
  schemaClass as unknown as SchemaClassRuntime<AnySchemaClass>

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

const decodeGenericSync = (
  schemaClass: AnyGenericSchemaClass,
  input: unknown,
  options: StandardSchemaV1.Options | undefined
): GenericDecodeOperation<AnyGenericSchemaClass> => {
  const descriptor = findGenericDescriptor(schemaClass)
  if (descriptor === undefined) {
    return schemaFailure<unknown, GenericDecodeFailure>(
      new SchemaDefinitionFailure({ operation: 'decode', cause: 'missing-descriptor' })
    )
  }

  const decoded = validateStandardSync(
    descriptor.schema,
    input,
    descriptor.identifier,
    'decode',
    options
  )
  if (Result.isError(decoded))
    return decoded as unknown as GenericDecodeOperation<AnyGenericSchemaClass>

  if (decoded.value._tag !== 'success') {
    return decoded.value._tag === 'definition'
      ? schemaFailure<unknown, GenericDecodeFailure>(decoded.value.failure)
      : schemaFailure<unknown, GenericDecodeFailure>(
          new SchemaDecodeFailure({
            identifier: descriptor.identifier,
            operation: 'decode',
            issues: decoded.value.issues,
            cause: decoded.value.issues
          })
        )
  }

  const constructed = schemaClass.make(decoded.value.value)
  return Result.isError(constructed)
    ? (constructed as unknown as GenericDecodeOperation<AnyGenericSchemaClass>)
    : schemaSuccess<unknown, GenericDecodeFailure>(constructed.value)
}

const decodeGenericAsync = async (
  schemaClass: AnyGenericSchemaClass,
  input: unknown,
  options: StandardSchemaV1.Options | undefined
): Promise<GenericDecodeOperation<AnyGenericSchemaClass>> => {
  const descriptor = findGenericDescriptor(schemaClass)
  if (descriptor === undefined) {
    return schemaFailure<unknown, GenericDecodeFailure>(
      new SchemaDefinitionFailure({ operation: 'decodeAsync', cause: 'missing-descriptor' })
    )
  }

  const decoded = await validateStandardAsync(
    descriptor.schema,
    input,
    descriptor.identifier,
    'decodeAsync',
    options
  )
  if (Result.isError(decoded))
    return decoded as unknown as GenericDecodeOperation<AnyGenericSchemaClass>

  if (decoded.value._tag !== 'success') {
    return decoded.value._tag === 'definition'
      ? schemaFailure<unknown, GenericDecodeFailure>(decoded.value.failure)
      : schemaFailure<unknown, GenericDecodeFailure>(
          new SchemaDecodeFailure({
            identifier: descriptor.identifier,
            operation: 'decodeAsync',
            issues: decoded.value.issues,
            cause: decoded.value.issues
          })
        )
  }

  const constructed = await schemaClass.makeAsync(decoded.value.value)
  return Result.isError(constructed)
    ? (constructed as unknown as GenericDecodeOperation<AnyGenericSchemaClass>)
    : schemaSuccess<unknown, GenericDecodeFailure>(constructed.value)
}

const encodeGenericSync = (
  schemaClass: AnyGenericSchemaClass,
  value: unknown
): GenericEncodeOperation<AnyGenericSchemaClass> => {
  const descriptor = findGenericDescriptor(schemaClass)
  if (descriptor === undefined) {
    return schemaFailure<unknown, GenericEncodeFailure>(
      new SchemaDefinitionFailure({ operation: 'encode', cause: 'missing-descriptor' })
    )
  }

  if (descriptor.preparationFailure !== undefined)
    return schemaFailure<unknown, GenericEncodeFailure>(descriptor.preparationFailure)

  let encoder: unknown
  try {
    encoder = Reflect.get(descriptor.definition, 'encode')
  } catch (cause) {
    return schemaFailure<unknown, GenericEncodeFailure>(
      new SchemaExecutionFailure({
        identifier: descriptor.identifier,
        operation: 'encode',
        cause
      })
    )
  }
  if (typeof encoder !== 'function') {
    return schemaFailure<unknown, GenericEncodeFailure>(
      new SchemaUnsupportedOperation({
        identifier: descriptor.identifier,
        operation: 'encode',
        cause: 'missing-encoding-capability'
      })
    )
  }

  const encoded = invokeSync('encode', () => Reflect.apply(encoder, descriptor.definition, [value]))
  if (Result.isError(encoded))
    return encoded as unknown as GenericEncodeOperation<AnyGenericSchemaClass>
  if (descriptor.encodedSchema === undefined)
    return schemaSuccess<unknown, GenericEncodeFailure>(encoded.value)

  const validated = validateStandardSync(
    descriptor.encodedSchema,
    encoded.value,
    descriptor.identifier,
    'encode',
    undefined
  )
  if (Result.isError(validated))
    return validated as unknown as GenericEncodeOperation<AnyGenericSchemaClass>
  if (validated.value._tag === 'success')
    return schemaSuccess<unknown, GenericEncodeFailure>(validated.value.value)
  if (validated.value._tag === 'definition') return schemaFailure(validated.value.failure)
  return schemaFailure(
    new SchemaEncodeFailure({
      identifier: descriptor.identifier,
      operation: 'encode',
      issues: validated.value.issues,
      cause: validated.value.issues
    })
  )
}

const encodeGenericAsync = async (
  schemaClass: AnyGenericSchemaClass,
  value: unknown
): Promise<GenericEncodeOperation<AnyGenericSchemaClass>> => {
  const descriptor = findGenericDescriptor(schemaClass)
  if (descriptor === undefined) {
    return schemaFailure<unknown, GenericEncodeFailure>(
      new SchemaDefinitionFailure({ operation: 'encodeAsync', cause: 'missing-descriptor' })
    )
  }

  if (descriptor.preparationFailure !== undefined)
    return schemaFailure<unknown, GenericEncodeFailure>(descriptor.preparationFailure)

  let encoder: unknown
  try {
    encoder = Reflect.get(descriptor.definition, 'encode')
  } catch (cause) {
    return schemaFailure<unknown, GenericEncodeFailure>(
      new SchemaExecutionFailure({
        identifier: descriptor.identifier,
        operation: 'encodeAsync',
        cause
      })
    )
  }
  if (typeof encoder !== 'function') {
    return schemaFailure<unknown, GenericEncodeFailure>(
      new SchemaUnsupportedOperation({
        identifier: descriptor.identifier,
        operation: 'encodeAsync',
        cause: 'missing-encoding-capability'
      })
    )
  }

  const encoded = await invokeAsync('encodeAsync', () =>
    Reflect.apply(encoder, descriptor.definition, [value])
  )
  if (Result.isError(encoded))
    return encoded as unknown as GenericEncodeOperation<AnyGenericSchemaClass>
  if (descriptor.encodedSchema === undefined)
    return schemaSuccess<unknown, GenericEncodeFailure>(encoded.value)

  const validated = await validateStandardAsync(
    descriptor.encodedSchema,
    encoded.value,
    descriptor.identifier,
    'encodeAsync',
    undefined
  )
  if (Result.isError(validated))
    return validated as unknown as GenericEncodeOperation<AnyGenericSchemaClass>
  if (validated.value._tag === 'success')
    return schemaSuccess<unknown, GenericEncodeFailure>(validated.value.value)
  if (validated.value._tag === 'definition') return schemaFailure(validated.value.failure)
  return schemaFailure(
    new SchemaEncodeFailure({
      identifier: descriptor.identifier,
      operation: 'encodeAsync',
      issues: validated.value.issues,
      cause: validated.value.issues
    })
  )
}

/** Decode an unknown value with a typed failure instead of throwing a ZodError. */
export function decodeUnknown<Class extends AnyGenericSchemaClass>(
  schema: Class
): (input: unknown) => GenericDecodeOperation<Class>
export function decodeUnknown<Class extends AnyGenericSchemaClass>(
  schema: Class,
  input: unknown
): GenericDecodeOperation<Class>
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
): unknown {
  if (isGenericSchemaClass(schema)) {
    const run = (value: unknown): GenericDecodeOperation<typeof schema> =>
      decodeGenericSync(schema, value, options) as unknown as GenericDecodeOperation<typeof schema>
    return (arguments.length === 1 ? run : run(input)) as unknown as DecodeOperation<Schema>
  }

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
export function decode<Class extends AnyGenericSchemaClass>(
  schema: Class
): (input: GenericClassConstructorInput<GenericClassOf<Class>>) => GenericDecodeOperation<Class>
export function decode<Class extends AnyGenericSchemaClass>(
  schema: Class,
  input: GenericClassConstructorInput<GenericClassOf<Class>>
): GenericDecodeOperation<Class>
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
): unknown {
  if (isGenericSchemaClass(schema)) {
    const run = (value: unknown): GenericDecodeOperation<typeof schema> =>
      decodeGenericSync(schema, value, options) as unknown as GenericDecodeOperation<typeof schema>
    return (arguments.length === 1 ? run : run(input)) as unknown as DecodeOperation<Schema>
  }

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
export function decodeUnknownAsync<Class extends AnyGenericSchemaClass>(
  schema: Class
): (input: unknown) => Promise<GenericDecodeOperation<Class>>
export function decodeUnknownAsync<Class extends AnyGenericSchemaClass>(
  schema: Class,
  input: unknown
): Promise<GenericDecodeOperation<Class>>
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
): unknown {
  if (isGenericSchemaClass(schema)) {
    const run = async (value: unknown): Promise<GenericDecodeOperation<typeof schema>> =>
      decodeGenericAsync(schema, value, options) as Promise<GenericDecodeOperation<typeof schema>>
    return (arguments.length === 1 ? run : run(input)) as unknown as Promise<
      DecodeOperation<Schema>
    >
  }

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
export function decodeAsync<Class extends AnyGenericSchemaClass>(
  schema: Class
): (
  input: GenericClassConstructorInput<GenericClassOf<Class>>
) => Promise<GenericDecodeOperation<Class>>
export function decodeAsync<Class extends AnyGenericSchemaClass>(
  schema: Class,
  input: GenericClassConstructorInput<GenericClassOf<Class>>
): Promise<GenericDecodeOperation<Class>>
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
): unknown {
  if (isGenericSchemaClass(schema)) {
    const run = async (value: unknown): Promise<GenericDecodeOperation<typeof schema>> =>
      decodeGenericAsync(schema, value, options) as Promise<GenericDecodeOperation<typeof schema>>
    return (arguments.length === 1 ? run : run(input)) as unknown as Promise<
      DecodeOperation<Schema>
    >
  }

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

/** Encode through a generic class capability or an explicit schema codec. */
export function encode<Class extends AnyGenericSchemaClass>(
  schema: Class
): (value: Instance<Class>) => GenericEncodeOperation<Class>
export function encode<Class extends AnyGenericSchemaClass>(
  schema: Class,
  value: Instance<Class>
): GenericEncodeOperation<Class>
export function encode<Schema extends LegacySchemaCodec>(
  schema: Schema
): (value: CodecOutput<Schema>) => LegacyEncodeOperation<Schema>
export function encode<Schema extends LegacySchemaCodec>(
  schema: Schema,
  value: CodecOutput<Schema>
): LegacyEncodeOperation<Schema>
export function encode<Codec extends AnySchemaCodec>(
  codec: Codec
): (value: CodecOutput<Codec>) => CodecEncodeOperation<Codec>
export function encode<Codec extends AnySchemaCodec>(
  codec: Codec,
  value: CodecOutput<Codec>
): CodecEncodeOperation<Codec>
export function encode(codec: AnySchemaCodec | AnyGenericSchemaClass, value?: unknown): unknown {
  const run = (input: unknown): unknown =>
    isGenericSchemaClass(codec)
      ? encodeGenericSync(codec, input)
      : encodeCodec(codec as AnySchemaCodec, input)

  return arguments.length === 1 ? run : run(value)
}

/** Asynchronously encode through a generic class capability or an explicit codec. */
export function encodeAsync<Class extends AnyGenericSchemaClass>(
  schema: Class
): (value: Instance<Class>) => Promise<GenericEncodeOperation<Class>>
export function encodeAsync<Class extends AnyGenericSchemaClass>(
  schema: Class,
  value: Instance<Class>
): Promise<GenericEncodeOperation<Class>>
export function encodeAsync<Codec extends AnySchemaCodec>(
  codec: Codec
): (value: CodecOutput<Codec>) => CodecEncodeAsyncOperation<Codec>
export function encodeAsync<Codec extends AnySchemaCodec>(
  codec: Codec,
  value: CodecOutput<Codec>
): CodecEncodeAsyncOperation<Codec>
export function encodeAsync(
  codec: AnySchemaCodec | AnyGenericSchemaClass,
  value?: unknown
): unknown {
  const run = (input: unknown): Promise<unknown> =>
    isGenericSchemaClass(codec)
      ? encodeGenericAsync(codec, input)
      : encodeCodecAsync(codec as AnySchemaCodec, input)

  return arguments.length === 1 ? run : run(value)
}

/** Construct a schema class from decoded props with a typed failure. */
export function make<Class extends AnyGenericSchemaClass>(
  schemaClass: Class
): (
  props: GenericClassConstructorInput<GenericClassOf<Class>>
) => GenericConstructionOperation<Class>
export function make<Class extends AnyGenericSchemaClass>(
  schemaClass: Class,
  props: GenericClassConstructorInput<GenericClassOf<Class>>
): GenericConstructionOperation<Class>
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
): unknown {
  if (isGenericSchemaClass(schemaClass)) {
    const run = (input: unknown): GenericConstructionOperation<AnyGenericSchemaClass> =>
      schemaClass.make(input) as unknown as GenericConstructionOperation<AnyGenericSchemaClass>
    return (arguments.length === 1 ? run : run(props)) as unknown as ConstructionOperation<Class>
  }

  const run = (input: Props<Class>): ConstructionOperation<Class> => {
    const result = invokeSync('make', () => classRuntime(schemaClass).safeMake(input))

    if (Result.isError(result)) return result as ConstructionOperation<Class>

    const parsed = result.value
    return parsed.success
      ? schemaSuccess<Instance<Class>, ConstructionFailure>(parsed.data as Instance<Class>)
      : schemaFailure<Instance<Class>, ConstructionFailure>(
          new SchemaConstructionFailure({
            identifier: identifierOf(schemaClass),
            cause: parsed.error
          })
        )
  }

  return arguments.length === 1 ? run : run(props as Props<Class>)
}

/** Asynchronously construct a schema class from decoded props with a typed failure. */
export function makeAsync<Class extends AnyGenericSchemaClass>(
  schemaClass: Class
): (
  props: GenericClassConstructorInput<GenericClassOf<Class>>
) => Promise<GenericConstructionOperation<Class>>
export function makeAsync<Class extends AnyGenericSchemaClass>(
  schemaClass: Class,
  props: GenericClassConstructorInput<GenericClassOf<Class>>
): Promise<GenericConstructionOperation<Class>>
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
): unknown {
  if (isGenericSchemaClass(schemaClass)) {
    const run = async (
      input: unknown
    ): Promise<GenericConstructionOperation<AnyGenericSchemaClass>> =>
      schemaClass.makeAsync(input) as unknown as Promise<
        GenericConstructionOperation<AnyGenericSchemaClass>
      >
    return (arguments.length === 1 ? run : run(props)) as unknown as Promise<
      ConstructionOperation<Class>
    >
  }

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
            identifier: identifierOf(schemaClass),
            cause: parsed.error
          })
        )
  }

  return arguments.length === 1 ? run : run(props as Props<Class>)
}
