// oxlint-disable anti-slop/no-runtime-typeof -- untrusted persisted backoff fields are parsed here.

import { Result, type Result as ResultType } from 'better-result'

import { readObjectFields } from '../internal/json'

import { JobDefinitionError } from './errors'
import type { BackoffKind, PersistedBackoff } from './types'
import { validateDuration, validateOptionalDuration } from './time'

const backoffFields = ['type', 'delayMs', 'incrementMs', 'factor', 'maxDelayMs', 'jitter'] as const

const invalidBackoff = (message: string): ResultType<PersistedBackoff, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field: 'backoff', message }))

type MutablePersistedBackoff = {
  type: BackoffKind
  delayMs: number
  incrementMs?: number
  factor?: number
  maxDelayMs?: number
  jitter?: number
}

const isBackoffKind = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the decoded backoff kind boundary.
  value: unknown
): value is BackoffKind => value === 'constant' || value === 'linear' || value === 'exponential'

/** Validate and snapshot the storage representation of a retry backoff. */
export const makePersistedBackoff = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- backoffs are decoded from untrusted persistence data.
  backoff: unknown
): ResultType<PersistedBackoff, JobDefinitionError> => {
  const fields = readObjectFields(backoff, backoffFields, 'backoff')

  if (Result.isError(fields)) {
    return Result.err(fields.error)
  }

  if (!isBackoffKind(fields.value.type)) {
    return invalidBackoff('type is not a supported backoff kind')
  }

  const delay = validateDuration(fields.value.delayMs, 'backoff.delayMs')

  if (Result.isError(delay)) {
    return Result.err(delay.error)
  }

  const maximum = validateOptionalDuration(fields.value.maxDelayMs, 'backoff.maxDelayMs')

  if (Result.isError(maximum)) {
    return Result.err(maximum.error)
  }

  if (maximum.value !== undefined && maximum.value < delay.value) {
    return invalidBackoff('maxDelayMs must be greater than or equal to delayMs')
  }

  if (fields.value.type === 'constant' && fields.value.incrementMs !== undefined) {
    return invalidBackoff('incrementMs is only valid for linear backoff')
  }
  if (fields.value.type !== 'exponential' && fields.value.factor !== undefined) {
    return invalidBackoff('factor is only valid for exponential backoff')
  }
  if (fields.value.type === 'exponential' && fields.value.incrementMs !== undefined) {
    return invalidBackoff('incrementMs is not valid for exponential backoff')
  }

  const increment =
    fields.value.incrementMs === undefined
      ? Result.ok<number | undefined>(undefined)
      : validateDuration(fields.value.incrementMs, 'backoff.incrementMs')
  if (Result.isError(increment)) return Result.err(increment.error)

  const factor = fields.value.factor
  if (
    factor !== undefined &&
    (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0)
  ) {
    return invalidBackoff('factor must be finite and greater than zero')
  }
  if (fields.value.type === 'linear' && increment.value === undefined) {
    return invalidBackoff('linear backoff requires incrementMs')
  }
  const jitter = fields.value.jitter
  if (
    jitter !== undefined &&
    (typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter > 1)
  ) {
    return invalidBackoff('jitter must be between zero and one')
  }

  const safeBackoff: MutablePersistedBackoff = {
    type: fields.value.type,
    delayMs: delay.value
  }
  if (increment.value !== undefined) safeBackoff.incrementMs = increment.value
  if (factor !== undefined) safeBackoff.factor = factor

  if (maximum.value !== undefined) safeBackoff.maxDelayMs = maximum.value
  if (jitter !== undefined) safeBackoff.jitter = jitter

  return Result.ok(Object.freeze(safeBackoff))
}

export const validatePersistedBackoff = makePersistedBackoff
