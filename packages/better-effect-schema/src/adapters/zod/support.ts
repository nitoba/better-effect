import { Result, type Result as ResultType } from 'better-result'
import * as z from 'zod'

import type {
  CapabilityResult,
  SchemaCapabilityFailure,
  StandardSchema as ProviderStandardSchema
} from '../../capabilities/types.js'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import {
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../../failure.js'
import { invokeAsync, invokeSync } from '../../internal/execution.js'

export type ZodSchema = z.ZodType

export type ZodCapabilityResult<Value> = CapabilityResult<Value, SchemaCapabilityFailure>

const isObjectLike = (value: unknown): value is object | Function =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isObjectLike(value)) return false

  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

export const isZodSchema = (value: unknown): value is ZodSchema => {
  if (!isObjectLike(value)) return false

  try {
    return value instanceof z.ZodType
  } catch {
    return false
  }
}

export const isZodObject = (value: unknown): value is z.ZodObject => {
  if (!isObjectLike(value)) return false

  try {
    return value instanceof z.ZodObject
  } catch {
    return false
  }
}

export const isZodCodec = (value: unknown): value is z.ZodCodec => {
  if (!isObjectLike(value)) return false

  try {
    return value instanceof z.ZodCodec
  } catch {
    return false
  }
}

const rawShape = (value: unknown): Record<string, ZodSchema> | undefined => {
  if (!isPlainRecord(value)) return undefined

  let keys: readonly PropertyKey[]
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    return undefined
  }

  if (keys.some((key) => typeof key !== 'string')) return undefined

  const shape: Record<string, ZodSchema> = {}
  for (const key of keys) {
    let field: unknown
    try {
      field = Reflect.get(value, key)
    } catch {
      return undefined
    }
    if (!isZodSchema(field)) return undefined
    Object.defineProperty(shape, key, {
      configurable: true,
      enumerable: true,
      value: field,
      writable: true
    })
  }

  return shape
}

/** Accept only a real Zod schema or an explicit raw shape of Zod schemas. */
export const toZodSchema = (value: unknown): ZodSchema | undefined => {
  if (isZodSchema(value)) return value

  const shape = rawShape(value)
  if (shape === undefined) return undefined

  try {
    return z.object(shape)
  } catch {
    return undefined
  }
}

export const asStandardSchema = <Input, Output>(
  schema: ZodSchema
): StandardSchemaV1<Input, Output> => schema as unknown as StandardSchemaV1<Input, Output>

export const identifierOf = (schema: unknown): string => {
  if (!isObjectLike(schema)) return 'ZodSchema'

  try {
    const constructor = Reflect.get(schema, 'constructor')
    const name = isObjectLike(constructor) ? Reflect.get(constructor, 'name') : undefined
    return typeof name === 'string' && name.trim().length > 0 ? name : 'ZodSchema'
  } catch {
    return 'ZodSchema'
  }
}

export const unsupported = <Value = never>(
  operation: string,
  cause?: unknown
): ZodCapabilityResult<Value> => Result.err(new SchemaUnsupportedOperation({ operation, cause }))

export const definitionFailure = <Value = never>(
  operation: string,
  cause: unknown
): ZodCapabilityResult<Value> => Result.err(new SchemaDefinitionFailure({ operation, cause }))

export const invokeZodSync = <Value>(
  operation: string,
  thunk: () => Value
): ZodCapabilityResult<Value> => invokeSync(operation, thunk)

export const invokeZodAsync = async <Value>(
  operation: string,
  thunk: () => Value | PromiseLike<Value>
): Promise<ZodCapabilityResult<Awaited<Value>>> => invokeAsync(operation, thunk)

export const executionFailure = <Value = never>(
  operation: string,
  cause: unknown,
  schema?: unknown
): ZodCapabilityResult<Value> =>
  Result.err(
    new SchemaExecutionFailure({
      operation,
      cause,
      identifier: schema === undefined ? undefined : identifierOf(schema)
    })
  )

export const isSafeParseSuccess = <Value>(
  value: unknown
): value is { readonly success: true; readonly data: Value } =>
  isObjectLike(value) && Reflect.get(value, 'success') === true

export const readSafeParseError = (value: object): unknown => Reflect.get(value, 'error')

export const zodFieldMap = (
  shape: unknown
): ZodCapabilityResult<Readonly<Record<string, ProviderStandardSchema>>> => {
  if (!isObjectLike(shape)) return definitionFailure('fields', 'invalid-shape')

  let keys: readonly PropertyKey[]
  try {
    keys = Reflect.ownKeys(shape)
  } catch (cause) {
    return executionFailure('fields', cause)
  }

  if (keys.some((key) => typeof key !== 'string')) {
    return unsupported('fields', 'symbol-keys-are-not-portable')
  }

  const fields: Record<string, ProviderStandardSchema> = {}
  for (const key of keys) {
    let field: unknown
    try {
      field = Reflect.get(shape, key)
    } catch (cause) {
      return executionFailure('fields', cause)
    }

    if (!isZodSchema(field)) return definitionFailure('fields', `invalid-field:${String(key)}`)
    Object.defineProperty(fields, key, {
      configurable: true,
      enumerable: true,
      value: asStandardSchema(field),
      writable: true
    })
  }

  return Result.ok(Object.freeze(fields))
}

export const applyZodMethod = <Value>(
  operation: string,
  receiver: object,
  methodName: string,
  args: readonly unknown[] = []
): ZodCapabilityResult<Value> => {
  let method: unknown
  try {
    method = Reflect.get(receiver, methodName)
  } catch (cause) {
    return executionFailure(operation, cause, receiver)
  }

  if (typeof method !== 'function') return unsupported(operation, `missing-method:${methodName}`)

  return invokeZodSync(operation, () => Reflect.apply(method, receiver, args) as Value)
}

export const applyZodMethodAsync = async <Value>(
  operation: string,
  receiver: object,
  methodName: string,
  args: readonly unknown[] = []
): Promise<ZodCapabilityResult<Awaited<Value>>> => {
  let method: unknown
  try {
    method = Reflect.get(receiver, methodName)
  } catch (cause) {
    return executionFailure(operation, cause, receiver)
  }

  if (typeof method !== 'function') return unsupported(operation, `missing-method:${methodName}`)

  return invokeZodAsync(operation, () => Reflect.apply(method, receiver, args) as Value)
}

export const resultError = (
  operation: string,
  schema: unknown,
  result: unknown
): ResultType<never, SchemaCapabilityFailure> =>
  Result.err(
    new SchemaExecutionFailure({
      operation,
      identifier: identifierOf(schema),
      cause: isObjectLike(result) ? readSafeParseError(result) : result
    })
  )
