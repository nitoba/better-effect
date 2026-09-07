import * as v from 'valibot'
import { Result, type Result as ResultType } from 'better-result'

import type { StandardSchemaV1 } from '@standard-schema/spec'

import {
  SchemaAsyncRequired,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../../failure.js'
import { invokeAsync, invokeSync } from '../../internal/execution.js'
import { validateStandardSync, type StandardValidation } from '../../internal/standard.js'
import type {
  AsyncCapabilityResult,
  CapabilityResult,
  SchemaAdapter,
  SchemaCapabilityFailure,
  SchemaDescriptor,
  SchemaDerivationOperation,
  SchemaFieldMap,
  SchemaObjectPolicy
} from '../../capabilities/types.js'

type NativeSchema = v.GenericSchema<unknown, unknown> | v.GenericSchemaAsync<unknown, unknown>

type NativeEntries = Record<string, NativeSchema>
type NativeResult<Value> = ResultType<Value, SchemaCapabilityFailure>

type ObjectKind = 'object' | 'loose_object' | 'strict_object' | 'object_with_rest'

interface StructuralInfo {
  readonly base: NativeSchema
  readonly kind: ObjectKind
  readonly entries: NativeEntries
  readonly rest?: NativeSchema
  readonly readonlyActions: readonly unknown[]
}

export type ValibotEncoder = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  value: Output
) => Input | PromiseLike<Input>

export type ValibotAsyncEncoder = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  value: Output
) => Input | PromiseLike<Input>

export interface ValibotAdapterOptions {
  readonly encode?: ValibotEncoder
  readonly encodeAsync?: ValibotAsyncEncoder
}

type ValibotSyncEncoding = Pick<NonNullable<SchemaAdapter['encoding']>, 'encode'>
type ValibotAsyncEncoding = ValibotSyncEncoding & {
  readonly encodeAsync: NonNullable<NonNullable<SchemaAdapter['encoding']>['encodeAsync']>
}

export interface ValibotConfiguredAdapter extends SchemaAdapter {
  readonly encoding: ValibotSyncEncoding
}

export interface ValibotAsyncConfiguredAdapter extends SchemaAdapter {
  readonly encoding: ValibotAsyncEncoding
}

type ValibotConfigure = {
  (
    options: { readonly encode: ValibotEncoder; readonly encodeAsync: ValibotAsyncEncoder }
  ): ValibotAsyncConfiguredAdapter
  (options: { readonly encode: ValibotEncoder }): ValibotConfiguredAdapter
  (options: { readonly encodeAsync: ValibotAsyncEncoder }): ValibotAsyncConfiguredAdapter
  (options: ValibotAdapterOptions): SchemaAdapter
}

export interface ValibotAdapterContract {
  readonly name: string
  readonly read: NonNullable<SchemaAdapter['read']>
  readonly props: NonNullable<SchemaAdapter['props']>
  readonly encoded: NonNullable<SchemaAdapter['encoded']>
  readonly structure: NonNullable<SchemaAdapter['structure']>
  readonly derivation: NonNullable<SchemaAdapter['derivation']>
  readonly bridge: NonNullable<SchemaAdapter['bridge']>
  readonly configure: ValibotConfigure
  readonly withEncoder: {
    (encode: ValibotEncoder): ValibotConfiguredAdapter
    (encode: ValibotEncoder, encodeAsync: ValibotAsyncEncoder): ValibotAsyncConfiguredAdapter
  }
}

const IDENTIFIER = 'ValibotAdapter'

const isObjectLike = (value: unknown): value is object | Function =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const readProperty = (value: object | Function, key: PropertyKey): unknown =>
  Reflect.get(value, key)

const failure = <Value>(error: SchemaCapabilityFailure): NativeResult<Value> => Result.err(error)

const capabilitySuccess = <Value>(value: Value): CapabilityResult<Value, SchemaCapabilityFailure> =>
  Result.ok(value) as unknown as CapabilityResult<Value, SchemaCapabilityFailure>

const unsupported = <Value>(operation: string): NativeResult<Value> =>
  failure(new SchemaUnsupportedOperation({ identifier: IDENTIFIER, operation }))

const definition = <Value>(operation: string, cause: unknown): NativeResult<Value> =>
  failure(new SchemaDefinitionFailure({ identifier: IDENTIFIER, operation, cause }))

const execution = <Value>(operation: string, cause: unknown): NativeResult<Value> =>
  failure(new SchemaExecutionFailure({ identifier: IDENTIFIER, operation, cause }))

const runSync = <Value>(
  operation: string,
  thunk: () => Value
): CapabilityResult<Value, SchemaCapabilityFailure> => {
  const result = invokeSync(operation, thunk)
  return Result.isError(result) ? result : Result.ok(result.value)
}

