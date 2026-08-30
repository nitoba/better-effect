// oxlint-disable anti-slop/no-unknown-parameters -- codec callbacks and validators are explicit untrusted JavaScript boundaries.
// oxlint-disable anti-slop/no-runtime-typeof -- runtime guards are the codec trust boundary.

import { Result } from 'better-result'

import type { Result as ResultType, StandardSchemaV1 } from 'better-result'
import type { Effect as EffectType, EffectRequirements } from 'better-effect'

import type { JsonValue } from '../protocol/types'

import {
  copyDecodeFailure,
  copyEncodeFailure,
  JobDecodeFailure,
  JobEncodeFailure,
  sanitizeSchemaIssues
} from './errors'
import { validateJsonValue } from './json'
import type { CodecIssue, CodecPath } from './errors'

export type CodecEffect<Value, Failure> = EffectType<Value, Failure, never>

export type CodecCallbackResult<Value, Failure> =
  | Value
  | ResultType<Value, Failure>
  | PromiseLike<Value | ResultType<Value, Failure>>

type CodecOperation<Value, Failure> =
  | CodecEffect<Value, Failure>
  | Promise<CodecEffect<Value, Failure>>

type RequirementFree<Returned> =
  Returned extends PromiseLike<infer Awaited>
    ? [EffectRequirements<Awaited>] extends [never]
      ? Returned
      : never
    : [EffectRequirements<Returned>] extends [never]
      ? Returned
      : never

type UnknownResult = ResultType<unknown, unknown>

type CallbackOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }

type ReadDataProperty = {
  readonly present: boolean
  readonly value: unknown
}

type MutableCodecFailureOptions = {
  message: string
  code?: string
  path?: CodecPath
  issues?: readonly CodecIssue[]
}

const okEffect = <Value, Failure>(value: Value): CodecEffect<Value, Failure> =>
  // SAFETY: Codec Effects are the declaration-only better-effect facade over a Result.
  Result.ok<Value, Failure>(value) as CodecEffect<Value, Failure>

const errEffect = <Value, Failure>(error: Failure): CodecEffect<Value, Failure> =>
  // SAFETY: Codec Effects are the declaration-only better-effect facade over a Result.
  Result.err<Value, Failure>(error) as CodecEffect<Value, Failure>

const isPromiseLike = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- callback and schema boundaries may return arbitrary thenables.
  value: unknown
): value is PromiseLike<unknown> => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Promise-like values can be objects or functions.
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return false
  }

  try {
    // oxlint-disable-next-line anti-slop/no-reflect-get -- thenable detection is contained in the callback boundary.
    const then = Reflect.get(value, 'then')
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a callable then property identifies a thenable.
    return typeof then === 'function'
  } catch {
    return false
  }
}

const readDataProperty = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- schema result values are untrusted.
  value: unknown,
  key: string
): ReadDataProperty => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- schema results may be malformed JavaScript values.
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return { present: false, value: undefined }
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (descriptor === undefined || !('value' in descriptor)) {
      return { present: false, value: undefined }
    }

    return { present: true, value: descriptor.value }
  } catch {
    return { present: false, value: undefined }
  }
}

const isResultLike = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- custom codec callbacks are JavaScript boundaries.
  value: unknown
): value is UnknownResult => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Result values are object instances.
  if (typeof value !== 'object' || value === null) {
    return false
  }

  try {
    // oxlint-disable-next-line anti-slop/no-reflect-get -- Result-like values may come from a duplicated better-result package.
    const status = Reflect.get(value, 'status')
    // oxlint-disable-next-line anti-slop/no-reflect-get -- Result-like values may come from a duplicated better-result package.
    const isOk = Reflect.get(value, 'isOk')
    // oxlint-disable-next-line anti-slop/no-reflect-get -- Result-like values may come from a duplicated better-result package.
    const isErr = Reflect.get(value, 'isErr')
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Result instances expose both branch methods.
    return (
      (status === 'ok' || status === 'error') &&
      typeof isOk === 'function' &&
      typeof isErr === 'function'
    )
  } catch {
    return false
  }
}

const inspectCallbackResult = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- callback results are checked at runtime before use.
  value: unknown
): CallbackOutcome => {
  if (!isResultLike(value)) {
    return { ok: true, value }
  }

  return value.status === 'error'
    ? { ok: false, error: value.error }
    : { ok: true, value: value.value }
}

