// oxlint-disable anti-slop/no-runtime-typeof -- public schedule and row boundaries are validated here.
// oxlint-disable anti-slop/no-unknown-parameters -- PostgreSQL rows and schedule DTOs are untrusted.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- JSON and metadata maps are built after validation.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts are confined to SQL row boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions restore checked protocol types.

import { createHash } from 'node:crypto'
import { Layer } from 'better-effect'
import type { ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  DuplicateScheduleError,
  JobScheduleStore,
  ScheduleDefinitionError,
  ScheduleNotFoundError,
  ScheduleStoreFailure,
  isValidTimeZone,
  makeJobId,
  makeJobName,
  makeJobRecord,
  makePersistedBackoff,
  makeQueueName,
  makeScheduleOccurrenceId,
  maxScheduleIdentityLength,
  normalizeIdempotencyKey,
  normalizeMetadata,
  parseCron,
  validateDuration,
  validateTimestamp
} from 'better-effect-mq'
import type {
  AnyJobScheduleStoreToken,
  DueSchedulesOptions,
  EnqueueRequest,
  JobRecord,
  JobScheduleStoreContract,
  ListSchedulesOptions,
  MisfirePolicy,
  PersistedBackoff,
  ScheduleOccurrence,
  ScheduleRecord,
  ScheduleSelector,
  ScheduleStoreError,
  ScheduleTickDecision,
  TickScheduleCommand,
  TickScheduleResult,
  UpsertScheduleResult,
  DurableJobEventInput,
  DurableJobEventType,
  JobEventStoreWriter
} from 'better-effect-mq'
import {
  normalizePostgresJobStoreConfig,
  normalizePostgresJobStoreConnectionConfig,
  type PostgresJobStoreConfig,
  type PostgresJobStoreConnectionConfig,
  type PoolClient
} from './config'
import { PostgresClient } from './client'
import {
  appendPostgresJobEvent,
  assertPostgresJobEventWriterReady,
  defaultPostgresJobEventWriter,
  postgresJobEventTableAvailable
} from './event-store'
import { POSTGRES_TABLES, quoteIdentifier } from './schema'

export type PostgresJobScheduleStoreOptions = PostgresJobStoreConfig

type Row = Record<string, unknown>
type ScheduleResult<Value> = ResultType<Value, ScheduleStoreError>
type Operation<Value> = import('better-effect-mq').ScheduleStoreOperation<Value, ScheduleStoreError>
type Tx = PoolClient & {
  query<RowValue = unknown>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: readonly RowValue[]; rowCount: number | null }>
}

const maxOccurrencesPerTick = 256
const maxSafeInteger = Number.MAX_SAFE_INTEGER
const scheduleDescriptor = Object.freeze({
  extension: 'better-effect-mq/schedules' as const,
  extensionVersion: 1 as const,
  jobStoreProtocolVersion: 1 as const
})
const scheduleEventMutationOperations = new Set([
  'upsertSchedule',
  'removeSchedule',
  'tickSchedule',
  'pauseSchedule',
  'resumeSchedule'
])

const scheduleColumns = [
  'schedule_key',
  'schedule_group',
  'job_queue',
  'job_name',
  'job_version',
  'queue',
  'cron',
  'every_ms',
  'time_zone',
  'payload',
  'metadata',
  'priority',
  'attempts_max',
  'backoff',
  'timeout_ms',
  'misfire',
  'overlap',
  'paused',
  'revision',
  'next_run_at_ms',
  'last_scheduled_at_ms',
  'last_job_id',
  'created_at_ms',
  'updated_at_ms'
] as const

const jobColumns = [
  'id',
  'name',
  'version',
  'queue',
  'state',
  'payload',
  'metadata',
  'priority',
  'run_at_ms',
  'sequence',
  'attempts_max',
  'attempts_made',
  'attempt_sequence',
  'delivery_count',
  'stalled_count',
  'backoff',
  'timeout_ms',
  'idempotency_key',
  'created_at_ms',
  'updated_at_ms',
  'processed_at_ms',
  'finished_at_ms',
  'lease_owner',
  'lease_token',
  'lease_expires_at_ms',
  'cancel_requested',
  'cancellation_requested_at_ms',
  'result',
  'failure'
] as const

const ok = <Value>(value: Value): ResultType<Value, ScheduleStoreError> =>
  Result.ok(value) as unknown as ResultType<Value, ScheduleStoreError>

const failed = <Value>(result: unknown): Operation<Value> => result as Operation<Value>

const pending = <Value>(promise: PromiseLike<ScheduleResult<Value>>): Operation<Value> =>
  promise as unknown as Operation<Value>

const errorTags = new Set([
  'JobDefinitionError',
  'JobNotFoundError',
  'JobStoreFailure',
  'InvalidJobTransitionError',
  'LeaseLostError',
  'SettlementConflictError',
  'UnsupportedJobStoreOperationError',
  'ScheduleDefinitionError',
  'ScheduleNotFoundError',
  'ScheduleStoreFailure',
  'DuplicateScheduleError'
])

const isTaggedError = (cause: unknown): boolean => {
  try {
    return (
      typeof cause === 'object' &&
      cause !== null &&
      typeof (cause as { readonly _tag?: unknown })._tag === 'string' &&
      errorTags.has((cause as { readonly _tag: string })._tag)
    )
  } catch {
    return false
  }
}

const postgresErrorCode = (cause: unknown): string | undefined => {
  try {
    if (typeof cause !== 'object' || cause === null) return undefined
    const code = (cause as { readonly code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

const isRetryable = (cause: unknown): boolean => {
  const code = postgresErrorCode(cause)
  return code === '40001' || code === '40P01'
}

const releaseError = (cause: unknown): Error | undefined =>
  cause instanceof Error && typeof postgresErrorCode(cause) === 'string' ? cause : undefined

const failure = (operation: string, cause: unknown): ScheduleStoreFailure =>
  new ScheduleStoreFailure({
    operation,
    retryable: isRetryable(cause),
    message: `PostgreSQL ${operation} failed`,
    cause
  })

const fail = <Value>(operation: string, cause: unknown): ResultType<Value, ScheduleStoreError> =>
  isTaggedError(cause)
    ? (Result.err(cause) as ResultType<Value, ScheduleStoreError>)
    : (Result.err(failure(operation, cause)) as ResultType<Value, ScheduleStoreError>)

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true
    }
  }
  return false
}

const definition = <Value>(field: string, message: string): ResultType<Value, ScheduleStoreError> =>
  Result.err(new ScheduleDefinitionError({ field, message }))

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const validateText = (value: unknown, field: string): ResultType<string, ScheduleStoreError> => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxScheduleIdentityLength ||
    value.includes('\u0000') ||
    hasUnpairedSurrogate(value)
  ) {
    return definition(
      field,
      `must be a non-empty string of at most ${maxScheduleIdentityLength} characters`
    )
  }
  return Result.ok(value)
}