const runAsync = async <Value>(
  operation: string,
  thunk: () => Value | PromiseLike<Value>
): Promise<CapabilityResult<Value, SchemaCapabilityFailure>> => {
  const result = await invokeAsync(operation, thunk)
  return Result.isError(result) ? result : Result.ok(result.value)
}

const inspectNative = <Value>(value: Value, operation: string): NativeResult<NativeSchema> => {
  if (!isObjectLike(value)) return unsupported(operation)

  try {
    const standard = readProperty(value, '~standard')
    if (!isObjectLike(standard)) return unsupported(operation)

    if (
      readProperty(value, 'kind') !== 'schema' ||
      readProperty(standard, 'version') !== 1 ||
      readProperty(standard, 'vendor') !== 'valibot' ||
      typeof readProperty(standard, 'validate') !== 'function' ||
      typeof readProperty(value, '~run') !== 'function'
    ) {
      return unsupported(operation)
    }

    return Result.ok(value as unknown as NativeSchema)
  } catch (cause) {
    return execution(operation, cause)
  }
}

const isNativeSchema = (value: unknown): value is NativeSchema =>
  Result.isOk(inspectNative(value, 'inspect'))

const isAsync = (schema: NativeSchema): boolean => {
  try {
    return readProperty(schema, 'async') === true
  } catch {
    return false
  }
}

const isReadonlyAction = (value: unknown): boolean => {
  if (!isObjectLike(value)) return false

  try {
    return (
      readProperty(value, 'kind') === 'transformation' && readProperty(value, 'type') === 'readonly'
    )
  } catch {
    return false
  }
}

const isInputPreservingAction = (value: unknown): boolean => {
  if (isReadonlyAction(value)) return true
  if (!isObjectLike(value)) return false

  try {
    return readProperty(value, 'kind') === 'validation'
  } catch {
    return false
  }
}

const nativeConstructor = (
  operation: string,
  constructor: Function,
  args: readonly unknown[]
): NativeResult<NativeSchema> => {
  const result = runSync(operation, () => Reflect.apply(constructor, undefined, args))
  if (Result.isError(result)) return failure(result.error as SchemaCapabilityFailure)
  return inspectNative(result.value, operation)
}

const withReadonlyActions = (
  schema: NativeSchema,
  actions: readonly unknown[],
  operation: string
): NativeResult<NativeSchema> => {
  if (actions.length === 0) return Result.ok(schema)
  return nativeConstructor(operation, v.pipe, [schema, ...actions])
}

const entriesOf = (schema: NativeSchema, operation: string): NativeResult<NativeEntries> => {
  let entries: unknown
  try {
    entries = readProperty(schema, 'entries')
  } catch (cause) {
    return execution(operation, cause)
  }

  if (!isObjectLike(entries) || Array.isArray(entries)) {
    return definition(operation, 'missing-object-entries')
  }

  try {
    const result: NativeEntries = {}
    for (const key of Object.keys(entries)) {
      const field = readProperty(entries, key)
      if (!isNativeSchema(field)) {
        return definition(operation, `invalid-entry:${key}`)
      }
      result[key] = field
    }
    return Result.ok(result)
  } catch (cause) {
    return execution(operation, cause)
  }
}

const structural = (schema: unknown, operation: string): NativeResult<StructuralInfo> => {
  const inspected = inspectNative(schema, operation)
  if (Result.isError(inspected)) return inspected

  let base = inspected.value
  let readonlyActions: unknown[] = []

  try {
    const pipe = readProperty(base, 'pipe')
    if (pipe !== undefined) {
      if (!Array.isArray(pipe) || pipe.length < 1) {
        return definition(operation, 'invalid-pipe')
      }

      const first = pipe[0]
      if (!isNativeSchema(first)) return definition(operation, 'invalid-pipe-base')

      readonlyActions = pipe.slice(1)
      if (!readonlyActions.every(isReadonlyAction)) {
        return unsupported(`${operation}:object-pipeline`)
      }
      base = first
    }

    const type = readProperty(base, 'type')
    if (
      type !== 'object' &&
      type !== 'loose_object' &&
      type !== 'strict_object' &&
      type !== 'object_with_rest'
    ) {
      return unsupported(`${operation}:non-object`)
    }

    const entries = entriesOf(base, operation)
    if (Result.isError(entries)) return entries

    if (type === 'object_with_rest') {
      const rest = readProperty(base, 'rest')
      if (!isNativeSchema(rest)) return definition(operation, 'missing-rest-schema')
      return Result.ok({
        base,
        kind: type,
        entries: entries.value,
        rest,
        readonlyActions
      })
    }

    return Result.ok({
      base,
      kind: type,
      entries: entries.value,
      readonlyActions
    })
  } catch (cause) {
    return execution(operation, cause)
  }
}

const hasAsyncSchema = (schemas: Iterable<NativeSchema>): boolean => {
  for (const schema of schemas) {
    if (isAsync(schema)) return true
  }
  return false
}

