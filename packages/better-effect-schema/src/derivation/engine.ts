import { Result, type Result as ResultType } from 'better-result'

import {
  SchemaAsyncRequired,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../failure.js'
import type {
  DerivationCapabilities,
  DerivationContext,
  DerivationEngine,
  DerivationFailure,
  DerivationFieldMap,
  DerivationMask,
  DerivationMemo,
  DerivationOptions,
  SchemaDerivationConfig
} from './types.js'
import type { SchemaDerivationOperation } from '../capabilities/types.js'

type ObjectLike = object | Function
type FailureResult<Value> = ResultType<Value, DerivationFailure>

interface CapabilityMethod {
  readonly owner: ObjectLike
  readonly method: Function
}

interface ReadCapability {
  readonly value?: CapabilityMethod
  readonly cause?: unknown
}

const isObjectLike = (value: unknown): value is ObjectLike =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const isThenable = (
  value: unknown
): { readonly thenable: boolean; readonly failed: boolean; readonly cause?: unknown } => {
  if (!isObjectLike(value)) return { thenable: false, failed: false }

  try {
    return {
      thenable: typeof Reflect.get(value, 'then') === 'function',
      failed: false
    }
  } catch (cause) {
    return { thenable: false, failed: true, cause }
  }
}

const observeRejection = (value: unknown): void => {
  try {
    void Promise.resolve(value).catch(() => undefined)
  } catch {
    // The sync boundary already has a typed failure. Observing is best effort.
  }
}

const unsupported = <Value = never>(operation: string): FailureResult<Value> =>
  Result.err(new SchemaUnsupportedOperation({ operation }))

const definitionFailure = <Value = never>(
  operation: string,
  cause?: unknown
): FailureResult<Value> => Result.err(new SchemaDefinitionFailure({ operation, cause }))

const executionFailure = <Value = never>(
  operation: string,
  cause?: unknown
): FailureResult<Value> => Result.err(new SchemaExecutionFailure({ operation, cause }))

const asyncRequired = <Value = never>(operation: string, cause: unknown): FailureResult<Value> =>
  Result.err(new SchemaAsyncRequired({ operation, cause }))

const isKnownFailure = (value: unknown): value is DerivationFailure =>
  (() => {
    try {
      return (
        value instanceof SchemaDefinitionFailure ||
        value instanceof SchemaExecutionFailure ||
        value instanceof SchemaUnsupportedOperation ||
        value instanceof SchemaAsyncRequired
      )
    } catch {
      return false
    }
  })()

const normalizeCapabilityResult = <Value>(
  operation: string,
  value: unknown
): FailureResult<Value> => {
  try {
    if (isObjectLike(value)) {
      const result = value as ResultType<unknown, unknown>
      if (Result.isOk(result)) return Result.ok(result.value as Value)
      if (Result.isError(result)) {
        return isKnownFailure(result.error)
          ? Result.err(result.error)
          : executionFailure(operation, result.error)
      }
    }
  } catch (cause) {
    return executionFailure(operation, cause)
  }

  return definitionFailure(
    operation,
    new TypeError('A derivation capability must return a Result.')
  )
}

const callSync = <Value>(
  operation: string,
  capability: CapabilityMethod,
  args: readonly unknown[]
): FailureResult<Value> => {
  let value: unknown

  try {
    value = Reflect.apply(capability.method, capability.owner, args)
  } catch (cause) {
    return executionFailure(operation, cause)
  }

  const inspected = isThenable(value)
  if (inspected.failed) return executionFailure(operation, inspected.cause)
  if (inspected.thenable) {
    observeRejection(value)
    return asyncRequired(operation, value)
  }

  return normalizeCapabilityResult(operation, value)
}

const readCapability = (
  capabilities: object,
  group: 'structure' | 'derivation',
  method: string
): ReadCapability => {
  let grouped: unknown
  try {
    grouped = Reflect.get(capabilities, group)
  } catch (cause) {
    return { cause }
  }

  if (!isObjectLike(grouped)) return {}

  let candidate: unknown
  try {
    candidate = Reflect.get(grouped, method)
  } catch (cause) {
    return { cause }
  }

  return typeof candidate === 'function' ? { value: { owner: grouped, method: candidate } } : {}
}

const createMemo = <Schema>(): DerivationMemo<Schema> => {
  const values = new Map<Schema, Schema>()
  return Object.freeze({
    has: (schema: Schema): boolean => values.has(schema),
    get: (schema: Schema): Schema | undefined => values.get(schema),
    set: (schema: Schema, derived: Schema): void => {
      values.set(schema, derived)
    }
  })
}

const isRecordLike = (value: unknown): value is object =>
  isObjectLike(value) && !Array.isArray(value)

const ownKeys = (
  value: object,
  operation: string
): ResultType<readonly PropertyKey[], DerivationFailure> => {
  try {
    return Result.ok(Reflect.ownKeys(value))
  } catch (cause) {
    return executionFailure(operation, cause)
  }
}

const own = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const snapshotRecord = <Value>(
  value: unknown,
  operation: string
): FailureResult<DerivationFieldMap<Value>> => {
  if (!isRecordLike(value)) return definitionFailure(operation)

  const keys = ownKeys(value, operation)
  if (Result.isError(keys)) return keys

  const copy = Object.create(null) as Record<PropertyKey, Value>
  try {
    for (const key of keys.value) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) {
        return definitionFailure(operation)
      }
      Object.defineProperty(copy, key, descriptor)
    }
    return Result.ok(Object.freeze(copy))
  } catch (cause) {
    return executionFailure(operation, cause)
  }
}

