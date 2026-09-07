import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'

import { SchemaDefinitionFailure, SchemaExecutionFailure } from '../failure.js'
import type {
  GenericClassAnnotations,
  GenericClassDefinition,
  GenericSchemaClass
} from '../types/generic-class.js'
import { INSTANCE_MARKER } from './symbols.js'

export interface GenericClassDescriptor {
  readonly identifier: string
  readonly definition: GenericClassDefinition
  readonly schema: StandardSchemaV1
  readonly propsSchema: StandardSchemaV1
  readonly encodedSchema: StandardSchemaV1 | undefined
  readonly fields: Readonly<Record<string, StandardSchemaV1>> | undefined
  readonly struct: unknown
  readonly codec: unknown
  readonly annotations: GenericClassAnnotations | undefined
  readonly kind: GenericClassKind
  readonly baseClass: Function | undefined
  readonly prepareConstruction: ((value: unknown) => unknown) | undefined
  readonly preparationFailure: SchemaDefinitionFailure | SchemaExecutionFailure | undefined
  readonly instances: WeakSet<object>
}

export type GenericClassKind = 'class' | 'tagged-class' | 'tagged-error'

const descriptors = new WeakMap<Function, GenericClassDescriptor>()
const allInstances = new WeakSet<object>()
const instancesByIdentity = new Map<string, WeakSet<object>>()
export const GENERIC_CLASS_MARKER = Symbol.for('better-effect-schema/generic-class')

const objectLike = (value: unknown): value is object | Function =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const read = (value: object, key: PropertyKey): unknown => Reflect.get(value, key)

const failure = (identifier: unknown, operation: string, cause: unknown): SchemaDefinitionFailure =>
  new SchemaDefinitionFailure({ identifier, operation, cause })

const validStandard = (value: unknown): value is StandardSchemaV1 => {
  if (!objectLike(value)) return false

  const standard = read(value, '~standard')
  if (!objectLike(standard)) return false

  return (
    read(standard, 'version') === 1 &&
    typeof read(standard, 'vendor') === 'string' &&
    (read(standard, 'vendor') as string).trim().length > 0 &&
    typeof read(standard, 'validate') === 'function'
  )
}

const validFields = (value: unknown): value is Readonly<Record<string, StandardSchemaV1>> => {
  if (!objectLike(value) || Array.isArray(value)) return false
  for (const key of Object.keys(value)) {
    if (!validStandard(read(value, key))) return false
  }
  return true
}

export const prepareGenericDescriptor = (
  identifier: unknown,
  definition: unknown,
  annotations?: GenericClassAnnotations,
  options: {
    readonly kind?: GenericClassKind
    readonly baseClass?: Function
    readonly prepareConstruction?: (value: unknown) => unknown
    readonly definitionFailure?: SchemaDefinitionFailure | SchemaExecutionFailure
  } = {}
): GenericClassDescriptor => {
  const safeIdentifier = typeof identifier === 'string' ? identifier : ''
  const base: {
    identifier: string
    definition: GenericClassDefinition
    schema: StandardSchemaV1 | undefined
    propsSchema: StandardSchemaV1 | undefined
    encodedSchema: StandardSchemaV1 | undefined
    fields: Readonly<Record<string, StandardSchemaV1>> | undefined
    struct: unknown
    codec: unknown
    annotations: GenericClassAnnotations | undefined
    kind: GenericClassKind
    baseClass: Function | undefined
    prepareConstruction: ((value: unknown) => unknown) | undefined
    definitionFailure: SchemaDefinitionFailure | SchemaExecutionFailure | undefined
    preparationFailure: SchemaDefinitionFailure | SchemaExecutionFailure | undefined
    instances: WeakSet<object>
  } = {
    identifier: safeIdentifier,
    definition: definition as GenericClassDefinition,
    schema: undefined,
    propsSchema: undefined,
    encodedSchema: undefined,
    fields: undefined,
    struct: undefined,
    codec: undefined,
    annotations,
    kind: options.kind ?? 'class',
    baseClass: options.baseClass,
    prepareConstruction: options.prepareConstruction,
    definitionFailure: options.definitionFailure,
    preparationFailure: undefined,
    instances: new WeakSet<object>()
  }

  try {
    if (base.definitionFailure !== undefined) {
      base.preparationFailure = base.definitionFailure
    } else if (safeIdentifier.trim().length === 0) {
      base.preparationFailure = failure(identifier, 'definition', 'invalid-identifier')
    } else if (!objectLike(definition) || Array.isArray(definition)) {
      base.preparationFailure = failure(safeIdentifier, 'definition', 'invalid-definition')
    } else {
      const schema = read(definition, 'schema')
      const propsSchema = read(definition, 'propsSchema')
      const encodedSchema = read(definition, 'encodedSchema')
      const fields = read(definition, 'fields')
      const encode = read(definition, 'encode')

      if (!validStandard(schema)) {
        base.preparationFailure = failure(safeIdentifier, 'definition', 'invalid-schema-capability')
      } else if (!validStandard(propsSchema)) {
        base.preparationFailure = failure(safeIdentifier, 'definition', 'invalid-props-capability')
      } else if (encodedSchema !== undefined && !validStandard(encodedSchema)) {
        base.preparationFailure = failure(
          safeIdentifier,
          'definition',
          'invalid-encoded-capability'
        )
      } else if (fields !== undefined && !validFields(fields)) {
        base.preparationFailure = failure(safeIdentifier, 'definition', 'invalid-fields-capability')
      } else if (encode !== undefined && typeof encode !== 'function') {
        base.preparationFailure = failure(
          safeIdentifier,
          'definition',
          'invalid-encoding-capability'
        )
      } else {
        base.schema = schema
        base.propsSchema = propsSchema
        base.encodedSchema = encodedSchema
        base.fields = fields
        base.struct = read(definition, 'struct')
        base.codec = read(definition, 'codec')
      }
    }
  } catch (cause) {
    base.preparationFailure = new SchemaExecutionFailure({
      identifier: safeIdentifier,
      operation: 'definition',
      cause
    })
  }

  return Object.freeze({
    ...base,
    schema: base.schema as StandardSchemaV1,
    propsSchema: base.propsSchema as StandardSchemaV1
  })
}