const objectSchema = (
  kind: ObjectKind,
  entries: NativeEntries,
  rest: NativeSchema | undefined,
  operation: string
): NativeResult<NativeSchema> => {
  const schemas = Object.values(entries)
  if (rest !== undefined) schemas.push(rest)
  const asyncSchema = hasAsyncSchema(schemas)

  if (kind === 'object_with_rest' && rest === undefined) {
    return definition(operation, 'missing-rest-schema')
  }

  const constructor = asyncSchema
    ? kind === 'object'
      ? v.objectAsync
      : kind === 'loose_object'
        ? v.looseObjectAsync
        : kind === 'strict_object'
          ? v.strictObjectAsync
          : v.objectWithRestAsync
    : kind === 'object'
      ? v.object
      : kind === 'loose_object'
        ? v.looseObject
        : kind === 'strict_object'
          ? v.strictObject
          : v.objectWithRest

  const args = kind === 'object_with_rest' ? [entries, rest] : [entries]
  return nativeConstructor(operation, constructor, args)
}

const structuralSchema = (
  info: StructuralInfo,
  entries: NativeEntries,
  operation: string
): NativeResult<NativeSchema> => {
  const built = objectSchema(info.kind, entries, info.rest, operation)
  if (Result.isError(built)) return built
  return withReadonlyActions(built.value, info.readonlyActions, operation)
}

const fieldMap = (value: unknown, operation: string): NativeResult<NativeEntries> => {
  if (!isObjectLike(value) || Array.isArray(value)) {
    return definition(operation, 'expected-field-map')
  }

  try {
    const entries: NativeEntries = {}
    for (const key of Object.keys(value)) {
      const field = readProperty(value, key)
      if (!isNativeSchema(field)) return unsupported(`${operation}:foreign-field`)
      entries[key] = field
    }
    return Result.ok(entries)
  } catch (cause) {
    return execution(operation, cause)
  }
}

type MaskConfig = Readonly<Record<string, true>> | readonly string[]

const maskKeys = (
  config: unknown,
  entries: NativeEntries,
  operation: string,
  defaultKeys: readonly string[]
): NativeResult<readonly string[]> => {
  let candidate = config
  if (isObjectLike(config) && !Array.isArray(config)) {
    try {
      const nested = readProperty(config, 'keys')
      if (nested !== undefined) candidate = nested
    } catch (cause) {
      return execution(operation, cause)
    }
  }

  if (candidate === undefined) return Result.ok(defaultKeys)

  if (Array.isArray(candidate)) {
    const result: string[] = []
    for (const key of candidate) {
      if (typeof key !== 'string') return definition(operation, 'mask-key-not-string')
      if (!Object.prototype.hasOwnProperty.call(entries, key)) {
        return definition(operation, `unknown-field:${key}`)
      }
      if (!result.includes(key)) result.push(key)
    }
    return Result.ok(result)
  }

  if (!isObjectLike(candidate)) return definition(operation, 'expected-mask')

  try {
    const result: string[] = []
    for (const key of Object.keys(candidate)) {
      if (readProperty(candidate, key) !== true) {
        return definition(operation, `mask-value-not-true:${key}`)
      }
      if (!Object.prototype.hasOwnProperty.call(entries, key)) {
        return definition(operation, `unknown-field:${key}`)
      }
      result.push(key)
    }
    return Result.ok(result)
  } catch (cause) {
    return execution(operation, cause)
  }
}

const selectEntries = (
  entries: NativeEntries,
  keys: readonly string[],
  keep: boolean
): NativeEntries => {
  const selected = new Set(keys)
  const result: NativeEntries = {}
  for (const [key, value] of Object.entries(entries)) {
    if (selected.has(key) === keep) result[key] = value
  }
  return result
}

const wrappedSchema = (
  schema: NativeSchema,
  operation: string
): NativeResult<{ readonly type: string; readonly wrapped: NativeSchema }> => {
  try {
    const type = readProperty(schema, 'type')
    const wrapped = readProperty(schema, 'wrapped')
    if (typeof type !== 'string' || !isNativeSchema(wrapped)) {
      return definition(operation, 'missing-wrapped-schema')
    }
    return Result.ok({ type, wrapped })
  } catch (cause) {
    return execution(operation, cause)
  }
}

const optionalSchema = (
  schema: NativeSchema,
  exact: boolean,
  operation: string
): NativeResult<NativeSchema> => {
  let type: unknown
  try {
    type = readProperty(schema, 'type')
  } catch (cause) {
    return execution(operation, cause)
  }

  const wrapped =
    type === 'optional' || type === 'exact_optional'
      ? wrappedSchema(schema, operation)
      : Result.ok({ type: '', wrapped: schema })
  if (Result.isError(wrapped)) return wrapped

  const constructor = isAsync(wrapped.value.wrapped)
    ? exact
      ? v.exactOptionalAsync
      : v.optionalAsync
    : exact
      ? v.exactOptional
      : v.optional
  let hasDefault = false
  let defaultValue: unknown
  try {
    hasDefault = Reflect.has(schema, 'default')
    if (hasDefault) defaultValue = readProperty(schema, 'default')
  } catch (cause) {
    return execution(operation, cause)
  }
  return nativeConstructor(
    operation,
    constructor,
    hasDefault ? [wrapped.value.wrapped, defaultValue] : [wrapped.value.wrapped]
  )
}

