import { Result, type Result as ResultType } from 'better-result'

import { JobDefinitionError } from '../protocol/errors'
import type { JsonValue } from '../protocol/types'

type JsonSnapshot = { readonly ok: true; readonly value: JsonValue } | { readonly ok: false }

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- fields are fixed by each caller's schema.
export type ParsedObjectFields = Readonly<Record<string, unknown>>
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- this map is populated only after the allowed-field check.
type MutableObjectFields = Record<string, unknown>

const invalidSnapshot = (): JsonSnapshot => ({ ok: false })

const validSnapshot = (value: JsonValue): JsonSnapshot => ({ ok: true, value })

const definitionError = <Value>(
  field: string,
  message: string
): ResultType<Value, JobDefinitionError> => Result.err(new JobDefinitionError({ field, message }))

const arrayIndex = (key: string): number | undefined => {
  if (key.length === 0) return undefined

  const index = Number(key)

  if (!Number.isInteger(index) || index < 0 || index >= 4_294_967_295 || String(index) !== key) {
    return undefined
  }

  return index
}

const readJsonProperty = (
  // oxlint-disable-next-line anti-slop/no-object-parameters -- value was checked as a persistence object before this internal read.
  value: object,
  key: string,
  ancestors: Set<object>
): JsonSnapshot => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (descriptor === undefined || !descriptor.enumerable) {
      return invalidSnapshot()
    }

    // oxlint-disable-next-line anti-slop/no-reflect-get -- accessors must be invoked inside this parser's catch boundary.
    const child = 'value' in descriptor ? descriptor.value : Reflect.get(value, key)

    return snapshotJsonValueInternal(child, ancestors)
  } catch {
    return invalidSnapshot()
  }
}

const snapshotArray = (
  // oxlint-disable-next-line anti-slop/no-object-parameters -- value was checked as a persistence object before this internal read.
  value: object,
  keys: readonly PropertyKey[],
  ancestors: Set<object>
): JsonSnapshot => {
  let length: number

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length')

    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 4_294_967_295
    ) {
      return invalidSnapshot()
    }

    length = descriptor.value
  } catch {
    return invalidSnapshot()
  }

  const children = new Map<number, JsonValue>()

  for (const key of keys) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- symbols are rejected before JSON array indexes are copied.
    if (typeof key !== 'string') {
      return invalidSnapshot()
    }

    if (key === 'length') {
      continue
    }

    const index = arrayIndex(key)

    if (index === undefined || index >= length || children.has(index)) {
      return invalidSnapshot()
    }

    const child = readJsonProperty(value, key, ancestors)

    if (!child.ok) {
      return invalidSnapshot()
    }

    children.set(index, child.value)
  }

  if (children.size !== length) {
    return invalidSnapshot()
  }

  const copy: JsonValue[] = []

  for (let index = 0; index < length; index += 1) {
    const child = children.get(index)

    if (child === undefined) {
      return invalidSnapshot()
    }

    copy.push(child)
  }

  return validSnapshot(Object.freeze(copy))
}

const snapshotObject = (
  // oxlint-disable-next-line anti-slop/no-object-parameters -- value was checked as a persistence object before this internal read.
  value: object,
  keys: readonly PropertyKey[],
  ancestors: Set<object>
): JsonSnapshot => {
  const copy: Record<string, JsonValue> = {}

  for (const key of keys) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- symbols are rejected before JSON object fields are copied.
    if (typeof key !== 'string') {
      return invalidSnapshot()
    }

    const child = readJsonProperty(value, key, ancestors)

    if (!child.ok) {
      return invalidSnapshot()
    }

    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: child.value,
      writable: true
    })
  }

  return validSnapshot(Object.freeze(copy))
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON validation is an untyped persistence boundary.
const snapshotJsonValueInternal = (value: unknown, ancestors: Set<object>): JsonSnapshot => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON values are limited to primitive JSON types and objects.
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return validSnapshot(value)
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON numbers must be finite primitives.
  if (typeof value === 'number') {
    return Number.isFinite(value) ? validSnapshot(value) : invalidSnapshot()
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- reject functions, symbols, bigint, and undefined.
  if (typeof value !== 'object' || value === null) {
    return invalidSnapshot()
  }

  let isArray: boolean
  let prototype: object | null
  let keys: readonly PropertyKey[]

  try {
    isArray = Array.isArray(value)
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return invalidSnapshot()
  }

  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    return invalidSnapshot()
  }

  if (ancestors.has(value)) {
    return invalidSnapshot()
  }

  ancestors.add(value)

  try {
    return isArray ? snapshotArray(value, keys, ancestors) : snapshotObject(value, keys, ancestors)
  } catch {
    return invalidSnapshot()
  } finally {
    ancestors.delete(value)
  }
}

/** Read and snapshot a plain DTO while rejecting every unknown own field. */
export const readObjectFields = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- DTOs arrive from an untyped persistence boundary.
  value: unknown,
  allowedFields: readonly string[],
  field: string
): ResultType<ParsedObjectFields, JobDefinitionError> => {
  try {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- persistence DTOs must be plain objects.
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return definitionError(field, 'must be a plain object')
    }

    const prototype = Object.getPrototypeOf(value)

    if (prototype !== Object.prototype && prototype !== null) {
      return definitionError(field, 'must be a plain object')
    }

    const allowed = new Set(allowedFields)
    const keys = Reflect.ownKeys(value)
    // SAFETY: this map is populated only from the fixed allowed field list.
    const fields: MutableObjectFields = Object.create(null) as MutableObjectFields

    for (const key of keys) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- symbols are rejected as unknown DTO fields.
      if (typeof key !== 'string' || !allowed.has(key)) {
        return definitionError(field, 'contains unsupported fields')
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key)

      if (descriptor === undefined) {
        return definitionError(field, 'could not read fields')
      }

      // oxlint-disable-next-line anti-slop/no-reflect-get -- accessors must be invoked inside this parser's catch boundary.
      const child = 'value' in descriptor ? descriptor.value : Reflect.get(value, key)

      Object.defineProperty(fields, key, {
        configurable: true,
        enumerable: true,
        value: child,
        writable: true
      })
    }

    return Result.ok(Object.freeze(fields))
  } catch {
    return definitionError(field, 'could not read fields')
  }
}

export const parseJsonValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON values arrive from an untyped persistence boundary.
  value: unknown,
  field = 'value'
): ResultType<JsonValue, JobDefinitionError> => {
  try {
    const snapshot = snapshotJsonValueInternal(value, new Set<object>())

    return snapshot.ok ? Result.ok(snapshot.value) : definitionError(field, 'must be JSON-safe')
  } catch {
    return definitionError(field, 'must be JSON-safe')
  }
}

export const isJsonValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON validation is an untyped persistence boundary.
  value: unknown
): value is JsonValue => {
  try {
    return snapshotJsonValueInternal(value, new Set<object>()).ok
  } catch {
    return false
  }
}

export const cloneJsonValue = (value: JsonValue): JsonValue => {
  const snapshot = snapshotJsonValueInternal(value, new Set<object>())

  if (!snapshot.ok) {
    throw new TypeError('Cannot clone an invalid JSON value')
  }

  return snapshot.value
}