const makeEncodeFailure = (
  message: string,
  code: string,
  path?: CodecPath,
  issues?: readonly CodecIssue[]
): JobEncodeFailure => {
  const options: MutableCodecFailureOptions = { message, code }

  if (path !== undefined) {
    options.path = path
  }

  if (issues !== undefined) {
    options.issues = issues
  }

  return new JobEncodeFailure(options)
}

const makeDecodeFailure = (
  message: string,
  code: string,
  path?: CodecPath,
  issues?: readonly CodecIssue[]
): JobDecodeFailure => {
  const options: MutableCodecFailureOptions = { message, code }

  if (path !== undefined) {
    options.path = path
  }

  if (issues !== undefined) {
    options.issues = issues
  }

  return new JobDecodeFailure(options)
}

const jsonEncodeFailure = (code: string, path: CodecPath): JobEncodeFailure =>
  makeEncodeFailure('Encoded value is not JSON-safe', code, path, [
    { message: 'Encoded value is not JSON-safe', code, path }
  ])

const jsonDecodeFailure = (code: string, path: CodecPath): JobDecodeFailure =>
  makeDecodeFailure('Decoded value is not JSON-safe', code, path, [
    { message: 'Decoded value is not JSON-safe', code, path }
  ])

const normalizeCallbackFailure = (
  operation: 'encode' | 'decode',
  error: unknown
): JobEncodeFailure | JobDecodeFailure => {
  if (operation === 'encode') {
    return JobEncodeFailure.is(error)
      ? copyEncodeFailure(error)
      : new JobEncodeFailure({ message: 'Codec encode operation failed', code: 'callback-failure' })
  }

  return JobDecodeFailure.is(error)
    ? copyDecodeFailure(error)
    : new JobDecodeFailure({ message: 'Codec decode operation failed', code: 'callback-failure' })
}

const invokeCallback = <Value, Failure extends JobEncodeFailure | JobDecodeFailure>(
  operation: 'encode' | 'decode',
  callback: () => CodecCallbackResult<Value, Failure>,
  onSuccess: (value: unknown) => CodecEffect<Value, Failure>
): CodecOperation<Value, Failure> => {
  const failed = (error?: unknown): CodecEffect<Value, Failure> => {
    const normalized = normalizeCallbackFailure(operation, error)

    // SAFETY: The operation-specific branch constructs the matching tagged failure type.
    return errEffect<Value, Failure>(normalized as Failure)
  }

  const settle = (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- callback results are normalized before reaching the codec success channel.
    value: unknown
  ): CodecEffect<Value, Failure> => {
    try {
      const outcome = inspectCallbackResult(value)

      if (!outcome.ok) {
        return failed(outcome.error)
      }

      return onSuccess(outcome.value)
    } catch {
      return failed()
    }
  }

  try {
    const returned = callback()

    if (isPromiseLike(returned)) {
      return Promise.resolve(returned).then(settle, () => failed())
    }

    return settle(returned)
  } catch {
    return failed()
  }
}

const encodeJsonOutput = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- custom encoders must be checked at the storage boundary.
  value: unknown
): CodecEffect<JsonValue, JobEncodeFailure> => {
  const checked = validateJsonValue(value)

  return checked.ok
    ? okEffect(checked.value)
    : errEffect(jsonEncodeFailure(checked.code, checked.path))
}

const decodeCustomOutput = <Value>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- custom decoders define their in-memory value boundary.
  value: unknown
): CodecEffect<Value, JobDecodeFailure> => {
  // SAFETY: The decoder callback's public contract declares Value; this is the final custom boundary.
  return okEffect(value as Value)
}

const primitiveCodec = <Value extends JsonValue>(
  label: string,
  guard: (value: unknown) => value is Value
): Codec<Value, Value> => {
  const encode = (value: Value): CodecEffect<JsonValue, JobEncodeFailure> =>
    guard(value)
      ? okEffect(value)
      : errEffect(makeEncodeFailure(`Value is not a ${label}`, 'invalid-type'))

  const decode = (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- decoding begins with unknown persisted data.
    value: unknown
  ): CodecEffect<Value, JobDecodeFailure> =>
    guard(value)
      ? okEffect(value)
      : errEffect(makeDecodeFailure(`Value is not a ${label}`, 'invalid-type'))

  return Object.freeze({ encode, decode })
}