const snapshotMask = (
  value: unknown,
  fields: DerivationFieldMap<unknown>,
  protectedKeys: readonly PropertyKey[],
  operation: string,
  allowProtected: boolean
): FailureResult<{
  readonly mask: DerivationMask
  readonly keys: readonly PropertyKey[]
}> => {
  if (!isRecordLike(value)) return definitionFailure(operation)

  const keys = ownKeys(value, operation)
  if (Result.isError(keys)) return keys

  const fieldRecord = fields as object
  const copy = Object.create(null) as Record<PropertyKey, true>
  try {
    for (const key of keys.value) {
      if (Reflect.get(value, key) !== true) {
        return definitionFailure(operation)
      }
      if (!own(fieldRecord, key)) return definitionFailure(operation)
      if (!allowProtected && protectedKeys.some((protectedKey) => Object.is(protectedKey, key))) {
        return definitionFailure(operation)
      }
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: true,
        writable: false
      })
    }
  } catch (cause) {
    return executionFailure(operation, cause)
  }

  return Result.ok({
    mask: Object.freeze(copy),
    keys: Object.freeze([...keys.value])
  })
}

const snapshotProtectedKeys = <Schema>(
  options: DerivationOptions<Schema> | undefined,
  operation: string
): FailureResult<readonly PropertyKey[]> => {
  const candidate = options?.protectedKeys
  if (candidate === undefined) return Result.ok(Object.freeze([]))
  if (!Array.isArray(candidate)) return definitionFailure(operation)

  const result: PropertyKey[] = []
  try {
    for (const key of candidate) {
      if (typeof key !== 'string' && typeof key !== 'symbol' && typeof key !== 'number') {
        return definitionFailure(operation)
      }
      const normalized = typeof key === 'number' ? String(key) : key
      if (result.some((existing) => Object.is(existing, normalized))) {
        return definitionFailure(operation)
      }
      result.push(normalized)
    }
  } catch (cause) {
    return executionFailure(operation, cause)
  }

  return Result.ok(Object.freeze(result))
}

const validateIdentifier = <Schema>(
  options: DerivationOptions<Schema> | undefined,
  operation: string
): FailureResult<string | undefined> => {
  const identifier = options?.identifier
  if (identifier === undefined) return Result.ok(undefined)
  if (typeof identifier !== 'string' || identifier.trim().length === 0) {
    return definitionFailure(operation, new TypeError('Schema identifiers must not be empty.'))
  }
  return Result.ok(identifier)
}

