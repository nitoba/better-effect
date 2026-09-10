import { TaggedError as BetterResultTaggedError, Result } from 'better-result'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import {
  SchemaAsyncRequired,
  SchemaDefinitionFailure,
  SchemaExecutionFailure
} from '../failure.js'
import type {
  ErrorTaglessFields,
  TaggedAnnotations,
  TaggedClassType,
  TaggedErrorType,
  TaggedFieldMap,
  TaglessFields
} from '../types/tagged.js'
import { createGenericClass } from './generic-factory.js'
import { validateStandardAsync, validateStandardSync, type StandardValidation } from './standard.js'

export const TAG_FIELD = '_tag' as const
export const ERROR_RESERVED_FIELDS = [
  '_tag',
  'name',
  'stack',
  'cause',
  'match',
  'toJSON'
] as const

type TaggedKind = 'tagged-class' | 'tagged-error'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const issue = (message: string): { readonly message: string }[] => [{ message }]

const messageOf = (value: unknown): string => (value instanceof Error ? value.message : String(value))

const issueResult = (value: unknown): { readonly issues: readonly { readonly message: string }[] } => ({
  issues: issue(messageOf(value))
})

const normalize = (
  value: unknown,
  identifier: string,
  operation: string
): StandardValidation<unknown> => {
  if (!isRecord(value) && typeof value !== 'function') {
    return {
      _tag: 'definition',
      failure: new SchemaDefinitionFailure({ identifier, operation, cause: 'invalid-result' })
    }
  }

  try {
    const issuesValue = Reflect.get(value, 'issues')
    if (issuesValue !== undefined) {
      return Array.isArray(issuesValue)
        ? { _tag: 'failure', issues: issuesValue }
        : {
            _tag: 'definition',
            failure: new SchemaDefinitionFailure({ identifier, operation, cause: 'invalid-issues' })
          }
    }
    if (!Reflect.has(value, 'value')) {
      return {
        _tag: 'definition',
        failure: new SchemaDefinitionFailure({ identifier, operation, cause: 'missing-value' })
      }
    }
    return { _tag: 'success', value: Reflect.get(value, 'value') }
  } catch (cause) {
    return { _tag: 'definition', failure: new SchemaDefinitionFailure({ identifier, operation, cause }) }
  }
}

const failureResult = (
  result: StandardValidation<unknown>
): { readonly issues: readonly { readonly message: string }[] } => {
  switch (result._tag) {
    case 'failure':
      return issueResult(result.issues)
    case 'definition':
      return issueResult(result.failure)
    case 'success':
      return issueResult('unexpected-validation-success')
  }
}

const validateAsyncFields = async (
  tag: string,
  fields: TaggedFieldMap,
  source: Record<string, unknown>,
  output: Record<string, unknown>,
  start = 0
): Promise<
  | { readonly value: Record<string, unknown> }
  | StandardSchemaV1.FailureResult
> => {
  const keys = Object.keys(fields)
  for (let index = start; index < keys.length; index += 1) {
    const key = keys[index]
    if (key === undefined) return issueResult('field-index-out-of-range')
    const field = fields[key]
    if (field === undefined) return issueResult(`missing-field:${key}`)
    const validation = await validateStandardAsync(field, Reflect.get(source, key), tag, 'tagged', undefined)
    if (Result.isError(validation)) return issueResult(validation.error)
    if (validation.value._tag !== 'success') return failureResult(validation.value)
    output[key] = validation.value.value
  }
  output[TAG_FIELD] = tag
  return { value: output }
}

const taggedSchema = (
  tag: string,
  fields: TaggedFieldMap,
  requireTag: boolean,
  validateFields = true
): StandardSchemaV1 => ({
  '~standard': {
    version: 1,
    vendor: 'better-effect-schema',
    validate(value: unknown) {
      if (!isRecord(value)) return { issues: issue('Tagged schema expects an object.') }
      if (requireTag && Reflect.get(value, TAG_FIELD) !== tag) {
        return { issues: issue(`Expected _tag to be ${tag}.`) }
      }

      const output: Record<string, unknown> = {}
      if (!validateFields) {
        for (const key of Object.keys(fields)) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) {
            return { issues: issue(`Missing field: ${key}.`) }
          }
          output[key] = Reflect.get(value, key)
        }
        output[TAG_FIELD] = tag
        return { value: output }
      }

      const keys = Object.keys(fields)
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        if (key === undefined) return { issues: issue('field-index-out-of-range') }
        const field = fields[key]
        if (field === undefined) return { issues: issue(`missing-field:${key}`) }
        const validation = validateStandardSync(
          field,
          Reflect.get(value, key),
          tag,
          'tagged',
          undefined
        )
        if (Result.isError(validation)) {
          if (validation.error instanceof SchemaAsyncRequired) {
            return Promise.resolve(validation.error.cause).then((pending) => {
              const normalized = normalize(pending, tag, 'tagged')
              if (normalized._tag !== 'success') return failureResult(normalized)
              output[key] = normalized.value
              return validateAsyncFields(tag, fields, value, output, index + 1)
            })
          }
          return issueResult(validation.error)
        }
        if (validation.value._tag !== 'success') return failureResult(validation.value)
        output[key] = validation.value.value
      }

      output[TAG_FIELD] = tag
      return { value: output }
    }
  }
})

