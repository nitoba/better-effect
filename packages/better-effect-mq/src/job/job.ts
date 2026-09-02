// oxlint-disable anti-slop/no-runtime-typeof -- job definitions and callback results cross untyped JavaScript boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- definition and callback guards accept hostile values.
// oxlint-disable anti-slop/no-unknown-returns -- internal boundary readers return deliberately untyped values.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- fixed option keys are parsed before use.
// oxlint-disable anti-slop/no-chained-type-assertions -- assertions are localized at erased runtime boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- checked runtime boundaries justify these assertions.

import { types as nodeTypes } from 'node:util'

import { Result, type Result as ResultType } from 'better-result'

import type { Codec } from '../codec'
import {
  isMarkedCodecOperation,
  isMarkedCodecSnapshot,
  isMarkedVoidCodec,
  markVoidCodecSnapshot
} from '../codec/snapshot'
import {
  JobDefinitionError,
  makeJobName,
  makePersistedBackoff,
  makeQueueName,
  validatePositiveDuration
} from '../protocol'
import type { PersistedBackoff } from '../protocol'
import { normalizeRetryPolicy } from '../retry'
import type { RetryPolicy } from '../retry'
import { JobStore, isJobStoreToken } from '../store'
import type { AnyJobStoreToken, DefaultJobStoreToken } from '../store'
import { makeJobOperations } from './application'
import type { JobBoundOperations, JobOperationDescriptor } from './application'

import type { QueueDefinition } from './queue'
import { isQueueDefinition } from './queue'
import {
  isCallable,
  isFrozenSafely,
  isPlainObject,
  jobTypeId,
  markDescriptor,
  readOwnDataProperty
} from './internal'

declare const JobDefinitionTypeId: unique symbol

const unrecoverableFailures = new WeakSet<object>()

export const isUnrecoverableFailure = (value: unknown): boolean =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? unrecoverableFailures.has(value)
    : false

export const markUnrecoverable = <Failure>(failure: Failure): Failure => {
  if ((typeof failure === 'object' && failure !== null) || typeof failure === 'function') {
    unrecoverableFailures.add(failure)
  }
  return failure
}

/** A codec-shaped value used only to erase heterogeneous codec details internally. */
export type CodecLike = {
  readonly encode: (...arguments_: never[]) => unknown
  readonly decode: (...arguments_: never[]) => unknown
}

type CodecInputOf<Current extends CodecLike> =
  Current extends Codec<infer Input, infer _Value> ? Input : never

type CodecValueOf<Current extends CodecLike> =
  Current extends Codec<infer _Input, infer Value> ? Value : never

type CodecSnapshot<Current extends CodecLike> = {
  readonly encode: Current['encode']
  readonly decode: Current['decode']
}

type OptionalCodecSnapshot<Current extends CodecLike | undefined> = Current extends CodecLike
  ? CodecSnapshot<Current>
  : undefined

type EnsureCodec<Current extends CodecLike> =
  Current extends Codec<infer _Input, infer _Value> ? Current : never

type FailureValueOf<Current extends CodecLike | undefined> = Current extends CodecLike
  ? CodecValueOf<Current>
  : never

type OptionalCodec<Current extends CodecLike | undefined> = Current extends undefined
  ? Current
  : Current extends CodecLike
    ? Current & EnsureCodec<Current>
    : never

type PositiveIntegerLiteral<Value extends number> = number extends Value
  ? Value
  : `${Value}` extends `${bigint}`
    ? `${Value}` extends `-${string}` | '0'
      ? never
      : Value
    : never

export type NonEmptyStringLiteral<Value extends string> = string extends Value
  ? Value
  : Value extends ''
    ? never
    : Value

export type JobIdentity<
  Queue extends string = string,
  Name extends string = string,
  Version extends number = number
> = {
  readonly queue: Queue
  readonly name: Name
  readonly version: Version
}

export type JobDefaults = {
  readonly attempts: number
  readonly backoff: PersistedBackoff | undefined
  readonly timeoutMs: number | undefined
  readonly priority: number
}

export type JobDefaultsInput = {
  readonly attempts?: number
  readonly backoff?: PersistedBackoff | RetryPolicy
  readonly timeoutMs?: number
  readonly priority?: number
}

export type IdempotencyKeyCallback<Payload> = (payload: Payload) => string | undefined

export type MetadataCallback<Payload> = (payload: Payload) => Readonly<Record<string, string>>

export type RetryableCallback<Failure> = (failure: Failure) => boolean

export type JobDefinitionOptions<
  Version extends number,
  PayloadCodec extends CodecLike,
  ResultCodec extends CodecLike | undefined = undefined,
  FailureCodec extends CodecLike | undefined = undefined,
  Store extends AnyJobStoreToken = DefaultJobStoreToken
> = {
  readonly version: PositiveIntegerLiteral<Version>
  readonly payload: PayloadCodec & EnsureCodec<PayloadCodec>
  readonly result?: OptionalCodec<ResultCodec>
  readonly failure?: OptionalCodec<FailureCodec>
  readonly defaults?: JobDefaultsInput
  readonly idempotencyKey?: IdempotencyKeyCallback<CodecValueOf<PayloadCodec>>
  readonly metadata?: MetadataCallback<CodecValueOf<PayloadCodec>>
  readonly retryable?: FailureCodec extends undefined
    ? never
    : RetryableCallback<FailureValueOf<FailureCodec>>
  /** The Service token used by future producer and worker operations. */
  readonly store?: Store
}

type RetryableFor<FailureCodec extends CodecLike | undefined> = FailureCodec extends CodecLike
  ? RetryableCallback<CodecValueOf<FailureCodec>>
  : undefined

/** The immutable, inert descriptor shared by producers and workers. */
export interface JobDefinition<
  Queue extends string = string,
  Name extends string = string,
  Version extends number = number,
  PayloadCodec extends CodecLike = CodecLike,
  ResultCodec extends CodecLike | undefined = undefined,
  FailureCodec extends CodecLike | undefined = undefined,
  Store extends AnyJobStoreToken = DefaultJobStoreToken
> extends JobBoundOperations<
  CodecInputOf<PayloadCodec>,
  CodecValueOf<NonNullable<ResultCodec>>,
  FailureValueOf<FailureCodec>,
  Store
> {
  readonly [JobDefinitionTypeId]: 'JobDefinition'
  readonly queue: Queue
  readonly name: Name
  readonly version: Version
  readonly identity: JobIdentity<Queue, Name, Version>
  readonly payload: CodecSnapshot<PayloadCodec>
  readonly result: OptionalCodecSnapshot<ResultCodec>
  readonly failure: OptionalCodecSnapshot<FailureCodec>
  readonly defaults: JobDefaults
  readonly store: Store
  readonly idempotencyKey: IdempotencyKeyCallback<CodecValueOf<PayloadCodec>> | undefined
  readonly metadata: MetadataCallback<CodecValueOf<PayloadCodec>> | undefined
  readonly retryable: RetryableFor<FailureCodec>
  readonly retryPolicy: RetryPolicy | undefined
}

export type AnyJobDefinition = JobDefinition<
  string,
  string,
  number,
  CodecLike,
  CodecLike | undefined,
  CodecLike | undefined,
  AnyJobStoreToken
>

type RawDefinitionOptions = {
  readonly version: unknown
  readonly payload: unknown
  readonly result: unknown
  readonly failure: unknown
  readonly defaults: unknown
  readonly idempotencyKey: unknown
  readonly metadata: unknown
  readonly retryable: unknown
  readonly store: unknown
}

