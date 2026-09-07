import { Result, TaggedError as BetterResultTaggedError } from 'better-result'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import {
  SchemaAsyncRequired,
  SchemaConstructionFailure,
  SchemaDefinitionFailure,
  SchemaExecutionFailure
} from '../failure.js'
import type { SchemaEffect } from '../schema-effect.js'
import { INSTANCE_MARKER } from './symbols.js'
import { invokeAsync, invokeSync, type AsyncExecution } from './execution.js'
import { schemaFailure, schemaSuccess } from './result.js'
import { validateStandardAsync, validateStandardSync, type StandardValidation } from './standard.js'

export type TaggedFieldMap = Readonly<Record<string, StandardSchemaV1>>
export type TaggedKind = 'tagged-class' | 'tagged-error'

export type TaggedFailure =
  | SchemaAsyncRequired
  | SchemaConstructionFailure
  | SchemaDefinitionFailure
  | SchemaExecutionFailure

const taggedSuccess = <Value>(value: Value): SchemaEffect<Value, TaggedFailure> =>
  schemaSuccess<Value, TaggedFailure>(value)

const taggedFailure = <Value>(failure: TaggedFailure): SchemaEffect<Value, TaggedFailure> =>
  schemaFailure<Value, TaggedFailure>(failure)

export interface TaggedRuntimeOptions {
  readonly tag: string
  readonly fields: TaggedFieldMap
  readonly kind: TaggedKind
  readonly definitionFailure?: SchemaDefinitionFailure
}

interface TaggedRuntimeClass {
  new (props?: unknown): object
  make(props?: unknown): SchemaEffect<object, TaggedFailure>
  makeAsync(props?: unknown): Promise<SchemaEffect<object, TaggedFailure>>
  unsafeMake(props?: unknown): SchemaEffect<object, TaggedFailure>
  safeMake(
    props?: unknown
  ):
    | { readonly success: true; readonly data: object }
    | { readonly success: false; readonly error: TaggedFailure }
  safeMakeAsync(
    props?: unknown
  ): Promise<
    | { readonly success: true; readonly data: object }
    | { readonly success: false; readonly error: TaggedFailure }
  >
  decode(input: unknown): SchemaEffect<object, TaggedFailure>
  decodeAsync(input: unknown): Promise<SchemaEffect<object, TaggedFailure>>
  parse(input: unknown): object
  encode(input: object): Record<string, unknown>
  readonly identifier: string
  readonly kind: TaggedKind
  readonly fields: TaggedFieldMap & { readonly _tag: StandardSchemaV1<unknown, string> }
  readonly schema: TaggedRuntimeClass
  readonly struct: StandardSchemaV1
  readonly codec: StandardSchemaV1
  readonly encodedSchema: StandardSchemaV1
  readonly propsSchema: StandardSchemaV1
  is(input: unknown): boolean
}

const TAG_FIELD = '_tag'
const RESERVED_ERROR_FIELDS = new Set([TAG_FIELD, 'name', 'stack', 'cause', 'match', 'toJSON'])

const isObjectLike = (value: unknown): value is object | Function =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const definitionFailure = (
  tag: unknown,
  operation: string,
  cause: unknown
): SchemaDefinitionFailure =>
  new SchemaDefinitionFailure({
    identifier: typeof tag === 'string' ? tag : 'TaggedSchema',
    operation,
    cause
  })

const readKeys = (value: object): readonly string[] | undefined => {
  try {
    return Object.keys(value)
  } catch {
    return undefined
  }
}

const readOwn = (
  value: object,
  key: string
): { readonly present: boolean; readonly value: unknown } => {
  try {
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (property === undefined || !('value' in property)) {
      return { present: false, value: undefined }
    }
    return { present: true, value: property.value }
  } catch {
    return { present: false, value: undefined }
  }
}

const readField = (
  fields: TaggedFieldMap,
  key: string
): { readonly present: boolean; readonly value: unknown } => readOwn(fields, key)

