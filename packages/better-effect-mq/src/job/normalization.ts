// oxlint-disable anti-slop/no-runtime-typeof -- normalization is the public untyped callback boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- callback outputs are validated before persistence.

import { Result, type Result as ResultType } from 'better-result'

import { hasUnpairedSurrogate } from '../internal/validation'
import { JobDefinitionError } from '../protocol/errors'
import { isPlainObject } from './internal'

const invalid = <Value>(field: string, message: string): ResultType<Value, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

export const normalizeIdempotencyKey = (
  value: unknown
): ResultType<string | undefined, JobDefinitionError> => {
  if (value === undefined) {
    return Result.ok(undefined)
  }

  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    hasUnpairedSurrogate(value)
  ) {
    return invalid(
      'idempotencyKey',
      'must be a non-empty well-formed string without NUL or undefined'
    )
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