type CanonicalDefinitionOptions = RawDefinitionOptions

const definitionFields = [
  'version',
  'payload',
  'result',
  'failure',
  'defaults',
  'idempotencyKey',
  'metadata',
  'retryable',
  'store'
] as const

const defaultFields = ['attempts', 'backoff', 'timeoutMs', 'priority'] as const

const invalid = <Value>(field: string, message: string): ResultType<Value, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

const throwDefinition = (result: ResultType<unknown, JobDefinitionError>): never => {
  if (Result.isError(result)) {
    throw result.error
  }

  throw new JobDefinitionError({ field: 'definition', message: 'invalid job definition' })
}

const readDataFields = (
  value: unknown,
  allowedFields: readonly string[],
  field: string
): ResultType<Readonly<Record<string, unknown>>, JobDefinitionError> => {
  if (!isPlainObject(value)) {
    return invalid(field, 'must be a plain object')
  }

  try {
    const allowed = new Set(allowedFields)
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        return invalid(field, 'contains unsupported fields')
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key)

      if (descriptor === undefined || !('value' in descriptor)) {
        return invalid(field, 'contains an accessor field')
      }

      Object.defineProperty(fields, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true
      })
    }

    return Result.ok(Object.freeze(fields))
  } catch {
    return invalid(field, 'could not read fields')
  }
}

