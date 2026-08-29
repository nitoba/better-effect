import { Result, type Result as ResultType } from 'better-result'

import { cloneJsonValue, isJsonValue } from '../internal/json'
import { validateTextValue, validateTimestampValue } from '../internal/validation'

import { JobDefinitionError } from './errors'
import type { JobFailureKind, JsonValue, SerializedJobFailure } from './types'

const invalidFailure = (message: string): ResultType<SerializedJobFailure, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field: 'failure', message }))

interface MutableSerializedJobFailure {
  kind: JobFailureKind
  code?: string
  message: string
  data?: JsonValue
  retryable: boolean
  recordedAt: number
}

const isFailureKind = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the decoded failure kind boundary.
  kind: unknown
): kind is JobFailureKind => {
  switch (kind) {
    case 'typed':
    case 'defect':
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
 * Validate and freeze the explicitly safe failure envelope written to storage.
 *
 * This function accepts a DTO, not an Error or TaggedError. It deliberately
 * never calls `toJSON()` and never copies an arbitrary cause or stack.
 */
export const makeSerializedJobFailure = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- failures are decoded from untrusted persistence data.
  failure: unknown
): ResultType<SerializedJobFailure, JobDefinitionError> => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- reject primitive and null failures before reading fields.
  if (typeof failure !== 'object' || failure === null || !('kind' in failure)) {
    return invalidFailure('must be an object')
  }

  const kind = failure.kind

  if (!isFailureKind(kind)) {
    return invalidFailure('kind is not a supported persisted failure kind')
  }

  const message = validateTextValue(
    'message' in failure ? failure.message : undefined,
    'failure.message'
  )

  if (Result.isError(message)) {
    return invalidFailure(message.error.message)
  }

  const rawCode = 'code' in failure ? failure.code : undefined
  const code =
    rawCode === undefined
      ? Result.ok<string | undefined>(undefined)
      : validateTextValue(rawCode, 'failure.code')

  if (Result.isError(code)) {
    return invalidFailure(code.error.message)
  }

  const data = 'data' in failure ? failure.data : undefined

  if (data !== undefined && !isJsonValue(data)) {
    return invalidFailure('data must be JSON-safe')
  }

  const recordedAt = validateTimestampValue(
    'recordedAt' in failure ? failure.recordedAt : undefined,
    'failure.recordedAt'
  )

  if (Result.isError(recordedAt)) {
    return invalidFailure(recordedAt.error.message)
  }

  const retryable = 'retryable' in failure ? failure.retryable : undefined

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

  if (data !== undefined) {
    safeFailure.data = cloneJsonValue(data)
  }

  return Result.ok(Object.freeze(safeFailure))
}

export const validateSerializedJobFailure = makeSerializedJobFailure
export const makePersistedJobFailure = makeSerializedJobFailure
