import type { JsonValue } from '../protocol/types'

import type { CodecPath, CodecPathSegment } from './errors'

/** Maximum structural nesting accepted without recursive stack growth. */
export const jsonDepthLimit = 1_024

type JsonValidationFailure = {
  readonly ok: false
  readonly path: CodecPath
  readonly code: string
}

type JsonValidationSuccess = {
  readonly ok: true
  readonly value: JsonValue
}

export type JsonValidationResult = JsonValidationFailure | JsonValidationSuccess

type JsonEntry = {
  readonly key: string
  readonly segment: CodecPathSegment
  readonly value: unknown
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the object is populated only with validated JSON values.
type MutableJsonObject = Record<string, JsonValue>

type JsonFrame = {
  readonly source: object
  readonly path: CodecPath
  readonly entries: readonly JsonEntry[]
  readonly array: boolean
  readonly output: MutableJsonObject | JsonValue[]
  next: number
  pending: JsonEntry | undefined
}

const emptyPath = (): CodecPath => Object.freeze([])

const appendPath = (path: CodecPath, segment: CodecPathSegment): CodecPath =>
  Object.freeze([...path, segment])

const failure = (path: CodecPath, code: string): JsonValidationFailure => ({
  ok: false,
  path,
  code
})

const isArrayIndex = (key: string): number | undefined => {
  if (key.length === 0) {
    return undefined
  }

  const index = Number(key)

  if (!Number.isSafeInteger(index) || index < 0 || index >= 4_294_967_295) {
    return undefined
  }

  return String(index) === key ? index : undefined
}

type DataProperty = {
  readonly ok: true
  readonly value: unknown
}

type InvalidProperty = {
  readonly ok: false
  readonly code: string
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- caller has already established a non-null object.
const readDataProperty = (value: object, key: string): DataProperty | InvalidProperty => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (descriptor === undefined || !descriptor.enumerable) {
      return { ok: false, code: 'non-enumerable-property' }
    }

    if (!('value' in descriptor)) {
      return { ok: false, code: 'accessor-property' }
    }

    // Read only the captured descriptor value. Never read the property through the object.
    return { ok: true, value: descriptor.value }
  } catch {
    return { ok: false, code: 'unreadable-property' }
  }
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- caller has already established a non-null object.
const prepareFrame = (value: object, path: CodecPath): JsonFrame | JsonValidationFailure => {
  if (path.length > jsonDepthLimit) {
    return failure(path, 'depth-limit')
  }

  let isArray: boolean
  let prototype: object | null
  let keys: readonly PropertyKey[]

  try {
    isArray = Array.isArray(value)
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return failure(path, 'unreadable-object')
  }

  if (isArray) {
    if (prototype !== Array.prototype && prototype !== null) {
      return failure(path, 'unsupported-object')
    }

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
        return failure(path, 'invalid-array')
      }

      length = descriptor.value
    } catch {
      return failure(path, 'invalid-array')
    }

    const entries: JsonEntry[] = []
    const seen = new Set<number>()

    for (const key of keys) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON arrays cannot contain symbol properties.
      if (typeof key !== 'string') {
        return failure(path, 'unsupported-property')
      }

      if (key === 'length') {
        continue
      }

      const index = isArrayIndex(key)

      if (index === undefined || index >= length || seen.has(index)) {
        return failure(path, 'invalid-array')
      }

      const property = readDataProperty(value, key)

      if (!property.ok) {
        return failure(appendPath(path, index), property.code)
      }

      seen.add(index)
      entries.push({ key, segment: index, value: property.value })
    }

    if (seen.size !== length) {
      return failure(path, 'sparse-array')
    }

    return {
      source: value,
      path,
      entries,
      array: true,
      output: [],
      next: 0,
      pending: undefined
    }
  }

  if (prototype !== Object.prototype && prototype !== null) {
    return failure(path, 'unsupported-object')
  }

  const entries: JsonEntry[] = []
  const seen = new Set<string>()

  for (const key of keys) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON object keys are strings only.
    if (typeof key !== 'string') {
      return failure(path, 'unsupported-property')
    }

    if (seen.has(key)) {
      return failure(path, 'duplicate-property')
    }

    const property = readDataProperty(value, key)

    if (!property.ok) {
      return failure(appendPath(path, key), property.code)
    }

    seen.add(key)
    entries.push({ key, segment: key, value: property.value })
  }

  return {
    source: value,
    path,
    entries,
    array: false,
    output: {},
    next: 0,
    pending: undefined
  }
}