const memoFor = <Schema>(
  options: DerivationOptions<Schema> | undefined,
  operation: string
): FailureResult<DerivationMemo<Schema>> => {
  const memo = options?.memo
  if (memo === undefined) return Result.ok(createMemo())
  if (!isObjectLike(memo)) return definitionFailure(operation)

  try {
    if (
      typeof Reflect.get(memo, 'has') !== 'function' ||
      typeof Reflect.get(memo, 'get') !== 'function' ||
      typeof Reflect.get(memo, 'set') !== 'function'
    ) {
      return definitionFailure(operation)
    }
  } catch (cause) {
    return executionFailure(operation, cause)
  }

  return Result.ok(memo)
}

const readFields = <Schema, Field>(
  capabilities: DerivationCapabilities<Schema, Field>,
  schema: Schema,
  operation: string
): FailureResult<DerivationFieldMap<Field>> => {
  if (!isObjectLike(capabilities)) return unsupported(operation)
  const selected = readCapability(capabilities, 'structure', 'fields')
  if (selected.cause !== undefined) return executionFailure(operation, selected.cause)
  if (selected.value === undefined) return unsupported(operation)
  return callSync<DerivationFieldMap<Field>>(operation, selected.value, [schema])
}

const normalizeFields = <Schema, Field>(
  capabilities: DerivationCapabilities<Schema, Field>,
  schema: Schema,
  operation: string
): FailureResult<DerivationFieldMap<Field>> => {
  const result = readFields(capabilities, schema, operation)
  if (Result.isError(result)) return result
  return snapshotRecord<Field>(result.value, operation)
}

const normalizeOptions = <Schema>(
  options: DerivationOptions<Schema> | undefined,
  operation: string
): FailureResult<{
  readonly identifier: string | undefined
  readonly protectedKeys: readonly PropertyKey[]
  readonly memo: DerivationMemo<Schema>
}> => {
  try {
    const identifier = validateIdentifier(options, operation)
    if (Result.isError(identifier)) return identifier

    const protectedKeys = snapshotProtectedKeys(options, operation)
    if (Result.isError(protectedKeys)) return protectedKeys

    const memo = memoFor(options, operation)
    if (Result.isError(memo)) return memo

    return Result.ok({
      identifier: identifier.value,
      protectedKeys: protectedKeys.value,
      memo: memo.value
    })
  } catch (cause) {
    return executionFailure(operation, cause)
  }
}

const copyKeys = (keys: readonly PropertyKey[]): readonly PropertyKey[] => Object.freeze([...keys])

const appendUniqueKeys = (
  first: readonly PropertyKey[],
  second: readonly PropertyKey[]
): readonly PropertyKey[] => {
  const result = [...first]
  for (const key of second) {
    if (!result.some((existing) => Object.is(existing, key))) result.push(key)
  }
  return result
}