const hasField = (fields: Readonly<Record<string, unknown>>, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(fields, field)

const fieldValue = (fields: Readonly<Record<string, unknown>>, field: string): unknown =>
  fields[field]

const readDefinitionOptions = (
  value: unknown
): ResultType<CanonicalDefinitionOptions, JobDefinitionError> => {
  const fields = readDataFields(value, definitionFields, 'options')

  if (Result.isError(fields)) {
    return Result.err(fields.error)
  }

  if (!hasField(fields.value, 'version')) {
    return invalid('version', 'is required')
  }

  if (!hasField(fields.value, 'payload')) {
    return invalid('payload', 'is required')
  }

  return Result.ok({
    version: fieldValue(fields.value, 'version'),
    payload: fieldValue(fields.value, 'payload'),
    result: fieldValue(fields.value, 'result'),
    failure: fieldValue(fields.value, 'failure'),
    defaults: fieldValue(fields.value, 'defaults'),
    idempotencyKey: fieldValue(fields.value, 'idempotencyKey'),
    metadata: fieldValue(fields.value, 'metadata'),
    retryable: fieldValue(fields.value, 'retryable'),
    store: fieldValue(fields.value, 'store')
  })
}

const normalizeDefaults = (value: unknown): ResultType<JobDefaults, JobDefinitionError> => {
  const defaults = {
    attempts: 1,
    backoff: undefined as PersistedBackoff | undefined,
    timeoutMs: undefined as number | undefined,
    priority: 0
  }

  if (value === undefined) {
    return Result.ok(Object.freeze(defaults))
  }

  const fields = readDataFields(value, defaultFields, 'defaults')

  if (Result.isError(fields)) {
    return Result.err(fields.error)
  }

  const attemptsValue = fieldValue(fields.value, 'attempts')

  if (attemptsValue !== undefined) {
    if (
      typeof attemptsValue !== 'number' ||
      !Number.isSafeInteger(attemptsValue) ||
      attemptsValue < 1
    ) {
      return invalid('defaults.attempts', 'must be a positive safe integer')
    }

    defaults.attempts = attemptsValue
  }

  const timeoutValue = fieldValue(fields.value, 'timeoutMs')

  if (timeoutValue !== undefined) {
    const timeout = validatePositiveDuration(timeoutValue, 'defaults.timeoutMs')

    if (Result.isError(timeout)) {
      return Result.err(timeout.error)
    }

    defaults.timeoutMs = timeout.value
  }

  const priorityValue = fieldValue(fields.value, 'priority')

  if (priorityValue !== undefined) {
    if (typeof priorityValue !== 'number' || !Number.isSafeInteger(priorityValue)) {
      return invalid('defaults.priority', 'must be a safe integer')
    }

    defaults.priority = priorityValue
  }

  const backoffValue = fieldValue(fields.value, 'backoff')

  if (backoffValue !== undefined) {
    const policy = normalizeRetryPolicy(backoffValue)
    if (Result.isError(policy)) return Result.err(policy.error)
    if (policy.value !== undefined) {
      if (policy.value.type !== 'custom' && policy.value.type !== 'never') {
        defaults.backoff = policy.value.backoff
      }
      if (policy.value.maxAttempts !== undefined && attemptsValue === undefined) {
        defaults.attempts = policy.value.maxAttempts
      }
      if (
        policy.value.maxAttempts !== undefined &&
        attemptsValue !== undefined &&
        policy.value.maxAttempts !== attemptsValue
      ) {
        return invalid('defaults.backoff.maxAttempts', 'must match defaults.attempts')
      }
    }
  }

  return Result.ok(Object.freeze(defaults))
}

type CodecMethod = (value: unknown) => unknown

type CodecMethodLookup =
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' }
  | { readonly status: 'found'; readonly method: unknown }

type DataDescriptorLookup =
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' }
  | { readonly status: 'found'; readonly value: unknown }

type ReceiverValueSnapshot = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

type ReceiverSnapshotContext = {
  readonly active: Set<object>
  readonly copies: Map<object, unknown>
  readonly methods: Map<object, unknown>
  propertyCount: number
}

type ReceiverPrototypeEntry = { readonly key: string; readonly value: unknown }
type ReceiverPrototypeLevel = readonly ReceiverPrototypeEntry[]

const maxCodecPrototypeDepth = 32
const maxCodecReceiverDepth = 32
const maxCodecReceiverProperties = 4_096

const isObjectLikeValue = (value: unknown): boolean => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- codec values may be objects or callable objects.
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

const isProxyValue = (value: unknown): boolean => {
  if (!isObjectLikeValue(value)) {
    return false
  }

  try {
    return nodeTypes.isProxy(value)
  } catch {
    return true
  }
}

const readDataDescriptor = (
  // oxlint-disable-next-line anti-slop/no-object-parameters -- this helper reads an already-classified codec receiver.
  value: object,
  key: PropertyKey
): DataDescriptorLookup => {
  if (isProxyValue(value)) {
    return { status: 'invalid' }
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (descriptor === undefined) {
      return { status: 'missing' }
    }

    if (!('value' in descriptor)) {
      return { status: 'invalid' }
    }

    return { status: 'found', value: descriptor.value }
  } catch {
    return { status: 'invalid' }
  }
}

const readCodecMethod = (value: unknown, key: 'encode' | 'decode'): CodecMethodLookup => {
  if (!isObjectLikeValue(value)) {
    return { status: 'missing' }
  }

  // SAFETY: `isObjectLikeValue` permits only values accepted by Object.getPrototypeOf.
  let current = value as object
  const visited = new Set<object>()

  for (let depth = 0; current !== null && depth <= maxCodecPrototypeDepth; depth += 1) {
    if (visited.has(current)) {
      return { status: 'invalid' }
    }

    visited.add(current)
    const descriptor = readDataDescriptor(current, key)

    if (descriptor.status === 'invalid') {
      return { status: 'invalid' }
    }

    if (descriptor.status === 'found') {
      return { status: 'found', method: descriptor.value }
    }

    try {
      current = Object.getPrototypeOf(current)
    } catch {
      return { status: 'invalid' }
    }
  }

  return { status: 'invalid' }
}

const isSnapshotPrimitive = (value: unknown): boolean => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- receiver state is restricted to inert primitives.
  return (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}

const receiverArrayIndex = (key: string): number | undefined => {
  if (key.length === 0) {
    return undefined
  }

  const index = Number(key)

  if (!Number.isSafeInteger(index) || index < 0 || index >= 4_294_967_295) {
    return undefined
  }

  return String(index) === key ? index : undefined
}

const snapshotReceiverValue = (
  value: unknown,
  context: ReceiverSnapshotContext,
  depth: number
): ReceiverValueSnapshot => {
  if (isSnapshotPrimitive(value)) {
    return { ok: true, value }
  }

  if (isProxyValue(value)) {
    return { ok: false }
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- functions and symbols are not snapshot state.
  if (typeof value !== 'object' || value === null) {
    return { ok: false }
  }

  if (depth > maxCodecReceiverDepth || context.active.has(value)) {
    return { ok: false }
  }

  const cached = context.copies.get(value)

  if (cached !== undefined || context.copies.has(value)) {
    return { ok: true, value: cached }
  }

  let isArray: boolean
  let prototype: object | null
  let keys: readonly PropertyKey[]

  try {
    isArray = Array.isArray(value)
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return { ok: false }
  }

  if (isArray) {
    if (prototype !== Array.prototype && prototype !== null) {
      return { ok: false }
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false }
  }

  if (keys.length > maxCodecReceiverProperties) {
    return { ok: false }
  }

  let copy: Record<string, unknown> | unknown[]

  try {
    if (isArray) {
      const length = readDataDescriptor(value, 'length')

      if (
        length.status !== 'found' ||
        typeof length.value !== 'number' ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        length.value > maxCodecReceiverProperties
      ) {
        return { ok: false }
      }

      copy = []
      copy.length = length.value
    } else {
      copy = Object.create(null) as Record<string, unknown>
    }

    context.propertyCount += keys.length

    if (context.propertyCount > maxCodecReceiverProperties) {
      return { ok: false }
    }

    context.copies.set(value, copy)
    context.active.add(value)

    if (isArray) {
      const seen = new Set<number>()

      for (const key of keys) {
        if (key === 'length') {
          continue
        }

        if (typeof key !== 'string') {
          return { ok: false }
        }

        const index = receiverArrayIndex(key)
        const descriptor = readDataDescriptor(value, key)

        if (
          index === undefined ||
          index >= (copy as unknown[]).length ||
          seen.has(index) ||
          descriptor.status !== 'found'
        ) {
          return { ok: false }
        }

        const child = snapshotReceiverValue(descriptor.value, context, depth + 1)

        if (!child.ok) {
          return { ok: false }
        }

        Object.defineProperty(copy, key, {
          configurable: true,
          enumerable: true,
          value: child.value,
          writable: true
        })
        seen.add(index)
      }

      if (seen.size !== (copy as unknown[]).length) {
        return { ok: false }
      }
    } else {
      for (const key of keys) {
        if (typeof key !== 'string') {
          return { ok: false }
        }

        const descriptor = readDataDescriptor(value, key)

        if (descriptor.status !== 'found') {
          return { ok: false }
        }

        const child = snapshotReceiverValue(descriptor.value, context, depth + 1)

        if (!child.ok) {
          return { ok: false }
        }

        Object.defineProperty(copy, key, {
          configurable: true,
          enumerable: true,
          value: child.value,
          writable: true
        })
      }
    }

    return { ok: true, value: Object.freeze(copy) }
  } catch {
    return { ok: false }
  } finally {
    context.active.delete(value)
  }
}

const isIntrinsicFunctionProperty = (key: string): boolean =>
  key === 'length' ||
  key === 'name' ||
  key === 'arguments' ||
  key === 'caller' ||
  key === 'prototype'

const readFunctionSource = (value: unknown): string | undefined => {
  if (!isCallable(value)) {
    return undefined
  }

  try {
    const source = Function.prototype.toString.call(value).trim()

    return source.length === 0 || source.includes('[native code]') ? undefined : source
  } catch {
    return undefined
  }
}

const unicodeEscapePattern = /\\u([0-9a-f]{4}|\{[0-9a-f]{1,6}\})/giu

const decodeUnicodeEscapes = (source: string): string =>
  source.replace(unicodeEscapePattern, (escape) => {
    const digits = escape[2] === '{' ? escape.slice(3, -1) : escape.slice(2)
    const codePoint = Number.parseInt(digits, 16)

    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escape
  })

const arrowFunctionSourcePattern = /^(?:async\b\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/u

/**
 * Check the raw source before tokenization because the scanner may mistake a
 * division after a numeric literal for a regex and skip `this` in an arrow.
 * The anchored arrow prefix keeps ordinary methods with dynamic `this` safe.
 */
const hasPotentialArrowThis = (source: string): boolean => {
  const decodedSource = decodeUnicodeEscapes(source)

  return arrowFunctionSourcePattern.test(decodedSource) && decodedSource.includes('this')
}

/**
 * Check the raw source before tokenization because the scanner may mistake a
 * division after a numeric literal for a regex and skip an actual direct eval.
 * This intentionally treats textual and escaped eval spellings as unsafe; this
 * boundary prefers rejecting harmless text over allowing receiver-sensitive eval.
 */
const hasPotentialDirectEval = (source: string): boolean =>
  source.includes('eval') || decodeUnicodeEscapes(source).includes('eval')

/**
 * Check the raw source before tokenization because the scanner may mistake a
 * division after a numeric literal for a regex and skip an actual super receiver.
 * This intentionally treats textual and escaped super spellings as unsafe; this
 * boundary prefers rejecting harmless text over allowing receiver-sensitive super.
 */
const hasPotentialSuper = (source: string): boolean =>
  source.includes('super') || decodeUnicodeEscapes(source).includes('super')

/**
 * Check only syntax whose receiver semantics cannot survive detachment. This is
 * deliberately not a free-variable or closure analysis: direct user functions
 * retain their lexical environment when the Job invokes them with the snapshot receiver.
 */
const hasUnsafeMethodSyntax = (source: string): boolean => {
  if (
    hasPotentialArrowThis(source) ||
    hasPotentialDirectEval(source) ||
    hasPotentialSuper(source)
  ) {
    return true
  }

  const tokens = tokenizeFunctionSource(source)

  if (tokens === undefined) {
    return true
  }

  return (
    tokens.some((token, index) => {
      // Do not try to decode escaped identifiers: they can hide private names or eval.
      if (
        token.value === '#' ||
        token.value === '\\' ||
        (token.identifier && token.value === 'eval')
      ) {
        return true
      }

      if (
        token.value === 'new' &&
        tokens[index + 1]?.value === '.' &&
        tokens[index + 2]?.value === 'target'
      ) {
        return true
      }

      if (token.value !== 'super') {
        return false
      }

      return tokens[index - 1]?.value !== '.' && tokens[index - 1]?.value !== '?.'
    }) ||
    (isArrowFunctionSource(tokens) && tokens.some((token) => token.value === 'this'))
  )
}

const hasOnlyIntrinsicFunctionProperties = (
  // oxlint-disable-next-line anti-slop/no-object-parameters -- the value was narrowed to a callable object.
  value: object
): boolean => {
  try {
    return Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && isIntrinsicFunctionProperty(key)
    )
  } catch {
    return false
  }
}

type SourceToken = { readonly value: string; readonly identifier: boolean }

const isSourceIdentifierStart = (value: string): boolean => /^[A-Za-z_$]$/u.test(value)
const isSourceIdentifierPart = (value: string): boolean => /^[A-Za-z0-9_$]$/u.test(value)

const regexPrecedingTokens = new Set([
  '(',
  '[',
  '{',
  '=',
  ':',
  ',',
  ';',
  '!',
  '~',
  '?',
  '&',
  '|',
  '=>',
  'return',
  'throw',
  'case',
  'delete',
  'void',
  'typeof',
  'yield',
  'await',
  'in',
  'of',
  'instanceof'
])

const isRegexStart = (previous: string | undefined): boolean =>
  previous === undefined || regexPrecedingTokens.has(previous)

const tokenizeFunctionSource = (source: string): readonly SourceToken[] | undefined => {
  const tokens: SourceToken[] = []
  let index = 0
  let scanCode: (stopAtBrace: boolean) => boolean

  const skipQuoted = (quote: string): boolean => {
    index += 1

    while (index < source.length) {
      const character = source[index]

      if (character === undefined) {
        return false
      }

      if (character.charCodeAt(0) === 92) {
        index += 2
        continue
      }

      index += 1

      if (character === quote) {
        return true
      }
    }

    return false
  }

  const scanTemplate = (): boolean => {
    index += 1

    while (index < source.length) {
      const character = source[index]

      if (character === undefined) {
        return false
      }

      if (character.charCodeAt(0) === 92) {
        index += 2
      } else if (character === '`') {
        index += 1
        return true
      } else if (character === '$' && source[index + 1] === '{') {
        index += 2

        if (!scanCode(true)) {
          return false
        }
      } else {
        index += 1
      }
    }

    return false
  }

  const skipRegex = (): boolean => {
    index += 1
    let inCharacterClass = false

    while (index < source.length) {
      const character = source[index]

      if (character === undefined) {
        return false
      }

      if (character.charCodeAt(0) === 92) {
        index += 2
        continue
      }

      if (character === '[') {
        inCharacterClass = true
      } else if (character === ']') {
        inCharacterClass = false
      } else if (character === '/' && !inCharacterClass) {
        index += 1

        while (index < source.length && isSourceIdentifierPart(source[index] ?? '')) {
          index += 1
        }

        return true
      }

      index += 1
    }

    return false
  }

  scanCode = (stopAtBrace: boolean): boolean => {
    let braceDepth = 0

    while (index < source.length) {
      const character = source[index]
      const next = source[index + 1]

      if (character === undefined) {
        return false
      }

      if (stopAtBrace && character === '}' && braceDepth === 0) {
        index += 1
        return true
      }

      if (character === '/' && next === '/') {
        index += 2

        while (index < source.length && source[index]?.charCodeAt(0) !== 10) {
          index += 1
        }

        continue
      }

      if (character === '/' && next === '*') {
        const end = source.indexOf('*/', index + 2)

        if (end === -1) {
          return false
        }

        index = end + 2
        continue
      }

      if (character === '/' && isRegexStart(tokens[tokens.length - 1]?.value)) {
        if (!skipRegex()) {
          return false
        }

        continue
      }

      if (character.charCodeAt(0) === 39 || character.charCodeAt(0) === 34) {
        if (!skipQuoted(character)) {
          return false
        }

        continue
      }

      if (character === '`') {
        if (!scanTemplate()) {
          return false
        }

        continue
      }

      if (isSourceIdentifierStart(character)) {
        const start = index
        index += 1

        while (index < source.length && isSourceIdentifierPart(source[index] ?? '')) {
          index += 1
        }

        tokens.push({ value: source.slice(start, index), identifier: true })
        continue
      }

      if (character >= '0' && character <= '9') {
        index += 1

        while (index < source.length && /[A-Za-z0-9_$.]/u.test(source[index] ?? '')) {
          index += 1
        }

        continue
      }

      if (character === '{') {
        braceDepth += 1
      } else if (character === '}' && braceDepth > 0) {
        braceDepth -= 1
      }

      const pair = `${character}${next ?? ''}`

      if (pair === '?.' || pair === '=>') {
        tokens.push({ value: pair, identifier: false })
        index += 2
      } else {
        tokens.push({ value: character, identifier: false })
        index += 1
      }
    }

    return !stopAtBrace
  }

  return scanCode(false) ? tokens : undefined
}

const nextSourceTokenIndex = (tokens: readonly SourceToken[], start: number): number => {
  let index = start

  while (/^\s$/u.test(tokens[index]?.value ?? '')) {
    index += 1
  }

  return index
}

const isArrowFunctionSource = (tokens: readonly SourceToken[]): boolean => {
  let index = nextSourceTokenIndex(tokens, 0)

  if (tokens[index]?.value === 'async') {
    const next = nextSourceTokenIndex(tokens, index + 1)

    if (tokens[next]?.value === '=>') {
      return true
    }

    index = next
  }

  const next = nextSourceTokenIndex(tokens, index + 1)

  if (tokens[index]?.identifier && tokens[next]?.value === '=>') {
    return true
  }

  if (tokens[index]?.value !== '(') {
    return false
  }

  let depth = 0

  for (; index < tokens.length; index += 1) {
    const token = tokens[index]?.value

    if (token === '(') {
      depth += 1
    } else if (token === ')') {
      depth -= 1

      if (depth === 0) {
        return tokens[nextSourceTokenIndex(tokens, index + 1)]?.value === '=>'
      }
    }
  }

  return false
}

/**
 * Validate only the callable's receiver-sensitive surface. The function itself
 * is retained so its lexical closures and default expressions keep JavaScript's
 * normal behavior; only its dynamic `this` is redirected to the detached receiver.
 */
const isSafeCodecMethod = (value: unknown): value is CodecMethod => {
  if (isProxyValue(value) || !isCallable(value)) {
    return false
  }

  const source = readFunctionSource(value)

  return (
    source !== undefined &&
    !/^class\b/u.test(source) &&
    !hasUnsafeMethodSyntax(source) &&
    hasOnlyIntrinsicFunctionProperties(value)
  )
}

const snapshotReceiverMethod = (
  value: unknown,
  context: ReceiverSnapshotContext
): ReceiverValueSnapshot => {
  if (!isCallable(value)) {
    return { ok: false }
  }

  if (isMarkedCodecOperation(value)) {
    return { ok: true, value }
  }

  if (context.methods.has(value)) {
    const method = context.methods.get(value)

    return method === undefined ? { ok: false } : { ok: true, value: method }
  }

  const method = isSafeCodecMethod(value) ? value : undefined
  context.methods.set(value, method)

  return method === undefined ? { ok: false } : { ok: true, value: method }
}

const snapshotReceiverPrototype = (
  // oxlint-disable-next-line anti-slop/no-object-parameters -- the source was checked as a codec before snapshotting.
  source: object,
  shadowed: Set<string>,
  context: ReceiverSnapshotContext
): ReceiverPrototypeLevel[] | undefined => {
  if (isProxyValue(source)) {
    return undefined
  }

  const levels: ReceiverPrototypeLevel[] = []
  const visited = new Set<object>([source])
  let current: object | null

  try {
    current = Object.getPrototypeOf(source)
  } catch {
    return undefined
  }

  for (let depth = 0; current !== null; depth += 1) {
    if (depth > maxCodecPrototypeDepth) {
      return undefined
    }

    if (
      current === Object.prototype ||
      current === Function.prototype ||
      current === Array.prototype
    ) {
      return levels
    }

    if (visited.has(current) || isProxyValue(current)) {
      return undefined
    }

    visited.add(current)

    let keys: readonly PropertyKey[]

    try {
      keys = Reflect.ownKeys(current)
    } catch {
      return undefined
    }

    if (keys.length > maxCodecReceiverProperties) {
      return undefined
    }

    const entries: ReceiverPrototypeEntry[] = []

    for (const key of keys) {
      if (typeof key !== 'string') {
        return undefined
      }

      if (key === 'constructor') {
        const constructor = readDataDescriptor(current, key)
        const constructorSource =
          constructor.status === 'found' ? readFunctionSource(constructor.value) : undefined

        if (
          constructor.status !== 'found' ||
          !isCallable(constructor.value) ||
          (constructorSource !== undefined && hasUnsafeMethodSyntax(constructorSource))
        ) {
          return undefined
        }

        continue
      }

      if (shadowed.has(key)) {
        continue
      }

      const descriptor = readDataDescriptor(current, key)

      if (descriptor.status !== 'found') {
        return undefined
      }

      const value = isCallable(descriptor.value)
        ? snapshotReceiverMethod(descriptor.value, context)
        : snapshotReceiverValue(descriptor.value, context, 0)

      if (!value.ok) {
        return undefined
      }

      entries.push({ key, value: value.value })
      shadowed.add(key)
    }

    levels.push(entries)

    try {
      current = Object.getPrototypeOf(current)
    } catch {
      return undefined
    }
  }

  return levels
}

const snapshotCodecReceiver = (
  value: unknown,
  encode: unknown,
  decode: unknown
): object | undefined => {
  if (!isObjectLikeValue(value)) {
    return undefined
  }

  const source = value as object
  const context: ReceiverSnapshotContext = {
    active: new Set<object>(),
    copies: new Map<object, unknown>(),
    methods: new Map<object, unknown>(),
    propertyCount: 0
  }
  const ownEntries: ReceiverPrototypeEntry[] = []
  const encodeSnapshot = snapshotReceiverMethod(encode, context)
  const decodeSnapshot = snapshotReceiverMethod(decode, context)

  if (!encodeSnapshot.ok || !decodeSnapshot.ok) {
    return undefined
  }
  const shadowed = new Set<string>()
  let keys: readonly PropertyKey[]

  try {
    keys = Reflect.ownKeys(source)
  } catch {
    return undefined
  }

  if (keys.length > maxCodecReceiverProperties) {
    return undefined
  }

  for (const key of keys) {
    if (typeof key !== 'string') {
      return undefined
    }

    shadowed.add(key)

    if (isCallable(source) && isIntrinsicFunctionProperty(key)) {
      continue
    }

    const descriptor = readDataDescriptor(source, key)

    if (descriptor.status !== 'found') {
      return undefined
    }

    if (key === 'encode' || key === 'decode') {
      if (!isCallable(descriptor.value)) {
        return undefined
      }

      continue
    }

    if (isCallable(descriptor.value)) {
      return undefined
    }

    const snapshot = snapshotReceiverValue(descriptor.value, context, 0)

    if (!snapshot.ok) {
      return undefined
    }

    ownEntries.push({ key, value: snapshot.value })
  }

  const prototypeLevels = snapshotReceiverPrototype(source, shadowed, context)

  if (prototypeLevels === undefined) {
    return undefined
  }

  try {
    let prototype: object | null = null

    for (let index = prototypeLevels.length - 1; index >= 0; index -= 1) {
      const level = Object.create(prototype) as object

      for (const entry of prototypeLevels[index] ?? []) {
        Object.defineProperty(level, entry.key, {
          configurable: true,
          enumerable: true,
          value: entry.value,
          writable: true
        })
      }

      prototype = Object.freeze(level)
    }

    const receiver = Object.create(prototype) as Record<string, unknown>

    for (const entry of ownEntries) {
      Object.defineProperty(receiver, entry.key, {
        configurable: true,
        enumerable: true,
        value: entry.value,
        writable: true
      })
    }

    Object.defineProperty(receiver, 'encode', {
      configurable: true,
      enumerable: true,
      value: encodeSnapshot.value,
      writable: true
    })
    Object.defineProperty(receiver, 'decode', {
      configurable: true,
      enumerable: true,
      value: decodeSnapshot.value,
      writable: true
    })

    return Object.freeze(receiver)
  } catch {
    return undefined
  }
}

// oxlint-disable-next-line typescript/unbound-method -- bind the intrinsic before using it as a receiver-safe dispatcher.
const callFunction = Function.prototype.call.bind(Function.prototype.call)

const makeCodecMethod = (
  method: unknown,
  // oxlint-disable-next-line anti-slop/no-object-parameters -- receiver is the detached snapshot built above.
  receiver: object
): CodecLike['encode'] => {
  // SAFETY: The caller checks this value with `isCallable` before creating the facade.
  const callable = method as CodecMethod
  const facade = (value: unknown): unknown => callFunction(callable, receiver, value)

  return Object.freeze(facade)
}

const snapshotTrustedCodec = (
  value: unknown,
  field: string
): ResultType<CodecLike, JobDefinitionError> => {
  if (!isMarkedCodecSnapshot(value)) {
    return invalid(field, 'trusted codec snapshot is invalid')
  }

  const encode = readOwnDataProperty(value, 'encode')
  const decode = readOwnDataProperty(value, 'decode')

  if (
    !encode.present ||
    !isCallable(encode.value) ||
    !decode.present ||
    !isCallable(decode.value)
  ) {
    return invalid(field, 'trusted codec snapshot is invalid')
  }

  // SAFETY: The private capability check and callable checks establish this codec shape.
  const snapshot = Object.freeze({ encode: encode.value, decode: decode.value })
  return Result.ok(
    (isMarkedVoidCodec(value) ? markVoidCodecSnapshot(snapshot) : snapshot) as CodecLike
  )
}

const snapshotCodec = (
  value: unknown,
  field: string
): ResultType<CodecLike, JobDefinitionError> => {
  if (isMarkedCodecSnapshot(value)) {
    return snapshotTrustedCodec(value, field)
  }

  const encode = readCodecMethod(value, 'encode')
  const decode = readCodecMethod(value, 'decode')

  if (
    encode.status !== 'found' ||
    !isCallable(encode.method) ||
    decode.status !== 'found' ||
    !isCallable(decode.method)
  ) {
    return invalid(field, 'must provide callable encode and decode operations')
  }

  const receiver = snapshotCodecReceiver(value, encode.method, decode.method)

  if (receiver === undefined) {
    return invalid(field, 'receiver state must be snapshot-safe')
  }

  return Result.ok(
    Object.freeze({
      encode: makeCodecMethod(encode.method, receiver),
      decode: makeCodecMethod(decode.method, receiver)
    })
  )
}

const snapshotOptionalCodec = (
  value: unknown,
  field: string
): ResultType<CodecLike | undefined, JobDefinitionError> =>
  value === undefined ? Result.ok(undefined) : snapshotCodec(value, field)

const validateCallbacks = (
  options: CanonicalDefinitionOptions,
  hasFailureCodec: boolean
): ResultType<void, JobDefinitionError> => {
  if (options.idempotencyKey !== undefined && !isCallable(options.idempotencyKey)) {
    return invalid('idempotencyKey', 'must be callable')
  }

  if (options.metadata !== undefined && !isCallable(options.metadata)) {
    return invalid('metadata', 'must be callable')
  }

  if (options.retryable !== undefined) {
    if (!hasFailureCodec) {
      return invalid('retryable', 'requires a failure codec')
    }

    if (!isCallable(options.retryable)) {
      return invalid('retryable', 'must be callable')
    }
  }

  return Result.ok()
}

const buildJob = (queue: unknown, name: unknown, options: unknown): AnyJobDefinition => {
  const checkedQueue = makeQueueName(queue)
  const checkedName = makeJobName(name)
  const checkedOptions = readDefinitionOptions(options)

  if (Result.isError(checkedQueue)) {
    throw checkedQueue.error
  }

  if (Result.isError(checkedName)) {
    throw checkedName.error
  }

  if (Result.isError(checkedOptions)) {
    throw checkedOptions.error
  }

  const versionValue = checkedOptions.value.version

  if (
    typeof versionValue !== 'number' ||
    !Number.isSafeInteger(versionValue) ||
    versionValue <= 0
  ) {
    throwDefinition(invalid('version', 'must be a positive safe integer'))
  }
  const version = versionValue as number

  const payload = snapshotCodec(checkedOptions.value.payload, 'payload')
  const result = snapshotOptionalCodec(checkedOptions.value.result, 'result')
  const failure = snapshotOptionalCodec(checkedOptions.value.failure, 'failure')
  const defaults = normalizeDefaults(checkedOptions.value.defaults)
  const rawDefaults =
    checkedOptions.value.defaults === undefined ? {} : checkedOptions.value.defaults
  const rawDefaultFields = readDataFields(rawDefaults, defaultFields, 'defaults')
  const retryPolicy = Result.isError(rawDefaultFields)
    ? Result.err(rawDefaultFields.error)
    : normalizeRetryPolicy(fieldValue(rawDefaultFields.value, 'backoff'))

  if (Result.isError(payload)) throw payload.error
  if (Result.isError(result)) throw result.error
  if (Result.isError(failure)) throw failure.error
  if (Result.isError(defaults)) throw defaults.error
  if (Result.isError(retryPolicy)) throw retryPolicy.error

  const callbacks = validateCallbacks(checkedOptions.value, failure.value !== undefined)

  if (Result.isError(callbacks)) {
    throw callbacks.error
  }

  const store = checkedOptions.value.store === undefined ? JobStore : checkedOptions.value.store

  if (!isJobStoreToken(store)) {
    throw new JobDefinitionError({ field: 'store', message: 'must be a JobStore token' })
  }

  const identity = Object.freeze({
    queue: checkedQueue.value,
    name: checkedName.value,
    version
  })
  const descriptor = markDescriptor(
    {
      queue: checkedQueue.value,
      name: checkedName.value,
      version,
      identity,
      payload: payload.value,
      result: result.value,
      failure: failure.value,
      defaults: defaults.value,
      store,
      idempotencyKey: checkedOptions.value.idempotencyKey,
      metadata: checkedOptions.value.metadata,
      retryable: checkedOptions.value.retryable,
      retryPolicy: retryPolicy.value,
      ...makeJobOperations({
        identity,
        payload: payload.value,
        result: result.value,
        failure: failure.value,
        defaults: defaults.value,
        store,
        idempotencyKey: checkedOptions.value.idempotencyKey,
        metadata: checkedOptions.value.metadata
      } satisfies JobOperationDescriptor)
    },
    jobTypeId
  )

  return Object.freeze(descriptor) as unknown as AnyJobDefinition
}

/** Shared implementation used by Queue.job and the direct Job.define sugar. */
export function createJob<
  const Queue extends string,
  const Name extends string,
  const Version extends number,
  const PayloadCodec extends CodecLike,
  const ResultCodec extends CodecLike | undefined = undefined,
  const FailureCodec extends CodecLike | undefined = undefined,
  const Store extends AnyJobStoreToken = DefaultJobStoreToken
>(
  queue: NonEmptyStringLiteral<Queue>,
  name: NonEmptyStringLiteral<Name>,
  options: JobDefinitionOptions<Version, PayloadCodec, ResultCodec, FailureCodec, Store>
): JobDefinition<Queue, Name, Version, PayloadCodec, ResultCodec, FailureCodec, Store>
export function createJob(queue: unknown, name: unknown, options: unknown): AnyJobDefinition
export function createJob(queue: unknown, name: unknown, options: unknown): AnyJobDefinition {
  return buildJob(queue, name, options)
}

/** Bind an inert Job descriptor to a default or named JobStore token. */
export const bindJob = <Definition extends AnyJobDefinition, Store extends AnyJobStoreToken>(
  definition: Definition,
  store: Store
): Job.Bound<Definition, Store> => {
  if (!isJobDefinition(definition)) {
    throw new JobDefinitionError({ field: 'definition', message: 'must be a Job definition' })
  }

  if (!isJobStoreToken(store)) {
    throw new JobDefinitionError({ field: 'store', message: 'must be a JobStore token' })
  }

  // SAFETY: both values were validated above; recreate operations so the runtime token matches the bound type.
  const operations = makeJobOperations({
    identity: definition.identity,
    payload: definition.payload,
    result: definition.result,
    failure: definition.failure,
    defaults: definition.defaults,
    store,
    idempotencyKey: definition.idempotencyKey,
    metadata: definition.metadata
  } satisfies JobOperationDescriptor)
  return Object.freeze(
    markDescriptor({ ...definition, store, ...operations }, jobTypeId)
  ) as unknown as Job.Bound<Definition, Store>
}

export const normalizeIdempotencyKey = (
  value: unknown
): ResultType<string | undefined, JobDefinitionError> => {
  if (value === undefined) {
    return Result.ok(undefined)
  }

  if (typeof value !== 'string' || value.length === 0) {
    return invalid('idempotencyKey', 'must be a non-empty string or undefined')
  }

  return Result.ok(value)
}

export const normalizeMetadata = (
  value: unknown
): ResultType<Readonly<Record<string, string>>, JobDefinitionError> => {
  if (!isPlainObject(value)) {
    return invalid('metadata', 'must be a plain object with string values')
  }

  try {
    const metadata: Record<string, string> = {}

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        return invalid('metadata', 'must contain only string keys and values')
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key)

      if (descriptor === undefined || !('value' in descriptor)) {
        return invalid('metadata', 'must contain only data properties')
      }

      if (typeof descriptor.value !== 'string') {
        return invalid('metadata', 'must contain only string keys and values')
      }

      Object.defineProperty(metadata, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true
      })
    }

    return Result.ok(Object.freeze(metadata))
  } catch {
    return invalid('metadata', 'could not read callback output')
  }
}

