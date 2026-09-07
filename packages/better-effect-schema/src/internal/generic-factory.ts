import type {
  GenericClassAnnotations,
  GenericClassBuilder,
  GenericClassDefinition,
  GenericClassFactory,
  GenericSchemaClass
} from '../types/generic-class.js'
import {
  checkGenericClass,
  prepareGenericDescriptor,
  registerGenericDescriptor
} from './generic-descriptor.js'
import { createGenericRuntimeClass } from './generic-runtime-class.js'
import { defaultGenericMetadata, setGenericMetadata } from './generic-metadata.js'
import { genericBridgeFor, installStandardSchema } from '../standard/class.js'

export interface GenericClassOptions {
  readonly kind?: import('./generic-descriptor.js').GenericClassKind
  readonly baseClass?: Function
  readonly prepareConstruction?: (value: unknown) => unknown
  readonly definitionFailure?: import('../failure.js').SchemaDefinitionFailure
}

export const createGenericClass = <Self, Definition extends GenericClassDefinition>(
  identifier: string,
  definition: Definition,
  annotations?: GenericClassAnnotations,
  options?: GenericClassOptions
): GenericSchemaClass<Self, Definition> => {
  const descriptor = prepareGenericDescriptor(identifier, definition, annotations, options)
  const runtimeClass = createGenericRuntimeClass(descriptor)
  setGenericMetadata(runtimeClass, defaultGenericMetadata(descriptor.identifier, annotations))
  registerGenericDescriptor(runtimeClass, descriptor)
  installStandardSchema(runtimeClass, genericBridgeFor)
  return runtimeClass as unknown as GenericSchemaClass<Self, Definition>
}

const makeGenericClass = <Self>(
  identifier: string,
  annotations?: GenericClassAnnotations
): GenericClassBuilder<Self> =>
  ((definition: GenericClassDefinition) =>
    createGenericClass<Self, GenericClassDefinition>(
      identifier,
      definition,
      annotations
    )) as GenericClassBuilder<Self>

export const GenericClass = makeGenericClass as GenericClassFactory
export { checkGenericClass }