const primitiveFailure = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON validation is an unknown-value boundary.
  value: unknown,
  path: CodecPath
): JsonValidationFailure | undefined => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON numbers must be finite primitives.
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : failure(path, 'non-finite-number')
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- unsupported primitive and callable values are rejected.
  if (typeof value !== 'object' && value !== null) {
    return failure(path, 'unsupported-type')
  }

  return undefined
}

const isValidPrimitive = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON validation is an unknown-value boundary.
  value: unknown
): boolean => {
  if (value === null) {
    return true
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON primitives are narrowed by their runtime type.
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON numbers must be finite primitives.
  return typeof value === 'number' && Number.isFinite(value)
}

const assignOutput = (frame: JsonFrame, entry: JsonEntry, value: JsonValue): void => {
  if (frame.array) {
    if (!Array.isArray(frame.output)) {
      throw new TypeError('Invalid JSON array frame')
    }

    // The frame was built from a validated canonical array index.
    frame.output[Number(entry.key)] = value
    return
  }

  // defineProperty keeps __proto__ as data and cannot invoke a prototype setter.
  Object.defineProperty(frame.output, entry.key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

const freezeOutput = (frame: JsonFrame): JsonValue => Object.freeze(frame.output)

/** Validate JSON structure and return a detached, deeply frozen clone iteratively. */
export const validateJsonValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- codecs are intentionally a trust boundary.
  value: unknown
): JsonValidationResult => {
  const active = new Set<object>()
  const frames: JsonFrame[] = []
  let current: unknown = value
  let currentPath = emptyPath()

  try {
    for (;;) {
      if (currentPath.length > jsonDepthLimit) {
        return failure(currentPath, 'depth-limit')
      }

      let completed: JsonValue

      if (isValidPrimitive(current)) {
        // SAFETY: isValidPrimitive accepts exactly the JsonPrimitive members.
        completed = current as JsonValue
      } else {
        const primitiveError = primitiveFailure(current, currentPath)

        if (primitiveError !== undefined) {
          return primitiveError
        }

        // SAFETY: the primitive branches above leave only non-null objects here.
        const object = current as object

        if (active.has(object)) {
          return failure(currentPath, 'cycle')
        }

        const frame = prepareFrame(object, currentPath)

        if ('ok' in frame) {
          return frame
        }

        active.add(object)
        frames.push(frame)

        if (frame.entries.length === 0) {
          active.delete(object)
          frames.pop()
          completed = freezeOutput(frame)
        } else {
          const entry = frame.entries[0]

          if (entry === undefined) {
            return failure(currentPath, 'unreadable-value')
          }

          frame.next = 1
          frame.pending = entry
          current = entry.value
          currentPath = appendPath(frame.path, entry.segment)
          continue
        }
      }

      for (;;) {
        const parent = frames[frames.length - 1]

        if (parent === undefined) {
          return { ok: true, value: completed }
        }

        const pending = parent.pending

        if (pending === undefined) {
          return failure(parent.path, 'unreadable-value')
        }

        assignOutput(parent, pending, completed)
        parent.pending = undefined

        const entry = parent.entries[parent.next]

        if (entry !== undefined) {
          parent.next += 1
          parent.pending = entry
          current = entry.value
          currentPath = appendPath(parent.path, entry.segment)
          break
        }

        frames.pop()
        active.delete(parent.source)
        completed = freezeOutput(parent)
      }
    }
  } catch {
    return failure(currentPath, 'unreadable-value')
  }
}