const callbackFailure = (field: string): ResultType<never, JobDefinitionError> =>
  invalid(field, 'callback failed')

const isThenable = (value: unknown): boolean => {
  if (!isObjectLikeValue(value)) {
    return false
  }

  // SAFETY: `isObjectLikeValue` permits only values accepted by Object.getPrototypeOf.
  let current = value as object
  const visited = new Set<object>()

  for (let depth = 0; current !== null && depth <= maxCodecPrototypeDepth; depth += 1) {
    if (visited.has(current)) {
      return false
    }

    visited.add(current)

    let descriptor: PropertyDescriptor | undefined

    try {
      descriptor = Object.getOwnPropertyDescriptor(current, 'then')
    } catch {
      return false
    }

    if (descriptor !== undefined) {
      return 'value' in descriptor && isCallable(descriptor.value)
    }

    try {
      current = Object.getPrototypeOf(current)
    } catch {
      return false
    }
  }

  return false
}

const observeRejectedRetryableResult = (value: unknown): void => {
  if (!isThenable(value)) {
    return
  }

  try {
    void Promise.resolve(value).catch(() => undefined)
  } catch {
    // A hostile thenable is already normalized to the retryable fallback.
  }
}

/**
 * Normalize a definition-layer retry predicate result. The predicate is synchronous;
 * thrown errors and untyped rejected Promise results fail open as retryable without
 * retaining the failure. A thenable is not awaited, and non-boolean non-thenables
 * remain invalid predicate results.
 */
