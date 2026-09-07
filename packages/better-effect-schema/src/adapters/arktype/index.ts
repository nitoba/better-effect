import { Result, type Result as ResultType } from 'better-result'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import {
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../../failure.js'
import type {
  CapabilityResult,
  SchemaAdapter,
  SchemaCapabilityFailure,
  SchemaDescriptor,
  SchemaDerivationOperation,
  SchemaFieldMap,
  SchemaObjectPolicy
} from '../../capabilities/types.js'
import { invokeSync } from '../../internal/execution.js'
import { validateStandardSync, type StandardValidation } from '../../internal/standard.js'

const IDENTIFIER = 'ArkType'

type AnyArkType = StandardSchemaV1 & {
  readonly inferIn: unknown
  readonly inferOut: unknown
  readonly in: StandardSchemaV1
  readonly out: StandardSchemaV1
}
type CapabilityFailure = SchemaCapabilityFailure

export type ArkTypeInput<Schema extends AnyArkType> = Schema['inferIn']
export type ArkTypeOutput<Schema extends AnyArkType> = Schema['inferOut']
export type ArkTypeEncodedSchema<Schema extends AnyArkType> = Schema['in']
export type ArkTypePropsSchema<Schema extends AnyArkType> = Schema['out']

type NativeProp = {
  readonly kind: unknown
  readonly key: unknown
  readonly value: unknown
}

const isObjectLike = (value: unknown): value is object | Function =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const error = <Value = never>(failure: CapabilityFailure): ResultType<Value, CapabilityFailure> =>
  Result.err(failure) as ResultType<Value, CapabilityFailure>

const unsupported = <Value = never>(
  operation: string,
  cause?: unknown
): ResultType<Value, CapabilityFailure> =>
  error(new SchemaUnsupportedOperation({ identifier: IDENTIFIER, operation, cause }))

const definitionFailure = <Value = never>(
  operation: string,
  cause: unknown
): ResultType<Value, CapabilityFailure> =>
  error(new SchemaDefinitionFailure({ identifier: IDENTIFIER, operation, cause }))

const executionFailure = <Value = never>(
  operation: string,
  cause: unknown,
  issues?: unknown
): ResultType<Value, CapabilityFailure> =>
  error(
    new SchemaExecutionFailure({
      identifier: IDENTIFIER,
      operation,
      cause,
      ...(issues === undefined ? {} : { issues })
    })
  )

const isArkType = (value: unknown): value is AnyArkType => {
  if (!isObjectLike(value)) return false

  try {
    const standard = Reflect.get(value, '~standard')
    return (
      isObjectLike(standard) &&
      Reflect.get(standard, 'vendor') === 'arktype' &&
      Reflect.get(standard, 'version') === 1 &&
      typeof Reflect.get(standard, 'validate') === 'function'
    )
  } catch {
    return false
  }
}

const native = <Value = AnyArkType>(
  value: unknown,
  operation: string
): ResultType<Value, CapabilityFailure> =>
  isArkType(value) ? Result.ok(value as Value) : unsupported(operation, 'not-an-arktype-type')

const readMember = <Value>(
  value: unknown,
  member: PropertyKey,
  operation: string
): ResultType<Value, CapabilityFailure> => {
  if (!isObjectLike(value)) return definitionFailure(operation, 'not-an-object')

  try {
    return Result.ok(Reflect.get(value, member, value) as Value)
  } catch (cause) {
    return executionFailure(operation, cause)
  }
}

const isParseFailure = (cause: unknown): boolean => {
  if (!isObjectLike(cause)) return false

  try {
    const constructor = Reflect.get(cause, 'constructor')
    return isObjectLike(constructor) && Reflect.get(constructor, 'name') === 'ParseError'
  } catch {
    return false
  }
}

const invokeNative = <Value>(
  value: unknown,
  member: PropertyKey,
  args: readonly unknown[],
  operation: string
): ResultType<Value, CapabilityFailure> => {
  const method = readMember<unknown>(value, member, operation)
  if (Result.isError(method)) return method
  if (typeof method.value !== 'function') return unsupported(operation, 'missing-native-method')

  const result = invokeSync<unknown>(operation, () =>
    Reflect.apply(method.value as (...args: readonly unknown[]) => unknown, value, args)
  )
  if (Result.isError(result)) {
    if (result.error instanceof SchemaExecutionFailure && isParseFailure(result.error.cause)) {
      return definitionFailure(operation, result.error.cause)
    }
    return error<Value>(result.error)
  }

  return Result.ok(result.value as Value)
}

const nativeProps = (
  schema: AnyArkType,
  operation: string
): ResultType<readonly NativeProp[], CapabilityFailure> => {
  const result = readMember<unknown>(schema, 'props', operation)
  if (Result.isError(result)) {
    if (result.error instanceof SchemaExecutionFailure && isParseFailure(result.error.cause)) {
      return unsupported(operation, 'non-structural-type')
    }
    return result
  }
  if (!Array.isArray(result.value)) return unsupported(operation, 'non-structural-type')

  const json = readMember<unknown>(schema, 'json', operation)
  if (Result.isError(json)) return json
  if (Array.isArray(json.value) || isObjectLike(json.value)) {
    let sequence = Array.isArray(json.value)
    try {
      sequence = sequence || Reflect.has(json.value as object, 'sequence')
    } catch (cause) {
      return executionFailure(operation, cause)
    }
    if (sequence) return unsupported(operation, 'non-object-structure')
  }

  return Result.ok(result.value as readonly NativeProp[])
}

const structuralPolicy = (
  schema: AnyArkType,
  operation: string
): ResultType<SchemaObjectPolicy, CapabilityFailure> => {
  const props = nativeProps(schema, operation)
  if (Result.isError(props)) return props

  const keys: string[] = []
  for (const prop of props.value) {
    if (!isObjectLike(prop)) return definitionFailure(operation, 'invalid-property')
    let key: unknown
    try {
      key = Reflect.get(prop, 'key')
    } catch (cause) {
      return executionFailure(operation, cause)
    }
    if (typeof key !== 'string') return unsupported(operation, 'non-string-property-key')
    keys.push(key)
  }

  const baseline = invokeNative<AnyArkType>(schema, 'pick', keys, operation)
  if (Result.isError(baseline)) return baseline

  for (const [policy, behavior] of [
    ['loose', 'ignore'],
    ['strict', 'reject'],
    ['strip', 'delete']
  ] as const) {
    const candidate = invokeNative<AnyArkType>(
      baseline.value,
      'onUndeclaredKey',
      [behavior],
      operation
    )
    if (Result.isError(candidate)) continue

    const equal = invokeNative<boolean>(schema, 'equals', [candidate.value], operation)
    if (!Result.isError(equal) && equal.value) return Result.ok(policy)
  }

  return unsupported(operation, 'root-refinement-or-unsupported-structure')
}

const derivableObject = (
  schema: AnyArkType,
  operation: string
): ResultType<SchemaObjectPolicy, CapabilityFailure> => {
  return structuralPolicy(schema, operation)
}

const keysFromConfig = (
  config: unknown,
  operation: string
): ResultType<readonly string[], CapabilityFailure> => {
  if (typeof config === 'string') return Result.ok([config])

  if (Array.isArray(config)) {
    const keys: string[] = []
    for (const key of config) {
      if (typeof key !== 'string') return definitionFailure(operation, 'invalid-property-key')
      keys.push(key)
    }
    return Result.ok(keys)
  }

  if (!isObjectLike(config)) return definitionFailure(operation, 'missing-property-keys')

  let keys: string[]
  try {
    keys = []
    for (const key of Reflect.ownKeys(config)) {
      if (typeof key !== 'string') return definitionFailure(operation, 'invalid-property-key')
      if (Reflect.get(config, key, config) !== true) {
        return definitionFailure(operation, 'property-mask-values-must-be-true')
      }
      keys.push(key)
    }
  } catch (cause) {
    return executionFailure(operation, cause)
  }

  return Result.ok(keys)
}

const requireNative = (
  value: unknown,
  operation: string
): ResultType<AnyArkType, CapabilityFailure> => native(value, operation)

const read = <Schema extends StandardSchemaV1>(
  schema: Schema
): CapabilityResult<Schema, CapabilityFailure> => {
  const result = requireNative(schema, 'read')
  if (Result.isError(result)) return result

  const input = readMember<unknown>(result.value, 'in', 'read')
  if (Result.isError(input)) return input
  const output = readMember<unknown>(result.value, 'out', 'read')
  if (Result.isError(output)) return output
  if (!isObjectLike(input.value) || !isObjectLike(output.value)) {
    return definitionFailure('read', 'invalid-native-type')
  }

  return Result.ok(schema)
}

function encoded<Schema extends AnyArkType>(
  schema: Schema
): CapabilityResult<ArkTypeEncodedSchema<Schema>, CapabilityFailure>
function encoded<Input, Output>(
  schema: StandardSchemaV1<Input, Output>
): CapabilityResult<StandardSchemaV1<Input, Input>, CapabilityFailure>
function encoded(schema: StandardSchemaV1): CapabilityResult<StandardSchemaV1, CapabilityFailure> {
  const result = requireNative(schema, 'encoded')
  if (Result.isError(result)) return result

  const input = readMember<unknown>(result.value, 'in', 'encoded')
  if (Result.isError(input)) return input
  return native(input.value, 'encoded')
}

function bridge<Schema extends AnyArkType>(
  schema: Schema
): CapabilityResult<Schema, CapabilityFailure>
function bridge<Native, Input, Output>(
  nativeSchema: Native
): CapabilityResult<StandardSchemaV1<Input, Output>, CapabilityFailure>
function bridge(schema: unknown): CapabilityResult<StandardSchemaV1, CapabilityFailure> {
  const result = requireNative(schema, 'bridge')
  return Result.isError(result) ? result : Result.ok(schema as StandardSchemaV1)
}

const props = <Input, Output, Props, Self, ConstructionInput = Props>(
  descriptor: SchemaDescriptor<Input, Output, Props, Self, ConstructionInput>
): CapabilityResult<StandardSchemaV1<ConstructionInput, Props>, CapabilityFailure> => {
  const schema = readMember<unknown>(descriptor, 'schema', 'props')
  if (Result.isError(schema)) return schema
  const nativeSchema = requireNative(schema.value, 'props')
  if (Result.isError(nativeSchema)) return nativeSchema

  const propsSchema = readMember<unknown>(descriptor, 'propsSchema', 'props')
  if (Result.isError(propsSchema)) return propsSchema
  const standard = readMember<unknown>(propsSchema.value, '~standard', 'props')
  if (Result.isError(standard)) return standard

  let valid = false
  try {
    valid =
      isObjectLike(standard.value) &&
      Reflect.get(standard.value, 'version') === 1 &&
      typeof Reflect.get(standard.value, 'validate') === 'function'
  } catch (cause) {
    return executionFailure('props', cause)
  }
  if (!valid) {
    return definitionFailure('props', 'invalid-props-schema')
  }

  return Result.ok(propsSchema.value as StandardSchemaV1<ConstructionInput, Props>)
}

const make = <Input, Output, Props, Self, ConstructionInput = Props>(
  descriptor: SchemaDescriptor<Input, Output, Props, Self, ConstructionInput>,
  value: ConstructionInput
): CapabilityResult<Self, CapabilityFailure> => {
  const prepared = props(descriptor)
  if (Result.isError(prepared)) return prepared

  const validation = validateStandardSync<Props>(
    prepared.value,
    value,
    IDENTIFIER,
    'make',
    undefined
  )
  if (Result.isError(validation)) return validation

  const result: StandardValidation<Props> = validation.value
  switch (result._tag) {
    case 'definition':
      return Result.err(result.failure)
    case 'failure':
      return executionFailure('make', result.issues, result.issues)
    case 'success': {
      const constructed = invokeSync<Self>('make', () => descriptor.construct(result.value))
      return constructed
    }
  }
}

const fields = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>
): CapabilityResult<SchemaFieldMap, CapabilityFailure> => {
  const nativeSchema = requireNative(schema, 'fields')
  if (Result.isError(nativeSchema)) return nativeSchema

  const propsResult = nativeProps(nativeSchema.value, 'fields')
  if (Result.isError(propsResult)) return propsResult

  const fieldMap: Record<string, StandardSchemaV1> = {}
  for (const prop of propsResult.value) {
    if (!isObjectLike(prop)) return definitionFailure('fields', 'invalid-property')

    let key: unknown
    let value: unknown
    try {
      key = Reflect.get(prop, 'key')
      value = Reflect.get(prop, 'value')
    } catch (cause) {
      return executionFailure('fields', cause)
    }
    if (typeof key !== 'string') return unsupported('fields', 'non-string-property-key')
    if (!isArkType(value)) return unsupported('fields', 'non-arktype-property')

    try {
      Object.defineProperty(fieldMap, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true
      })
    } catch (cause) {
      return executionFailure('fields', cause)
    }
  }

  return Result.ok(Object.freeze(fieldMap))
}