const nullableSchema = (
  schema: NativeSchema,
  nullish: boolean,
  operation: string
): NativeResult<NativeSchema> => {
  const wrapped = wrappedSchema(schema, operation)
  if (Result.isError(wrapped)) return wrapped

  const constructor = isAsync(wrapped.value.wrapped)
    ? nullish
      ? v.nullishAsync
      : v.nullableAsync
    : nullish
      ? v.nullish
      : v.nullable
  return nativeConstructor(operation, constructor, [wrapped.value.wrapped])
}

const projectInput = (
  schema: NativeSchema,
  cache = new WeakMap<object, NativeSchema>()
): NativeResult<NativeSchema> => {
  const cached = cache.get(schema)
  if (cached !== undefined) return Result.ok(cached)

  let type: unknown
  let pipe: unknown
  try {
    type = readProperty(schema, 'type')
    pipe = readProperty(schema, 'pipe')
  } catch (cause) {
    return execution('encoded', cause)
  }

  if (Array.isArray(pipe)) {
    if (pipe.length < 1 || !isNativeSchema(pipe[0])) {
      return definition('encoded', 'invalid-pipe')
    }
    const actions = pipe.slice(1)
    if (!actions.every(isInputPreservingAction)) {
      return unsupported('encoded:pipeline')
    }

    const projected = projectInput(pipe[0], cache)
    if (Result.isError(projected)) return projected
    const withActions = withReadonlyActions(projected.value, actions, 'encoded')
    if (Result.isError(withActions)) return withActions
    cache.set(schema, withActions.value)
    return withActions
  }

  if (type === 'fallback') return unsupported('encoded:fallback')

  if (type === 'optional' || type === 'exact_optional') {
    const wrapped = wrappedSchema(schema, 'encoded')
    if (Result.isError(wrapped)) return wrapped
    const projected = projectInput(wrapped.value.wrapped, cache)
    if (Result.isError(projected)) return projected
    const constructor = isAsync(projected.value)
      ? type === 'exact_optional'
        ? v.exactOptionalAsync
        : v.optionalAsync
      : type === 'exact_optional'
        ? v.exactOptional
        : v.optional
    const result = nativeConstructor('encoded', constructor, [projected.value])
    if (Result.isOk(result)) cache.set(schema, result.value)
    return result
  }

  if (type === 'nullable' || type === 'nullish') {
    const wrapped = wrappedSchema(schema, 'encoded')
    if (Result.isError(wrapped)) return wrapped
    const projected = projectInput(wrapped.value.wrapped, cache)
    if (Result.isError(projected)) return projected
    const constructor = isAsync(projected.value)
      ? type === 'nullish'
        ? v.nullishAsync
        : v.nullableAsync
      : type === 'nullish'
        ? v.nullish
        : v.nullable
    const result = nativeConstructor('encoded', constructor, [projected.value])
    if (Result.isOk(result)) cache.set(schema, result.value)
    return result
  }

  if (type === 'lazy') {
    return lazyProjection(schema, isAsync(schema), cache)
  }

  if (
    type === 'object' ||
    type === 'loose_object' ||
    type === 'strict_object' ||
    type === 'object_with_rest'
  ) {
    const entries = entriesOf(schema, 'encoded')
    if (Result.isError(entries)) return entries

    const projectedEntries: NativeEntries = {}
    for (const [key, field] of Object.entries(entries.value)) {
      const projected = projectInput(field, cache)
      if (Result.isError(projected)) return projected
      projectedEntries[key] = projected.value
    }

    let projectedRest: NativeSchema | undefined
    if (type === 'object_with_rest') {
      let rest: unknown
      try {
        rest = readProperty(schema, 'rest')
      } catch (cause) {
        return execution('encoded', cause)
      }
      if (!isNativeSchema(rest)) return definition('encoded', 'missing-rest-schema')
      const projected = projectInput(rest, cache)
      if (Result.isError(projected)) return projected
      projectedRest = projected.value
    }

    const result = objectSchema(type, projectedEntries, projectedRest, 'encoded')
    if (Result.isOk(result)) cache.set(schema, result.value)
    return result
  }

  if (type === 'array') {
    let item: unknown
    try {
      item = readProperty(schema, 'item')
    } catch (cause) {
      return execution('encoded', cause)
    }
    if (!isNativeSchema(item)) return definition('encoded', 'missing-array-item')
    const projected = projectInput(item, cache)
    if (Result.isError(projected)) return projected
    const result = nativeConstructor('encoded', isAsync(projected.value) ? v.arrayAsync : v.array, [
      projected.value
    ])
    if (Result.isOk(result)) cache.set(schema, result.value)
    return result
  }

  if (type === 'tuple' || type === 'tuple_with_rest') {
    let items: unknown
    try {
      items = readProperty(schema, 'items')
    } catch (cause) {
      return execution('encoded', cause)
    }
    if (!Array.isArray(items)) return definition('encoded', 'missing-tuple-items')

    const projectedItems: NativeSchema[] = []
    for (const item of items) {
      if (!isNativeSchema(item)) return definition('encoded', 'invalid-tuple-item')
      const projected = projectInput(item, cache)
      if (Result.isError(projected)) return projected
      projectedItems.push(projected.value)
    }

    if (type === 'tuple') {
      const result = nativeConstructor(
        'encoded',
        hasAsyncSchema(projectedItems) ? v.tupleAsync : v.tuple,
        [projectedItems]
      )
      if (Result.isOk(result)) cache.set(schema, result.value)
      return result
    }

    let rest: unknown
    try {
      rest = readProperty(schema, 'rest')
    } catch (cause) {
      return execution('encoded', cause)
    }
    if (!isNativeSchema(rest)) return definition('encoded', 'missing-tuple-rest')
    const projectedRest = projectInput(rest, cache)
    if (Result.isError(projectedRest)) return projectedRest
    const allSchemas = [...projectedItems, projectedRest.value]
    const result = nativeConstructor(
      'encoded',
      hasAsyncSchema(allSchemas) ? v.tupleWithRestAsync : v.tupleWithRest,
      [projectedItems, projectedRest.value]
    )
    if (Result.isOk(result)) cache.set(schema, result.value)
    return result
  }

  if (type === 'record') {
    let key: unknown
    let value: unknown
    try {
      key = readProperty(schema, 'key')
      value = readProperty(schema, 'value')
    } catch (cause) {
      return execution('encoded', cause)
    }
    if (!isNativeSchema(key) || !isNativeSchema(value)) {
      return definition('encoded', 'missing-record-schema')
    }
    const projectedKey = projectInput(key, cache)
    if (Result.isError(projectedKey)) return projectedKey
    const projectedValue = projectInput(value, cache)
    if (Result.isError(projectedValue)) return projectedValue
    const result = nativeConstructor(
      'encoded',
      hasAsyncSchema([projectedKey.value, projectedValue.value]) ? v.recordAsync : v.record,
      [projectedKey.value, projectedValue.value]
    )
    if (Result.isOk(result)) cache.set(schema, result.value)
    return result
  }

  cache.set(schema, schema)
  return Result.ok(schema)
}

