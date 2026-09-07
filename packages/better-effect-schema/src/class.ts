import { GenericClass } from './internal/generic-factory.js'
import type {
  GenericClassDefinition,
  GenericSchemaClass
} from './types/generic-class.js'

/** Declares a provider-neutral schema-backed class. */
export const Class = GenericClass

export type { GenericClassDefinition, GenericSchemaClass }
