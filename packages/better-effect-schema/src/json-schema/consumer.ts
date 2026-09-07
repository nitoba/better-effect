import type { StandardJSONSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'

import {
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../failure.js'
import { invokeSync } from '../internal/execution.js'
import { schemaFailure, schemaSuccess } from '../internal/result.js'
import type {
  JSONSchemaConversionFailure,
  JSONSchemaEffect,
  JSONSchemaSource,
  JsonSchemaDocument,
  ToJSONSchemaOptions
} from './types.js'

type ObjectLike = object | Function

type Normalization =
  | { readonly _tag: 'success'; readonly value: unknown }
  | { readonly _tag: 'definition'; readonly cause: unknown }
  | { readonly _tag: 'failure'; readonly failure: JSONSchemaConversionFailure }

type PropertyRead =
  | { readonly _tag: 'success'; readonly value: unknown }
  | { readonly _tag: 'failure'; readonly failure: JSONSchemaConversionFailure }

const isObjectLike = (value: unknown): value is ObjectLike =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const JSON_SCHEMA_IDENTIFIER = 'JSONSchema'

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isObjectLike(value) || Array.isArray(value)) return false

  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const readProperty = (owner: ObjectLike, key: PropertyKey, operation: string): PropertyRead => {
  const result = invokeSync<unknown>(operation, () => Reflect.get(owner, key))
  return Result.isError(result)
    ? { _tag: 'failure', failure: result.error as JSONSchemaConversionFailure }
    : { _tag: 'success', value: result.value }
}

const definitionFailure = (cause: unknown): SchemaDefinitionFailure =>
  new SchemaDefinitionFailure({
    identifier: JSON_SCHEMA_IDENTIFIER,
    operation: 'toJSONSchema',
    cause
  })

const unsupportedFailure = (cause: unknown): SchemaUnsupportedOperation =>
  new SchemaUnsupportedOperation({
    identifier: JSON_SCHEMA_IDENTIFIER,
    operation: 'toJSONSchema',
    cause
  })

const executionFailure = (cause: unknown): SchemaExecutionFailure =>
  new SchemaExecutionFailure({
    identifier: JSON_SCHEMA_IDENTIFIER,
    operation: 'toJSONSchema',
    cause
  })

const failureResult = (failure: JSONSchemaConversionFailure): JSONSchemaEffect =>
  schemaFailure<JsonSchemaDocument, JSONSchemaConversionFailure>(failure)

const normalizeValue = (value: unknown, active: WeakSet<object>): Normalization => {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return { _tag: 'success', value }
    case 'number':
      return Number.isFinite(value)
        ? { _tag: 'success', value }
        : { _tag: 'definition', cause: 'non-finite-number' }
    case 'object':
      break
    default:
      return { _tag: 'definition', cause: `invalid-json-value:${typeof value}` }
  }

  if (value === null) return { _tag: 'success', value }
  if (active.has(value)) return { _tag: 'definition', cause: 'cyclic-document' }
  active.add(value)

  try {
    if (Array.isArray(value)) {
      let length: number
      try {
        length = Reflect.get(value, 'length') as number
      } catch (cause) {
        return { _tag: 'failure', failure: executionFailure(cause) }
      }

      if (!Number.isSafeInteger(length) || length < 0) {
        return { _tag: 'definition', cause: 'invalid-array-length' }
      }

      const result: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        const item = readProperty(value, index, 'toJSONSchema')
        if (item._tag === 'failure') return { _tag: 'failure', failure: item.failure }

        const normalized = normalizeValue(item.value, active)
        if (normalized._tag !== 'success') return normalized
        result.push(normalized.value)
      }

      return { _tag: 'success', value: result }
    }

    if (!isPlainObject(value)) return { _tag: 'definition', cause: 'non-plain-document-value' }

    let keys: readonly (string | symbol)[]
    try {
      keys = Reflect.ownKeys(value)
    } catch (cause) {
      return { _tag: 'failure', failure: executionFailure(cause) }
    }

    const result: Record<string, unknown> = {}
    for (const key of keys) {
      if (typeof key === 'symbol') return { _tag: 'definition', cause: 'symbol-key' }

      const item = readProperty(value, key, 'toJSONSchema')
      if (item._tag === 'failure') return { _tag: 'failure', failure: item.failure }

      const normalized = normalizeValue(item.value, active)
      if (normalized._tag !== 'success') return normalized
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: normalized.value,
        writable: true
      })
    }

    return { _tag: 'success', value: result }
  } finally {
    active.delete(value)
  }
}

