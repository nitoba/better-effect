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

export const createGenericClass = <Self, Definition extends GenericClassDefinition>(
  identifier: string,
  definition: Definition,
  annotations?: GenericClassAnnotations
): GenericSchemaClass<Self, Definition> => {
  const descriptor = prepareGenericDescriptor(identifier, definition, annotations)
  const runtimeClass = createGenericRuntimeClass(descriptor)
  setGenericMetadata(runtimeClass, defaultGenericMetadata(descriptor.identifier, annotations))
  registerGenericDescriptor(runtimeClass, descriptor)
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