const struct = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  fieldMap: SchemaFieldMap
): CapabilityResult<StandardSchemaV1, CapabilityFailure> => {
  const nativeSchema = requireNative(schema, 'struct')
  if (Result.isError(nativeSchema)) return nativeSchema

  const sourceProps = nativeProps(nativeSchema.value, 'struct')
  if (Result.isError(sourceProps)) return sourceProps
  const derivable = structuralPolicy(nativeSchema.value, 'struct')
  if (Result.isError(derivable)) return derivable

  if (!isObjectLike(fieldMap)) return definitionFailure('struct', 'invalid-field-map')
  const sourceKeys: string[] = []
  const sourceKinds = new Map<string, 'required' | 'optional'>()
  for (const prop of sourceProps.value) {
    if (!isObjectLike(prop)) return definitionFailure('struct', 'invalid-property')
    let key: unknown
    let kind: unknown
    try {
      key = Reflect.get(prop, 'key')
      kind = Reflect.get(prop, 'kind')
    } catch (cause) {
      return executionFailure('struct', cause)
    }
    if (typeof key !== 'string') return unsupported('struct', 'non-string-property-key')
    if (kind !== 'required' && kind !== 'optional') {
      return unsupported('struct', 'unknown-property-kind')
    }
    sourceKeys.push(key)
    sourceKinds.set(key, kind)
  }

  const fieldKeys: string[] = []
  try {
    for (const key of Reflect.ownKeys(fieldMap)) {
      if (typeof key !== 'string') return definitionFailure('struct', 'invalid-property-key')
      const value = Reflect.get(fieldMap, key, fieldMap)
      if (!isArkType(value)) return unsupported('struct', 'non-arktype-property')
      fieldKeys.push(key)
    }
  } catch (cause) {
    return executionFailure('struct', cause)
  }

  if (
    sourceKeys.length !== fieldKeys.length ||
    fieldKeys.some((key) => !sourceKeys.includes(key))
  ) {
    return unsupported('struct', 'field-map-must-keep-the-existing-object-keys')
  }

  const picked = invokeNative<AnyArkType>(nativeSchema.value, 'pick', sourceKeys, 'struct')
  if (Result.isError(picked)) return picked

  const extension: Record<string, unknown> = {}
  try {
    for (const key of sourceKeys) {
      const field = Reflect.get(fieldMap, key, fieldMap)
      const extensionKey = sourceKinds.get(key) === 'optional' ? `${key}?` : key
      Object.defineProperty(extension, extensionKey, {
        configurable: true,
        enumerable: true,
        value: field,
        writable: true
      })
    }
  } catch (cause) {
    return executionFailure('struct', cause)
  }

  return invokeNative<StandardSchemaV1>(picked.value, 'merge', [extension], 'struct')
}

