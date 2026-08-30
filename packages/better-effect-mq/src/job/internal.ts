// oxlint-disable anti-slop/no-runtime-typeof -- descriptor guards are hostile JavaScript boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- guards inspect arbitrary cross-package values.

export const queueTypeId = Symbol.for('better-effect-mq/QueueDefinition')
export const jobTypeId = Symbol.for('better-effect-mq/JobDefinition')

export type OwnDataProperty =
  | { readonly present: true; readonly value: unknown }
  | { readonly present: false }

type CallableObject = object | ((...arguments_: never[]) => void)

const isObjectLike = (value: unknown): value is CallableObject =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

export const readOwnDataProperty = (value: unknown, key: PropertyKey): OwnDataProperty => {
  if (!isObjectLike(value)) {
    return { present: false }
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (descriptor === undefined || !('value' in descriptor)) {
      return { present: false }
    }

    return { present: true, value: descriptor.value }
  } catch {
    return { present: false }
  }
}

export const isCallable = (value: unknown): value is (...arguments_: never[]) => void =>
  typeof value === 'function'

export const isFrozenSafely = (value: unknown): boolean => {
  if (!isObjectLike(value)) {
    return false
  }

  try {
    return Object.isFrozen(value)
  } catch {
    return false
  }
}

export const isPlainObject = (value: unknown): value is object => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  try {
    return (
      !Array.isArray(value) &&
      (() => {
        const prototype = Object.getPrototypeOf(value)
        return prototype === Object.prototype || prototype === null
      })()
    )
  } catch {
    return false
  }
}

export const markDescriptor = <Value extends object>(value: Value, typeId: symbol): Value => {
  Object.defineProperty(value, typeId, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  })

  return value
}