const checkDefinition = (
  options: Pick<TaggedRuntimeOptions, 'tag' | 'fields' | 'kind'>
): SchemaDefinitionFailure | undefined => {
  if (typeof options.tag !== 'string' || options.tag.trim().length === 0) {
    return definitionFailure(
      options.tag,
      'definition',
      'Tagged schema identifiers must contain at least one non-whitespace character.'
    )
  }

  if (!isRecord(options.fields)) {
    return definitionFailure(options.tag, 'definition', 'fields-not-object')
  }

  const keys = readKeys(options.fields)
  if (keys === undefined) return definitionFailure(options.tag, 'definition', 'fields-unreadable')

  for (const key of keys) {
    const field = readOwn(options.fields, key)
    if (!field.present)
      return definitionFailure(options.tag, 'definition', `field-unreadable:${key}`)

    if (options.kind === 'tagged-error' && RESERVED_ERROR_FIELDS.has(key)) {
      return definitionFailure(options.tag, 'definition', `reserved-field:${key}`)
    }

    if (options.kind === 'tagged-class' && key === TAG_FIELD) {
      return definitionFailure(options.tag, 'definition', 'reserved-field:_tag')
    }
  }

  return undefined
}

export const validateTaggedDefinition = (
  options: Pick<TaggedRuntimeOptions, 'tag' | 'fields' | 'kind'>
): SchemaDefinitionFailure | undefined => checkDefinition(options)

const readTag = (
  props: Record<string, unknown>
): { readonly present: boolean; readonly value: unknown } => readOwn(props, TAG_FIELD)

const prepareProps = (
  props: unknown,
  tag: string,
  requireTag: boolean
): SchemaEffect<Record<string, unknown>, SchemaConstructionFailure> => {
  const source = props === undefined && !requireTag ? {} : props
  if (!isRecord(source)) {
    return schemaFailure<Record<string, unknown>, SchemaConstructionFailure>(
      new SchemaConstructionFailure({
        identifier: tag,
        operation: 'tagged-construction',
        cause: 'props-not-object'
      })
    )
  }

  const suppliedTag = readTag(source)
  if (suppliedTag.present && suppliedTag.value !== tag) {
    return schemaFailure<Record<string, unknown>, SchemaConstructionFailure>(
      new SchemaConstructionFailure({
        identifier: tag,
        operation: requireTag ? 'tagged-decode' : 'tagged-construction',
        cause: 'invalid-tag'
      })
    )
  }

  if (requireTag && !suppliedTag.present) {
    return schemaFailure<Record<string, unknown>, SchemaConstructionFailure>(
      new SchemaConstructionFailure({
        identifier: tag,
        operation: 'tagged-decode',
        cause: 'missing-tag'
      })
    )
  }

  const prepared: Record<string, unknown> = {}
  const keys = readKeys(source)
  if (keys === undefined) {
    return schemaFailure<Record<string, unknown>, SchemaConstructionFailure>(
      new SchemaConstructionFailure({
        identifier: tag,
        operation: 'tagged-construction',
        cause: 'props-unreadable'
      })
    )
  }

  for (const key of keys) {
    if (key === TAG_FIELD) continue
    const property = readOwn(source, key)
    if (property.present) prepared[key] = property.value
  }

  prepared[TAG_FIELD] = tag
  return schemaSuccess<Record<string, unknown>, SchemaConstructionFailure>(prepared)
}

const invalidStandardResult = <Value>(
  tag: string,
  operation: string,
  result: unknown
): SchemaEffect<Value, TaggedFailure> => taggedFailure(definitionFailure(tag, operation, result))

const normalizeFieldResult = <Value>(
  tag: string,
  operation: string,
  result: StandardValidation<Value>
): SchemaEffect<Value, TaggedFailure> => {
  switch (result._tag) {
    case 'success':
      return taggedSuccess(result.value)
    case 'failure':
      return taggedFailure(
        new SchemaConstructionFailure({
          identifier: tag,
          operation,
          cause: result.issues
        })
      )
    case 'definition':
      return taggedFailure(result.failure)
  }
}

const normalizeAsyncStandardResult = (
  tag: string,
  operation: string,
  result: unknown
): StandardValidation<unknown> => {
  if (!isObjectLike(result)) {
    return {
      _tag: 'definition',
      failure: definitionFailure(tag, operation, 'invalid-result')
    }
  }

  const issues = Reflect.get(result, 'issues')
  if (issues !== undefined) {
    return Array.isArray(issues)
      ? { _tag: 'failure', issues }
      : {
          _tag: 'definition',
          failure: definitionFailure(tag, operation, 'invalid-issues')
        }
  }

  if (!Reflect.has(result, 'value')) {
    return {
      _tag: 'definition',
      failure: definitionFailure(tag, operation, 'missing-value')
    }
  }

  return { _tag: 'success', value: Reflect.get(result, 'value') }
}

