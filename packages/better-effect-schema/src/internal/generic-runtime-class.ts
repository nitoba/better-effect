import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'

import {
  SchemaAsyncRequired,
  SchemaConstructionFailure,
  SchemaDefinitionFailure,
  SchemaExecutionFailure
} from '../failure.js'
import type {
  GenericClassAnnotations,
  GenericClassDefinition,
  GenericClassFailure,
  GenericSchemaClass
} from '../types/generic-class.js'
import { validateStandardAsync, validateStandardSync, type StandardValidation } from './standard.js'
import {
  findGenericDescriptor,
  hasGenericIdentity,
  registerGenericDescriptor,
  registerGenericInstance,
  GENERIC_CLASS_MARKER,
  type GenericClassDescriptor
} from './generic-descriptor.js'
import {
  getPrevalidatedConstruction,
  withPrevalidatedConstruction
} from './construction-context.js'
import { assignGenericProps, genericConstructionRecord } from './generic-instance.js'
import { INSTANCE_MARKER } from './symbols.js'
import { getGenericMetadata, setGenericMetadata } from './generic-metadata.js'

type ConstructionFailure =
  | SchemaAsyncRequired
  | SchemaConstructionFailure
  | SchemaDefinitionFailure
  | SchemaExecutionFailure

type RuntimeClass = GenericSchemaClass<unknown, GenericClassDefinition>

const markerFor = (
  descriptor: GenericClassDescriptor
): Readonly<{ identifier: string; kind: 'class' }> =>
  Object.freeze({ identifier: descriptor.identifier, kind: descriptor.kind })

const descriptorFor = (
  constructor: Function,
  fallback: GenericClassDescriptor
): GenericClassDescriptor => findGenericDescriptor(constructor) ?? fallback

const constructionFailure = (
  descriptor: GenericClassDescriptor,
  cause: unknown,
  operation = 'construction'
): SchemaConstructionFailure =>
  new SchemaConstructionFailure({
    identifier: descriptor.identifier,
    operation,
    cause
  })

const resultOfValidation = <Output>(
  descriptor: GenericClassDescriptor,
  result: StandardValidation<Output>
): Result<Output, ConstructionFailure> => {
  switch (result._tag) {
    case 'success':
      return Result.ok(result.value)
    case 'definition':
      return Result.err(result.failure)
    case 'failure':
      return Result.err(
        new SchemaConstructionFailure({
          identifier: descriptor.identifier,
          operation: 'construction',
          issues: result.issues,
          cause: result.issues
        })
      )
  }
}

const construct = (
  constructor: RuntimeClass,
  descriptor: GenericClassDescriptor,
  props: Record<PropertyKey, unknown>
): Result<object, SchemaConstructionFailure | SchemaExecutionFailure> => {
  try {
    const instance = withPrevalidatedConstruction(
      constructor,
      props,
      () => Reflect.construct(constructor, [props]) as object
    )
    return Result.ok(instance)
  } catch (cause) {
    return Result.err(constructionFailure(descriptor, cause))
  }
}

const makeSync = (
  constructor: RuntimeClass,
  descriptor: GenericClassDescriptor,
  input: unknown
): Result<object, GenericClassFailure> => {
  if (descriptor.preparationFailure !== undefined) return Result.err(descriptor.preparationFailure)

  let candidate: Record<PropertyKey, unknown>
  try {
    candidate = genericConstructionRecord(input)
  } catch (cause) {
    return Result.err(constructionFailure(descriptor, cause))
  }

  const validated = validateStandardSync(
    descriptor.propsSchema,
    candidate,
    descriptor.identifier,
    'make',
    undefined
  )
  if (Result.isError(validated)) return validated as Result<object, GenericClassFailure>

  const props = resultOfValidation(descriptor, validated.value)
  if (Result.isError(props)) return props as Result<object, GenericClassFailure>

  try {
    return construct(constructor, descriptor, genericConstructionRecord(props.value)) as Result<
      object,
      GenericClassFailure
    >
  } catch (cause) {
    return Result.err(constructionFailure(descriptor, cause))
  }
}