const lazyProjection = (
  schema: NativeSchema,
  asyncSchema: boolean,
  cache: WeakMap<object, NativeSchema>
): NativeResult<NativeSchema> => {
  let getter: unknown
  try {
    getter = readProperty(schema, 'getter')
  } catch (cause) {
    return execution('encoded', cause)
  }
  if (typeof getter !== 'function') return definition('encoded', 'missing-lazy-getter')

  const projected = asyncSchema
    ? nativeConstructor('encoded', v.lazyAsync, [
        async (input: unknown) => {
          const target = await Reflect.apply(getter, undefined, [input])
          const result = projectInput(target as NativeSchema, cache)
          if (Result.isError(result)) throw result.error
          return result.value
        }
      ])
    : nativeConstructor('encoded', v.lazy, [
        (input: unknown) => {
          const target = Reflect.apply(getter, undefined, [input])
          const result = projectInput(target as NativeSchema, cache)
          if (Result.isError(result)) throw result.error
          return result.value
        }
      ])

  if (Result.isOk(projected)) cache.set(schema, projected.value)
  return projected
}

const deepPartial = (
  schema: NativeSchema,
  cache = new WeakMap<object, NativeSchema>()
): NativeResult<NativeSchema> => {
  const cached = cache.get(schema)
  if (cached !== undefined) return Result.ok(cached)

  let type: unknown
  let pipe: unknown
  try {
    type = readProperty(schema, 'type')
    pipe = readProperty(schema, 'pipe')
  } catch (cause) {
    return execution('deepPartial', cause)
  }

  if (Array.isArray(pipe)) {
    if (pipe.length < 1 || !isNativeSchema(pipe[0])) {
      return definition('deepPartial', 'invalid-pipe')
    }
    const actions = pipe.slice(1)
    if (!actions.every(isReadonlyAction)) return unsupported('deepPartial:pipeline')
    const projected = deepPartial(pipe[0], cache)
    if (Result.isError(projected)) return projected
    const result = withReadonlyActions(projected.value, actions, 'deepPartial')
    if (Result.isOk(result)) cache.set(schema, result.value)
    return result
  }

  if (type === 'optional' || type === 'exact_optional') {
    const wrapped = wrappedSchema(schema, 'deepPartial')
    if (Result.isError(wrapped)) return wrapped
    const projected = deepPartial(wrapped.value.wrapped, cache)
    if (Result.isError(projected)) return projected
    const result = nativeConstructor(
      'deepPartial',
      isAsync(projected.value)
        ? type === 'exact_optional'
          ? v.exactOptionalAsync
          : v.optionalAsync
        : type === 'exact_optional'
          ? v.exactOptional
          : v.optional,
      [projected.value]
    )
    if (Result.isOk(result)) cache.set(schema, result.value)
    return result
  }

  if (type === 'nullable' || type === 'nullish') {
    const wrapped = wrappedSchema(schema, 'deepPartial')
    if (Result.isError(wrapped)) return wrapped
    const projected = deepPartial(wrapped.value.wrapped, cache)
    if (Result.isError(projected)) return projected
    const result = nativeConstructor(
      'deepPartial',
      isAsync(projected.value)
        ? type === 'nullish'
          ? v.nullishAsync
          : v.nullableAsync
        : type === 'nullish'
          ? v.nullish
          : v.nullable,
      [projected.value]
    )
    if (Result.isOk(result)) cache.set(schema, result.value)
    return result
  }

  if (type === 'lazy') return lazyProjection(schema, isAsync(schema), cache)

  if (
    type === 'object' ||
    type === 'loose_object' ||
    type === 'strict_object' ||
    type === 'object_with_rest'
  ) {
    const info = structural(schema, 'deepPartial')
    if (Result.isError(info)) return info

    const entries: NativeEntries = {}
    for (const [key, field] of Object.entries(info.value.entries)) {
      const projected = deepPartial(field, cache)
      if (Result.isError(projected)) return projected
      let fieldType: unknown
      try {
        fieldType = readProperty(field, 'type')
      } catch (cause) {
        return execution('deepPartial', cause)
      }
      if (fieldType === 'optional' || fieldType === 'exact_optional') {
        entries[key] = projected.value
      } else {
        const optional = nativeConstructor(
          'deepPartial',
          isAsync(projected.value) ? v.optionalAsync : v.optional,
          [projected.value]
        )
        if (Result.isError(optional)) return optional
        entries[key] = optional.value
      }
    }

    let rest = info.value.rest
    if (rest !== undefined) {
      const projectedRest = deepPartial(rest, cache)
      if (Result.isError(projectedRest)) return projectedRest
      rest = projectedRest.value
    }

    const partialInfo: StructuralInfo =
      rest === undefined ? { ...info.value } : { ...info.value, rest }
    const result = structuralSchema(partialInfo, entries, 'deepPartial')
    if (Result.isOk(result)) cache.set(schema, result.value)
    return result
  }

  if (type === 'array') {
    let item: unknown
    try {
      item = readProperty(schema, 'item')
    } catch (cause) {
      return execution('deepPartial', cause)
    }
    if (!isNativeSchema(item)) return definition('deepPartial', 'missing-array-item')
    const projected = deepPartial(item, cache)
    if (Result.isError(projected)) return projected
    const result = nativeConstructor(
      'deepPartial',
      isAsync(projected.value) ? v.arrayAsync : v.array,
      [projected.value]
    )
    if (Result.isOk(result)) cache.set(schema, result.value)
    return result
  }

  cache.set(schema, schema)
  return Result.ok(schema)
}