const voidCodec: Codec<void, void> = Object.freeze({
  encode: (value: void): CodecEffect<JsonValue, JobEncodeFailure> =>
    value === undefined
      ? okEffect(null)
      : errEffect(makeEncodeFailure('Void values are represented by null', 'invalid-type')),
  decode: (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- decoding begins with unknown persisted data.
    value: unknown
  ): CodecEffect<void, JobDecodeFailure> =>
    value === null
      ? okEffect(undefined)
      : errEffect(makeDecodeFailure('Void values are represented by null', 'invalid-type'))
})

export interface Codec<Input, Value = Input> {
  /** Convert an in-memory value to a JSON-safe persisted value. */
  readonly encode: (value: Value) => CodecOperation<JsonValue, JobEncodeFailure>
  /** Validate and convert an unknown persisted value to the in-memory value. */
  readonly decode: (value: unknown) => CodecOperation<Value, JobDecodeFailure>
}

export type CodecMakeOptions<
  Value,
  EncodeReturn extends CodecCallbackResult<JsonValue, JobEncodeFailure> = CodecCallbackResult<
    JsonValue,
    JobEncodeFailure
  >,
  DecodeReturn extends CodecCallbackResult<Value, JobDecodeFailure> = CodecCallbackResult<
    Value,
    JobDecodeFailure
  >
> = {
  readonly encode: (value: Value) => EncodeReturn & RequirementFree<EncodeReturn>
  readonly decode: (value: unknown) => DecodeReturn & RequirementFree<DecodeReturn>
}

/** Create a codec from Result/raw callbacks; callbacks are intentionally requirement-free. */
export function make<
  Value,
  EncodeReturn extends CodecCallbackResult<JsonValue, JobEncodeFailure> = CodecCallbackResult<
    JsonValue,
    JobEncodeFailure
  >,
  DecodeReturn extends CodecCallbackResult<Value, JobDecodeFailure> = CodecCallbackResult<
    Value,
    JobDecodeFailure
  >
>(options: CodecMakeOptions<Value, EncodeReturn, DecodeReturn>): Codec<Value, Value>
export function make<Value>(options: CodecMakeOptions<Value>): Codec<Value, Value> {
  const encode = (value: Value): CodecOperation<JsonValue, JobEncodeFailure> =>
    invokeCallback<JsonValue, JobEncodeFailure>(
      'encode',
      () => options.encode(value),
      encodeJsonOutput
    )

  const decode = (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- decoding begins with unknown persisted data.
    value: unknown
  ): CodecOperation<Value, JobDecodeFailure> =>
    invokeCallback<Value, JobDecodeFailure>(
      'decode',
      () => options.decode(value),
      decodeCustomOutput
    )

  return Object.freeze({ encode, decode })
}

/** Create an identity JSON codec with iterative, accessor-free boundary validation. */
export function json<Value extends JsonValue = JsonValue>(): Codec<Value, Value> {
  const encode = (value: Value): CodecEffect<JsonValue, JobEncodeFailure> => {
    const checked = validateJsonValue(value)

    return checked.ok
      ? okEffect(checked.value)
      : errEffect(jsonEncodeFailure(checked.code, checked.path))
  }

  const decode = (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- decoding begins with unknown persisted data.
    value: unknown
  ): CodecEffect<Value, JobDecodeFailure> => {
    const checked = validateJsonValue(value)

    if (!checked.ok) {
      return errEffect(jsonDecodeFailure(checked.code, checked.path))
    }

    // SAFETY: json<Value>() makes the caller's declared JSON subtype the codec value type.
    return okEffect(checked.value as Value)
  }

  return Object.freeze({ encode, decode })
}

type SchemaInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>
type SchemaOutput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>

type StandardSchemaEncoder<Value, Returned> = (value: Value) => Returned & RequirementFree<Returned>

type StandardSchemaEncodeResult = CodecCallbackResult<JsonValue, JobEncodeFailure>

export type StandardSchemaCodecOptions<
  Schema extends StandardSchemaV1,
  EncodeReturn extends StandardSchemaEncodeResult = StandardSchemaEncodeResult
> = [SchemaOutput<Schema>] extends [JsonValue]
  ? {
      readonly schema: Schema
      readonly encode?: StandardSchemaEncoder<SchemaOutput<Schema>, EncodeReturn>
    }
  : {
      readonly schema: Schema
      readonly encode: StandardSchemaEncoder<SchemaOutput<Schema>, EncodeReturn>
    }

