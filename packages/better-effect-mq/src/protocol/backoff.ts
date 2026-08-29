import { Result, type Result as ResultType } from 'better-result'

import { readObjectFields } from '../internal/json'

import { JobDefinitionError } from './errors'
import type { BackoffKind, PersistedBackoff } from './types'
import { validateDuration, validateOptionalDuration } from './time'

const backoffFields = ['type', 'delayMs', 'maxDelayMs'] as const

const invalidBackoff = (message: string): ResultType<PersistedBackoff, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field: 'backoff', message }))

type MutablePersistedBackoff = {
  type: BackoffKind
  delayMs: number
  maxDelayMs?: number
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

  const safeBackoff: MutablePersistedBackoff = {
    type: fields.value.type,
    delayMs: delay.value
  }

  if (maximum.value !== undefined) {
    safeBackoff.maxDelayMs = maximum.value
  }

  return Result.ok(Object.freeze(safeBackoff))
}

export const validatePersistedBackoff = makePersistedBackoff