export const normalizeRetryable = (value: unknown): ResultType<boolean, JobDefinitionError> => {
  if (typeof value === 'boolean') {
    return Result.ok(value)
  }

  if (isThenable(value)) {
    observeRejectedRetryableResult(value)
    return Result.ok(true)
  }

  return invalid('retryable', 'callback must return a boolean')
}

export const runIdempotencyKey = <Definition extends AnyJobDefinition>(
  definition: Definition,
  payload: JobPayload<Definition>
): ResultType<string | undefined, JobDefinitionError> => {
  const callback = definition.idempotencyKey

  if (callback === undefined) {
    return Result.ok(undefined)
  }

  try {
    return normalizeIdempotencyKey(callback(payload))
  } catch {
    return callbackFailure('idempotencyKey')
  }
}

export const runMetadata = <Definition extends AnyJobDefinition>(
  definition: Definition,
  payload: JobPayload<Definition>
): ResultType<Readonly<Record<string, string>>, JobDefinitionError> => {
  const callback = definition.metadata

  if (callback === undefined) {
    return Result.ok(Object.freeze({}))
  }

  try {
    return normalizeMetadata(callback(payload))
  } catch {
    return callbackFailure('metadata')
  }
}

export const runRetryable = <Definition extends AnyJobDefinition>(
  definition: Definition,
  failure: JobFailure<Definition>
): ResultType<boolean | undefined, JobDefinitionError> => {
  const callback = definition.retryable

  if (callback === undefined) {
    return Result.ok(undefined)
  }

  try {
    return normalizeRetryable(callback(failure))
  } catch {
    return Result.ok(true)
  }
}

