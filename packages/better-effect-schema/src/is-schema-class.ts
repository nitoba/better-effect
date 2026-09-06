import type {
  CLASS_TYPE_ID
} from "./internal/symbols.js"
import type {
  ClassDefinition,
  ClassKind,
  ClassTypeMetadata,
  RawShape
} from "./types.js"
import { findDescriptor } from "./internal/descriptor.js"

/**
 * Existential view of a schema class. Concrete input, props and instance types
 * remain available when a specific class is passed to a generic operation.
 */
export interface AnySchemaClass {
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

/** Returns whether a value is a class created by this package. */
export const isSchemaClass = (value: unknown): value is AnySchemaClass =>
  typeof value === "function" && findDescriptor(value) !== undefined