const isThenable = (value: unknown): boolean => {
  if (!isObjectLike(value)) return false

  try {
    return typeof Reflect.get(value, 'then') === 'function'
  } catch {
    return false
  }
}

const continueAsyncFields = async (
  options: TaggedRuntimeOptions,
  props: Record<string, unknown>,
  keys: readonly string[],
  output: Record<string, unknown>,
  index: number,
  operation: string,
  pending: unknown
): Promise<SchemaEffect<Record<string, unknown>, TaggedFailure>> => {
  const resumed = await invokeAsync(operation, () =>
    Promise.resolve(pending).then((result) =>
      normalizeAsyncStandardResult(options.tag, operation, result)
    )
  )
  if (Result.isError(resumed))
    return resumed as SchemaEffect<Record<string, unknown>, TaggedFailure>

  const key = keys[index]
  if (key === undefined)
    return invalidStandardResult<Record<string, unknown>>(
      options.tag,
      operation,
      'field-index-out-of-range'
    )
  const normalized = normalizeFieldResult(options.tag, operation, resumed.value)
  if (Result.isError(normalized))
    return normalized as SchemaEffect<Record<string, unknown>, TaggedFailure>
  output[key] = normalized.value

  for (let next = index + 1; next < keys.length; next += 1) {
    const nextKey = keys[next]
    if (nextKey === undefined)
      return invalidStandardResult<Record<string, unknown>>(
        options.tag,
        operation,
        'field-index-out-of-range'
      )
    const field = readField(options.fields, nextKey)
    if (!field.present)
      return invalidStandardResult<Record<string, unknown>>(
        options.tag,
        operation,
        `field-unreadable:${nextKey}`
      )

    const input = readOwn(props, nextKey)
    const result = await validateStandardAsync(
      field.value as StandardSchemaV1,
      input.value,
      options.tag,
      operation,
      undefined
    )
    if (Result.isError(result))
      return result as SchemaEffect<Record<string, unknown>, TaggedFailure>

    const nextNormalized = normalizeFieldResult(options.tag, operation, result.value)
    if (Result.isError(nextNormalized))
      return nextNormalized as SchemaEffect<Record<string, unknown>, TaggedFailure>
    output[nextKey] = nextNormalized.value
  }

  output[TAG_FIELD] = options.tag
  return taggedSuccess(output)
}

const validateFieldsSync = (
  options: TaggedRuntimeOptions,
  props: Record<string, unknown>,
  operation: string
): SchemaEffect<Record<string, unknown>, TaggedFailure> => {
  const prepared = prepareProps(props, options.tag, operation.includes('decode'))
  if (Result.isError(prepared))
    return prepared as SchemaEffect<Record<string, unknown>, TaggedFailure>

  const output: Record<string, unknown> = {}
  const keys = Object.keys(options.fields)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (key === undefined)
      return invalidStandardResult<Record<string, unknown>>(
        options.tag,
        operation,
        'field-index-out-of-range'
      )
    const field = readField(options.fields, key)
    if (!field.present)
      return invalidStandardResult<Record<string, unknown>>(
        options.tag,
        operation,
        `field-unreadable:${key}`
      )

    const input = readOwn(prepared.value, key)
    const result = validateStandardSync(
      field.value as StandardSchemaV1,
      input.value,
      options.tag,
      operation,
      undefined
    )
    if (Result.isError(result)) {
      if (result.error instanceof SchemaAsyncRequired) {
        let pending: unknown
        try {
          pending = result.error.cause
        } catch (cause) {
          return taggedFailure(
            new SchemaExecutionFailure({
              identifier: options.tag,
              operation,
              cause
            })
          )
        }
        if (isThenable(pending)) {
          const continuation = continueAsyncFields(
            options,
            prepared.value,
            keys,
            output,
            index,
            operation,
            pending
          )
          return taggedFailure(
            new SchemaAsyncRequired({
              identifier: options.tag,
              operation,
              cause: continuation
            })
          )
        }
      }
      return result as SchemaEffect<Record<string, unknown>, TaggedFailure>
    }

    const normalized = normalizeFieldResult(options.tag, operation, result.value)
    if (Result.isError(normalized))
      return normalized as SchemaEffect<Record<string, unknown>, TaggedFailure>
    output[key] = normalized.value
  }

  output[TAG_FIELD] = options.tag
  return taggedSuccess(output)
}