const tagSchema = (tag: string): StandardSchemaV1<unknown, string> => ({
  '~standard': {
    version: 1,
    vendor: 'better-effect-schema',
    validate(value: unknown) {
      return value === tag ? { value: tag } : { issues: issue(`Expected _tag to be ${tag}.`) }
    }
  }
})

const prepareTaggedProps = (tag: string) => (value: unknown): unknown => {
  const source = value === undefined ? {} : value
  if (!isRecord(source)) throw new TypeError('Tagged schema construction expects an object.')
  if (Object.prototype.hasOwnProperty.call(source, TAG_FIELD) && source[TAG_FIELD] !== tag) {
    throw new TypeError(`Expected _tag to be ${tag}.`)
  }
  return { ...source, [TAG_FIELD]: tag }
}

const definitionError = (
  tag: unknown,
  cause: unknown
): SchemaDefinitionFailure =>
  new SchemaDefinitionFailure({
    identifier: typeof tag === 'string' ? tag : 'TaggedSchema',
    operation: 'definition',
    cause
  })

const validateDefinition = (
  tag: unknown,
  fields: unknown,
  kind: TaggedKind
): SchemaDefinitionFailure | undefined => {
  if (typeof tag !== 'string' || tag.trim().length === 0) {
    return definitionError(tag, 'invalid-identifier')
  }
  if (!isRecord(fields)) return definitionError(tag, 'fields-not-object')
  for (const key of Object.keys(fields)) {
    if (kind === 'tagged-class' && key === TAG_FIELD) {
      return definitionError(tag, 'reserved-field:_tag')
    }
    if (kind === 'tagged-error' && ERROR_RESERVED_FIELDS.includes(key as (typeof ERROR_RESERVED_FIELDS)[number])) {
      return definitionError(tag, `reserved-field:${key}`)
    }
    const field = fields[key]
    if (!isRecord(field) && typeof field !== 'function') return definitionError(tag, `invalid-field:${key}`)
    try {
      const standard = Reflect.get(field, '~standard')
      if (!isRecord(standard) || Reflect.get(standard, 'version') !== 1 || typeof Reflect.get(standard, 'validate') !== 'function') {
        return definitionError(tag, `invalid-field:${key}`)
      }
    } catch (cause) {
      return definitionError(tag, cause)
    }
  }
  return undefined
}

const createTagged = <Self>(
  tag: string,
  fields: TaggedFieldMap,
  annotations: TaggedAnnotations | undefined,
  kind: TaggedKind,
  encode?: (value: unknown) => unknown
) => {
  const definitionFailure = validateDefinition(tag, fields, kind)
  const safeFields = isRecord(fields) ? fields : {}
  const schema = taggedSchema(tag, safeFields, true)
  const propsSchema = taggedSchema(tag, safeFields, false, false)
  const fieldMap: Record<string, StandardSchemaV1> = { _tag: tagSchema(tag) }
  for (const key of Object.keys(safeFields)) {
    const field = safeFields[key]
    if (field !== undefined) fieldMap[key] = field
  }
  const baseClass = kind === 'tagged-error' ? BetterResultTaggedError(tag) : undefined
  return createGenericClass(
    tag,
    {
      schema,
      propsSchema,
      fields: Object.freeze(fieldMap),
      struct: schema,
      codec: schema,
      ...(encode === undefined ? {} : { encode })
    },
    annotations,
    {
      kind,
      prepareConstruction: prepareTaggedProps(tag),
      ...(baseClass === undefined ? {} : { baseClass }),
      ...(definitionFailure === undefined ? {} : { definitionFailure })
    }
  ) as unknown
}

const makeTaggedClass = () => (
  tag: string,
  fields: TaglessFields,
  annotations?: TaggedAnnotations,
  encode?: (value: unknown) => unknown
) => createTagged(tag, fields, annotations, 'tagged-class', encode)

const makeTaggedError = () => (
  tag: string,
  fields: ErrorTaglessFields,
  annotations?: TaggedAnnotations,
  encode?: (value: unknown) => unknown
) => createTagged(tag, fields, annotations, 'tagged-error', encode)

export const createTaggedClass = makeTaggedClass
export const createTaggedError = makeTaggedError
