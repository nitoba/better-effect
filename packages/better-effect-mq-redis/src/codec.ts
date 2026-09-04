// oxlint-disable anti-slop/no-unknown-parameters -- Redis replies are decoded at this persistence boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- Redis hashes are deliberately string dictionaries.
// oxlint-disable anti-slop/no-unknown-returns -- decoded values are validated before returning.
// oxlint-disable anti-slop/no-runtime-typeof -- JSON values are parsed and narrowed at the codec boundary.
// oxlint-disable anti-slop/no-known-value-widening -- dictionary snapshots are used to defeat prototype pollution.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts stay at validated persistence boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts follow validation or null-prototype construction.

import { Result, type Result as ResultType } from 'better-result'
import {
  makeJobRecord,
  validateAttemptRecord,
  validateJobRecord,
  type AttemptRecord,
  type JsonValue,
  type JobRecord
} from 'better-effect-mq'

import { RedisLayoutError } from './errors'
import { hasUnpairedSurrogate } from './internal/text'

export type RedisHashFields = Readonly<Record<string, string>>
export type RedisDecodeResult<T> = ResultType<T, RedisLayoutError>

const jobFields = [
  'id',
  'name',
  'version',
  'queue',
  'state',
  'payload',
  'metadata',
  'priority',
  'runAt',
  'orderingSequence',
  'attemptsMax',
  'attemptsMade',
  'attemptSequence',
  'deliveryCount',
  'stalledCount',
  'backoff',
  'timeoutMs',
  'idempotencyKey',
  'createdAt',
  'updatedAt',
  'processedAt',
  'finishedAt',
  'leaseOwner',
  'leaseToken',
  'leaseExpiresAt',
  'cancellationRequestedAt',
  'result',
  'failure'
] as const

const knownJobFields = new Set<string>(jobFields)
const attemptFields = [
  'attempt',
  'attemptSequence',
  'delivery',
  'startedAt',
  'finishedAt',
  'outcome',
  'result',
  'failure',
  'retryAt',
  'retryDelayMs'
] as const
const knownAttemptFields = new Set<string>(attemptFields)
const decimal = /^(?:0|[1-9]\d*)$/u
const signedDecimal = /^-?(?:0|[1-9]\d*)$/u

type PlainRecord = Record<string, unknown>

const invalid = (field: string, message: string, cause?: unknown): RedisLayoutError =>
  new RedisLayoutError(message, field, 'INVALID_DATA', cause === undefined ? {} : { cause })

const isPlainObject = (value: unknown): value is PlainRecord => {
  if (value === null || typeof value !== 'object') return false
  try {
    if (Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const ownValue = (value: PlainRecord, key: string): { present: boolean; value: unknown } => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) return { present: false, value: undefined }
    if (!('value' in descriptor)) throw new Error('accessor')
    return { present: true, value: descriptor.value }
  } catch {
    throw invalid(key, 'contains an unreadable field')
  }
}

const canonicalize = (value: unknown, seen: Set<object>, field: string): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && hasUnpairedSurrogate(value)) {
      throw invalid(field, 'contains malformed Unicode')
    }
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(field, 'contains an invalid number')
    return value
  }
  if (typeof value !== 'object') throw invalid(field, 'contains a non-JSON value')
  if (seen.has(value)) throw invalid(field, 'contains a cycle')
  seen.add(value)

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype)
        throw invalid(field, 'must use the standard array prototype')
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
      const length = lengthDescriptor?.value
      if (
        lengthDescriptor === undefined ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        Object.keys(value).length !== length
      ) {
        throw invalid(field, 'contains an invalid array')
      }
      const ownKeys = Reflect.ownKeys(value)
      if (
        ownKeys.length !== length + 1 ||
        ownKeys.some(
          (key) =>
            typeof key !== 'string' ||
            (key !== 'length' && (!decimal.test(key) || Number(key) >= length))
        )
      ) {
        throw invalid(field, 'contains unsupported array properties')
      }
      const output: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        const item = ownValue(value as unknown as PlainRecord, String(index))
        if (!item.present) throw invalid(`${field}.${index}`, 'is missing')
        output.push(canonicalize(item.value, seen, `${field}.${index}`))
      }
      return output
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid(field, 'must contain plain objects')
    }
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key !== 'string')) {
      throw invalid(field, 'must not contain symbols')
    }
    const output = Object.create(null) as PlainRecord
    for (const key of ownKeys.filter((key): key is string => typeof key === 'string').sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        throw invalid(`${field}.${key}`, 'must contain enumerable data properties')
      }
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: canonicalize(descriptor.value, seen, `${field}.${key}`),
        writable: true
      })
    }
    return output
  } catch (cause) {
    if (cause instanceof RedisLayoutError) throw cause
    throw invalid(field, 'could not read JSON value', cause)
  } finally {
    seen.delete(value)
  }
}