const validateNonNegativeInteger = (
  value: unknown,
  field: string
): ResultType<number, ScheduleStoreError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return definition(field, 'must be a non-negative safe integer')
  return Result.ok(value)
}

const validateSafeInteger = (
  value: unknown,
  field: string
): ResultType<number, ScheduleStoreError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    return definition(field, 'must be a safe integer')
  return Result.ok(value)
}

const validatePositiveInteger = (
  value: unknown,
  field: string
): ResultType<number, ScheduleStoreError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    return definition(field, 'must be a positive safe integer')
  return Result.ok(value)
}

const snapshotJson = (
  value: unknown,
  field: string,
  ancestors = new Set<object>()
): ResultType<import('better-effect-mq').JsonValue, ScheduleStoreError> => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return Result.ok(value)
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Result.ok(value) : definition(field, 'must be JSON-safe')
  }
  if (typeof value !== 'object' || value === null) return definition(field, 'must be JSON-safe')
  if (ancestors.has(value)) return definition(field, 'must not contain cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const output: import('better-effect-mq').JsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index))
          return definition(`${field}[${index}]`, 'must not be sparse')
        const child = snapshotJson(value[index], `${field}[${index}]`, ancestors)
        if (Result.isError(child)) return child
        output.push(child.value)
      }
      return Result.ok(Object.freeze(output))
    }
    if (!isPlainObject(value)) return definition(field, 'must contain only plain objects')
    const output: Record<string, import('better-effect-mq').JsonValue> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return definition(field, 'must contain only string keys')
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (property === undefined || !('value' in property))
        return definition(`${field}.${key}`, 'must contain data properties')
      const child = snapshotJson(property.value, `${field}.${key}`, ancestors)
      if (Result.isError(child)) return child
      output[key] = child.value
    }
    return Result.ok(Object.freeze(output))
  } catch {
    return definition(field, 'must be JSON-safe')
  } finally {
    ancestors.delete(value)
  }
}

const parseJson = (value: unknown, field: string): import('better-effect-mq').JsonValue => {
  let candidate = value
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value)
    } catch {
      candidate = value
    }
  }
  const parsed = snapshotJson(candidate, field)
  if (Result.isError(parsed)) throw parsed.error
  return parsed.value
}

const optionalJson = (
  value: unknown,
  field: string
): import('better-effect-mq').JsonValue | undefined =>
  value === null || value === undefined ? undefined : parseJson(value, field)

