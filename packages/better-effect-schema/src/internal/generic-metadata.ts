import type { GenericClassAnnotations } from '../types/generic-class.js'

const metadata = new WeakMap<Function, GenericClassAnnotations>()

export const defaultGenericMetadata = (
  identifier: string,
  annotations?: GenericClassAnnotations
): GenericClassAnnotations => ({
  title: identifier,
  ...(annotations ?? {})
})

export const getGenericMetadata = (constructor: Function): GenericClassAnnotations | undefined => {
  let current: object | null = constructor
  while (typeof current === 'function') {
    const value = metadata.get(current)
    if (value !== undefined) return value
    current = Object.getPrototypeOf(current) as object | null
  }
  return undefined
}

export const setGenericMetadata = (constructor: Function, value: GenericClassAnnotations): void => {
  metadata.set(constructor, Object.freeze({ ...value }))
}