const canonicalJson = (value: unknown, field: string): string => {
  try {
    const encoded = JSON.stringify(canonicalize(value, new Set<object>(), field))
    if (encoded === undefined) throw invalid(field, 'could not encode JSON value')
    return encoded
  } catch (cause) {
    if (cause instanceof RedisLayoutError) throw cause
    throw invalid(field, 'could not encode JSON value', cause)
  }
}

const snapshotDto = (
  value: unknown,
  allowedFields: ReadonlySet<string>,
  field: string
): PlainRecord => {
  if (!isPlainObject(value)) throw invalid(field, 'must be a plain object')
  const output = Object.create(null) as PlainRecord
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowedFields.has(key)) {
        throw invalid(field, 'contains unsupported fields')
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        throw invalid(`${field}.${key}`, 'must contain enumerable data properties')
      }
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true
      })
    }
  } catch (cause) {
    if (cause instanceof RedisLayoutError) throw cause
    throw invalid(field, 'could not read DTO', cause)
  }
  return output
}

const parseJson = (value: string, field: string): unknown => {
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw invalid(field, 'contains invalid JSON', cause)
  }
}

const encodeOptional = (target: Record<string, string>, key: string, value: unknown): void => {
  if (value !== undefined) target[key] = canonicalJson(value, key)
}

const encodeNumber = (target: Record<string, string>, key: string, value: number): void => {
  if (!Number.isSafeInteger(value)) throw invalid(key, 'must be a safe integer')
  target[key] = String(value)
}

const encodeOptionalNumber = (
  target: Record<string, string>,
  key: string,
  value: number | undefined
): void => {
  if (value !== undefined) encodeNumber(target, key, value)
}

const encodeJobFields = (record: JobRecord): RedisHashFields => {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>
  fields.id = record.id
  fields.name = record.name
  encodeNumber(fields, 'version', record.version)
  fields.queue = record.queue
  fields.state = record.state
  fields.payload = canonicalJson(record.payload, 'payload')
  fields.metadata = canonicalJson(record.metadata, 'metadata')
  encodeNumber(fields, 'priority', record.priority)
  encodeNumber(fields, 'runAt', record.runAt)
  encodeNumber(fields, 'orderingSequence', record.orderingSequence)
  encodeNumber(fields, 'attemptsMax', record.attemptsMax)
  encodeNumber(fields, 'attemptsMade', record.attemptsMade)
  encodeOptionalNumber(fields, 'attemptSequence', record.attemptSequence)
  encodeNumber(fields, 'deliveryCount', record.deliveryCount)
  encodeNumber(fields, 'stalledCount', record.stalledCount)
  encodeOptional(fields, 'backoff', record.backoff)
  encodeOptionalNumber(fields, 'timeoutMs', record.timeoutMs)
  if (record.idempotencyKey !== undefined) fields.idempotencyKey = record.idempotencyKey
  encodeNumber(fields, 'createdAt', record.createdAt)
  encodeNumber(fields, 'updatedAt', record.updatedAt)
  encodeOptionalNumber(fields, 'processedAt', record.processedAt)
  encodeOptionalNumber(fields, 'finishedAt', record.finishedAt)
  if (record.leaseOwner !== undefined) fields.leaseOwner = record.leaseOwner
  if (record.leaseToken !== undefined) fields.leaseToken = record.leaseToken
  encodeOptionalNumber(fields, 'leaseExpiresAt', record.leaseExpiresAt)
  encodeOptionalNumber(fields, 'cancellationRequestedAt', record.cancellationRequestedAt)
  encodeOptional(fields, 'result', record.result)
  encodeOptional(fields, 'failure', record.failure)
  return Object.freeze(fields)
}

