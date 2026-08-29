const isPrimitiveValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON validation is an untyped persistence boundary.
  value: unknown,
  tag: string
): value is string | number | boolean | null => {
  if (value === null) {
    return true
  }

  if (tag === '[object String]' || tag === '[object Boolean]') {
    return value !== Object(value)
  }

  if (tag === '[object Number]') {
    // SAFETY: the primitive tag and identity check above exclude boxed values.
    return value !== Object(value) && Number.isFinite(value as number)
  }

  return false
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON validation is an untyped persistence boundary.
const isJsonValueInternal = (value: unknown, ancestors: Set<object>): boolean => {
  let tag: string

  try {
    tag = Object.prototype.toString.call(value)
  } catch {
    return false
  }

  if (isPrimitiveValue(value, tag)) {
    return true
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- reject functions and symbols at the JSON boundary.
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const isArray = Array.isArray(value)
  const prototype = isArray ? null : Object.getPrototypeOf(value)

  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    return false
  }

  if (ancestors.has(value)) {
    return false
  }

  ancestors.add(value)

  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return false
    }

    if (isArray) {
      const elements: readonly unknown[] = value

      for (const element of elements) {
        if (!isJsonValueInternal(element, ancestors)) {
          return false
        }
      }

      return true
    }

    const entries: ReadonlyArray<readonly [string, unknown]> = Object.entries(value)

    for (const [, child] of entries) {
      if (!isJsonValueInternal(child, ancestors)) {
        return false
      }
    }

    return true
  } catch {
    return false
  } finally {
    ancestors.delete(value)
  }
}

export const isJsonValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON validation is an untyped persistence boundary.
  value: unknown
): value is import('../protocol/types.ts').JsonValue =>
  isJsonValueInternal(value, new Set<object>())

export const cloneJsonValue = (
  value: import('../protocol/types.ts').JsonValue
): import('../protocol/types.ts').JsonValue => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneJsonValue))
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- cloneJsonValue only receives an already validated JsonValue.
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, import('../protocol/types.ts').JsonValue> = {}

    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonValue(child),
        writable: true
      })
    }

    return Object.freeze(copy)
  }

  return value
}