const json = (value: unknown): string => JSON.stringify(value)

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`
}

const logicalDigest = (record: ScheduleRecord): string =>
  stableJson({
    key: record.key,
    group: record.group,
    job: record.job,
    queue: record.queue,
    cron: record.cron,
    everyMs: record.everyMs,
    timeZone: record.timeZone,
    payload: record.payload,
    metadata: record.metadata,
    priority: record.priority,
    attemptsMax: record.attemptsMax,
    backoff: record.backoff,
    timeoutMs: record.timeoutMs,
    misfire: record.misfire,
    overlap: record.overlap,
    paused: record.paused
  })

const cloneRecord = (record: ScheduleRecord): ScheduleRecord =>
  Object.freeze({
    ...record,
    job: Object.freeze({ ...record.job }),
    payload: parseJson(json(record.payload), 'payload'),
    metadata: Object.freeze({ ...record.metadata }),
    backoff: record.backoff === undefined ? undefined : Object.freeze({ ...record.backoff }),
    misfire: Object.freeze({ ...record.misfire }) as MisfirePolicy
  })

const normalizePolicy = (value: unknown): ResultType<MisfirePolicy, ScheduleStoreError> => {
  if (!isPlainObject(value)) return definition('misfire', 'must be an object')
  if (value.strategy === 'skip' || value.strategy === 'run-once') {
    return Result.ok(Object.freeze({ strategy: value.strategy }))
  }
  if (value.strategy === 'catch-up') {
    const maximum = validatePositiveInteger(value.maxOccurrences, 'misfire.maxOccurrences')
    return Result.isError(maximum)
      ? maximum
      : Result.ok(Object.freeze({ strategy: 'catch-up', maxOccurrences: maximum.value }))
  }
  return definition('misfire.strategy', 'must be skip, run-once or catch-up')
}

const normalizeRecord = (value: unknown): ResultType<ScheduleRecord, ScheduleStoreError> => {
  if (!isPlainObject(value)) return definition('record', 'must be an object')
  const key = validateText(value.key, 'key')
  const group = validateText(value.group, 'group')
  const queue = makeQueueName(value.queue)
  const job = value.job
  if (!isPlainObject(job)) return definition('job', 'must be an object')
  const jobQueue = makeQueueName(job.queue)
  const jobName = makeJobName(job.name)
  const jobVersion = validatePositiveInteger(job.version, 'job.version')
  const payload = snapshotJson(value.payload, 'payload')
  const metadata = normalizeMetadata(value.metadata)
  const priority = validateSafeInteger(value.priority, 'priority')
  const attemptsMax = validatePositiveInteger(value.attemptsMax, 'attemptsMax')
  const timeout =
    value.timeoutMs === undefined
      ? Result.ok<number | undefined>(undefined)
      : validateDuration(value.timeoutMs, 'timeoutMs')
  const backoff =
    value.backoff === undefined
      ? Result.ok<PersistedBackoff | undefined>(undefined)
      : makePersistedBackoff(value.backoff)
  const revision = validateNonNegativeInteger(value.revision, 'revision')
  const nextRunAtMs = validateTimestamp(value.nextRunAtMs, 'nextRunAtMs')
  const createdAtMs = validateTimestamp(value.createdAtMs, 'createdAtMs')
  const updatedAtMs = validateTimestamp(value.updatedAtMs, 'updatedAtMs')
  const lastScheduledAtMs =
    value.lastScheduledAtMs === undefined
      ? Result.ok<number | undefined>(undefined)
      : validateTimestamp(value.lastScheduledAtMs, 'lastScheduledAtMs')
  const lastJobId =
    value.lastJobId === undefined
      ? Result.ok<import('better-effect-mq').JobId | undefined>(undefined)
      : makeJobId(value.lastJobId)
  const timeZone: ResultType<string | undefined, ScheduleStoreError> =
    value.timeZone === undefined
      ? Result.ok<string | undefined>(undefined)
      : typeof value.timeZone === 'string' && isValidTimeZone(value.timeZone)
        ? Result.ok<string | undefined>(value.timeZone)
        : definition('timeZone', 'must be a valid IANA timezone')
  const policy = normalizePolicy(value.misfire)

  if (Result.isError(key)) return key
  if (Result.isError(group)) return group
  if (Result.isError(queue)) return queue
  if (Result.isError(jobQueue)) return jobQueue
  if (Result.isError(jobName)) return jobName
  if (Result.isError(jobVersion)) return jobVersion
  if (Result.isError(payload)) return payload
  if (Result.isError(metadata)) return metadata
  if (Result.isError(priority)) return priority
  if (Result.isError(attemptsMax)) return attemptsMax
  if (Result.isError(timeout)) return timeout
  if (Result.isError(backoff)) return backoff
  if (Result.isError(revision)) return revision
  if (Result.isError(nextRunAtMs)) return nextRunAtMs
  if (Result.isError(createdAtMs)) return createdAtMs
  if (Result.isError(updatedAtMs)) return updatedAtMs
  if (Result.isError(lastScheduledAtMs)) return lastScheduledAtMs
  if (Result.isError(lastJobId)) return lastJobId
  if (Result.isError(timeZone)) return timeZone
  if (Result.isError(policy)) return policy
  if (jobQueue.value !== queue.value) return definition('job.queue', 'must match queue')

  const hasCron = value.cron !== undefined
  const hasEveryMs = value.everyMs !== undefined
  if (hasCron === hasEveryMs)
    return definition('cadence', 'must provide exactly one of cron or everyMs')
  let cron: string | undefined
  let everyMs: number | undefined
  if (hasCron) {
    if (typeof value.cron !== 'string') return definition('cron', 'must be a string')
    try {
      parseCron(value.cron)
    } catch (cause) {
      return isTaggedError(cause)
        ? (Result.err(cause) as ResultType<ScheduleRecord, ScheduleStoreError>)
        : definition('cron', 'must be valid')
    }
    cron = value.cron
  } else {
    const cadence = validatePositiveInteger(value.everyMs, 'everyMs')
    if (Result.isError(cadence)) return cadence
    everyMs = cadence.value
  }
  if (value.overlap !== 'allow' && value.overlap !== 'skip')
    return definition('overlap', 'must be allow or skip')
  if (typeof value.paused !== 'boolean') return definition('paused', 'must be boolean')
  if (timeout.value === 0) return definition('timeoutMs', 'must be greater than zero')
  if (updatedAtMs.value < createdAtMs.value)
    return definition('updatedAtMs', 'must not be earlier than createdAtMs')
  return Result.ok(
    Object.freeze({
      key: key.value,
      group: group.value,
      job: Object.freeze({
        queue: jobQueue.value,
        name: jobName.value,
        version: jobVersion.value
      }),
      queue: queue.value,
      cron,
      everyMs,
      timeZone: timeZone.value,
      payload: payload.value,
      metadata: metadata.value,
      priority: priority.value,
      attemptsMax: attemptsMax.value,
      backoff: backoff.value,
      timeoutMs: timeout.value,
      misfire: policy.value,
      overlap: value.overlap,
      paused: value.paused,
      revision: revision.value,
      nextRunAtMs: nextRunAtMs.value,
      lastScheduledAtMs: lastScheduledAtMs.value,
      lastJobId: lastJobId.value,
      createdAtMs: createdAtMs.value,
      updatedAtMs: updatedAtMs.value
    })
  )
}

type ParsedSelector = { readonly group: string | undefined; readonly key: string }

const parseSelector = (value: unknown): ResultType<ParsedSelector, ScheduleStoreError> => {
  if (typeof value === 'string') {
    const key = validateText(value, 'key')
    return Result.isError(key) ? key : Result.ok({ key: key.value, group: undefined })
  }
  if (!isPlainObject(value)) return definition('key', 'must be a key or address')
  const key = validateText(value.key, 'key')
  const group = validateText(value.group, 'group')
  return Result.isError(key)
    ? key
    : Result.isError(group)
      ? group
      : Result.ok({ key: key.value, group: group.value })
}

const notFound = (selector: ParsedSelector): ScheduleNotFoundError =>
  selector.group === undefined
    ? new ScheduleNotFoundError({ key: selector.key })
    : new ScheduleNotFoundError({ key: selector.key, group: selector.group })

const scheduleValues = (record: ScheduleRecord): readonly unknown[] => [
  record.key,
  record.group,
  record.job.queue,
  record.job.name,
  record.job.version,
  record.queue,
  record.cron ?? null,
  record.everyMs ?? null,
  record.timeZone ?? null,
  json(record.payload),
  json(record.metadata),
  record.priority,
  record.attemptsMax,
  record.backoff === undefined ? null : json(record.backoff),
  record.timeoutMs ?? null,
  json(record.misfire),
  record.overlap,
  record.paused,
  record.revision,
  record.nextRunAtMs,
  record.lastScheduledAtMs ?? null,
  record.lastJobId ?? null,
  record.createdAtMs,
  record.updatedAtMs
]

const integer = (value: unknown, field: string, minimum = 0): number => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < minimum)
    throw new ScheduleDefinitionError({ field, message: 'must be a safe integer' })
  return number
}

const optionalInteger = (value: unknown, field: string): number | undefined =>
  value === null || value === undefined ? undefined : integer(value, field)

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || hasUnpairedSurrogate(value))
    throw new ScheduleDefinitionError({ field, message: 'must be a non-empty string' })
  return value
}

const decodeSchedule = (row: Row): ScheduleRecord => {
  const record = normalizeRecord({
    key: row.schedule_key,
    group: row.schedule_group,
    job: {
      queue: row.job_queue,
      name: row.job_name,
      version: integer(row.job_version, 'job_version', 1)
    },
    queue: row.queue,
    cron: row.cron === null ? undefined : row.cron,
    everyMs: optionalInteger(row.every_ms, 'every_ms'),
    timeZone: row.time_zone === null ? undefined : row.time_zone,
    payload: parseJson(row.payload, 'payload'),
    metadata: parseJson(row.metadata, 'metadata'),
    priority: integer(row.priority, 'priority', -maxSafeInteger),
    attemptsMax: integer(row.attempts_max, 'attempts_max', 1),
    backoff: optionalJson(row.backoff, 'backoff'),
    timeoutMs: optionalInteger(row.timeout_ms, 'timeout_ms'),
    misfire: parseJson(row.misfire, 'misfire'),
    overlap: row.overlap,
    paused: row.paused,
    revision: integer(row.revision, 'revision'),
    nextRunAtMs: integer(row.next_run_at_ms, 'next_run_at_ms'),
    lastScheduledAtMs: optionalInteger(row.last_scheduled_at_ms, 'last_scheduled_at_ms'),
    lastJobId: optionalString(row.last_job_id, 'last_job_id'),
    createdAtMs: integer(row.created_at_ms, 'created_at_ms'),
    updatedAtMs: integer(row.updated_at_ms, 'updated_at_ms')
  })
  if (Result.isError(record)) throw record.error
  return record.value
}

const decodeJob = (row: Row): JobRecord => {
  const decoded = makeJobRecord({
    id: row.id,
    name: row.name,
    version: integer(row.version, 'version', 1),
    queue: row.queue,
    state: row.state,
    payload: parseJson(row.payload, 'job.payload'),
    metadata: parseJson(row.metadata, 'job.metadata'),
    priority: integer(row.priority, 'priority', -maxSafeInteger),
    runAt: integer(row.run_at_ms, 'run_at_ms'),
    orderingSequence: integer(row.sequence, 'sequence'),
    attemptsMax: integer(row.attempts_max, 'attempts_max', 1),
    attemptsMade: integer(row.attempts_made, 'attempts_made'),
    attemptSequence: integer(row.attempt_sequence, 'attempt_sequence'),
    deliveryCount: integer(row.delivery_count, 'delivery_count'),
    stalledCount: integer(row.stalled_count, 'stalled_count'),
    backoff: optionalJson(row.backoff, 'job.backoff'),
    timeoutMs: optionalInteger(row.timeout_ms, 'timeout_ms'),
    idempotencyKey: optionalString(row.idempotency_key, 'idempotency_key'),
    createdAt: integer(row.created_at_ms, 'created_at_ms'),
    updatedAt: integer(row.updated_at_ms, 'updated_at_ms'),
    processedAt: optionalInteger(row.processed_at_ms, 'processed_at_ms'),
    finishedAt: optionalInteger(row.finished_at_ms, 'finished_at_ms'),
    leaseOwner: optionalString(row.lease_owner, 'lease_owner'),
    leaseToken: optionalString(row.lease_token, 'lease_token'),
    leaseExpiresAt: optionalInteger(row.lease_expires_at_ms, 'lease_expires_at_ms'),
    cancellationRequestedAt: optionalInteger(
      row.cancellation_requested_at_ms,
      'cancellation_requested_at_ms'
    ),
    result: optionalJson(row.result, 'job.result'),
    failure: optionalJson(row.failure, 'job.failure')
  })
  if (Result.isError(decoded)) throw decoded.error
  return decoded.value
}

const readSlots = (
  decision: ScheduleTickDecision
): ResultType<readonly ScheduleOccurrence[], ScheduleStoreError> => {
  const source = decision.occurrences ?? decision.occurrenceSlots
  if (source !== undefined && decision.enqueueRequests !== undefined)
    return definition('decision', 'must not provide both occurrences and enqueueRequests')
  if (decision.enqueueRequests !== undefined) {
    if (!Array.isArray(decision.enqueueRequests))
      return definition('decision.enqueueRequests', 'must be an array')
    if (decision.enqueueRequests.length > maxOccurrencesPerTick)
      return definition(
        'decision.enqueueRequests',
        `must contain at most ${maxOccurrencesPerTick} items`
      )
    const checked: ScheduleOccurrence[] = []
    for (const request of decision.enqueueRequests) {
      if (!isPlainObject(request))
        return definition('decision.enqueueRequests', 'must contain objects')
      const slot = validateTimestamp(request.runAt, 'decision.enqueueRequest.runAt')
      if (Result.isError(slot)) return slot
      // SAFETY: the public request was narrowed to an object and is validated by insertJob.
      checked.push({ slotMs: slot.value, enqueueRequest: request as EnqueueRequest })
    }
    return Result.ok(Object.freeze(checked))
  }
  if (source === undefined) return definition('decision.occurrences', 'is required')
  if (!Array.isArray(source)) return definition('decision.occurrences', 'must be an array')
  if (source.length > maxOccurrencesPerTick)
    return definition('decision.occurrences', `must contain at most ${maxOccurrencesPerTick} items`)
  const checked: ScheduleOccurrence[] = []
  for (const item of source) {
    const slotMs = typeof item === 'number' ? item : item?.slotMs
    const slot = validateTimestamp(slotMs, 'decision.occurrence.slotMs')
    if (Result.isError(slot)) return slot
    checked.push(typeof item === 'number' ? slot.value : { ...item, slotMs: slot.value })
  }
  return Result.ok(Object.freeze(checked))
}

const occurrenceId = (record: ScheduleRecord, slotMs: number): import('better-effect-mq').JobId =>
  makeJobId(makeScheduleOccurrenceId(record.key, slotMs)).unwrap()

class PostgresJobScheduleStoreImplementation implements JobScheduleStoreContract {
  readonly descriptor = scheduleDescriptor
  private closed = false
  private disposal: Promise<void> | undefined
  private readonly channel: string
  private eventsLayoutChecked = false
  private eventsAvailable = false
  private readonly eventWriter: JobEventStoreWriter

  constructor(
    private readonly client: PostgresClient,
    eventWriter?: JobEventStoreWriter
  ) {
    this.channel = `mq_${hash(`${client.schema}:${client.namespace}`)}_wake`
    this.eventWriter = eventWriter ?? defaultPostgresJobEventWriter
  }

  private table(name: string): string {
    return `${quoteIdentifier(this.client.schema)}.${quoteIdentifier(name)}`
  }

  private async withTx<Value>(
    operation: string,
    body: (tx: Tx) => Promise<Value>
  ): Promise<ScheduleResult<Value>> {
    if (this.closed) return fail(operation, new Error('store is closed'))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let tx: PoolClient | undefined
      let value: Value | undefined
      let cause: unknown
      let committed = false
      try {
        tx = await this.client.pool.connect()
        await tx.query('BEGIN')
        if (!this.eventsLayoutChecked) {
          this.eventsAvailable = await postgresJobEventTableAvailable(tx as Tx, this.client)
          this.eventsLayoutChecked = true
        }
        if (scheduleEventMutationOperations.has(operation)) {
          await assertPostgresJobEventWriterReady(
            tx as Tx,
            this.client,
            operation,
            this.eventWriter,
            this.eventsAvailable
          )
        }
        value = await body(tx as Tx)
        await tx.query('COMMIT')
        committed = true
      } catch (error) {
        cause = error
      }
      if (!committed && tx !== undefined) {
        try {
          await tx.query('ROLLBACK')
        } catch (rollback) {
          cause = cause === undefined ? rollback : new AggregateError([cause, rollback])
        }
      }
      if (tx !== undefined) {
        try {
          tx.release(releaseError(cause))
        } catch (release) {
          cause = cause === undefined ? release : new AggregateError([cause, release])
        }
      }
      if (committed) return ok(value as Value)
      if (isRetryable(cause) && attempt < 2) continue
      return fail(operation, cause)
    }
    return fail(operation, new Error('retry budget exhausted'))
  }

  private async appendEvent(
    tx: Tx,
    type: DurableJobEventType,
    record: ScheduleRecord,
    recordedAtMs: number,
    attributes: Readonly<Record<string, string>>
  ): Promise<void> {
    if (!this.eventsAvailable || !this.eventWriter.canAppend) return
    const input: DurableJobEventInput = {
      type,
      recordedAtMs,
      jobId: record.lastJobId,
      queue: record.queue,
      name: record.job.name,
      version: record.job.version,
      state: undefined,
      attempt: undefined,
      delivery: undefined,
      workerId: undefined,
      outcome: undefined,
      failureKind: undefined,
      duplicate: undefined,
      attributes
    }
    await appendPostgresJobEvent(tx, this.client, input)
  }

  private async appendJobEnqueued(tx: Tx, job: JobRecord, recordedAtMs: number): Promise<void> {
    if (!this.eventsAvailable || !this.eventWriter.canAppend) return
    const input: DurableJobEventInput = {
      type: 'job-enqueued',
      recordedAtMs,
      jobId: job.id,
      queue: job.queue,
      name: job.name,
      version: job.version,
      state: job.state,
      attempt: undefined,
      delivery: job.deliveryCount > 0 ? job.deliveryCount : undefined,
      workerId: undefined,
      outcome: undefined,
      failureKind: undefined,
      duplicate: false,
      attributes: Object.freeze({})
    }
    await appendPostgresJobEvent(tx, this.client, input)
  }

  private async notify(tx: Tx, queue: string, now: number): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.table(POSTGRES_TABLES.queues)} (namespace,queue,wake_version,updated_at_ms) VALUES ($1,$2,1,$3) ON CONFLICT (namespace,queue) DO UPDATE SET wake_version=${this.table(POSTGRES_TABLES.queues)}.wake_version+1,updated_at_ms=EXCLUDED.updated_at_ms WHERE ${this.table(POSTGRES_TABLES.queues)}.wake_version < 9007199254740991`,
      [this.client.namespace, queue, now]
    )
    try {
      await tx.query('SAVEPOINT better_effect_mq_schedule_notify')
      await tx.query('SELECT pg_notify($1,$2)', [this.channel, queue])
      await tx.query('RELEASE SAVEPOINT better_effect_mq_schedule_notify')
    } catch {
      try {
        await tx.query('ROLLBACK TO SAVEPOINT better_effect_mq_schedule_notify')
        await tx.query('RELEASE SAVEPOINT better_effect_mq_schedule_notify')
      } catch {
        // Polling on the JobStore wake-version remains authoritative.
      }
    }
  }

  private async resolve(
    tx: Tx,
    selector: ParsedSelector,
    lock: boolean
  ): Promise<ScheduleRecord | undefined> {
    const suffix = lock ? ' FOR UPDATE' : ''
    const result =
      selector.group === undefined
        ? await tx.query<Row>(
            `SELECT ${scheduleColumns.join(',')} FROM ${this.table(POSTGRES_TABLES.schedules)} WHERE namespace=$1 AND schedule_key=$2 ORDER BY schedule_group COLLATE "C" ASC${suffix}`,
            [this.client.namespace, selector.key]
          )
        : await tx.query<Row>(
            `SELECT ${scheduleColumns.join(',')} FROM ${this.table(POSTGRES_TABLES.schedules)} WHERE namespace=$1 AND schedule_group=$2 AND schedule_key=$3${suffix}`,
            [this.client.namespace, selector.group, selector.key]
          )
    if (selector.group === undefined && result.rows.length > 1) {
      throw new DuplicateScheduleError({
        group: '*',
        key: selector.key,
        message: `Schedule key "${selector.key}" is ambiguous`
      })
    }
    const row = result.rows[0]
    return row === undefined ? undefined : decodeSchedule(row)
  }

  private async insertJob(
    tx: Tx,
    record: ScheduleRecord,
    item: ScheduleOccurrence,
    nowMs: number
  ): Promise<{ readonly job: JobRecord; readonly duplicate: boolean }> {
    const occurrence = typeof item === 'number' ? { slotMs: item } : item
    const supplied = occurrence.enqueueRequest
    const payload = supplied === undefined ? record.payload : supplied.payload
    const metadata = supplied === undefined ? record.metadata : (supplied.metadata ?? {})
    const priority = supplied === undefined ? record.priority : (supplied.priority ?? 0)
    const attemptsMax = supplied === undefined ? record.attemptsMax : supplied.attemptsMax
    const backoff = supplied === undefined ? record.backoff : supplied.backoff
    const timeoutMs = supplied === undefined ? record.timeoutMs : supplied.timeoutMs
    const parsedPayload = snapshotJson(payload, 'decision.enqueueRequest.payload')
    const parsedMetadata = normalizeMetadata(metadata)
    const parsedPriority = validateSafeInteger(priority, 'decision.enqueueRequest.priority')
    const parsedAttempts = validatePositiveInteger(
      attemptsMax,
      'decision.enqueueRequest.attemptsMax'
    )
    const parsedRunAt = validateTimestamp(occurrence.slotMs, 'decision.occurrence.slotMs')
    const parsedBackoff =
      backoff === undefined
        ? Result.ok<PersistedBackoff | undefined>(undefined)
        : makePersistedBackoff(backoff)
    const parsedTimeout =
      timeoutMs === undefined
        ? Result.ok<number | undefined>(undefined)
        : validateDuration(timeoutMs, 'timeoutMs')
    const parsedIdempotency = normalizeIdempotencyKey(supplied?.idempotencyKey)
    if (Result.isError(parsedPayload)) throw parsedPayload.error
    if (Result.isError(parsedMetadata)) throw parsedMetadata.error
    if (Result.isError(parsedPriority)) throw parsedPriority.error
    if (Result.isError(parsedAttempts)) throw parsedAttempts.error
    if (Result.isError(parsedRunAt)) throw parsedRunAt.error
    if (Result.isError(parsedBackoff)) throw parsedBackoff.error
    if (Result.isError(parsedTimeout)) throw parsedTimeout.error
    if (Result.isError(parsedIdempotency)) throw parsedIdempotency.error
    const id = occurrenceId(record, parsedRunAt.value)
    const created = await tx.query<Row>(
      `INSERT INTO ${this.table(POSTGRES_TABLES.jobs)} (namespace,id,queue,name,version,state,payload,metadata,priority,run_at_ms,attempts_max,attempts_made,delivery_count,stalled_count,created_at_ms,updated_at_ms,backoff,timeout_ms,idempotency_key,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,0,0,0,$12,$12,$13::jsonb,$14,$15,NULL) ON CONFLICT DO NOTHING RETURNING ${jobColumns.join(',')}`,
      [
        this.client.namespace,
        id,
        record.job.queue,
        record.job.name,
        record.job.version,
        parsedRunAt.value <= nowMs ? 'waiting' : 'delayed',
        json(parsedPayload.value),
        json(parsedMetadata.value),
        parsedPriority.value,
        parsedRunAt.value,
        parsedAttempts.value,
        nowMs,
        parsedBackoff.value === undefined ? null : json(parsedBackoff.value),
        parsedTimeout.value ?? null,
        parsedIdempotency.value ?? null
      ]
    )
    const inserted = created.rows[0]
    if (inserted !== undefined) {
      const job = decodeJob(inserted)
      await this.appendJobEnqueued(tx, job, nowMs)
      return { job, duplicate: false }
    }
    const duplicate = await tx.query<Row>(
      `SELECT ${jobColumns.join(',')} FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND id=$2 FOR UPDATE`,
      [this.client.namespace, id]
    )
    const existing = duplicate.rows[0]
    if (existing === undefined) throw new Error('schedule occurrence conflict row is missing')
    return { job: decodeJob(existing), duplicate: true }
  }

  upsertSchedule(value: ScheduleRecord): Operation<UpsertScheduleResult> {
    const checked = normalizeRecord(value)
    if (Result.isError(checked)) return failed(checked)
    const normalized = checked.value
    return pending(
      this.withTx('upsertSchedule', async (tx) => {
        const selector = { group: normalized.group, key: normalized.key }
        const existing = await this.resolve(tx, selector, true)
        if (existing === undefined) {
          const result = await tx.query<Row>(
            `INSERT INTO ${this.table(POSTGRES_TABLES.schedules)} (namespace,${scheduleColumns.join(',')}) VALUES ($1,${scheduleColumns.map((_, index) => `$${index + 2}`).join(',')}) RETURNING ${scheduleColumns.join(',')}`,
            [this.client.namespace, ...scheduleValues(normalized)]
          )
          const row = result.rows[0]
          if (row === undefined) throw new Error('created schedule row is missing')
          const created = decodeSchedule(row)
          await this.appendEvent(tx, 'schedule-upserted', created, created.updatedAtMs, {
            created: 'true'
          })
          return { record: cloneRecord(created), created: true, changed: true }
        }
        if (logicalDigest(existing) === logicalDigest(normalized))
          return { record: cloneRecord(existing), created: false, changed: false }
        if (existing.revision >= maxSafeInteger)
          throw new ScheduleDefinitionError({
            field: 'revision',
            message: 'cannot exceed the safe integer range'
          })
        const updated = {
          ...normalized,
          revision: existing.revision + 1,
          createdAtMs: existing.createdAtMs,
          updatedAtMs: Math.max(normalized.updatedAtMs, existing.updatedAtMs)
        }
        await this.updateSchedule(tx, updated)
        await this.appendEvent(tx, 'schedule-upserted', updated, updated.updatedAtMs, {
          created: 'false'
        })
        return { record: cloneRecord(updated), created: false, changed: true }
      })
    )
  }

  private async updateSchedule(tx: Tx, record: ScheduleRecord): Promise<void> {
    const values = scheduleValues(record)
    const result = await tx.query(
      `UPDATE ${this.table(POSTGRES_TABLES.schedules)} SET ${scheduleColumns.map((column, index) => `${column}=$${index + 4}`).join(',')} WHERE namespace=$1 AND schedule_group=$2 AND schedule_key=$3`,
      [this.client.namespace, record.group, record.key, ...values]
    )
    if (result.rowCount !== 1) throw new Error('schedule update lost its row')
  }

  removeSchedule(selector: ScheduleSelector): Operation<boolean> {
    const parsed = parseSelector(selector)
    if (Result.isError(parsed)) return failed(parsed)
    return pending(
      this.withTx('removeSchedule', async (tx) => {
        const current = await this.resolve(tx, parsed.value, true)
        if (current === undefined) return false
        const result = await tx.query(
          `DELETE FROM ${this.table(POSTGRES_TABLES.schedules)} WHERE namespace=$1 AND schedule_group=$2 AND schedule_key=$3`,
          [this.client.namespace, current.group, current.key]
        )
        if (result.rowCount === 1)
          await this.appendEvent(tx, 'schedule-removed', current, current.updatedAtMs, {})
        return result.rowCount === 1
      })
    )
  }

  getSchedule(selector: ScheduleSelector): Operation<ScheduleRecord | undefined> {
    const parsed = parseSelector(selector)
    if (Result.isError(parsed)) return failed(parsed)
    return pending(
      this.withTx('getSchedule', async (tx) => {
        const current = await this.resolve(tx, parsed.value, false)
        return current === undefined ? undefined : cloneRecord(current)
      })
    )
  }

  listSchedules(options: ListSchedulesOptions = {}): Operation<readonly ScheduleRecord[]> {
    if (!isPlainObject(options)) return failed(definition('options', 'must be an object'))
    const limit =
      options.limit === undefined ? undefined : validatePositiveInteger(options.limit, 'limit')
    if (limit !== undefined && Result.isError(limit)) return failed(limit)
    const group = options.group === undefined ? undefined : validateText(options.group, 'group')
    if (group !== undefined && Result.isError(group)) return failed(group)
    if (options.paused !== undefined && typeof options.paused !== 'boolean')
      return failed(definition('paused', 'must be boolean'))
    return pending(
      this.withTx('listSchedules', async (tx) => {
        const predicates = ['namespace=$1']
        const values: unknown[] = [this.client.namespace]
        if (group !== undefined) {
          predicates.push(`schedule_group=$${values.length + 1}`)
          values.push(group.value)
        }
        if (options.paused !== undefined) {
          predicates.push(`paused=$${values.length + 1}`)
          values.push(options.paused)
        }
        const limitSql = limit === undefined ? '' : ` LIMIT $${values.length + 1}`
        if (limit !== undefined) values.push(limit.value)
        const result = await tx.query<Row>(
          `SELECT ${scheduleColumns.join(',')} FROM ${this.table(POSTGRES_TABLES.schedules)} WHERE ${predicates.join(' AND ')} ORDER BY schedule_group COLLATE "C" ASC, schedule_key COLLATE "C" ASC${limitSql}`,
          values
        )
        return Object.freeze(result.rows.map(decodeSchedule).map(cloneRecord))
      })
    )
  }

  dueSchedules(options: DueSchedulesOptions): Operation<readonly ScheduleRecord[]> {
    if (!isPlainObject(options)) return failed(definition('options', 'must be an object'))
    const now = validateTimestamp(options.nowMs, 'nowMs')
    if (Result.isError(now)) return failed(now)
    const limit =
      options.limit === undefined ? undefined : validatePositiveInteger(options.limit, 'limit')
    if (limit !== undefined && Result.isError(limit)) return failed(limit)
    const group = options.group === undefined ? undefined : validateText(options.group, 'group')
    if (group !== undefined && Result.isError(group)) return failed(group)
    return pending(
      this.withTx('dueSchedules', async (tx) => {
        const predicates = ['namespace=$1', 'paused=false', `next_run_at_ms <= $${2}`]
        const values: unknown[] = [this.client.namespace, now.value]
        if (group !== undefined) {
          predicates.push(`schedule_group=$${values.length + 1}`)
          values.push(group.value)
        }
        const limitSql = limit === undefined ? '' : ` LIMIT $${values.length + 1}`
        if (limit !== undefined) values.push(limit.value)
        const result = await tx.query<Row>(
          `SELECT ${scheduleColumns.join(',')} FROM ${this.table(POSTGRES_TABLES.schedules)} WHERE ${predicates.join(' AND ')} ORDER BY next_run_at_ms ASC, schedule_group COLLATE "C" ASC, schedule_key COLLATE "C" ASC${limitSql}`,
          values
        )
        return Object.freeze(result.rows.map(decodeSchedule).map(cloneRecord))
      })
    )
  }

  tickSchedule(command: TickScheduleCommand): Operation<TickScheduleResult> {
    if (!isPlainObject(command)) return failed(definition('command', 'must be an object'))
    if (!isPlainObject(command.decision)) return failed(definition('decision', 'must be an object'))
    const parsed = parseSelector(command.key)
    if (Result.isError(parsed)) return failed(parsed)
    const revision = validateNonNegativeInteger(command.expectedRevision, 'expectedRevision')
    const expectedRunAt = validateTimestamp(command.expectedRunAtMs, 'expectedRunAtMs')
    const now = validateTimestamp(command.nowMs, 'nowMs')
    const slots = readSlots(command.decision)
    const nextRunAt = validateTimestamp(command.decision.nextRunAtMs, 'decision.nextRunAtMs')
    if (Result.isError(revision)) return failed(revision)
    if (Result.isError(expectedRunAt)) return failed(expectedRunAt)
    if (Result.isError(now)) return failed(now)
    if (Result.isError(slots)) return failed(slots)
    if (Result.isError(nextRunAt)) return failed(nextRunAt)
    if (nextRunAt.value <= expectedRunAt.value)
      return failed(definition('decision.nextRunAtMs', 'must advance beyond expectedRunAtMs'))
    const requestedSkippedValue = command.decision.skippedSlots
    if (requestedSkippedValue !== undefined && !Array.isArray(requestedSkippedValue))
      return failed(definition('decision.skippedSlots', 'must be an array'))
    const requestedSkipped = requestedSkippedValue ?? []
    for (const slot of requestedSkipped) {
      const checked = validateTimestamp(slot, 'decision.skippedSlots')
      if (Result.isError(checked)) return failed(checked)
    }
    return pending(
      this.withTx('tickSchedule', async (tx) => {
        const current = await this.resolve(tx, parsed.value, true)
        if (current === undefined) throw notFound(parsed.value)
        if (current.paused) return this.tickResult('paused', current, [], [])
        if (current.revision !== revision.value || current.nextRunAtMs !== expectedRunAt.value)
          return this.tickResult('stale', current, [], [])
        const skippedSlots = [...requestedSkipped]
        let effective = slots.value
        if (current.overlap === 'skip' && current.lastJobId !== undefined) {
          const prior = await tx.query<{ readonly state: string }>(
            `SELECT state FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND id=$2 FOR UPDATE`,
            [this.client.namespace, current.lastJobId]
          )
          const state = prior.rows[0]?.state
          if (state === 'waiting' || state === 'delayed' || state === 'active') {
            effective = []
            skippedSlots.push(
              ...slots.value.map((item) => (typeof item === 'number' ? item : item.slotMs))
            )
          }
        }
        const jobs: JobRecord[] = []
        let createdJob = false
        for (const item of effective) {
          const result = await this.insertJob(tx, current, item, now.value)
          jobs.push(result.job)
          createdJob ||= !result.duplicate
        }
        const updated = cloneRecord({
          ...current,
          revision: current.revision + 1,
          nextRunAtMs: nextRunAt.value,
          lastScheduledAtMs:
            jobs.length > 0
              ? Math.max(
                  ...effective.map((item) => (typeof item === 'number' ? item : item.slotMs))
                )
              : current.lastScheduledAtMs,
          lastJobId: jobs.at(-1)?.id ?? current.lastJobId,
          updatedAtMs: now.value
        })
        await this.updateSchedule(tx, updated)
        if (createdJob) await this.notify(tx, current.queue, now.value)
        await this.appendEvent(tx, 'schedule-ticked', updated, now.value, {
          status: jobs.length > 0 ? 'fired' : 'skipped',
          jobs: String(jobs.length),
          skipped: String(skippedSlots.length)
        })
        return this.tickResult(jobs.length > 0 ? 'fired' : 'skipped', updated, jobs, skippedSlots)
      })
    )
  }

  private tickResult(
    status: TickScheduleResult['status'],
    schedule: ScheduleRecord,
    jobs: readonly JobRecord[],
    skippedSlots: readonly number[]
  ): TickScheduleResult {
    return Object.freeze({
      status,
      schedule: cloneRecord(schedule),
      jobs: Object.freeze([...jobs]),
      fired: Object.freeze([...jobs]),
      skippedSlots: Object.freeze([...skippedSlots]),
      lastJobId: jobs.at(-1)?.id ?? schedule.lastJobId
    })
  }

  pauseSchedule(selector: ScheduleSelector): Operation<void> {
    return this.setPaused(selector, true)
  }

  resumeSchedule(selector: ScheduleSelector): Operation<void> {
    return this.setPaused(selector, false)
  }

  private setPaused(selector: ScheduleSelector, paused: boolean): Operation<void> {
    const parsed = parseSelector(selector)
    if (Result.isError(parsed)) return failed(parsed)
    return pending(
      this.withTx(paused ? 'pauseSchedule' : 'resumeSchedule', async (tx) => {
        const current = await this.resolve(tx, parsed.value, true)
        if (current === undefined) throw notFound(parsed.value)
        if (current.paused === paused) return undefined
        await tx.query(
          `UPDATE ${this.table(POSTGRES_TABLES.schedules)} SET paused=$4,revision=$5,updated_at_ms=$6 WHERE namespace=$1 AND schedule_group=$2 AND schedule_key=$3`,
          [
            this.client.namespace,
            current.group,
            current.key,
            paused,
            current.revision + 1,
            current.updatedAtMs
          ]
        )
        await this.appendEvent(
          tx,
          paused ? 'schedule-paused' : 'schedule-resumed',
          { ...current, paused, revision: current.revision + 1 },
          current.updatedAtMs,
          {}
        )
        return undefined
      })
    )
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = this.client.ownsPool ? this.client.dispose() : Promise.resolve()
    return this.disposal
  }
}