const validateFieldsAsync = async (
  options: TaggedRuntimeOptions,
  props: Record<string, unknown>,
  operation: string
): Promise<SchemaEffect<Record<string, unknown>, TaggedFailure>> => {
  const prepared = prepareProps(props, options.tag, operation.includes('decode'))
  if (Result.isError(prepared))
    return prepared as SchemaEffect<Record<string, unknown>, TaggedFailure>

  const output: Record<string, unknown> = {}
  for (const key of Object.keys(options.fields)) {
    const field = readField(options.fields, key)
    if (!field.present)
      return invalidStandardResult<Record<string, unknown>>(
        options.tag,
        operation,
        `field-unreadable:${key}`
      )

    const input = readOwn(prepared.value, key)
    const result = await validateStandardAsync(
      field.value as StandardSchemaV1,
      input.value,
      options.tag,
      operation,
      undefined
    )
    if (Result.isError(result))
      return result as SchemaEffect<Record<string, unknown>, TaggedFailure>

    const normalized = normalizeFieldResult(options.tag, operation, result.value)
    if (Result.isError(normalized))
      return normalized as SchemaEffect<Record<string, unknown>, TaggedFailure>
    output[key] = normalized.value
  }

  output[TAG_FIELD] = options.tag
  return taggedSuccess(output)
}

const construct = (
  constructor: Function,
  props: Record<string, unknown>
): SchemaEffect<object, TaggedFailure> => {
  const result = invokeSync(
    'tagged-construction',
    () => Reflect.construct(constructor, [props]) as object
  )
  if (Result.isError(result)) return result as SchemaEffect<object, TaggedFailure>
  return taggedSuccess(result.value)
}

const constructAsync = async (
  constructor: Function,
  props: Record<string, unknown>
): Promise<SchemaEffect<object, TaggedFailure>> => {
  const result = await invokeAsync(
    'tagged-construction',
    () => Reflect.construct(constructor, [props]) as object
  )
  if (Result.isError(result)) return result as SchemaEffect<object, TaggedFailure>
  return taggedSuccess(result.value)
}

const makeFailure = (options: TaggedRuntimeOptions): SchemaEffect<object, TaggedFailure> =>
  taggedFailure(
    options.definitionFailure ?? definitionFailure(options.tag, 'definition', 'invalid-definition')
  )

const makePortable = (
  constructor: Function,
  options: TaggedRuntimeOptions,
  props: unknown,
  requireTag: boolean
): SchemaEffect<object, TaggedFailure> => {
  if (options.definitionFailure !== undefined) return makeFailure(options)

  const prepared = validateFieldsSync(
    options,
    props as Record<string, unknown>,
    requireTag ? 'tagged-decode' : 'tagged-make'
  )
  if (Result.isError(prepared)) return prepared as SchemaEffect<object, TaggedFailure>
  return construct(constructor, prepared.value)
}

const makePortableAsync = async (
  constructor: Function,
  options: TaggedRuntimeOptions,
  props: unknown,
  requireTag: boolean
): Promise<SchemaEffect<object, TaggedFailure>> => {
  if (options.definitionFailure !== undefined) return makeFailure(options)

  const prepared = await validateFieldsAsync(
    options,
    props as Record<string, unknown>,
    requireTag ? 'tagged-decode-async' : 'tagged-make-async'
  )
  if (Result.isError(prepared)) return prepared as SchemaEffect<object, TaggedFailure>
  return constructAsync(constructor, prepared.value)
}

const makeUnsafePortable = (
  constructor: Function,
  options: TaggedRuntimeOptions,
  props: unknown
): SchemaEffect<object, TaggedFailure> => {
  if (options.definitionFailure !== undefined) return makeFailure(options)

  const prepared = prepareProps(props, options.tag, false)
  if (Result.isError(prepared)) return prepared as SchemaEffect<object, TaggedFailure>
  return construct(constructor, prepared.value)
}

const tagSchema = (tag: string): StandardSchemaV1<unknown, string> => ({
  '~standard': {
    version: 1,
    vendor: 'better-effect-schema',
    validate(value: unknown) {
      return value === tag ? { value: tag } : { issues: [{ message: 'Validation failed' }] }
    }
  }
})