const isCodecSnapshot = (value: unknown): boolean => {
  if (!isPlainObject(value) || !isFrozenSafely(value)) {
    return false
  }

  const encode = readOwnDataProperty(value, 'encode')
  const decode = readOwnDataProperty(value, 'decode')

  return encode.present && isCallable(encode.value) && decode.present && isCallable(decode.value)
}

const isBackoffSnapshot = (value: unknown): boolean => {
  if (value === undefined) {
    return true
  }

  try {
    return makePersistedBackoff(value).status === 'ok'
  } catch {
    return false
  }
}

const isJobDefinition = (value: unknown): value is AnyJobDefinition => {
  const marker = readOwnDataProperty(value, jobTypeId)

  if (!marker.present || marker.value !== true) {
    return false
  }

  const queue = readOwnDataProperty(value, 'queue')
  const name = readOwnDataProperty(value, 'name')
  const version = readOwnDataProperty(value, 'version')
  const identity = readOwnDataProperty(value, 'identity')
  const payload = readOwnDataProperty(value, 'payload')
  const result = readOwnDataProperty(value, 'result')
  const failure = readOwnDataProperty(value, 'failure')
  const defaults = readOwnDataProperty(value, 'defaults')
  const idempotencyKey = readOwnDataProperty(value, 'idempotencyKey')
  const metadata = readOwnDataProperty(value, 'metadata')
  const retryable = readOwnDataProperty(value, 'retryable')
  const store = readOwnDataProperty(value, 'store')

  if (
    !queue.present ||
    typeof queue.value !== 'string' ||
    queue.value.length === 0 ||
    !name.present ||
    typeof name.value !== 'string' ||
    name.value.length === 0 ||
    !version.present ||
    typeof version.value !== 'number' ||
    !Number.isSafeInteger(version.value) ||
    version.value <= 0 ||
    !identity.present ||
    !isPlainObject(identity.value) ||
    !payload.present ||
    !isPlainObject(payload.value) ||
    !result.present ||
    !failure.present ||
    !defaults.present ||
    !isPlainObject(defaults.value) ||
    !idempotencyKey.present ||
    !metadata.present ||
    !retryable.present ||
    !store.present
  ) {
    return false
  }

  const identityQueue = readOwnDataProperty(identity.value, 'queue')
  const identityName = readOwnDataProperty(identity.value, 'name')
  const identityVersion = readOwnDataProperty(identity.value, 'version')
  const encode = readOwnDataProperty(payload.value, 'encode')
  const decode = readOwnDataProperty(payload.value, 'decode')
  const attempts = readOwnDataProperty(defaults.value, 'attempts')
  const backoff = readOwnDataProperty(defaults.value, 'backoff')
  const timeoutMs = readOwnDataProperty(defaults.value, 'timeoutMs')
  const priority = readOwnDataProperty(defaults.value, 'priority')

  return (
    identityQueue.present &&
    identityQueue.value === queue.value &&
    identityName.present &&
    identityName.value === name.value &&
    identityVersion.present &&
    identityVersion.value === version.value &&
    isFrozenSafely(value) &&
    isFrozenSafely(identity.value) &&
    isFrozenSafely(defaults.value) &&
    isFrozenSafely(payload.value) &&
    encode.present &&
    isCallable(encode.value) &&
    decode.present &&
    isCallable(decode.value) &&
    (isCodecSnapshot(result.value) || result.value === undefined) &&
    (isCodecSnapshot(failure.value) || failure.value === undefined) &&
    attempts.present &&
    typeof attempts.value === 'number' &&
    Number.isSafeInteger(attempts.value) &&
    attempts.value >= 1 &&
    backoff.present &&
    isBackoffSnapshot(backoff.value) &&
    timeoutMs.present &&
    (timeoutMs.value === undefined ||
      (typeof timeoutMs.value === 'number' &&
        Number.isSafeInteger(timeoutMs.value) &&
        timeoutMs.value > 0)) &&
    priority.present &&
    typeof priority.value === 'number' &&
    Number.isSafeInteger(priority.value) &&
    (idempotencyKey.value === undefined || isCallable(idempotencyKey.value)) &&
    (metadata.value === undefined || isCallable(metadata.value)) &&
    (retryable.value === undefined || isCallable(retryable.value)) &&
    (failure.value !== undefined || retryable.value === undefined) &&
    isJobStoreToken(store.value)
  )
}