const schemaFailure = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- schema results are untrusted validator output.
  result: unknown
): JobDecodeFailure => {
  const issues = readDataProperty(result, 'issues')
  const safeIssues = sanitizeSchemaIssues(issues.value)
  const first = safeIssues[0]
  const options: MutableCodecFailureOptions = {
    message: 'Schema validation failed',
    issues: safeIssues
  }

  if (first?.code !== undefined) {
    options.code = first.code
  }

  if (first?.path !== undefined) {
    options.path = first.path
  }

  return new JobDecodeFailure(options)
}

const invalidSchemaResult = (): JobDecodeFailure =>
  new JobDecodeFailure({
    message: 'Schema returned an invalid validation result',
    code: 'invalid-result'
  })

const normalizeSchemaResult = <Value>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Standard Schema output is validated at runtime.
  result: unknown,
  requireJson: boolean
): CodecEffect<Value, JobDecodeFailure> => {
  const issues = readDataProperty(result, 'issues')

  if (issues.present && issues.value !== undefined) {
    return errEffect(schemaFailure(result))
  }

  const output = readDataProperty(result, 'value')

  if (!output.present) {
    return errEffect(invalidSchemaResult())
  }

  if (requireJson) {
    const checked = validateJsonValue(output.value)

    if (!checked.ok) {
      return errEffect(jsonDecodeFailure(checked.code, checked.path))
    }
  }

  // SAFETY: Standard Schema's successful result declares Value as its output type.
  return okEffect(output.value as Value)
}

const runSchemaValidation = <Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
  requireJson: boolean
): CodecOperation<SchemaOutput<Schema>, JobDecodeFailure> => {
  try {
    const validation = schema['~standard'].validate(value)

    if (isPromiseLike(validation)) {
      return Promise.resolve(validation).then(
        (result) => normalizeSchemaResult<SchemaOutput<Schema>>(result, requireJson),
        () =>
          errEffect(
            new JobDecodeFailure({ message: 'Schema validation failed', code: 'validator-failure' })
          )
      )
    }

    return normalizeSchemaResult<SchemaOutput<Schema>>(validation, requireJson)
  } catch {
    return errEffect(
      new JobDecodeFailure({ message: 'Schema validation failed', code: 'validator-failure' })
    )
  }
}

/**
 * Adapt a structural Standard Schema without importing a validator library.
 *
 * Codec v0.1 is deliberately requirement-free: validation and encode callbacks
 * cannot acquire Services. This keeps codecs portable across processes and
 * leaves contextual orchestration to the caller.
 */
export function standardSchema<
  Schema extends StandardSchemaV1,
  EncodeReturn extends StandardSchemaEncodeResult = StandardSchemaEncodeResult
>(
  options: StandardSchemaCodecOptions<Schema, EncodeReturn>
): Codec<SchemaInput<Schema>, SchemaOutput<Schema>> {
  const explicitEncode = options.encode
  const requireJsonOutput = explicitEncode === undefined

  const encode = (value: SchemaOutput<Schema>): CodecOperation<JsonValue, JobEncodeFailure> => {
    if (explicitEncode !== undefined) {
      return invokeCallback<JsonValue, JobEncodeFailure>(
        'encode',
        () => explicitEncode(value),
        encodeJsonOutput
      )
    }

    return encodeJsonOutput(value)
  }

  const decode = (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- decoding begins with unknown persisted data.
    value: unknown
  ): CodecOperation<SchemaOutput<Schema>, JobDecodeFailure> =>
    runSchemaValidation(options.schema, value, requireJsonOutput)

  return Object.freeze({ encode, decode })
}

const stringCodec = primitiveCodec<string>('string', (value): value is string => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- primitive codec validation is intentionally explicit.
  return typeof value === 'string'
})

const numberCodec = primitiveCodec<number>('finite number', (value): value is number => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- primitive codec validation is intentionally explicit.
  return typeof value === 'number' && Number.isFinite(value)
})

const booleanCodec = primitiveCodec<boolean>('boolean', (value): value is boolean => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- primitive codec validation is intentionally explicit.
  return typeof value === 'boolean'
})

export const Codec = {
  make,
  json,
  standardSchema,
  string: stringCodec,
  number: numberCodec,
  boolean: booleanCodec,
  void: voidCodec
} as const

export declare namespace Codec {
  /** The schema/input-side type associated with a codec. */
  export type Input<Current> = Current extends Codec<infer Input, infer _Value> ? Input : never

  /** The in-memory value type associated with a codec. */
  export type Value<Current> = Current extends Codec<infer _Input, infer Value> ? Value : never
}
