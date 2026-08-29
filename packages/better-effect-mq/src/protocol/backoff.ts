import { Result, type Result as ResultType } from 'better-result'

import { JobDefinitionError } from './errors'
import type { BackoffKind, PersistedBackoff } from './types'
import { validateDuration, validateOptionalDuration } from './time'

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

/** Validate the storage representation of a retry backoff without calculating delays. */
export const makePersistedBackoff = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- backoffs are decoded from untrusted persistence data.
  backoff: unknown
): ResultType<PersistedBackoff, JobDefinitionError> => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- reject primitive and null backoff values before reading fields.
  if (typeof backoff !== 'object' || backoff === null || !('type' in backoff)) {
    return invalidBackoff('must be an object')
  }

  if (!isBackoffKind(backoff.type)) {
    return invalidBackoff('type is not a supported backoff kind')
  }

  const delay = validateDuration(
    'delayMs' in backoff ? backoff.delayMs : undefined,
    'backoff.delayMs'
  )

  if (Result.isError(delay)) {
    return Result.err(delay.error)
  }

  const maximum = validateOptionalDuration(
    'maxDelayMs' in backoff ? backoff.maxDelayMs : undefined,
    'backoff.maxDelayMs'
  )

  if (Result.isError(maximum)) {
    return Result.err(maximum.error)
  }

  if (maximum.value !== undefined && maximum.value < delay.value) {
    return invalidBackoff('maxDelayMs must be greater than or equal to delayMs')
  }

  const safeBackoff: MutablePersistedBackoff = {
    type: backoff.type,
    delayMs: delay.value
  }

  if (maximum.value !== undefined) {
    safeBackoff.maxDelayMs = maximum.value
  }

  return Result.ok(Object.freeze(safeBackoff))
}

export const validatePersistedBackoff = makePersistedBackoff