type ScheduleLayer<Token extends AnyJobScheduleStoreToken> = Layer<
  InstanceType<Token>,
  InstanceType<Token['jobStore']>
>

const makeScheduleLayer = <Token extends AnyJobScheduleStoreToken>(
  token: Token,
  acquire: () => Promise<PostgresClient>,
  eventWriter?: JobEventStoreWriter
): ScheduleLayer<Token> =>
  Layer.scopedGen(
    token,
    async function* () {
      yield* token.jobStore
      const client = await acquire()
      let implementation: PostgresJobScheduleStoreImplementation | undefined
      try {
        if (client.validateSchema) await client.validate()
        implementation = new PostgresJobScheduleStoreImplementation(client, eventWriter)
        return JobScheduleStore.of(implementation as never) as unknown as ServiceContract<
          InstanceType<Token>
        >
      } catch (cause) {
        if (implementation !== undefined) await implementation.dispose()
        else if (client.ownsPool) await client.dispose()
        throw cause
      }
    },
    async (store) => {
      await (store as unknown as PostgresJobScheduleStoreImplementation).dispose()
    }
  ) as ScheduleLayer<Token>

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 48)

const namespaceForToken = (token: AnyJobScheduleStoreToken, namespace: string): string =>
  token.serviceTag === JobScheduleStore.serviceTag
    ? namespace
    : `${namespace}:store-${hash(token.jobStore.serviceTag)}`