const makeProps = <Input, Output, Props, Self, ConstructionInput = Props>(
  descriptor: SchemaDescriptor<Input, Output, Props, Self, ConstructionInput>,
  props: ConstructionInput
): CapabilityResult<Self, SchemaCapabilityFailure> => {
  const schemaResult = inspectNative(descriptor.schema, 'make')
  if (Result.isError(schemaResult)) return failure(schemaResult.error)
  const propsResult = inspectNative(descriptor.propsSchema, 'make')
  if (Result.isError(propsResult)) return failure(propsResult.error)

  const validation = validateStandardSync<Props>(
    descriptor.propsSchema,
    props,
    IDENTIFIER,
    'make',
    undefined
  )
  if (Result.isError(validation)) return validation

  const checked = validation.value as StandardValidation<Props>
  switch (checked._tag) {
    case 'definition':
      return Result.err(checked.failure)
    case 'failure':
      return Result.err(
        new SchemaExecutionFailure({
          identifier: IDENTIFIER,
          operation: 'make',
          cause: checked.issues,
          issues: checked.issues
        })
      )
    case 'success':
      return runSync('make', () => descriptor.construct(checked.value))
  }
}

const encodeWith = (encoder: ValibotEncoder): NonNullable<SchemaAdapter['encoding']> => ({
  encode: <Input, Output>(schema: StandardSchemaV1<Input, Output>, value: Output) => {
    const inspected = inspectNative(schema, 'encode')
    if (Result.isError(inspected)) return failure<Input>(inspected.error)
    return runSync('encode', () => encoder(schema, value) as Input)
  }
})