/** Encode a validated JobRecord into Redis hash string fields. */
export const encodeJobRecord = (record: JobRecord): RedisHashFields => {
  const snapshot = snapshotDto(record, knownJobFields, 'record')
  const checked = validateJobRecord(snapshot as unknown as JobRecord)
  if (Result.isError(checked)) throw invalid('record', 'is not a valid JobRecord', checked.error)
  return encodeJobFields(checked.value)
}

const required = (fields: PlainRecord, key: string): string => {
  const value = ownValue(fields, key)
  if (!value.present || typeof value.value !== 'string')
    throw invalid(key, 'is missing or not a string')
  return value.value
}

const optional = (fields: PlainRecord, key: string): string | undefined => {
  const value = ownValue(fields, key)
  if (!value.present) return undefined
  if (typeof value.value !== 'string') throw invalid(key, 'is not a string')
  return value.value
}

const parseInteger = (value: string, field: string, signed = false): number => {
  const pattern = signed ? signedDecimal : decimal
  if (!pattern.test(value)) throw invalid(field, 'contains a non-canonical integer')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw invalid(field, 'contains an unsafe integer')
  return parsed
}

const optionalInteger = (fields: PlainRecord, key: string, signed = false): number | undefined => {
  const value = optional(fields, key)
  return value === undefined ? undefined : parseInteger(value, key, signed)
}

const jsonValue = (fields: PlainRecord, key: string): JsonValue => {
  const value = parseJson(required(fields, key), key)
  try {
    const canonical = canonicalize(value, new Set<object>(), key)
    return canonical as JsonValue
  } catch (cause) {
    if (cause instanceof RedisLayoutError) throw cause
    throw invalid(key, 'contains invalid JSON data', cause)
  }
}

const optionalJsonValue = (fields: PlainRecord, key: string): JsonValue | undefined => {
  const value = optional(fields, key)
  if (value === undefined) return undefined
  const parsed = parseJson(value, key)
  try {
    return canonicalize(parsed, new Set<object>(), key) as JsonValue
  } catch (cause) {
    if (cause instanceof RedisLayoutError) throw cause
    throw invalid(key, 'contains invalid JSON data', cause)
  }
}

const readHash = (fields: unknown): PlainRecord => {
  if (!isPlainObject(fields)) throw invalid('fields', 'must be a plain object')
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== 'string') throw invalid('fields', 'must not contain symbols')
    const descriptor = Object.getOwnPropertyDescriptor(fields, key)
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw invalid(key, 'must be an enumerable data property')
    }
    if (typeof descriptor.value !== 'string') throw invalid(key, 'must be a string')
  }
  return fields
}

