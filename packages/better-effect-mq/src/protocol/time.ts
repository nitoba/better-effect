import type { Result as ResultType } from 'better-result'

import {
  validateDurationValue,
  validateOptionalDurationValue,
  validateOptionalTimestampValue,
  validatePositiveDurationValue,
  validateTimestampValue
} from '../internal/validation'

import type { JobDefinitionError } from './errors'

export const validateTimestamp = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- timestamps are decoded from untrusted persistence data.
  value: unknown,
  field = 'timestamp'
): ResultType<number, JobDefinitionError> => validateTimestampValue(value, field)

export const validateOptionalTimestamp = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- optional timestamps are decoded from untrusted persistence data.
  value: unknown,
  field = 'timestamp'
): ResultType<number | undefined, JobDefinitionError> =>
  validateOptionalTimestampValue(value, field)

export const validateDuration = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- durations are decoded from untrusted persistence data.
  value: unknown,
  field = 'durationMs'
): ResultType<number, JobDefinitionError> => validateDurationValue(value, field)

export const validateOptionalDuration = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- optional durations are decoded from untrusted persistence data.
  value: unknown,
  field = 'durationMs'
): ResultType<number | undefined, JobDefinitionError> => validateOptionalDurationValue(value, field)

export const validatePositiveDuration = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- durations are decoded from untrusted persistence data.
  value: unknown,
  field = 'durationMs'
): ResultType<number, JobDefinitionError> => validatePositiveDurationValue(value, field)