const createEngine = <Schema, Field>(
  capabilities: DerivationCapabilities<Schema, Field>
): DerivationEngine<Schema, Field> => {
  const dispatch = (
    schema: Schema,
    operation: SchemaDerivationOperation,
    config: SchemaDerivationConfig<Schema, Field>,
    active: Set<Schema>
  ): FailureResult<Schema> => {
    if (operation === 'deepPartial') {
      try {
        if (config.memo.has(schema)) {
          const cached = config.memo.get(schema)
          return Result.ok(cached as Schema)
        }
        if (active.has(schema)) return unsupported(operation)
        active.add(schema)
      } catch (cause) {
        return executionFailure(operation, cause)
      }
    }

    const selected = readCapability(capabilities, 'derivation', 'derive')
    let result: FailureResult<Schema>
    if (selected.cause !== undefined) {
      result = executionFailure(operation, selected.cause)
    } else if (selected.value === undefined) {
      result = unsupported(operation)
    } else {
      result = callSync<Schema>(operation, selected.value, [schema, operation, config])
    }

    if (operation === 'deepPartial') {
      active.delete(schema)
      if (Result.isOk(result)) {
        try {
          config.memo.set(schema, result.value)
        } catch (cause) {
          return executionFailure(operation, cause)
        }
      }
    }
    return result
  }

  const derive = (
    schema: Schema,
    operation: SchemaDerivationOperation,
    options: DerivationOptions<Schema> | undefined,
    configure: (
      normalized: {
        readonly identifier: string | undefined
        readonly protectedKeys: readonly PropertyKey[]
        readonly memo: DerivationMemo<Schema>
      },
      active: Set<Schema>
    ) => FailureResult<SchemaDerivationConfig<Schema, Field>>
  ): FailureResult<Schema> => {
    const normalized = normalizeOptions(options, operation)
    if (Result.isError(normalized)) return normalized
    const active = new Set<Schema>()
    const config = configure(normalized.value, active)
    if (Result.isError(config)) return config
    return dispatch(schema, operation, config.value, active)
  }

  const structural = (
    schema: Schema,
    operation: 'pick' | 'omit' | 'partial' | 'exactPartial' | 'required',
    mask: DerivationMask | undefined,
    options: DerivationOptions<Schema> | undefined
  ): FailureResult<Schema> =>
    derive(schema, operation, options, (normalized, active) => {
      if (mask !== undefined) {
        const fields = normalizeFields(capabilities, schema, operation)
        if (Result.isError(fields)) return fields
        const selectedMask = snapshotMask(
          mask,
          fields.value as DerivationFieldMap<unknown>,
          normalized.protectedKeys,
          operation,
          operation === 'pick'
        )
        if (Result.isError(selectedMask)) return selectedMask

        const selectedKeys = [...selectedMask.value.keys]
        const keys =
          operation === 'pick'
            ? appendUniqueKeys(
                selectedKeys,
                normalized.protectedKeys.filter((key) => own(fields.value as object, key))
              )
            : selectedKeys

        return Result.ok(
          Object.freeze({
            identifier: normalized.identifier,
            mask: selectedMask.value.mask,
            keys: copyKeys(keys),
            protectedKeys: normalized.protectedKeys,
            fields: fields.value,
            ...(operation === 'partial' || operation === 'exactPartial'
              ? {
                  partialMode:
                    operation === 'exactPartial'
                      ? ('exactOptional' as const)
                      : ('optional' as const)
                }
              : {}),
            memo: normalized.memo,
            context: contextFor(normalized.memo, normalized.protectedKeys, active, dispatch)
          })
        )
      }

      const fields = readFieldsIfNeeded(capabilities, schema, normalized.protectedKeys, operation)
      if (Result.isError(fields)) return fields
      const keys =
        fields.value === undefined
          ? []
          : [...keysFromFieldsValue(fields.value, normalized.protectedKeys)]

      return Result.ok(
        Object.freeze({
          identifier: normalized.identifier,
          keys: copyKeys(keys),
          protectedKeys: normalized.protectedKeys,
          ...(fields.value === undefined ? {} : { fields: fields.value }),
          ...(operation === 'partial' || operation === 'exactPartial'
            ? {
                partialMode:
                  operation === 'exactPartial' ? ('exactOptional' as const) : ('optional' as const)
              }
            : {}),
          memo: normalized.memo,
          context: contextFor(normalized.memo, normalized.protectedKeys, active, dispatch)
        })
      )
    })

  const engine: DerivationEngine<Schema, Field> = {
    extend: (schema, augmentation, options) =>
      derive(schema, 'extend', options, (normalized, active) => {
        const fields = snapshotRecord<Field>(augmentation, 'extend')
        if (Result.isError(fields)) return fields
        if (normalized.protectedKeys.some((key) => own(fields.value as object, key))) {
          return definitionFailure('extend')
        }
        return Result.ok(
          Object.freeze({
            identifier: normalized.identifier,
            keys: Object.freeze([]),
            protectedKeys: normalized.protectedKeys,
            augmentation: fields.value,
            memo: normalized.memo,
            context: contextFor(normalized.memo, normalized.protectedKeys, active, dispatch)
          })
        )
      }),
    pick: (schema, mask, options) => structural(schema, 'pick', mask, options),
    omit: (schema, mask, options) => structural(schema, 'omit', mask, options),
    partial: (schema, mask, options) => structural(schema, 'partial', mask, options),
    exactPartial: (schema, mask, options) => structural(schema, 'exactPartial', mask, options),
    deepPartial: (schema, options) =>
      derive(schema, 'deepPartial', options, (normalized, active) =>
        Result.ok(
          Object.freeze({
            identifier: normalized.identifier,
            keys: Object.freeze([]),
            protectedKeys: normalized.protectedKeys,
            memo: normalized.memo,
            context: contextFor(normalized.memo, normalized.protectedKeys, active, dispatch)
          })
        )
      ),
    required: (schema, mask, options) => structural(schema, 'required', mask, options),
    policy: function (schema, policy, catchall, options) {
      const hasCatchall = arguments.length >= 3
      if (
        policy !== 'strict' &&
        policy !== 'loose' &&
        policy !== 'strip' &&
        policy !== 'catchall'
      ) {
        return definitionFailure('policy')
      }
      const normalized = normalizeOptions(options, policy)
      if (Result.isError(normalized)) return normalized
      if (policy === 'catchall' && !hasCatchall) return definitionFailure('catchall')
      if (policy !== 'catchall' && hasCatchall && catchall !== undefined)
        return definitionFailure(policy)

      const selected = readCapability(capabilities, 'structure', 'policy')
      if (selected.cause !== undefined) return executionFailure(policy, selected.cause)
      if (selected.value === undefined) return unsupported(policy)
      return callSync<Schema>(policy, selected.value, [
        schema,
        policy,
        catchall,
        Object.freeze({
          identifier: normalized.value.identifier,
          protectedKeys: normalized.value.protectedKeys
        })
      ])
    },
    strict: (schema, options) => engine.policy(schema, 'strict', undefined, options),
    loose: (schema, options) => engine.policy(schema, 'loose', undefined, options),
    strip: (schema, options) => engine.policy(schema, 'strip', undefined, options),
    catchall: function (schema, catchall, options) {
      if (arguments.length < 2) return definitionFailure('catchall')
      return engine.policy(schema, 'catchall', catchall, options)
    }
  }
  return Object.freeze(engine)
}