const makeAsync = async (
  constructor: RuntimeClass,
  descriptor: GenericClassDescriptor,
  input: unknown
): Promise<Result<object, Exclude<GenericClassFailure, SchemaAsyncRequired>>> => {
  if (descriptor.preparationFailure !== undefined) return Result.err(descriptor.preparationFailure)

  let candidate: Record<PropertyKey, unknown>
  try {
    candidate = genericConstructionRecord(input)
  } catch (cause) {
    return Result.err(constructionFailure(descriptor, cause))
  }

  const validated = await validateStandardAsync(
    descriptor.propsSchema,
    candidate,
    descriptor.identifier,
    'makeAsync',
    undefined
  )
  if (Result.isError(validated)) {
    return Result.err(
      new SchemaExecutionFailure({
        identifier: descriptor.identifier,
        operation: 'makeAsync',
        cause: validated.error
      })
    )
  }

  const props = resultOfValidation(descriptor, validated.value)
  if (Result.isError(props)) {
    return props as Result<object, Exclude<GenericClassFailure, SchemaAsyncRequired>>
  }

  try {
    return construct(constructor, descriptor, genericConstructionRecord(props.value)) as Result<
      object,
      Exclude<GenericClassFailure, SchemaAsyncRequired>
    >
  } catch (cause) {
    return Result.err(constructionFailure(descriptor, cause))
  }
}

export const createGenericRuntimeClass = (descriptor: GenericClassDescriptor): RuntimeClass => {
  class GeneratedSchemaClass {
    constructor(props?: unknown) {
      const concrete = new.target as Function
      const inheritedDescriptor = descriptorFor(concrete, descriptor)
      const prepared = getPrevalidatedConstruction(concrete, props)
      const candidate = prepared ?? genericConstructionRecord(props)

      assignGenericProps(this, candidate)
      registerGenericInstance(inheritedDescriptor, this)
    }

    static get identifier(): string {
      return descriptorFor(this, descriptor).identifier
    }

    static get kind(): 'class' {
      return 'class'
    }

    static get schema(): StandardSchemaV1 {
      return descriptorFor(this, descriptor).schema
    }

    static get propsSchema(): StandardSchemaV1 {
      return descriptorFor(this, descriptor).propsSchema
    }

    static get encodedSchema(): StandardSchemaV1 | undefined {
      return descriptorFor(this, descriptor).encodedSchema
    }

    static get fields(): Readonly<Record<string, StandardSchemaV1>> | undefined {
      return descriptorFor(this, descriptor).fields
    }

    static get struct(): unknown {
      return descriptorFor(this, descriptor).struct
    }

    static get codec(): unknown {
      return descriptorFor(this, descriptor).codec
    }

    static make(input?: unknown): Result<object, GenericClassFailure> {
      const concrete = this as unknown as RuntimeClass
      const inheritedDescriptor = descriptorFor(concrete, descriptor)
      return makeSync(concrete, inheritedDescriptor, input)
    }

    static unsafeMake(props?: unknown): Result<object, GenericClassFailure> {
      const concrete = this as unknown as RuntimeClass
      const inheritedDescriptor = descriptorFor(concrete, descriptor)
      if (inheritedDescriptor.preparationFailure !== undefined) {
        return Result.err(inheritedDescriptor.preparationFailure)
      }

      try {
        const value = genericConstructionRecord(props)
        return construct(concrete, inheritedDescriptor, value) as Result<
          object,
          GenericClassFailure
        >
      } catch (cause) {
        return Result.err(constructionFailure(inheritedDescriptor, cause))
      }
    }

    static async makeAsync(
      input?: unknown
    ): Promise<Result<object, Exclude<GenericClassFailure, SchemaAsyncRequired>>> {
      const concrete = this as unknown as RuntimeClass
      const inheritedDescriptor = descriptorFor(concrete, descriptor)
      return makeAsync(concrete, inheritedDescriptor, input)
    }

    static [Symbol.hasInstance](value: unknown): boolean {
      return hasGenericIdentity(value, this)
    }

    static is(value: unknown): boolean {
      return hasGenericIdentity(value, this)
    }

    static meta(
      metadata?: GenericClassAnnotations
    ): GenericClassAnnotations | RuntimeClass | undefined {
      if (arguments.length === 0) return getGenericMetadata(this)
      setGenericMetadata(this, metadata ?? {})
      return this as unknown as RuntimeClass
    }

    static describe(description: string): RuntimeClass {
      const current = getGenericMetadata(this) ?? {}
      setGenericMetadata(this, { ...current, description })
      return this as unknown as RuntimeClass
    }

    static register<Metadata>(
      registry: { add(value: object, metadata?: Metadata): unknown },
      metadata?: Metadata
    ): RuntimeClass {
      registry.add(this, metadata)
      return this as unknown as RuntimeClass
    }
  }

  Object.defineProperty(GeneratedSchemaClass.prototype, INSTANCE_MARKER, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: markerFor(descriptor)
  })

  Object.defineProperty(GeneratedSchemaClass.prototype, GENERIC_CLASS_MARKER, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true
  })

  registerGenericDescriptor(GeneratedSchemaClass, descriptor)
  return GeneratedSchemaClass as unknown as RuntimeClass
}