/** Type-level aliases for job descriptor channels and logical identity. */
export declare namespace Job {
  export type Any = AnyJobDefinition
  export type Definition<
    Queue extends string = string,
    Name extends string = string,
    Version extends number = number,
    PayloadCodec extends CodecLike = CodecLike,
    ResultCodec extends CodecLike | undefined = undefined,
    FailureCodec extends CodecLike | undefined = undefined,
    Store extends AnyJobStoreToken = DefaultJobStoreToken
  > = JobDefinition<Queue, Name, Version, PayloadCodec, ResultCodec, FailureCodec, Store>
  export type Options<
    Version extends number,
    PayloadCodec extends CodecLike,
    ResultCodec extends CodecLike | undefined = undefined,
    FailureCodec extends CodecLike | undefined = undefined,
    Store extends AnyJobStoreToken = DefaultJobStoreToken
  > = JobDefinitionOptions<Version, PayloadCodec, ResultCodec, FailureCodec, Store>
  export type Defaults = JobDefaults
  export type Identity<Current extends Any = Any> =
    Current extends JobDefinition<
      infer Queue,
      infer Name,
      infer Version,
      infer _PayloadCodec,
      infer _ResultCodec,
      infer _FailureCodec,
      infer _Store
    >
      ? JobIdentity<Queue, Name, Version>
      : never
  export type Queue<Current extends Any = Any> =
    Current extends JobDefinition<
      infer Queue,
      infer _Name,
      infer _Version,
      infer _PayloadCodec,
      infer _ResultCodec,
      infer _FailureCodec,
      infer _Store
    >
      ? Queue
      : never
  export type Name<Current extends Any = Any> =
    Current extends JobDefinition<
      infer _Queue,
      infer Name,
      infer _Version,
      infer _PayloadCodec,
      infer _ResultCodec,
      infer _FailureCodec,
      infer _Store
    >
      ? Name
      : never
  export type Version<Current extends Any = Any> =
    Current extends JobDefinition<
      infer _Queue,
      infer _Name,
      infer Version,
      infer _PayloadCodec,
      infer _ResultCodec,
      infer _FailureCodec,
      infer _Store
    >
      ? Version
      : never
  export type PayloadInput<Current extends Any = Any> =
    Current extends JobDefinition<
      infer _Queue,
      infer _Name,
      infer _Version,
      infer PayloadCodec,
      infer _ResultCodec,
      infer _FailureCodec,
      infer _Store
    >
      ? PayloadCodec extends CodecLike
        ? CodecInputOf<PayloadCodec>
        : never
      : never
  export type Payload<Current extends Any = Any> =
    Current extends JobDefinition<
      infer _Queue,
      infer _Name,
      infer _Version,
      infer PayloadCodec,
      infer _ResultCodec,
      infer _FailureCodec,
      infer _Store
    >
      ? PayloadCodec extends CodecLike
        ? CodecValueOf<PayloadCodec>
        : never
      : never
  export type Success<Current extends Any = Any> =
    Current extends JobDefinition<
      infer _Queue,
      infer _Name,
      infer _Version,
      infer _PayloadCodec,
      infer ResultCodec,
      infer _FailureCodec,
      infer _Store
    >
      ? ResultCodec extends CodecLike
        ? CodecValueOf<ResultCodec>
        : never
      : never
  export type Failure<Current extends Any = Any> =
    Current extends JobDefinition<
      infer _Queue,
      infer _Name,
      infer _Version,
      infer _PayloadCodec,
      infer _ResultCodec,
      infer FailureCodec,
      infer _Store
    >
      ? FailureCodec extends CodecLike
        ? CodecValueOf<FailureCodec>
        : never
      : never
  export type StoreToken<Current extends Any = Any> =
    Current extends JobDefinition<
      infer _Queue,
      infer _Name,
      infer _Version,
      infer _PayloadCodec,
      infer _ResultCodec,
      infer _FailureCodec,
      infer Store
    >
      ? Store
      : DefaultJobStoreToken
  export type Store<Current extends Any = Any> = StoreToken<Current>
  export type Requirements<Current extends Any = Any> =
    StoreToken<Current> extends AnyJobStoreToken ? InstanceType<StoreToken<Current>> : never
  export type Bound<Current extends Any, Store extends AnyJobStoreToken> =
    Current extends JobDefinition<
      infer Queue,
      infer Name,
      infer Version,
      infer PayloadCodec,
      infer ResultCodec,
      infer FailureCodec,
      infer _Store
    >
      ? JobDefinition<Queue, Name, Version, PayloadCodec, ResultCodec, FailureCodec, Store>
      : never
  export type EnqueueRequest<Current extends Any = Any> = import('../store').EnqueueRequest & {
    readonly identity: Identity<Current>
    readonly job?: never
  }
  export type IdempotencyKey<_Current extends Any = Any> = string | undefined
  export type Metadata<_Current extends Any = Any> = Readonly<Record<string, string>>
  export type EnqueueOptions<_Current extends Any = Any> = import('./application').JobEnqueueOptions
  export type EnqueueManyOptions<_Current extends Any = Any> =
    import('./application').JobEnqueueManyOptions
  export type AwaitOptions<_Current extends Any = Any> = import('./application').JobAwaitOptions
  export type ExecuteOptions<_Current extends Any = Any> = import('./application').JobExecuteOptions
  export type RetryOptions<_Current extends Any = Any> = import('./application').JobRetryOptions
  export type RecordView<Current extends Any = Any> = import('./application').JobRecordView<
    Success<Current>,
    Failure<Current>
  >
  export type AttemptView<Current extends Any = Any> = import('./application').JobAttemptView<
    Success<Current>,
    Failure<Current>
  >
}