const makeDecodedRecord = (fields: PlainRecord): JobRecord => {
  const record = Object.create(null) as PlainRecord
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) record[key] = value
  }

  record.id = required(fields, 'id')
  record.name = required(fields, 'name')
  record.version = parseInteger(required(fields, 'version'), 'version')
  record.queue = required(fields, 'queue')
  record.state = required(fields, 'state')
  record.payload = jsonValue(fields, 'payload')
  record.metadata = jsonValue(fields, 'metadata')
  record.priority = parseInteger(required(fields, 'priority'), 'priority', true)
  record.runAt = parseInteger(required(fields, 'runAt'), 'runAt')
  record.orderingSequence = parseInteger(required(fields, 'orderingSequence'), 'orderingSequence')
  record.attemptsMax = parseInteger(required(fields, 'attemptsMax'), 'attemptsMax')
  record.attemptsMade = parseInteger(required(fields, 'attemptsMade'), 'attemptsMade')
  set('attemptSequence', optionalInteger(fields, 'attemptSequence'))
  record.deliveryCount = parseInteger(required(fields, 'deliveryCount'), 'deliveryCount')
  record.stalledCount = parseInteger(required(fields, 'stalledCount'), 'stalledCount')
  set('backoff', optionalJsonValue(fields, 'backoff'))
  set('timeoutMs', optionalInteger(fields, 'timeoutMs'))
  set('idempotencyKey', optional(fields, 'idempotencyKey'))
  record.createdAt = parseInteger(required(fields, 'createdAt'), 'createdAt')
  record.updatedAt = parseInteger(required(fields, 'updatedAt'), 'updatedAt')
  set('processedAt', optionalInteger(fields, 'processedAt'))
  set('finishedAt', optionalInteger(fields, 'finishedAt'))
  set('leaseOwner', optional(fields, 'leaseOwner'))
  set('leaseToken', optional(fields, 'leaseToken'))
  set('leaseExpiresAt', optionalInteger(fields, 'leaseExpiresAt'))
  set('cancellationRequestedAt', optionalInteger(fields, 'cancellationRequestedAt'))
  set('result', optionalJsonValue(fields, 'result'))
  set('failure', optionalJsonValue(fields, 'failure'))
  return record as unknown as JobRecord
}

/** Decode and validate an untrusted Redis hash into an immutable JobRecord. */
export const decodeJobRecord = (fields: RedisHashFields): RedisDecodeResult<JobRecord> => {
  try {
    const raw = readHash(fields)
    for (const key of Object.keys(raw)) {
      if (!knownJobFields.has(key)) throw invalid(key, 'is an unsupported JobRecord field')
    }
    const checked = makeJobRecord(makeDecodedRecord(raw))
    return Result.isError(checked)
      ? Result.err(invalid('record', 'contains invalid JobRecord fields', checked.error))
      : Result.ok(checked.value)
  } catch (cause) {
    return Result.err(
      cause instanceof RedisLayoutError
        ? cause
        : invalid('record', 'could not decode JobRecord', cause)
    )
  }
}

/** Encode a validated attempt ledger entry as canonical JSON. */
export const encodeAttempt = (attempt: AttemptRecord): string => {
  const snapshot = snapshotDto(attempt, knownAttemptFields, 'attempt')
  const checked = validateAttemptRecord(snapshot as unknown as AttemptRecord)
  if (Result.isError(checked))
    throw invalid('attempt', 'is not a valid AttemptRecord', checked.error)
  const value = checked.value
  const fields: Record<string, unknown> = {
    attempt: value.attempt,
    delivery: value.delivery,
    finishedAt: value.finishedAt,
    outcome: value.outcome
  }
  if (value.attemptSequence !== undefined) fields.attemptSequence = value.attemptSequence
  if (value.startedAt !== undefined) fields.startedAt = value.startedAt
  if (value.result !== undefined) fields.result = value.result
  if (value.failure !== undefined) fields.failure = value.failure
  if (value.retryAt !== undefined) fields.retryAt = value.retryAt
  if (value.retryDelayMs !== undefined) fields.retryDelayMs = value.retryDelayMs
  return canonicalJson(fields, 'attempt')
}

/** Decode and validate an untrusted attempt ledger JSON value. */
export const decodeAttempt = (value: string): RedisDecodeResult<AttemptRecord> => {
  try {
    const parsed = parseJson(value, 'attempt')
    const canonical = canonicalize(parsed, new Set<object>(), 'attempt')
    const checked = validateAttemptRecord(canonical)
    return Result.isError(checked)
      ? Result.err(invalid('attempt', 'contains invalid AttemptRecord fields', checked.error))
      : Result.ok(checked.value)
  } catch (cause) {
    return Result.err(
      cause instanceof RedisLayoutError
        ? cause
        : invalid('attempt', 'could not decode AttemptRecord', cause)
    )
  }
}
