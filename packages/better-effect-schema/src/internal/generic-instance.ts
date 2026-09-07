export const genericConstructionRecord = (value: unknown): Record<PropertyKey, unknown> => {
  if (value === undefined) return {}
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<PropertyKey, unknown>
  }
  throw new TypeError('Schema class construction expects an object of properties.')
}

export const assignGenericProps = (instance: object, props: Record<PropertyKey, unknown>): void => {
  for (const key of Reflect.ownKeys(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(props, key)
    if (descriptor?.enumerable !== true) continue

    Object.defineProperty(instance, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: descriptor.value
    })
  }
}
