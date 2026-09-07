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
): Readonly<{ identifier: string; kind: GenericClassDescriptor['kind'] }> =>
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
    candidate = genericConstructionRecord(descriptor.prepareConstruction?.(input) ?? input)
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
    candidate = genericConstructionRecord(descriptor.prepareConstruction?.(input) ?? input)
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

type StandardResult =
  | { readonly value: unknown }
  | { readonly issues: readonly { readonly message: string }[] }

const standardFailure = (cause: unknown): StandardResult => ({
  issues: [{ message: cause instanceof Error ? cause.message : String(cause) }]
})

const normalizeStandardResult = (
  value: unknown,
  identifier: string,
  operation: string
): StandardValidation<unknown> => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return {
      _tag: 'definition',
      failure: new SchemaDefinitionFailure({ identifier, operation, cause: 'invalid-result' })
    }
  }

  try {
    const issues = Reflect.get(value, 'issues')
    if (issues !== undefined) {
      return Array.isArray(issues)
        ? { _tag: 'failure', issues }
        : {
            _tag: 'definition',
            failure: new SchemaDefinitionFailure({ identifier, operation, cause: 'invalid-issues' })
          }
    }

    if (!Reflect.has(value, 'value')) {
      return {
        _tag: 'definition',
        failure: new SchemaDefinitionFailure({ identifier, operation, cause: 'missing-value' })
      }
    }

    return { _tag: 'success', value: Reflect.get(value, 'value') }
  } catch (cause) {
    return {
      _tag: 'definition',
      failure: new SchemaDefinitionFailure({ identifier, operation, cause })
    }
  }
}

const standardizeConstruction = (
  constructor: RuntimeClass,
  descriptor: GenericClassDescriptor,
  validation: StandardValidation<unknown>
): StandardResult | Promise<StandardResult> => {
  switch (validation._tag) {
    case 'definition':
      return standardFailure(validation.failure)
    case 'failure':
      return standardFailure(validation.issues)
    case 'success': {
      const result = makeSync(constructor, descriptor, validation.value)
      return Result.isError(result) ? standardFailure(result.error) : { value: result.value }
    }
  }
}

const standardizeAsyncConstruction = async (
  constructor: RuntimeClass,
  descriptor: GenericClassDescriptor,
  validation: StandardValidation<unknown>
): Promise<StandardResult> => {
  switch (validation._tag) {
    case 'definition':
      return standardFailure(validation.failure)
    case 'failure':
      return standardFailure(validation.issues)
    case 'success': {
      const result = await makeAsync(constructor, descriptor, validation.value)
      return Result.isError(result) ? standardFailure(result.error) : { value: result.value }
    }
  }
}

const standardizePending = async (
  constructor: RuntimeClass,
  descriptor: GenericClassDescriptor,
  pending: unknown
): Promise<StandardResult> => {
  try {
    const validation = normalizeStandardResult(pending, descriptor.identifier, 'decode')
    return standardizeAsyncConstruction(constructor, descriptor, validation)
  } catch (cause) {
    return standardFailure(cause)
  }
}

export const createGenericRuntimeClass = (descriptor: GenericClassDescriptor): RuntimeClass => {
  const BaseClass =
    descriptor.baseClass ??
    (class EmptySchemaClass {
      constructor(_props?: unknown) {}
    })

  class GeneratedSchemaClass extends (BaseClass as abstract new (props?: unknown) => object) {
    constructor(props?: unknown) {
      const concrete = new.target as Function
      const prepared = getPrevalidatedConstruction(concrete, props)
      const candidate =
        prepared ??
        genericConstructionRecord(descriptorFor(concrete, descriptor).prepareConstruction?.(props) ?? props)

      super(candidate)
      assignGenericProps(this, candidate)
      let current: object | null = concrete
      const seenConstructors = new Set<Function>()
      while (typeof current === 'function' && !seenConstructors.has(current)) {
        seenConstructors.add(current)
        const currentDescriptor = findGenericDescriptor(current)
        if (currentDescriptor !== undefined) registerGenericInstance(currentDescriptor, this)
        current = Object.getPrototypeOf(current) as object | null
      }
    }

    static get identifier(): string {
      return descriptorFor(this, descriptor).identifier
    }

    static get kind(): GenericClassDescriptor['kind'] {
      return descriptorFor(this, descriptor).kind
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

    static get ['~standard'](): StandardSchemaV1['~standard'] {
      const current = descriptorFor(this, descriptor)
      const constructor = this as unknown as RuntimeClass

      return {
        version: 1,
        vendor: 'better-effect-schema',
        validate(input: unknown, options?: StandardSchemaV1.Options) {
          const decoded = validateStandardSync(
            current.schema,
            input,
            current.identifier,
            'decode',
            options
          )

          if (Result.isError(decoded)) {
            if (decoded.error instanceof SchemaAsyncRequired) {
              return Promise.resolve(decoded.error.cause).then((pending) =>
                standardizePending(constructor, current, pending)
              )
            }
            return standardFailure(decoded.error)
          }

          const result = standardizeConstruction(constructor, current, decoded.value)
          return result
        }
      }
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
        const value = genericConstructionRecord(
          inheritedDescriptor.prepareConstruction?.(props) ?? props
        )
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

    static override [Symbol.hasInstance](value: unknown): boolean {
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
