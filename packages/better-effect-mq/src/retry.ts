// oxlint-disable anti-slop/no-runtime-typeof -- Retry validates public configuration at its boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- policy factories accept untrusted JavaScript options.
// oxlint-disable anti-slop/no-known-value-widening -- callback decisions are normalized at the boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- the null-prototype snapshot is an internal parsed DTO.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- canonical snapshots omit optional fields.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts follow explicit runtime checks.

import { Result, type Result as ResultType } from 'better-result'

import { makePersistedBackoff } from './protocol/backoff'
import type { PersistedBackoff } from './protocol/types'
import { JobDefinitionError } from './protocol/errors'

export type RetryJitter = number
export type RetryContext = { readonly attempt: number; readonly attemptsMax: number }
export type RetryDecision = {
  readonly retry: boolean
  readonly delayMs?: number
}
export type RetryDecide<Failure = unknown> = (
  failure: Failure,
  context: RetryContext
) => RetryDecision | boolean

export type RetryPolicy =
  | { readonly type: 'never'; readonly maxAttempts: 1 }
  | { readonly type: 'fixed'; readonly backoff: PersistedBackoff; readonly maxAttempts?: number }
  | { readonly type: 'linear'; readonly backoff: PersistedBackoff; readonly maxAttempts?: number }
  | {
      readonly type: 'exponential'
      readonly backoff: PersistedBackoff
      readonly maxAttempts?: number
    }
  | { readonly type: 'custom'; readonly maxAttempts?: number; readonly decide: RetryDecide<never> }

const invalid = (message: string): never => {
  throw new JobDefinitionError({ field: 'retry', message })
}

const backoffFields = [
  'type',
  'delayMs',
  'initialDelayMs',
  'incrementMs',
  'maxDelayMs',
  'factor',
  'jitter'
] as const
const retryPolicyFields = [...backoffFields, 'backoff', 'maxAttempts', 'decide'] as const

const typeFields = (type: unknown, hasPolicyBackoff: boolean): readonly string[] =>
  type === 'never'
    ? ['type', 'maxAttempts']
    : type === 'custom'
      ? ['type', 'maxAttempts', 'decide']
      : hasPolicyBackoff && (type === 'fixed' || type === 'linear' || type === 'exponential')
        ? ['type', 'backoff', 'maxAttempts']
        : backoffFields

