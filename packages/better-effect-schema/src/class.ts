import type {
  GenericClassAnnotations,
  GenericClassBuilder,
  GenericClassDefinition,
  GenericClassFactory,
  GenericSchemaClass
} from './types/generic-class.js'
import { createGenericClass } from './internal/generic-factory.js'
import { LegacyClass } from './legacy-class.js'
import type {
  ClassAnnotations,
  ClassBuilder,
  ClassDefinition,
  ClassFactory as LegacyClassFactory,
  MissingClassSelfGeneric,
  RawShape
} from './types.js'

type CombinedClassBuilder<Self> = GenericClassBuilder<Self> & ClassBuilder<Self>

export interface CombinedClassFactory {
  <Self = never>(
    identifier: string,
    annotations?: ClassAnnotations
  ): [Self] extends [never] ? MissingClassSelfGeneric<'Class'> : CombinedClassBuilder<Self>
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

/** Declares a provider-neutral schema-backed class. */
const isGenericDefinition = (definition: unknown): boolean => {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition))
    return false
  try {
    return Reflect.has(definition, 'schema') && Reflect.has(definition, 'propsSchema')
  } catch {
    return false
  }
}

const makeClass = (identifier: string, annotations?: unknown) => {
  const generic = makeGenericClass(identifier, annotations as GenericClassAnnotations)
  const legacy = LegacyClass<unknown>(identifier, annotations as ClassAnnotations)
  return (definition: unknown): unknown =>
    isGenericDefinition(definition)
      ? generic(definition as GenericClassDefinition)
      : legacy(definition as never)
}

export const Class = makeClass as unknown as CombinedClassFactory

export type { GenericClassDefinition, GenericSchemaClass }