const createSchema = (
  options: TaggedRuntimeOptions,
  constructor: TaggedRuntimeClass
): StandardSchemaV1 => ({
  '~standard': {
    version: 1,
    vendor: 'better-effect-schema',
    validate(value: unknown) {
      const result = makePortable(constructor, options, value, true)
      if (Result.isError(result)) {
        if (result.error instanceof SchemaAsyncRequired) {
          let pending: unknown
          try {
            pending = result.error.cause
          } catch (cause) {
            return { issues: [{ message: String(cause) }] }
          }

          if (isThenable(pending)) {
            return Promise.resolve(pending as Promise<SchemaEffect<object, TaggedFailure>>).then(
              (asyncResult) =>
                Result.isError(asyncResult)
                  ? { issues: [{ message: asyncResult.error.message }] }
                  : { value: asyncResult.value }
            )
          }
        }

        return { issues: [{ message: result.error.message }] }
      }

      return { value: result.value }
    }
  }
})

const encodePortable = (
  constructor: TaggedRuntimeClass,
  value: object,
  options: TaggedRuntimeOptions
): Record<string, unknown> => {
  if (!constructor.is(value)) {
    throw new TypeError(`Expected an instance of ${options.tag}.`)
  }

  const encoded: Record<string, unknown> = { [TAG_FIELD]: options.tag }
  for (const key of Object.keys(options.fields)) {
    const property = readOwn(value, key)
    if (property.present) encoded[key] = property.value
  }
  return encoded
}

const installMarker = (prototype: object, options: TaggedRuntimeOptions): void => {
  Object.defineProperty(prototype, INSTANCE_MARKER, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ identifier: options.tag, kind: options.kind })
  })
}

const assignProps = (
  instance: object,
  props: Record<string, unknown>,
  options: TaggedRuntimeOptions
): void => {
  for (const key of Object.keys(options.fields)) {
    const property = readOwn(props, key)
    if (!property.present) continue
    Object.defineProperty(instance, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: property.value
    })
  }

  Object.defineProperty(instance, TAG_FIELD, {
    configurable: false,
    enumerable: true,
    writable: false,
    value: options.tag
  })
}

const errorProps = (
  props: Record<string, unknown>,
  options: TaggedRuntimeOptions
): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(options.fields)) {
    const property = readOwn(props, key)
    if (property.present) result[key] = property.value
  }
  return result
}

const defineStatics = (constructor: TaggedRuntimeClass, options: TaggedRuntimeOptions): void => {
  const fieldValues: Record<string, StandardSchemaV1> = {}
  Object.defineProperty(fieldValues, TAG_FIELD, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: tagSchema(options.tag)
  })
  for (const key of Object.keys(options.fields)) {
    const field = readOwn(options.fields, key)
    if (!field.present) continue
    Object.defineProperty(fieldValues, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: field.value as StandardSchemaV1
    })
  }
  const fields = Object.freeze(fieldValues) as TaggedRuntimeClass['fields']
  const schema = createSchema(options, constructor)

  Object.defineProperties(constructor, {
    identifier: { configurable: false, enumerable: true, value: options.tag },
    kind: { configurable: false, enumerable: true, value: options.kind },
    fields: { configurable: false, enumerable: true, value: fields },
    schema: { configurable: false, enumerable: true, get: () => constructor },
    struct: { configurable: false, enumerable: true, value: schema },
    codec: { configurable: false, enumerable: true, value: schema },
    encodedSchema: { configurable: false, enumerable: true, value: schema },
    propsSchema: { configurable: false, enumerable: true, value: schema },
    '~standard': {
      configurable: false,
      enumerable: false,
      get(this: TaggedRuntimeClass) {
        return createSchema(options, this)['~standard']
      }
    }
  })
}

