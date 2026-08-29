import { Result, type Result as ResultType } from 'better-result'

import { JobDefinitionError } from '../protocol/errors'

const invalid = <T>(field: string, message: string): ResultType<T, JobDefinitionError> =>
  Result.err<T, JobDefinitionError>(new JobDefinitionError({ field, message }))

export const validateIdentity = <Brand extends string>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the untyped identity boundary.
  value: unknown,
  field: string,
  brand: (value: string) => Brand
): ResultType<Brand, JobDefinitionError> => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- identity constructors must reject non-strings.
  if (typeof value !== 'string' || value.length === 0) {
    return invalid(field, 'must be a non-empty string')
  }

  return Result.ok(brand(value))
}

const isNumber = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- numeric validators accept untrusted persistence values.
  value: unknown
): value is number => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- numeric validators must reject non-numbers.
  return typeof value === 'number'
}

export const validateTimestampValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- timestamp validation is an untyped persistence boundary.
  value: unknown,
  field: string
): ResultType<number, JobDefinitionError> => {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0) {
    return invalid(field, 'must be a non-negative safe integer epoch millisecond timestamp')
  }

  return Result.ok(value)
}

export const validateOptionalTimestampValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- optional timestamps are read from untyped persistence data.
  value: unknown,
  field: string
): ResultType<number | undefined, JobDefinitionError> =>
  value === undefined ? Result.ok(undefined) : validateTimestampValue(value, field)

export const validateDurationValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- duration validation is an untyped persistence boundary.
  value: unknown,
  field: string
): ResultType<number, JobDefinitionError> => {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0) {
    return invalid(field, 'must be a non-negative safe integer duration in milliseconds')
  }

  return Result.ok(value)
}

export const validatePositiveDurationValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- duration validation is an untyped persistence boundary.
  value: unknown,
  field: string
): ResultType<number, JobDefinitionError> => {
  const checked = validateDurationValue(value, field)

  if (Result.isError(checked)) {
    return checked
  }

  if (checked.value === 0) {
    return invalid(field, 'must be greater than zero')
  }

  return checked
}

export const validateCounterValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- counters are read from untyped persistence data.
  value: unknown,
  field: string
): ResultType<number, JobDefinitionError> => {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0) {
    return invalid(field, 'must be a non-negative safe integer counter')
  }

  return Result.ok(value)
}

export const validatePositiveIntegerValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- counters are read from untyped persistence data.
  value: unknown,
  field: string
): ResultType<number, JobDefinitionError> => {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value <= 0) {
    return invalid(field, 'must be a positive safe integer')
  }

  return Result.ok(value)
}

export const validatePriorityValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- priorities are read from untyped persistence data.
  value: unknown,
  field: string
): ResultType<number, JobDefinitionError> => {
  if (!isNumber(value) || !Number.isSafeInteger(value)) {
    return invalid(field, 'must be a safe integer')
  }

  return Result.ok(value)
}

export const validateOptionalDurationValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- optional durations are read from untyped persistence data.
  value: unknown,
  field: string
): ResultType<number | undefined, JobDefinitionError> =>
  value === undefined ? Result.ok(undefined) : validateDurationValue(value, field)

export const validateTextValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- record validation may receive untyped storage data.
  value: unknown,
  field: string
): ResultType<string, JobDefinitionError> => validateIdentity(value, field, (text) => text)
