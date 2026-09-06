// oxlint-disable anti-slop/no-unknown-parameters -- prepared values cross a persistence boundary.
// oxlint-disable anti-slop/no-runtime-typeof -- validation is the public untyped DTO boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- validation builds a canonical DTO from untrusted fields.
// oxlint-disable anti-slop/no-known-value-widening -- the builder assembles a validated persistence DTO.

import { Result, type Result as ResultType } from 'better-result'

import { validateJsonValue } from '../codec/json'
import { readObjectFields } from '../internal/json'
import {
  validatePositiveIntegerValue,
  validatePriorityValue,
  validateTimestampValue
} from '../internal/validation'
import { makePersistedBackoff } from '../protocol/backoff'
import { makeJobId, makeJobName, makeQueueName } from '../protocol/brands'
import { JobDefinitionError } from '../protocol/errors'
import { protocolVersion } from '../protocol/types'
import type { JsonValue, PersistedBackoff, ProtocolVersion } from '../protocol/types'
import { normalizeIdempotencyKey, normalizeMetadata } from './normalization'
import type { JobIdentity } from './job'

export type PreparedEnqueue<
  Queue extends string = string,
  Name extends string = string,
  Version extends number = number
> = {
  readonly protocolVersion: ProtocolVersion
  readonly identity: JobIdentity<Queue, Name, Version>
  readonly id?: import('../protocol').JobId
  readonly idempotencyKey?: string
  readonly payload: JsonValue
  readonly metadata: Readonly<Record<string, string>>
  readonly priority: number
  readonly runAt: number
  readonly attemptsMax: number
  readonly backoff?: PersistedBackoff
  readonly timeoutMs?: number
  readonly now: number
}

const fields = [
  'protocolVersion',
  'identity',
  'id',
  'idempotencyKey',
  'payload',
  'metadata',
  'priority',
  'runAt',
  'attemptsMax',
  'backoff',
  'timeoutMs',
  'now'
] as const

const identityFields = ['queue', 'name', 'version'] as const

const invalid = <Value>(field: string, message: string): ResultType<Value, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

const requireField = (
  value: Readonly<Record<string, unknown>>,
  field: string
): ResultType<unknown, JobDefinitionError> =>
  Object.prototype.hasOwnProperty.call(value, field)
    ? Result.ok(value[field])
    : invalid(field, 'is required')

const validateIdentity = (
  value: unknown
): ResultType<JobIdentity<string, string, number>, JobDefinitionError> => {
  const checked = readObjectFields(value, identityFields, 'identity')
  if (Result.isError(checked)) return checked

  const queue = makeQueueName(checked.value.queue)
  const name = makeJobName(checked.value.name)
  const version = validatePositiveIntegerValue(checked.value.version, 'identity.version')
  if (Result.isError(queue)) return queue
  if (Result.isError(name)) return name
  if (Result.isError(version)) return version

  return Result.ok(Object.freeze({ queue: queue.value, name: name.value, version: version.value }))
}

/** Validate and snapshot a storage-neutral PreparedEnqueue DTO. */
export const makePreparedEnqueue = (
  value: unknown
): ResultType<PreparedEnqueue, JobDefinitionError> => {
  const checked = readObjectFields(value, fields, 'preparedEnqueue')
  if (Result.isError(checked)) return checked

  const required = fields.filter(
    (field) =>
      field !== 'id' && field !== 'idempotencyKey' && field !== 'backoff' && field !== 'timeoutMs'
  )
  for (const field of required) {
    const present = requireField(checked.value, field)
    if (Result.isError(present)) return present
  }

  if (checked.value.protocolVersion !== protocolVersion) {
    return invalid(
      'protocolVersion',
      `expected protocol version ${protocolVersion}, received ${String(checked.value.protocolVersion)}`
    )
  }

  const identity = validateIdentity(checked.value.identity)
  if (Result.isError(identity)) return identity

  const payload = validateJsonValue(checked.value.payload)
  if (!payload.ok) return invalid('payload', `must be JSON-safe (${payload.code})`)

  const metadata = normalizeMetadata(checked.value.metadata)
  if (Result.isError(metadata)) return metadata

  const priority = validatePriorityValue(checked.value.priority, 'priority')
  const runAt = validateTimestampValue(checked.value.runAt, 'runAt')
  const attemptsMax = validatePositiveIntegerValue(checked.value.attemptsMax, 'attemptsMax')
  const now = validateTimestampValue(checked.value.now, 'now')
  if (Result.isError(priority)) return priority
  if (Result.isError(runAt)) return runAt
  if (Result.isError(attemptsMax)) return attemptsMax
  if (Result.isError(now)) return now

  const id =
    checked.value.id === undefined
      ? Result.ok<import('../protocol').JobId | undefined>(undefined)
      : makeJobId(checked.value.id)
  const idempotencyKey = normalizeIdempotencyKey(checked.value.idempotencyKey)
  const backoff =
    checked.value.backoff === undefined
      ? Result.ok<PersistedBackoff | undefined>(undefined)
      : makePersistedBackoff(checked.value.backoff)
  const timeout =
    checked.value.timeoutMs === undefined
      ? Result.ok<number | undefined>(undefined)
      : validatePositiveIntegerValue(checked.value.timeoutMs, 'timeoutMs')
  if (Result.isError(id)) return id
  if (Result.isError(idempotencyKey)) return idempotencyKey
  if (Result.isError(backoff)) return backoff
  if (Result.isError(timeout)) return timeout

  const prepared: Record<string, unknown> = {
    protocolVersion,
    identity: identity.value,
    payload: payload.value,
    metadata: metadata.value,
    priority: priority.value,
    runAt: runAt.value,
    attemptsMax: attemptsMax.value,
    now: now.value
  }
  if (id.value !== undefined) prepared.id = id.value
  if (idempotencyKey.value !== undefined) prepared.idempotencyKey = idempotencyKey.value
  if (backoff.value !== undefined) prepared.backoff = backoff.value
  if (timeout.value !== undefined) prepared.timeoutMs = timeout.value

  // SAFETY: every field was validated above and optional fields are added only after their validators succeed.
  return Result.ok(Object.freeze(prepared) as PreparedEnqueue)
}

export const validatePreparedEnqueue = makePreparedEnqueue
