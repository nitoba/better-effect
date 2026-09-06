// oxlint-disable anti-slop/no-runtime-typeof -- schedule identities are untrusted public boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- identity inputs are intentionally untyped at runtime.

import { JobDefinitionError } from '../protocol'
import { hasUnpairedSurrogate } from '../internal/validation'

export const maxScheduleIdentityLength = 256

const invalid = (field: string, message: string): never => {
  throw new JobDefinitionError({ field, message })
}

export const validateScheduleIdentityPart = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid(field, 'must be a non-empty string')
  }

  if (hasUnpairedSurrogate(value)) {
    return invalid(field, 'must contain well-formed Unicode scalar values')
  }

  if (value.length > maxScheduleIdentityLength) {
    return invalid(field, `must not exceed ${maxScheduleIdentityLength} characters`)
  }

  return value
}

/** Percent-encoding is injective for a validated key and keeps '/' structural. */
export const encodeScheduleKey = (key: string): string =>
  encodeURIComponent(validateScheduleIdentityPart(key, 'key'))

export const makeScheduleOccurrenceId = (scheduleKey: string, slotEpochMs: number): string => {
  const encodedKey = encodeScheduleKey(scheduleKey)

  if (
    typeof slotEpochMs !== 'number' ||
    !Number.isSafeInteger(slotEpochMs) ||
    slotEpochMs < 0 ||
    slotEpochMs > 8_640_000_000_000_000
  ) {
    return invalid('slotEpochMs', 'must be a non-negative safe integer epoch millisecond')
  }

  return `sched/${encodedKey}/${slotEpochMs}`
}