const borrowedClient = (token: AnyJobScheduleStoreToken, config: PostgresJobStoreConfig) => {
  const normalized = normalizePostgresJobStoreConfig(config)
  return () =>
    Promise.resolve(
      PostgresClient.fromPool({
        ...normalized,
        namespace: namespaceForToken(token, normalized.namespace)
      })
    )
}

const ownedClient = (token: AnyJobScheduleStoreToken, config: PostgresJobStoreConnectionConfig) => {
  const normalized = normalizePostgresJobStoreConnectionConfig(config)
  return () =>
    PostgresClient.fromConfig({
      ...normalized,
      namespace: namespaceForToken(token, normalized.namespace)
    })
}

type PostgresJobScheduleStoreApi = {
  readonly layer: (config: PostgresJobStoreConfig) => ScheduleLayer<typeof JobScheduleStore>
  readonly layerFor: <Token extends AnyJobScheduleStoreToken>(
    token: Token,
    config: PostgresJobStoreConfig
  ) => ScheduleLayer<Token>
  readonly layerFromConfig: (
    config: PostgresJobStoreConnectionConfig
  ) => ScheduleLayer<typeof JobScheduleStore>
  readonly layerFromConfigFor: <Token extends AnyJobScheduleStoreToken>(
    token: Token,
    config: PostgresJobStoreConnectionConfig
  ) => ScheduleLayer<Token>
}