const snapshotOwnDataFields = (
  options: unknown,
  allowed: readonly string[],
  label: string
): Readonly<Record<string, unknown>> => {
  if (typeof options !== 'object' || options === null) invalid(`${label} must be an object`)
  const objectOptions = options as object
  const prototype = Object.getPrototypeOf(objectOptions)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object`)
  }

  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(objectOptions)) {
    if (typeof key !== 'string' || !allowed.includes(key))
      invalid(`${label} contain unsupported fields`)
    const descriptor = Object.getOwnPropertyDescriptor(objectOptions, key)
    if (descriptor === undefined) return invalid(`${label} contain an accessor field`)
    if (!('value' in descriptor)) return invalid(`${label} contain an accessor field`)
    Object.defineProperty(fields, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true
    })
  }
  return Object.freeze(fields)
}

const validateFactoryOptions = (
  options: unknown,
  allowed: readonly string[]
): Readonly<Record<string, unknown>> => snapshotOwnDataFields(options, allowed, 'retry options')

const integer = (value: unknown, field: string, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    return invalid(`${field} must be a finite safe integer >= ${minimum}`)
  }
  return value
}

const attempts = (value: unknown): number | undefined =>
  value === undefined ? undefined : integer(value, 'maxAttempts', 1)

const jitter = (value: unknown): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return invalid('jitter must be a finite number between 0 and 1')
  }
  return value
}

const staticPolicy = (
  type: 'constant' | 'linear' | 'exponential',
  options: {
    readonly delayMs?: unknown
    readonly initialDelayMs?: unknown
    readonly incrementMs?: unknown
    readonly maxDelayMs?: unknown
    readonly factor?: unknown
    readonly jitter?: unknown
    readonly maxAttempts?: unknown
  }
): RetryPolicy => {
  const fields = validateFactoryOptions(
    options,
    type === 'constant'
      ? ['delayMs', 'maxAttempts']
      : type === 'linear'
        ? ['initialDelayMs', 'incrementMs', 'maxDelayMs', 'maxAttempts', 'jitter']
        : ['initialDelayMs', 'factor', 'maxDelayMs', 'maxAttempts', 'jitter']
  )
  const delay = integer(fields.delayMs ?? fields.initialDelayMs, 'delayMs')
  const maxDelayMs =
    fields.maxDelayMs === undefined ? undefined : integer(fields.maxDelayMs, 'maxDelayMs')
  if (maxDelayMs !== undefined && maxDelayMs < delay) invalid('maxDelayMs must be >= initial delay')
  const incrementMs =
    fields.incrementMs === undefined ? undefined : integer(fields.incrementMs, 'incrementMs')
  const factor = fields.factor === undefined ? undefined : fields.factor
  if (
    factor !== undefined &&
    (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0)
  )
    invalid('factor must be finite and > 0')
  const safeJitter = jitter(fields.jitter)
  const persisted = makePersistedBackoff({
    type,
    delayMs: delay,
    maxDelayMs,
    incrementMs,
    factor,
    jitter: safeJitter
  }).unwrap()
  const maxAttempts = attempts(fields.maxAttempts)
  return Object.freeze({
    type: type === 'constant' ? 'fixed' : type,
    backoff: persisted,
    ...(maxAttempts === undefined ? {} : { maxAttempts })
  }) as RetryPolicy
}

export const Retry = {
  never: (): RetryPolicy => Object.freeze({ type: 'never', maxAttempts: 1 }),
  fixed: (options: {
    readonly delayMs: number
    readonly maxAttempts?: number
  }): Extract<RetryPolicy, { readonly type: 'fixed' }> =>
    staticPolicy('constant', options) as Extract<RetryPolicy, { readonly type: 'fixed' }>,
  linear: (options: {
    readonly initialDelayMs: number
    readonly incrementMs: number
    readonly maxDelayMs?: number
    readonly maxAttempts?: number
    readonly jitter?: number
  }): Extract<RetryPolicy, { readonly type: 'linear' }> =>
    staticPolicy('linear', options) as Extract<RetryPolicy, { readonly type: 'linear' }>,
  exponential: (options: {
    readonly initialDelayMs: number
    readonly factor?: number
    readonly maxDelayMs?: number
    readonly maxAttempts?: number
    readonly jitter?: number
  }): Extract<RetryPolicy, { readonly type: 'exponential' }> =>
    staticPolicy('exponential', options) as Extract<RetryPolicy, { readonly type: 'exponential' }>,
  custom: <Failure = unknown>(options: {
    readonly maxAttempts?: number
    readonly decide: RetryDecide<Failure>
  }): RetryPolicy => {
    const fields = validateFactoryOptions(options, ['maxAttempts', 'decide'])
    if (typeof fields.decide !== 'function') invalid('decide must be callable')
    const maxAttempts = attempts(fields.maxAttempts)
    const policy: { type: 'custom'; maxAttempts?: number; decide: RetryDecide<Failure> } = {
      type: 'custom',
      // SAFETY: the runtime check above establishes the callable custom decision.
      decide: fields.decide as RetryDecide<Failure>
    }
    if (maxAttempts !== undefined) policy.maxAttempts = maxAttempts
    return Object.freeze(policy)
  },
  delay: (backoff: PersistedBackoff, attempt: number, random = 0.5): number => {
    const n = integer(attempt, 'attempt', 1)
    const base =
      backoff.type === 'linear'
        ? backoff.delayMs + (backoff.incrementMs ?? backoff.delayMs) * (n - 1)
        : backoff.type === 'exponential'
          ? backoff.delayMs * Math.pow(backoff.factor ?? 2, n - 1)
          : backoff.delayMs
    const spread = backoff.jitter ?? 0
    // Host-provided random sources are untrusted; invalid values must not turn
    // a finite schedule into NaN (which previously selected the max delay).
    const boundedRandom = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5
    const jittered = base * (1 - spread + 2 * spread * boundedRandom)
    const capped = Math.min(jittered, backoff.maxDelayMs ?? Number.MAX_SAFE_INTEGER)
    return Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(
        0,
        Math.floor(
          Number.isFinite(capped) ? capped : (backoff.maxDelayMs ?? Number.MAX_SAFE_INTEGER)
        )
      )
    )
  }
}

export const normalizeRetryPolicy = (
  value: unknown
): ResultType<RetryPolicy | undefined, JobDefinitionError> => {
  if (value === undefined) return Result.ok(undefined)
  if (typeof value !== 'object' || value === null) {
    return Result.err(
      new JobDefinitionError({
        field: 'defaults.backoff',
        message: 'must be a Retry policy or persisted backoff'
      })
    )
  }
  try {
    const fields = snapshotOwnDataFields(value, retryPolicyFields, 'retry policy')
    const candidate = fields as {
      readonly type?: unknown
      readonly backoff?: unknown
      readonly maxAttempts?: unknown
      readonly decide?: unknown
    }
    const type = candidate.type
    const hasPolicyBackoff = Object.prototype.hasOwnProperty.call(fields, 'backoff')
    const allowed = typeFields(type, hasPolicyBackoff)
    for (const key of Reflect.ownKeys(fields)) {
      if (typeof key !== 'string' || !allowed.includes(key))
        invalid('retry policy contains unsupported fields')
    }
    if (type === 'never') {
      if (
        candidate.maxAttempts !== 1 ||
        candidate.backoff !== undefined ||
        candidate.decide !== undefined
      )
        invalid('never requires maxAttempts to be exactly 1')
      return Result.ok(Retry.never())
    }
    if (type === 'custom') {
      if (!Object.prototype.hasOwnProperty.call(fields, 'decide'))
        invalid('custom requires an own decide property')
      if (candidate.backoff !== undefined) invalid('custom cannot contain a backoff')
      const maxAttempts = attempts(candidate.maxAttempts)
      return Result.ok(
        maxAttempts === undefined
          ? Retry.custom({ decide: candidate.decide as RetryDecide })
          : Retry.custom({ decide: candidate.decide as RetryDecide, maxAttempts })
      )
    }
    if (hasPolicyBackoff && (type === 'fixed' || type === 'linear' || type === 'exponential')) {
      const backoff = makePersistedBackoff(candidate.backoff)
      if (Result.isError(backoff)) return Result.err(backoff.error)
      if (backoff.value === undefined) invalid(`${type} requires a backoff`)
      if (
        (type === 'fixed' && backoff.value.type !== 'constant') ||
        (type !== 'fixed' && backoff.value.type !== type)
      )
        invalid('policy type and backoff type must agree')
      const maxAttempts = attempts(candidate.maxAttempts)
      return Result.ok(
        Object.freeze({
          type,
          backoff: backoff.value,
          ...(maxAttempts === undefined ? {} : { maxAttempts })
        }) as RetryPolicy
      )
    }
    // Legacy persisted backoffs are canonicalized into a policy snapshot.
    const backoff = makePersistedBackoff(fields)
    if (Result.isError(backoff)) return Result.err(backoff.error)
    return Result.ok(
      Object.freeze({
        type: backoff.value.type === 'constant' ? 'fixed' : backoff.value.type,
        backoff: backoff.value
      }) as RetryPolicy
    )
  } catch (error) {
    return Result.err(
      error instanceof JobDefinitionError
        ? error
        : new JobDefinitionError({ field: 'defaults.backoff', message: 'invalid retry policy' })
    )
  }
}

export type PersistedRetryPolicy = Exclude<
  RetryPolicy,
  { readonly type: 'custom' } | { readonly type: 'never' }
>

export declare namespace Retry {
  export type Policy = RetryPolicy
  export type Decision = RetryDecision
  export type Context = RetryContext
  export type Decide<Failure = unknown> = RetryDecide<Failure>
}