const hasStructuralKeyword = (document: Record<string, unknown>): boolean => {
  const structuralKeywords = [
    '$id',
    '$ref',
    '$schema',
    '$defs',
    'additionalItems',
    'additionalProperties',
    'allOf',
    'anyOf',
    'const',
    'contains',
    'contentEncoding',
    'contentMediaType',
    'contentSchema',
    'dependentRequired',
    'dependentSchemas',
    'else',
    'enum',
    'if',
    'items',
    'maxItems',
    'maxLength',
    'maximum',
    'maxProperties',
    'minItems',
    'minLength',
    'minimum',
    'minProperties',
    'multipleOf',
    'not',
    'oneOf',
    'pattern',
    'patternProperties',
    'prefixItems',
    'properties',
    'propertyNames',
    'required',
    'then',
    'type',
    'uniqueItems',
    'unevaluatedItems',
    'unevaluatedProperties'
  ]

  return structuralKeywords.some((key) => key in document)
}

const isSchemaValue = (value: unknown): value is boolean | Record<string, unknown> =>
  typeof value === 'boolean' || isPlainObject(value)

const readSchemaChild = (
  document: Record<string, unknown>,
  key: string
): { readonly present: false } | { readonly present: true; readonly value: unknown } =>
  key in document ? { present: true, value: document[key] } : { present: false }

const validateUniqueStrings = (value: unknown): boolean => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return false
  return new Set(value).size === value.length
}

const validateSchemaNode = (
  value: boolean | Record<string, unknown>,
  path: readonly string[],
  identifiers: Map<string, readonly string[]>
): unknown => {
  if (typeof value === 'boolean') return undefined

  const id = readSchemaChild(value, '$id')
  if (id.present) {
    if (typeof id.value !== 'string' || id.value.length === 0) return 'invalid-id'
    const previous = identifiers.get(id.value)
    if (previous !== undefined) return 'duplicate-id'
    identifiers.set(id.value, path)
  }

  const ref = readSchemaChild(value, '$ref')
  if (ref.present && typeof ref.value !== 'string') return 'invalid-ref'

  const schema = readSchemaChild(value, '$schema')
  if (schema.present && typeof schema.value !== 'string') return 'invalid-schema-uri'

  const required = readSchemaChild(value, 'required')
  if (required.present && !validateUniqueStrings(required.value)) return 'invalid-required'

  const type = readSchemaChild(value, 'type')
  if (
    type.present &&
    typeof type.value !== 'string' &&
    (!Array.isArray(type.value) ||
      type.value.length === 0 ||
      type.value.some((item) => typeof item !== 'string') ||
      new Set(type.value).size !== type.value.length)
  )
    return 'invalid-type'

  const schemaMaps = ['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties']
  for (const key of schemaMaps) {
    const child = readSchemaChild(value, key)
    if (!child.present) continue
    if (!isPlainObject(child.value)) return `invalid-${key}`
    for (const [name, schemaValue] of Object.entries(child.value)) {
      if (!isSchemaValue(schemaValue)) return `invalid-${key}-entry:${name}`
      const failure = validateSchemaNode(schemaValue, [...path, key, name], identifiers)
      if (failure !== undefined) return failure
    }
  }

  const singleSchemas = [
    'additionalItems',
    'additionalProperties',
    'contains',
    'contentSchema',
    'else',
    'if',
    'items',
    'not',
    'propertyNames',
    'then',
    'unevaluatedItems',
    'unevaluatedProperties'
  ]
  for (const key of singleSchemas) {
    const child = readSchemaChild(value, key)
    if (!child.present) continue
    if (!isSchemaValue(child.value)) return `invalid-${key}`
    const failure = validateSchemaNode(child.value, [...path, key], identifiers)
    if (failure !== undefined) return failure
  }

  const schemaArrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems']
  for (const key of schemaArrays) {
    const child = readSchemaChild(value, key)
    if (!child.present) continue
    if (!Array.isArray(child.value) || !child.value.every(isSchemaValue)) return `invalid-${key}`
    for (const [index, schemaValue] of child.value.entries()) {
      const failure = validateSchemaNode(schemaValue, [...path, key, String(index)], identifiers)
      if (failure !== undefined) return failure
    }
  }

  return undefined
}

const validateDocument = (
  value: unknown
):
  | { readonly _tag: 'success'; readonly document: JsonSchemaDocument }
  | { readonly _tag: 'failure'; readonly cause: unknown } => {
  if (!isPlainObject(value)) return { _tag: 'failure', cause: 'document-must-be-an-object' }

  const keys = Object.keys(value)
  if (keys.length === 0) return { _tag: 'failure', cause: 'empty-document' }
  if (!hasStructuralKeyword(value)) return { _tag: 'failure', cause: 'empty-schema' }

  const failure = validateSchemaNode(value, [], new Map())
  return failure === undefined
    ? { _tag: 'success', document: value }
    : { _tag: 'failure', cause: failure }
}