export type JobPayload<Current extends AnyJobDefinition> = Job.Payload<Current>
export type JobFailure<Current extends AnyJobDefinition> = Job.Failure<Current>

export const Job = {
  TypeId: jobTypeId,
  define: <
    const Name extends string,
    const Queue extends QueueDefinition<string>,
    const Version extends number,
    const PayloadCodec extends CodecLike,
    const ResultCodec extends CodecLike | undefined = undefined,
    const FailureCodec extends CodecLike | undefined = undefined,
    const Store extends AnyJobStoreToken = DefaultJobStoreToken
  >(
    name: NonEmptyStringLiteral<Name>,
    options: JobDefinitionOptions<Version, PayloadCodec, ResultCodec, FailureCodec, Store> & {
      readonly queue: Queue
    }
  ): JobDefinition<
    Queue extends QueueDefinition<infer QueueName> ? QueueName : never,
    Name,
    Version,
    PayloadCodec,
    ResultCodec,
    FailureCodec,
    Store
  > => {
    const fields = readDataFields(options, ['queue', ...definitionFields], 'options')

    if (Result.isError(fields)) {
      throw fields.error
    }

    const queue = fieldValue(fields.value, 'queue')

    if (!isQueueDefinition(queue)) {
      throw new JobDefinitionError({ field: 'queue', message: 'must be a Queue definition' })
    }

    const queueName = readOwnDataProperty(queue, 'queue')

    if (!queueName.present || typeof queueName.value !== 'string') {
      throw new JobDefinitionError({ field: 'queue', message: 'must be a Queue definition' })
    }

    const jobOptions: Record<string, unknown> = Object.create(null) as Record<string, unknown>

    for (const field of definitionFields) {
      if (hasField(fields.value, field)) {
        Object.defineProperty(jobOptions, field, {
          configurable: true,
          enumerable: true,
          value: fieldValue(fields.value, field),
          writable: true
        })
      }
    }

    return buildJob(queueName.value, name, jobOptions) as unknown as JobDefinition<
      Queue extends QueueDefinition<infer QueueName> ? QueueName : never,
      Name,
      Version,
      PayloadCodec,
      ResultCodec,
      FailureCodec,
      Store
    >
  },
  bind: bindJob,
  bindStore: bindJob,
  is: isJobDefinition,
  normalizeIdempotencyKey,
  normalizeMetadata,
  runIdempotencyKey,
  runMetadata,
  runRetryable,
  unrecoverable: markUnrecoverable
} as const