const encodeAsyncWith =
  (
    encoder: ValibotAsyncEncoder
  ): NonNullable<NonNullable<SchemaAdapter['encoding']>['encodeAsync']> =>
  async <Input, Output>(schema: StandardSchemaV1<Input, Output>, value: Output) => {
    const inspected = inspectNative(schema, 'encodeAsync')
    if (Result.isError(inspected)) return inspected
    return runAsync('encodeAsync', () => encoder(schema, value))
  }

const configured = (options: ValibotAdapterOptions): SchemaAdapter => {
  if (options.encode === undefined) {
    if (options.encodeAsync === undefined) {
      return ValibotAdapter
    }

    return Object.freeze({
      ...ValibotAdapter,
      encoding: {
        encode: <Input, Output>(schema: StandardSchemaV1<Input, Output>, value: Output) => {
          void schema
          void value
          return failure<Input>(
            new SchemaUnsupportedOperation({
              identifier: IDENTIFIER,
              operation: 'encode'
            })
          )
        },
        encodeAsync: encodeAsyncWith(options.encodeAsync)
      }
    })
  }

  return Object.freeze({
    ...ValibotAdapter,
    encoding: {
      ...encodeWith(options.encode),
      ...(options.encodeAsync === undefined
        ? {}
        : { encodeAsync: encodeAsyncWith(options.encodeAsync) })
    }
  })
}

function configure(
  options: { readonly encode: ValibotEncoder; readonly encodeAsync: ValibotAsyncEncoder }
): ValibotAsyncConfiguredAdapter
function configure(options: { readonly encode: ValibotEncoder }): ValibotConfiguredAdapter
function configure(options: { readonly encodeAsync: ValibotAsyncEncoder }): ValibotAsyncConfiguredAdapter
function configure(options: ValibotAdapterOptions): SchemaAdapter
function configure(options: ValibotAdapterOptions): SchemaAdapter {
  return configured(options)
}

function withEncoder(encode: ValibotEncoder): ValibotConfiguredAdapter
function withEncoder(
  encode: ValibotEncoder,
  encodeAsync: ValibotAsyncEncoder
): ValibotAsyncConfiguredAdapter
function withEncoder(
  encode: ValibotEncoder,
  encodeAsync?: ValibotAsyncEncoder
): ValibotConfiguredAdapter | ValibotAsyncConfiguredAdapter {
  const options = encodeAsync === undefined ? { encode } : { encode, encodeAsync }
  return configured(options) as ValibotConfiguredAdapter | ValibotAsyncConfiguredAdapter
}

