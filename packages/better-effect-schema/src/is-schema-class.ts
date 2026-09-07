import { findGenericDescriptor } from './internal/generic-descriptor.js'
export type AnyGenericSchemaClass = Function & {
  readonly identifier: string
  readonly kind: 'class' | 'tagged-class' | 'tagged-error'
  readonly make: (...args: never[]) => unknown
  readonly unsafeMake: (...args: never[]) => unknown
  readonly makeAsync: (...args: never[]) => Promise<unknown>
}
export type AnySchemaClass = AnyGenericSchemaClass

export const isGenericSchemaClass = (value: unknown): value is AnyGenericSchemaClass => {
  if (typeof value !== 'function') return false
  try {
    return findGenericDescriptor(value) !== undefined
  } catch {
    return false
  }
}

/** Returns whether a value is a class created by this package. */
export const isSchemaClass = isGenericSchemaClass