const policy = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  selected: SchemaObjectPolicy
): CapabilityResult<StandardSchemaV1, CapabilityFailure> => {
  const nativeSchema = requireNative(schema, 'policy')
  if (Result.isError(nativeSchema)) return nativeSchema
  if (selected === 'catchall') return unsupported('policy', 'catchall-requires-a-schema')

  const propsResult = nativeProps(nativeSchema.value, 'policy')
  if (Result.isError(propsResult)) return propsResult

  const behavior = selected === 'strict' ? 'reject' : selected === 'strip' ? 'delete' : 'ignore'
  return invokeNative<StandardSchemaV1>(nativeSchema.value, 'onUndeclaredKey', [behavior], 'policy')
}

const derive = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  operation: SchemaDerivationOperation,
  config?: unknown
): CapabilityResult<StandardSchemaV1, CapabilityFailure> => {
  const nativeSchema = requireNative(schema, `derive.${operation}`)
  if (Result.isError(nativeSchema)) return nativeSchema
  const derivable = derivableObject(nativeSchema.value, `derive.${operation}`)
  if (Result.isError(derivable)) return derivable

  switch (operation) {
    case 'pick':
    case 'omit': {
      const keys = keysFromConfig(config, `derive.${operation}`)
      if (Result.isError(keys)) return keys
      return invokeNative<StandardSchemaV1>(
        nativeSchema.value,
        operation,
        keys.value,
        `derive.${operation}`
      )
    }
    case 'partial':
      return config === undefined
        ? invokeNative<StandardSchemaV1>(nativeSchema.value, 'partial', [], 'derive.partial')
        : unsupported('derive.partial', 'selective-partial-is-not-native')
    case 'required':
      return config === undefined
        ? invokeNative<StandardSchemaV1>(nativeSchema.value, 'required', [], 'derive.required')
        : unsupported('derive.required', 'required-does-not-accept-a-mask')
    case 'extend': {
      if (!isObjectLike(config)) return definitionFailure('derive.extend', 'missing-extension')
      return invokeNative<StandardSchemaV1>(nativeSchema.value, 'merge', [config], 'derive.extend')
    }
    case 'exactPartial':
      return unsupported('derive.exactPartial', 'arktype-has-no-exact-partial-operation')
    case 'deepPartial':
      return unsupported('derive.deepPartial', 'arktype-has-no-deep-partial-operation')
  }
}

const ArkTypeCapabilities = {
  bridge: { bridge },
  derivation: { derive },
  encoded: { encoded },
  props: { make, props },
  read: { read },
  structure: { fields, policy, struct }
} satisfies SchemaAdapter['capabilities']

/**
 * Optional ArkType integration for `Schema.with`.
 *
 * Tested against ArkType 2.2.3. ArkType's Standard Schema implementation is
 * the decode path; this adapter only adds native, no-throw capabilities. It
 * intentionally has no encoder because `.in`/`.out` are projections, not an
 * inverse for a morph.
 */
export const ArkTypeAdapter = Object.freeze({
  name: 'arktype',
  capabilities: ArkTypeCapabilities
}) satisfies SchemaAdapter