const adapter: ValibotAdapterContract = {
  name: 'valibot',

  read: {
    read: <Schema extends StandardSchemaV1>(
      schema: Schema
    ): CapabilityResult<Schema, SchemaCapabilityFailure> => {
      const inspected = inspectNative(schema, 'read')
      if (Result.isError(inspected)) return failure<Schema>(inspected.error)
      return capabilitySuccess(schema)
    }
  },

  props: {
    props: <Input, Output, Props, Self, ConstructionInput = Props>(
      descriptor: SchemaDescriptor<Input, Output, Props, Self, ConstructionInput>
    ): CapabilityResult<StandardSchemaV1<ConstructionInput, Props>, SchemaCapabilityFailure> => {
      const schema = inspectNative(descriptor.schema, 'props')
      if (Result.isError(schema))
        return failure<StandardSchemaV1<ConstructionInput, Props>>(schema.error)
      const props = inspectNative(descriptor.propsSchema, 'props')
      if (Result.isError(props))
        return failure<StandardSchemaV1<ConstructionInput, Props>>(props.error)
      return capabilitySuccess(descriptor.propsSchema)
    },
    make: makeProps
  },

  encoded: {
    encoded: <Input, Output>(
      schema: StandardSchemaV1<Input, Output>
    ): CapabilityResult<StandardSchemaV1<Input, Input>, SchemaCapabilityFailure> => {
      const inspected = inspectNative(schema, 'encoded')
      if (Result.isError(inspected)) {
        return failure<StandardSchemaV1<Input, Input>>(inspected.error)
      }
      const projected = projectInput(inspected.value)
      return Result.isError(projected)
        ? projected
        : capabilitySuccess(projected.value as unknown as StandardSchemaV1<Input, Input>)
    }
  },

  structure: {
    fields: <Input, Output>(schema: StandardSchemaV1<Input, Output>) => {
      const info = structural(schema, 'fields')
      if (Result.isError(info)) return info
      return Result.ok(Object.freeze({ ...info.value.entries }) as SchemaFieldMap)
    },

    struct: <Input, Output>(schema: StandardSchemaV1<Input, Output>, fields: SchemaFieldMap) => {
      const info = structural(schema, 'struct')
      if (Result.isError(info)) return info
      const entries = fieldMap(fields, 'struct')
      if (Result.isError(entries)) return entries
      return structuralSchema(info.value, entries.value, 'struct')
    },

    policy: <Input, Output>(
      schema: StandardSchemaV1<Input, Output>,
      policy: SchemaObjectPolicy
    ) => {
      const info = structural(schema, 'policy')
      if (Result.isError(info)) return info

      if (policy === 'catchall' && info.value.rest === undefined) {
        return unsupported('policy:catchall-without-rest')
      }

      const kind: ObjectKind =
        policy === 'catchall'
          ? 'object_with_rest'
          : policy === 'strict'
            ? 'strict_object'
            : policy === 'loose'
              ? 'loose_object'
              : 'object'
      const result = objectSchema(
        kind,
        info.value.entries,
        kind === 'object_with_rest' ? info.value.rest : undefined,
        'policy'
      )
      if (Result.isError(result)) return result
      return withReadonlyActions(result.value, info.value.readonlyActions, 'policy')
    }
  },

  derivation: {
    derive: <Input, Output>(
      schema: StandardSchemaV1<Input, Output>,
      operation: SchemaDerivationOperation,
      config?: unknown
    ) => {
      const info = structural(schema, `derive:${operation}`)
      if (Result.isError(info)) return info

      switch (operation) {
        case 'extend': {
          const augmentation = fieldMap(config, 'derive:extend')
          if (Result.isError(augmentation)) return augmentation
          return structuralSchema(
            info.value,
            { ...info.value.entries, ...augmentation.value },
            'derive:extend'
          )
        }

        case 'pick': {
          const keys = maskKeys(
            config,
            info.value.entries,
            'derive:pick',
            Object.keys(info.value.entries)
          )
          if (Result.isError(keys)) return keys
          return structuralSchema(
            info.value,
            selectEntries(info.value.entries, keys.value, true),
            'derive:pick'
          )
        }

        case 'omit': {
          const keys = maskKeys(config, info.value.entries, 'derive:omit', [])
          if (Result.isError(keys)) return keys
          return structuralSchema(
            info.value,
            selectEntries(info.value.entries, keys.value, false),
            'derive:omit'
          )
        }

        case 'partial': {
          const keys = maskKeys(
            config,
            info.value.entries,
            'derive:partial',
            Object.keys(info.value.entries)
          )
          if (Result.isError(keys)) return keys
          const result = nativeConstructor(
            'derive:partial',
            hasAsyncSchema(Object.values(info.value.entries)) ? v.partialAsync : v.partial,
            keys.value.length === Object.keys(info.value.entries).length
              ? [info.value.base]
              : [info.value.base, keys.value]
          )
          if (Result.isError(result)) return result
          return withReadonlyActions(result.value, info.value.readonlyActions, 'derive:partial')
        }

        case 'exactPartial': {
          const keys = maskKeys(
            config,
            info.value.entries,
            'derive:exactPartial',
            Object.keys(info.value.entries)
          )
          if (Result.isError(keys)) return keys
          const selected = new Set(keys.value)
          const entries: NativeEntries = {}
          for (const [key, field] of Object.entries(info.value.entries)) {
            if (!selected.has(key)) {
              entries[key] = field
              continue
            }
            let fieldType: unknown
            try {
              fieldType = readProperty(field, 'type')
            } catch (cause) {
              return execution('derive:exactPartial', cause)
            }
            if (fieldType === 'optional' || fieldType === 'exact_optional') {
              entries[key] = field
              continue
            }
            const optional = optionalSchema(field, true, 'derive:exactPartial')
            if (Result.isError(optional)) return optional
            entries[key] = optional.value
          }
          return structuralSchema(info.value, entries, 'derive:exactPartial')
        }

        case 'deepPartial': {
          const result = deepPartial(info.value.base)
          if (Result.isError(result)) return result
          return withReadonlyActions(result.value, info.value.readonlyActions, 'derive:deepPartial')
        }

        case 'required': {
          const keys = maskKeys(
            config,
            info.value.entries,
            'derive:required',
            Object.keys(info.value.entries)
          )
          if (Result.isError(keys)) return keys
          const result = nativeConstructor(
            'derive:required',
            hasAsyncSchema(Object.values(info.value.entries)) ? v.requiredAsync : v.required,
            keys.value.length === Object.keys(info.value.entries).length
              ? [info.value.base]
              : [info.value.base, keys.value]
          )
          if (Result.isError(result)) return result
          return withReadonlyActions(result.value, info.value.readonlyActions, 'derive:required')
        }
      }
    }
  },

  bridge: {
    bridge: <Native, Input, Output>(native: Native) => {
      const inspected = inspectNative(native, 'bridge')
      if (Result.isError(inspected)) return inspected
      return Result.ok(inspected.value as unknown as StandardSchemaV1<Input, Output>)
    }
  },

  configure,

  withEncoder
}

export const ValibotAdapter = Object.freeze(adapter)