const keysFromFieldsValue = <Field>(
  fields: DerivationFieldMap<Field>,
  protectedKeys: readonly PropertyKey[]
): readonly PropertyKey[] =>
  Reflect.ownKeys(fields).filter(
    (key) => !protectedKeys.some((protectedKey) => Object.is(protectedKey, key))
  )

const readFieldsIfNeeded = <Schema, Field>(
  capabilities: DerivationCapabilities<Schema, Field>,
  schema: Schema,
  protectedKeys: readonly PropertyKey[],
  operation: string
): FailureResult<DerivationFieldMap<Field> | undefined> => {
  if (protectedKeys.length === 0) return Result.ok(undefined)
  return normalizeFields(capabilities, schema, operation)
}

const contextFor = <Schema, Field>(
  memo: DerivationMemo<Schema>,
  protectedKeys: readonly PropertyKey[],
  active: Set<Schema>,
  dispatch: (
    schema: Schema,
    operation: SchemaDerivationOperation,
    config: SchemaDerivationConfig<Schema, Field>,
    active: Set<Schema>
  ) => FailureResult<Schema>
): DerivationContext<Schema, Field> => ({
  memo,
  derive: (nested, operation) => {
    if (operation !== 'deepPartial') return unsupported(operation)
    return dispatch(
      nested,
      operation,
      {
        identifier: undefined,
        keys: Object.freeze([]),
        protectedKeys,
        memo,
        context: contextFor(memo, protectedKeys, active, dispatch)
      },
      active
    )
  },
  field: () => Result.err(new SchemaUnsupportedOperation({ operation: 'field' }))
})

/**
 * Build a provider-neutral derivation engine.
 *
 * The engine validates only portable inputs and dispatches semantics to the
 * declared capability. It never reconstructs a schema from fields, so a
 * provider can preserve refinements, codecs, defaults, and object policies or
 * report an explicit unsupported result instead.
 */
export const createDerivationEngine = <Schema, Field>(
  capabilities: DerivationCapabilities<Schema, Field>
): DerivationEngine<Schema, Field> => {
  if (!isObjectLike(capabilities)) {
    return createEngine({})
  }
  return createEngine(capabilities)
}