export const registerGenericDescriptor = (
  constructor: Function,
  descriptor: GenericClassDescriptor
): void => {
  descriptors.set(constructor, descriptor)
}

export const findGenericDescriptor = (
  constructor: Function
): GenericClassDescriptor | undefined => {
  let current: object | null = constructor
  while (typeof current === 'function') {
    const descriptor = descriptors.get(current)
    if (descriptor !== undefined) return descriptor
    current = Object.getPrototypeOf(current) as object | null
  }
  return undefined
}

export const genericDescriptorOf = (value: unknown): GenericClassDescriptor | undefined =>
  typeof value === 'function' ? findGenericDescriptor(value) : undefined

export const checkGenericClass = (
  constructor: Function
): Result<GenericClassDefinition, SchemaDefinitionFailure | SchemaExecutionFailure> => {
  const descriptor = findGenericDescriptor(constructor)
  if (descriptor === undefined) {
    return Result.err(
      new SchemaDefinitionFailure({
        operation: 'check',
        cause: 'missing-descriptor'
      })
    )
  }
  if (descriptor.preparationFailure !== undefined) return Result.err(descriptor.preparationFailure)
  return Result.ok(descriptor.definition)
}

export const registerGenericInstance = (
  descriptor: GenericClassDescriptor,
  value: object
): void => {
  descriptor.instances.add(value)
  allInstances.add(value)
  const identity = `${descriptor.kind}:${descriptor.identifier}`
  const instances = instancesByIdentity.get(identity) ?? new WeakSet<object>()
  instances.add(value)
  instancesByIdentity.set(identity, instances)
}

export const isGenericInstance = (value: unknown): value is object =>
  objectLike(value) && allInstances.has(value)

export const isGenericClassValue = (value: unknown): boolean => {
  if (!objectLike(value)) return false
  try {
    let current: object | null = value
    while (current !== null) {
      if (Object.prototype.hasOwnProperty.call(current, GENERIC_CLASS_MARKER)) return true
      current = Object.getPrototypeOf(current) as object | null
    }
  } catch {
    return false
  }
  return false
}

export const hasGenericIdentity = (value: unknown, constructor: Function): boolean => {
  try {
    const descriptor = findGenericDescriptor(constructor)
    if (descriptor === undefined || !objectLike(value)) return false

    let current: object | null = value
    while (current !== null) {
      if (Object.prototype.hasOwnProperty.call(current, GENERIC_CLASS_MARKER)) {
        const marker = Reflect.get(current, INSTANCE_MARKER) as unknown
        if (
          objectLike(marker) &&
          Reflect.get(marker, 'identifier') === descriptor.identifier &&
          Reflect.get(marker, 'kind') === descriptor.kind
        ) {
          return (
            instancesByIdentity.get(`${descriptor.kind}:${descriptor.identifier}`)?.has(value) ===
            true
          )
        }
      }
      current = Object.getPrototypeOf(current) as object | null
    }
  } catch {
    return false
  }
  return false
}

export const asGenericSchemaClass = (
  value: Function
): GenericSchemaClass<unknown, GenericClassDefinition> =>
  value as unknown as GenericSchemaClass<unknown, GenericClassDefinition>
