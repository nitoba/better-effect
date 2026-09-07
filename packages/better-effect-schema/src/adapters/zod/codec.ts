import { Result } from 'better-result'
import * as z from 'zod'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type {
  SchemaDescriptor,
  SchemaEncodedCapability,
  SchemaEncodingCapability,
  SchemaPropsCapability,
  SchemaReadCapability
} from '../../capabilities/types.js'
import {
  asStandardSchema,
  applyZodMethod,
  applyZodMethodAsync,
  definitionFailure,
  invokeZodSync,
  isSafeParseSuccess,
  isZodCodec,
  isZodSchema,
  resultError,
  toZodSchema,
  type ZodCapabilityResult,
  type ZodSchema,
  unsupported
} from './support.js'

const projectInput = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>
): ZodCapabilityResult<StandardSchemaV1<Input, Input>> => {
  if (!isZodSchema(schema)) return unsupported('encoded', 'not-a-zod-schema')

  const projection = invokeZodSync('encoded', () => z.input(schema))
  if (Result.isError(projection)) return projection
  if (!isZodSchema(projection.value))
    return definitionFailure('encoded', 'invalid-input-projection')

  return Result.ok(asStandardSchema<Input, Input>(projection.value))
}

const propsSchemaOf = <Input, Output, Props, Self, ConstructionInput = Props>(
  descriptor: SchemaDescriptor<Input, Output, Props, Self, ConstructionInput>
): ZodCapabilityResult<ZodSchema> => {
  if (isZodSchema(descriptor.propsSchema)) return Result.ok(descriptor.propsSchema)
  if (!isZodSchema(descriptor.schema)) return unsupported('props', 'not-a-zod-schema')

  const native = descriptor.schema
  const projection = invokeZodSync('props', () => z.output(native))
  if (Result.isError(projection)) return projection
  if (!isZodSchema(projection.value)) return definitionFailure('props', 'invalid-output-projection')

  return Result.ok(projection.value)
}

const props = <Input, Output, Props, Self, ConstructionInput = Props>(
  descriptor: SchemaDescriptor<Input, Output, Props, Self, ConstructionInput>
): ZodCapabilityResult<StandardSchemaV1<ConstructionInput, Props>> => {
  const result = propsSchemaOf(descriptor)
  if (Result.isError(result)) return result
  return Result.ok(asStandardSchema<ConstructionInput, Props>(result.value))
}

const make = <Input, Output, Props, Self, ConstructionInput = Props>(
  descriptor: SchemaDescriptor<Input, Output, Props, Self, ConstructionInput>,
  value: ConstructionInput
): ZodCapabilityResult<Self> => {
  const propsSchema = propsSchemaOf(descriptor)
  if (Result.isError(propsSchema)) return propsSchema

  const validation = invokeZodSync<unknown>('make', () => propsSchema.value.safeParse(value))
  if (Result.isError(validation)) return validation
  if (!isSafeParseSuccess<Props>(validation.value)) {
    return resultError('make', propsSchema.value, validation.value)
  }

  const parsed = validation.value as { readonly data: Props }
  return invokeZodSync('make', () => descriptor.construct(parsed.data))
}

const encodeResult = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  result: unknown
): ZodCapabilityResult<Input> => {
  if (!isSafeParseSuccess<Input>(result)) return resultError('encode', schema, result)
  return Result.ok(result.data)
}

const encode = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  value: Output
): ZodCapabilityResult<Input> => {
  if (!isZodCodec(schema)) return unsupported('encode', 'explicit-codec-required')

  const result = applyZodMethod<unknown>('encode', schema, 'safeEncode', [value])
  if (Result.isError(result)) return result
  return encodeResult(schema, result.value)
}

const encodeAsync = async <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  value: Output
): Promise<ZodCapabilityResult<Input>> => {
  if (!isZodCodec(schema)) return unsupported('encodeAsync', 'explicit-codec-required')

  const result = await applyZodMethodAsync<unknown>('encodeAsync', schema, 'safeEncodeAsync', [
    value
  ])
  if (Result.isError(result)) return result
  if (!isSafeParseSuccess<Input>(result.value))
    return resultError('encodeAsync', schema, result.value)
  return Result.ok(result.value.data)
}

const read = <Schema extends StandardSchemaV1>(schema: Schema): ZodCapabilityResult<Schema> =>
  isZodSchema(schema) ? Result.ok(schema) : unsupported('read', 'not-a-zod-schema')

const encoded: SchemaEncodedCapability = { encoded: projectInput }

const propsCapability: SchemaPropsCapability = { props, make }

const encoding: SchemaEncodingCapability = { encode, encodeAsync }

const readCapability: SchemaReadCapability = { read }

export const ZodCodecCapabilities = Object.freeze({
  encoded,
  encoding,
  props: propsCapability,
  read: readCapability
})

export function bridgeZodSchema<Native extends z.ZodType>(
  native: Native
): ZodCapabilityResult<StandardSchemaV1<z.input<Native>, z.output<Native>>>
export function bridgeZodSchema<Native, Input, Output>(
  native: Native
): ZodCapabilityResult<StandardSchemaV1<Input, Output>>
export function bridgeZodSchema(native: unknown): ZodCapabilityResult<StandardSchemaV1> {
  const schema = toZodSchema(native)
  if (schema === undefined) return unsupported('bridge', 'not-a-zod-schema-or-raw-shape')
  return Result.ok(asStandardSchema(schema))
}