export const PostgresJobScheduleStore: PostgresJobScheduleStoreApi = Object.freeze({
  layer(config: PostgresJobStoreConfig) {
    const normalized = normalizePostgresJobStoreConfig(config)
    return makeScheduleLayer(
      JobScheduleStore,
      borrowedClient(JobScheduleStore, normalized),
      normalized.eventWriter
    )
  },
  layerFor<Token extends AnyJobScheduleStoreToken>(token: Token, config: PostgresJobStoreConfig) {
    const normalized = normalizePostgresJobStoreConfig(config)
    return makeScheduleLayer(token, borrowedClient(token, normalized), normalized.eventWriter)
  },
  layerFromConfig(config: PostgresJobStoreConnectionConfig) {
    const normalized = normalizePostgresJobStoreConnectionConfig(config)
    return makeScheduleLayer(
      JobScheduleStore,
      ownedClient(JobScheduleStore, normalized),
      normalized.eventWriter
    )
  },
  layerFromConfigFor<Token extends AnyJobScheduleStoreToken>(
    token: Token,
    config: PostgresJobStoreConnectionConfig
  ) {
    const normalized = normalizePostgresJobStoreConnectionConfig(config)
    return makeScheduleLayer(token, ownedClient(token, normalized), normalized.eventWriter)
  }
})
