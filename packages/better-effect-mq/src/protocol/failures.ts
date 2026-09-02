import { Result, type Result as ResultType } from 'better-result'

import { parseJsonValue, readObjectFields } from '../internal/json'
import { validateTextValue, validateTimestampValue } from '../internal/validation'

import { JobDefinitionError } from './errors'
import type { JobFailureKind, JsonValue, SerializedJobFailure } from './types'

type MutableSerializedJobFailure = {
  kind: JobFailureKind
  message: string
  retryable: boolean
  recordedAt: number
  code?: string
  data?: JsonValue
}

const failureFields = ['kind', 'code', 'message', 'data', 'retryable', 'recordedAt'] as const

const invalidFailure = (message: string): ResultType<SerializedJobFailure, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field: 'failure', message }))

const isFailureKind = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the decoded failure kind boundary.
  kind: unknown
): kind is JobFailureKind => {
  switch (kind) {
    case 'typed':
    case 'defect':
    case 'encode':
    case 'timeout':
    case 'decode':
    case 'stalled':
    case 'cancelled':
      return true
    default:
      return false
  }
}

/**
 * Validate and snapshot the explicitly safe failure envelope written to storage.
 *
 * This function accepts a DTO, not an Error or TaggedError. It deliberately
 * never calls `toJSON()` and never copies an arbitrary cause or stack.
 */
export const makeSerializedJobFailure = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- failures are decoded from untrusted persistence data.
  failure: unknown
): ResultType<SerializedJobFailure, JobDefinitionError> => {
  const fields = readObjectFields(failure, failureFields, 'failure')

  if (Result.isError(fields)) {
    return Result.err(fields.error)
  }

  const kind = fields.value.kind

  if (!isFailureKind(kind)) {
    return invalidFailure('kind is not a supported persisted failure kind')
  }

  const message = validateTextValue(fields.value.message, 'failure.message')

  if (Result.isError(message)) {
    return invalidFailure(message.error.message)
  }

  const code =
    fields.value.code === undefined
      ? Result.ok<string | undefined>(undefined)
      : validateTextValue(fields.value.code, 'failure.code')

  if (Result.isError(code)) {
    return invalidFailure(code.error.message)
  }

  const data =
    fields.value.data === undefined
      ? Result.ok<JsonValue | undefined>(undefined)
      : parseJsonValue(fields.value.data, 'failure.data')

  if (Result.isError(data)) {
    return invalidFailure(data.error.message)
  }

  const recordedAt = validateTimestampValue(fields.value.recordedAt, 'failure.recordedAt')

  if (Result.isError(recordedAt)) {
    return invalidFailure(recordedAt.error.message)
  }

  const retryable = fields.value.retryable

  if (retryable !== true && retryable !== false) {
    return invalidFailure('retryable must be a boolean')
  }

  const safeFailure: MutableSerializedJobFailure = {
    kind,
    message: message.value,
    retryable,
    recordedAt: recordedAt.value
  }

  if (code.value !== undefined) {
    safeFailure.code = code.value
  }

  if (data.value !== undefined) {
    safeFailure.data = data.value
  }

  return Result.ok(Object.freeze(safeFailure))
}

export const validateSerializedJobFailure = makeSerializedJobFailure
export const makePersistedJobFailure = makeSerializedJobFailure
