import { Result } from 'better-result'
import * as z from 'zod'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type {
  SchemaDerivationCapability,
  SchemaDerivationOperation,
  SchemaFieldMap,
  SchemaObjectPolicy,
  SchemaStructureCapability
} from '../../capabilities/types.js'
import {
  applyZodMethod,
  asStandardSchema,
  definitionFailure,
  invokeZodSync,
  isZodObject,
  isZodSchema,
  unsupported,
  zodFieldMap,
  type ZodCapabilityResult
} from './support.js'

const objectOf = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  operation: string
): ZodCapabilityResult<z.ZodObject> =>
  isZodObject(schema) ? Result.ok(schema) : unsupported(operation, 'object-schema-required')

const objectFields = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>
): ZodCapabilityResult<SchemaFieldMap> => {
  const object = objectOf(schema, 'fields')
  if (Result.isError(object)) return object

  const shape = invokeZodSync('fields', () => object.value.shape)
  if (Result.isError(shape)) return shape
  return zodFieldMap(shape.value)
}

const asZodFields = (
  fields: SchemaFieldMap,
  operation: string
): ZodCapabilityResult<Record<string, z.ZodType>> => {
  const result: Record<string, z.ZodType> = {}
  let keys: readonly PropertyKey[]

  try {
    keys = Reflect.ownKeys(fields)
  } catch (cause) {
    return definitionFailure(operation, cause)
  }

  if (keys.some((key) => typeof key !== 'string')) {
    return unsupported(operation, 'symbol-keys-are-not-portable')
  }

  for (const key of keys) {
    if (typeof key !== 'string') return unsupported(operation, 'symbol-keys-are-not-portable')
    let value: unknown
    try {
      value = Reflect.get(fields, key)
    } catch (cause) {
      return definitionFailure(operation, cause)
    }

    if (!isZodSchema(value)) return unsupported(operation, `zod-field-required:${key}`)
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    })
  }

  return Result.ok(result)
}

const struct = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  fields: SchemaFieldMap
): ZodCapabilityResult<StandardSchemaV1> => {
  const object = objectOf(schema, 'struct')
  if (Result.isError(object)) return object

  const shape = asZodFields(fields, 'struct')
  if (Result.isError(shape)) return shape

  const method = typeof object.value.safeExtend === 'function' ? 'safeExtend' : 'extend'
  const result = applyZodMethod<unknown>('struct', object.value, method, [shape.value])
  if (Result.isError(result)) return result
  if (!isZodSchema(result.value)) return definitionFailure('struct', 'invalid-derived-schema')
  return Result.ok(asStandardSchema(result.value))
}

const policy = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  objectPolicy: SchemaObjectPolicy
): ZodCapabilityResult<StandardSchemaV1> => {
  const object = objectOf(schema, 'policy')
  if (Result.isError(object)) return object

  if (objectPolicy === 'catchall') {
    return unsupported('policy', 'catchall-requires-an-explicit-schema')
  }

  const result = applyZodMethod<unknown>('policy', object.value, objectPolicy)
  if (Result.isError(result)) return result
  if (!isZodSchema(result.value)) return definitionFailure('policy', 'invalid-policy-schema')
  return Result.ok(asStandardSchema(result.value))
}

const fieldMask = (
  value: unknown,
  object: z.ZodObject,
  operation: string
): ZodCapabilityResult<Record<string, true>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return definitionFailure(operation, 'invalid-mask')
  }

  const mask: Record<string, true> = {}
  let keys: readonly PropertyKey[]
  try {
    keys = Reflect.ownKeys(value)
  } catch (cause) {
    return definitionFailure(operation, cause)
  }

  if (keys.some((key) => typeof key !== 'string')) {
    return unsupported(operation, 'symbol-keys-are-not-portable')
  }

  let objectFields: unknown
  try {
    objectFields = object.shape
  } catch (cause) {
    return definitionFailure(operation, cause)
  }
  if (objectFields === null || typeof objectFields !== 'object') {
    return definitionFailure(operation, 'invalid-object-shape')
  }

  for (const key of keys) {
    if (typeof key !== 'string') return unsupported(operation, 'symbol-keys-are-not-portable')
    let selected: unknown
    try {
      selected = Reflect.get(value, key)
    } catch (cause) {
      return definitionFailure(operation, cause)
    }
    if (selected !== true) return definitionFailure(operation, `mask-value:${key}`)
    let hasField: boolean
    try {
      hasField = Object.prototype.hasOwnProperty.call(objectFields, key)
    } catch (cause) {
      return definitionFailure(operation, cause)
    }
    if (!hasField) {
      return definitionFailure(operation, `unknown-field:${key}`)
    }
    mask[key] = true
  }

  return Result.ok(mask)
}

const derive = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  operation: SchemaDerivationOperation,
  config?: unknown
): ZodCapabilityResult<StandardSchemaV1> => {
  const object = objectOf(schema, 'derive')
  if (Result.isError(object)) return object

  let result: ZodCapabilityResult<unknown>
  switch (operation) {
    case 'extend': {
      const fields = asZodFields(config as SchemaFieldMap, operation)
      if (Result.isError(fields)) return fields
      const method = typeof object.value.safeExtend === 'function' ? 'safeExtend' : 'extend'
      result = applyZodMethod('derive', object.value, method, [fields.value])
      break
    }
    case 'pick':
    case 'omit': {
      const mask = fieldMask(config, object.value, operation)
      if (Result.isError(mask)) return mask
      result = applyZodMethod('derive', object.value, operation, [mask.value])
      break
    }
    case 'partial':
    case 'exactPartial':
    case 'required': {
      if (config === undefined) {
        result = applyZodMethod('derive', object.value, operation)
        break
      }
      const mask = fieldMask(config, object.value, operation)
      if (Result.isError(mask)) return mask
      result = applyZodMethod('derive', object.value, operation, [mask.value])
      break
    }
    case 'deepPartial': {
      if (config !== undefined) return definitionFailure(operation, 'unexpected-config')
      result = invokeZodSync(operation, () => z.deepPartial(object.value))
      break
    }
    default:
      return unsupported('derive', operation)
  }

  if (Result.isError(result)) return result
  if (!isZodSchema(result.value)) return definitionFailure('derive', 'invalid-derived-schema')
  return Result.ok(asStandardSchema(result.value))
}

export const ZodObjectCapabilities = Object.freeze({
  derivation: { derive },
  structure: { fields: objectFields, policy, struct }
}) satisfies {
  readonly derivation: SchemaDerivationCapability
  readonly structure: SchemaStructureCapability
}
