import { Result, type Result as ResultType } from 'better-result'

import {
  SchemaAsyncRequired,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../failure.js'
import { invokeAsync, invokeSync } from '../internal/execution.js'
import { decode, decodeAsync, decodeUnknown, decodeUnknownAsync } from '../operations.js'
import type {
  CapabilityResult,
  SchemaAdapter,
  SchemaCapabilities,
  SchemaCapabilityFailure
} from './types.js'

type PublicCapabilityFailure = SchemaCapabilityFailure | SchemaAsyncRequired

type CapabilityKey = keyof SchemaCapabilities

const capabilityMethods = new Set([
  'read',
  'props',
  'make',
  'encoded',
  'encode',
  'encodeAsync',
  'fields',
  'struct',
  'policy',
  'derive',
  'toJSONSchema',
  'bridge'
])

type SelectedCapability<Adapter extends SchemaAdapter, Key extends CapabilityKey> =
  | (Key extends keyof Adapter ? NonNullable<Adapter[Key]> : never)
  | (Adapter['capabilities'] extends SchemaCapabilities
      ? NonNullable<Adapter['capabilities'][Key]>
      : never)

const isObjectLike = (value: unknown): value is object | Function =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const selectedCapability = (
  adapter: SchemaAdapter,
  key: CapabilityKey
): { readonly owner: object | Function; readonly value: object | Function } | undefined => {
  if (!isObjectLike(adapter)) return undefined

  try {
    const direct = Reflect.get(adapter, key)
    if (isObjectLike(direct)) return { owner: direct, value: direct }

    const grouped = Reflect.get(adapter, 'capabilities')
    if (!isObjectLike(grouped)) return undefined
    const nested = Reflect.get(grouped, key)
    return isObjectLike(nested) ? { owner: nested, value: nested } : undefined
  } catch {
    return undefined
  }
}

const unsupported = (operation: string): ResultType<never, SchemaUnsupportedOperation> =>
  Result.err(new SchemaUnsupportedOperation({ operation }))

const isResult = (value: unknown): boolean => {
  if (!isObjectLike(value)) return false

  try {
    const result = value as ResultType<unknown, unknown>
    return Result.isOk(result) || Result.isError(result)
  } catch {
    return false
  }
}

const normalizeResult = (
  operation: string,
  value: unknown
): CapabilityResult<unknown, PublicCapabilityFailure> =>
  isResult(value)
    ? (value as CapabilityResult<unknown, PublicCapabilityFailure>)
    : Result.err(new SchemaExecutionFailure({ operation, cause: 'invalid-result' }))

const syncCapability = (
  operation: string,
  capability: unknown,
  owner: object | Function,
  args: readonly unknown[]
): CapabilityResult<unknown, PublicCapabilityFailure> => {
  if (!isObjectLike(capability)) return unsupported(operation)

  let method: unknown
  try {
    method = Reflect.get(capability, operation)
  } catch (cause) {
    return Result.err(new SchemaExecutionFailure({ operation, cause }))
  }

  if (typeof method !== 'function') return unsupported(operation)
  const result = invokeSync<CapabilityResult<unknown, SchemaCapabilityFailure>>(operation, () =>
    Reflect.apply(method, owner, args)
  )
  return Result.isError(result) ? result : normalizeResult(operation, result.value)
}

const asyncCapability = async (
  operation: string,
  capability: unknown,
  owner: object | Function,
  args: readonly unknown[]
): Promise<CapabilityResult<unknown, PublicCapabilityFailure>> => {
  if (!isObjectLike(capability)) return unsupported(operation)

  let method: unknown
  try {
    method = Reflect.get(capability, operation)
  } catch (cause) {
    return Result.err(new SchemaExecutionFailure({ operation, cause }))
  }

  if (typeof method !== 'function') return unsupported(operation)
  const result = await invokeAsync<CapabilityResult<unknown, SchemaCapabilityFailure>>(
    operation,
    () => Reflect.apply(method, owner, args)
  )
  return Result.isError(result) ? result : normalizeResult(operation, result.value)
}

type Method<Capability, Key extends PropertyKey> = Capability extends unknown
  ? Key extends keyof Capability
    ? Capability[Key] extends (...args: never[]) => unknown
      ? Capability[Key]
      : never
    : never
  : never

type AddMethod<Capability, Key extends PropertyKey, Name extends PropertyKey = Key> = [
  Method<Capability, Key>
] extends [never]
  ? object
  : { readonly [Property in Name]: Method<Capability, Key> }

type CapabilityFacade<Adapter extends SchemaAdapter> = AddMethod<
  SelectedCapability<Adapter, 'read'>,
  'read'
> &
  AddMethod<SelectedCapability<Adapter, 'props'>, 'props'> &
  AddMethod<SelectedCapability<Adapter, 'props'>, 'make'> &
  AddMethod<SelectedCapability<Adapter, 'encoded'>, 'encoded'> &
  AddMethod<SelectedCapability<Adapter, 'encoding'>, 'encode'> &
  AddMethod<SelectedCapability<Adapter, 'encoding'>, 'encodeAsync'> &
  AddMethod<SelectedCapability<Adapter, 'structure'>, 'fields'> &
  AddMethod<SelectedCapability<Adapter, 'structure'>, 'struct'> &
  AddMethod<SelectedCapability<Adapter, 'structure'>, 'policy'> &
  AddMethod<SelectedCapability<Adapter, 'derivation'>, 'derive'> &
  AddMethod<SelectedCapability<Adapter, 'jsonSchema'>, 'toJSONSchema'> &
  AddMethod<SelectedCapability<Adapter, 'bridge'>, 'bridge'>

type AdapterExtensions<Adapter extends SchemaAdapter> = Adapter extends {
  readonly classes: infer Classes
}
  ? Classes
  : object

export type SchemaFacade<Adapter extends SchemaAdapter> = {
  readonly decode: typeof decode
  readonly decodeAsync: typeof decodeAsync
  readonly decodeUnknown: typeof decodeUnknown
  readonly decodeUnknownAsync: typeof decodeUnknownAsync
} & CapabilityFacade<Adapter> & AdapterExtensions<Adapter>

const installSync = (
  target: Record<string, unknown>,
  adapter: SchemaAdapter,
  key: CapabilityKey,
  method: string
): void => {
  const selected = selectedCapability(adapter, key)
  if (selected === undefined) return

  let available = false
  try {
    available = typeof Reflect.get(selected.value, method) === 'function'
  } catch {
    return
  }
  if (!available) return

  target[method] = (...args: readonly unknown[]) =>
    syncCapability(method, selected.value, selected.owner, args)
}

const installAsync = (
  target: Record<string, unknown>,
  adapter: SchemaAdapter,
  key: CapabilityKey,
  method: string
): void => {
  const selected = selectedCapability(adapter, key)
  if (selected === undefined) return

  let available = false
  try {
    available = typeof Reflect.get(selected.value, method) === 'function'
  } catch {
    return
  }
  if (!available) return

  target[method] = (...args: readonly unknown[]) =>
    asyncCapability(method, selected.value, selected.owner, args)
}

/** Create an immutable, capability-gated local Schema facade. */
export const withAdapter = <Adapter extends SchemaAdapter>(
  adapter: Adapter
): SchemaFacade<Adapter> => {
  const facade: Record<string, unknown> = {
    decode,
    decodeAsync,
    decodeUnknown,
    decodeUnknownAsync
  }

  installSync(facade, adapter, 'read', 'read')
  installSync(facade, adapter, 'props', 'props')
  installSync(facade, adapter, 'props', 'make')
  installSync(facade, adapter, 'encoded', 'encoded')
  installSync(facade, adapter, 'encoding', 'encode')
  installAsync(facade, adapter, 'encoding', 'encodeAsync')
  installSync(facade, adapter, 'structure', 'fields')
  installSync(facade, adapter, 'structure', 'struct')
  installSync(facade, adapter, 'structure', 'policy')
  installSync(facade, adapter, 'derivation', 'derive')
  installSync(facade, adapter, 'jsonSchema', 'toJSONSchema')
  installSync(facade, adapter, 'bridge', 'bridge')

  let extensions: unknown
  try {
    extensions = Reflect.get(adapter, 'classes')
  } catch {
    extensions = undefined
  }
  if (isObjectLike(extensions)) {
    for (const key of Reflect.ownKeys(extensions)) {
      if (typeof key !== 'string') continue
      const value = Reflect.get(extensions, key)
      if (typeof value === 'function') facade[key] = value
    }
  }

  const frozenFacade = Object.freeze(facade)
  return new Proxy(frozenFacade, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)

      if (typeof property === 'string' && capabilityMethods.has(property)) {
        return () => unsupported(property)
      }

      return undefined
    }
  }) as unknown as SchemaFacade<Adapter>
}