const converterFrom = (
  source: JSONSchemaSource
):
  | { readonly _tag: 'success'; readonly converter: StandardJSONSchemaV1.Converter }
  | { readonly _tag: 'failure'; readonly failure: JSONSchemaConversionFailure } => {
  if (!isObjectLike(source))
    return { _tag: 'failure', failure: definitionFailure('invalid-source') }

  const standard = readProperty(source, '~standard', 'toJSONSchema')
  if (standard._tag === 'failure') return standard
  if (standard.value !== undefined) {
    if (!isObjectLike(standard.value)) {
      return { _tag: 'failure', failure: definitionFailure('invalid-standard') }
    }

    const version = readProperty(standard.value, 'version', 'toJSONSchema')
    if (version._tag === 'failure') return version
    const vendor = readProperty(standard.value, 'vendor', 'toJSONSchema')
    if (vendor._tag === 'failure') return vendor
    const jsonSchema = readProperty(standard.value, 'jsonSchema', 'toJSONSchema')
    if (jsonSchema._tag === 'failure') return jsonSchema

    if (version.value !== 1 || typeof vendor.value !== 'string') {
      return { _tag: 'failure', failure: definitionFailure('invalid-standard') }
    }
    if (!isObjectLike(jsonSchema.value)) {
      return { _tag: 'failure', failure: definitionFailure('missing-json-schema') }
    }
    return {
      _tag: 'success',
      converter: jsonSchema.value as StandardJSONSchemaV1.Converter
    }
  }

  const direct = readProperty(source, 'jsonSchema', 'toJSONSchema')
  if (direct._tag === 'failure') return direct
  if (!isObjectLike(direct.value)) {
    return { _tag: 'failure', failure: unsupportedFailure('json-schema') }
  }

  return {
    _tag: 'success',
    converter: direct.value as StandardJSONSchemaV1.Converter
  }
}

const optionsFor = (
  options: ToJSONSchemaOptions
):
  | {
      readonly _tag: 'success'
      readonly side: 'input' | 'output'
      readonly options: StandardJSONSchemaV1.Options
    }
  | { readonly _tag: 'failure'; readonly failure: JSONSchemaConversionFailure } => {
  if (!isObjectLike(options))
    return { _tag: 'failure', failure: definitionFailure('invalid-options') }

  const side = readProperty(options, 'side', 'toJSONSchema')
  if (side._tag === 'failure') return side
  if (side.value !== undefined && side.value !== 'input' && side.value !== 'output') {
    return { _tag: 'failure', failure: unsupportedFailure('invalid-side') }
  }

  const target = readProperty(options, 'target', 'toJSONSchema')
  if (target._tag === 'failure') return target
  if (typeof target.value !== 'string' || target.value.trim().length === 0) {
    return { _tag: 'failure', failure: unsupportedFailure('invalid-target') }
  }

  const libraryOptions = readProperty(options, 'libraryOptions', 'toJSONSchema')
  if (libraryOptions._tag === 'failure') return libraryOptions
  if (
    libraryOptions.value !== undefined &&
    (!isPlainObject(libraryOptions.value) || Array.isArray(libraryOptions.value))
  ) {
    return { _tag: 'failure', failure: definitionFailure('invalid-library-options') }
  }

  return {
    _tag: 'success',
    side: side.value === 'output' ? 'output' : 'input',
    options: {
      target: target.value,
      ...(libraryOptions.value === undefined ? {} : { libraryOptions: libraryOptions.value })
    }
  }
}

/** Convert a Standard JSON Schema source without running validation or class code. */
export const toJSONSchema = (
  source: JSONSchemaSource,
  options: ToJSONSchemaOptions
): JSONSchemaEffect => {
  const normalizedOptions = optionsFor(options)
  if (normalizedOptions._tag === 'failure') return failureResult(normalizedOptions.failure)

  const sourceResult = converterFrom(source)
  if (sourceResult._tag === 'failure') return failureResult(sourceResult.failure)

  const methodResult = readProperty(sourceResult.converter, normalizedOptions.side, 'toJSONSchema')
  if (methodResult._tag === 'failure') return failureResult(methodResult.failure)
  if (typeof methodResult.value !== 'function') {
    return failureResult(unsupportedFailure(`missing-${normalizedOptions.side}-converter`))
  }

  const converted = invokeSync<unknown>('toJSONSchema', () =>
    Reflect.apply(methodResult.value as Function, sourceResult.converter, [
      normalizedOptions.options
    ])
  )
  if (Result.isError(converted)) return converted as JSONSchemaEffect

  const normalized = normalizeValue(converted.value, new WeakSet())
  if (normalized._tag === 'failure') return failureResult(normalized.failure)
  if (normalized._tag === 'definition') return failureResult(definitionFailure(normalized.cause))

  const document = validateDocument(normalized.value)
  return document._tag === 'success'
    ? schemaSuccess<JsonSchemaDocument, JSONSchemaConversionFailure>(document.document)
    : failureResult(definitionFailure(document.cause))
}
