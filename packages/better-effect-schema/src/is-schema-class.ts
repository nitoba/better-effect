import type { CLASS_TYPE_ID } from './internal/symbols.js'
import type { ClassDefinition, ClassKind, ClassTypeMetadata, RawShape } from './types.js'
import { findDescriptor } from './internal/descriptor.js'
import { findGenericDescriptor } from './internal/generic-descriptor.js'
import type { GenericClassDefinition, GenericSchemaClass } from './types/generic-class.js'

/**
 * Existential view of a schema class. Concrete input, props and instance types
 * remain available when a specific class is passed to a generic operation.
 */
interface LegacySchemaClass {
  readonly [CLASS_TYPE_ID]: ClassTypeMetadata<
    unknown,
    ClassDefinition,
    unknown,
    unknown,
    unknown,
    PropertyKey,
    RawShape
  >
  readonly identifier: string
  readonly kind: ClassKind
}

export type AnyGenericSchemaClass = GenericSchemaClass<unknown, GenericClassDefinition>
export type AnySchemaClass = LegacySchemaClass | AnyGenericSchemaClass

export const isGenericSchemaClass = (value: unknown): value is AnyGenericSchemaClass => {
  if (typeof value !== 'function') return false
  try {
    return findGenericDescriptor(value) !== undefined
  } catch {
    return false
  }
}

/** Returns whether a value is a class created by this package. */
export const isSchemaClass = (value: unknown): value is AnySchemaClass => {
  if (typeof value !== 'function') return false
  try {
    return findDescriptor(value) !== undefined || findGenericDescriptor(value) !== undefined
  } catch {
    return false
  }
}