export const createPortableTaggedClass = (input: TaggedRuntimeOptions): TaggedRuntimeClass => {
  const options = Object.freeze({ ...input })
  const ErrorBase =
    options.kind === 'tagged-error' ? BetterResultTaggedError(options.tag) : class EmptyBase {}

  class GeneratedTagged extends ErrorBase {
    constructor(props?: unknown) {
      const prepared = prepareProps(props, options.tag, false)
      if (Result.isError(prepared)) {
        throw prepared.error
      }

      if (options.kind === 'tagged-error') {
        super(errorProps(prepared.value, options))
      } else {
        super()
      }

      assignProps(this, prepared.value, options)
    }

    static make(props?: unknown): SchemaEffect<object, TaggedFailure> {
      return makePortable(this, options, props, false)
    }

    static async makeAsync(props?: unknown): Promise<SchemaEffect<object, TaggedFailure>> {
      return makePortableAsync(this, options, props, false)
    }

    static unsafeMake(props?: unknown): SchemaEffect<object, TaggedFailure> {
      return makeUnsafePortable(this, options, props)
    }

    static safeMake(
      props?: unknown
    ):
      | { readonly success: true; readonly data: object }
      | { readonly success: false; readonly error: TaggedFailure } {
      const result = this.make(props)
      return Result.isError(result)
        ? { success: false, error: result.error }
        : { success: true, data: result.value }
    }

    static async safeMakeAsync(
      props?: unknown
    ): Promise<
      | { readonly success: true; readonly data: object }
      | { readonly success: false; readonly error: TaggedFailure }
    > {
      const result = await this.makeAsync(props)
      return Result.isError(result)
        ? { success: false, error: result.error }
        : { success: true, data: result.value }
    }

    static decode(input: unknown): SchemaEffect<object, TaggedFailure> {
      return makePortable(this, options, input, true)
    }

    static decodeAsync(input: unknown): Promise<SchemaEffect<object, TaggedFailure>> {
      return makePortableAsync(this, options, input, true)
    }

    static parse(input: unknown): object {
      const result = this.decode(input)
      if (Result.isError(result)) throw result.error
      return result.value
    }

    static encode(input: object): Record<string, unknown> {
      return encodePortable(this as unknown as TaggedRuntimeClass, input, options)
    }

    static is(input: unknown): boolean {
      return isObjectLike(input) && input instanceof this
    }
  }

  installMarker(GeneratedTagged.prototype, options)
  defineStatics(GeneratedTagged as unknown as TaggedRuntimeClass, options)
  return GeneratedTagged as unknown as TaggedRuntimeClass
}

export const installLegacySafeFactories = (constructor: object, identifier: string): void => {
  const runtime = constructor as {
    safeMake(props?: unknown): {
      readonly success: boolean
      readonly data?: unknown
      readonly error?: unknown
    }
    safeMakeAsync(
      props?: unknown
    ): Promise<{ readonly success: boolean; readonly data?: unknown; readonly error?: unknown }>
    unsafeMake(props?: unknown): unknown
  }

  const normalize = (
    result: { readonly success: boolean; readonly data?: unknown; readonly error?: unknown },
    operation: string
  ): SchemaEffect<object, TaggedFailure> =>
    result.success
      ? taggedSuccess(result.data as object)
      : taggedFailure(
          new SchemaConstructionFailure({
            identifier,
            operation,
            cause: result.error
          })
        )

  Object.defineProperty(constructor, 'make', {
    configurable: true,
    value(this: typeof runtime, props?: unknown) {
      const result = invokeSync('tagged-make', () => this.safeMake(props))
      if (Result.isError(result)) return result as SchemaEffect<object, TaggedFailure>
      return normalize(result.value, 'tagged-make')
    }
  })

  Object.defineProperty(constructor, 'makeAsync', {
    configurable: true,
    value(this: typeof runtime, props?: unknown) {
      return invokeAsync('tagged-make-async', () => this.safeMakeAsync(props)).then(
        (
          result: AsyncExecution<{
            readonly success: boolean
            readonly data?: unknown
            readonly error?: unknown
          }>
        ) => {
          if (Result.isError(result)) return result as SchemaEffect<object, TaggedFailure>
          return normalize(result.value, 'tagged-make-async')
        }
      )
    }
  })

  const unsafe = runtime.unsafeMake
  Object.defineProperty(constructor, 'unsafeMake', {
    configurable: true,
    value(this: typeof runtime, props?: unknown) {
      const result = invokeSync('tagged-unsafe-make', () => unsafe.call(this, props))
      if (Result.isError(result)) return result as SchemaEffect<object, TaggedFailure>
      return taggedSuccess(result.value as object)
    }
  })
}

export const isLegacyTaggedShape = (fields: object): boolean => {
  const keys = readKeys(fields)
  if (keys === undefined || keys.length === 0) return false

  for (const key of keys) {
    const property = readOwn(fields, key)
    if (!property.present || !isObjectLike(property.value)) return false

    try {
      if (!Object.prototype.hasOwnProperty.call(property.value, '_zod')) return false
    } catch {
      return false
    }
  }

  return true
}

export const portableDefinitionFailure = definitionFailure
