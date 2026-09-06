// oxlint-disable anti-slop/no-runtime-typeof -- SQLite rows and public schedule DTOs are untrusted.
// oxlint-disable anti-slop/no-unknown-parameters -- adapter boundaries intentionally validate unknown values.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- JSON snapshots are checked before persistence.
// oxlint-disable anti-slop/no-chained-type-assertions -- assertions are confined to SQL and Service erasure boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- checked rows restore protocol types here.

import { Layer } from 'better-effect'
import type { ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  DuplicateScheduleError,
  JobScheduleStore,
  JobStore,
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
  validateTimestamp,
  type AnyJobScheduleStoreToken,
  type EnqueueRequest,
  type JobId,
  type JobRecord,
  type JobScheduleStoreContract,
  type JsonValue,
  type ListSchedulesOptions,
  type MisfirePolicy,
  type PersistedBackoff,
  type ScheduleOccurrence,
  type ScheduleRecord,
  type ScheduleSelector,
  type ScheduleStoreError,
  type ScheduleStoreOperation,
  type ScheduleTickDecision,
  type TickScheduleCommand,
  type TickScheduleResult,
  type UpsertScheduleResult
} from 'better-effect-mq'
import type { DueSchedulesOptions } from 'better-effect-mq'
import { normalizeSqliteJobStoreConfig, type SqliteJobStoreConfig } from './config'
import { SqliteMigrator } from './migrator'
import { SQLITE_TABLES } from './schema'

type Row = Record<string, unknown>
type ScheduleResult<Value> = ResultType<Value, ScheduleStoreError>
type Operation<Value> = ScheduleStoreOperation<Value, ScheduleStoreError>
type InsertedJob = { readonly job: JobRecord; readonly duplicate: boolean }

const maxSafeInteger = Number.MAX_SAFE_INTEGER
const maxOccurrencesPerTick = 256
const descriptor = Object.freeze({
  extension: 'better-effect-mq/schedules' as const,
  extensionVersion: 1 as const,
  jobStoreProtocolVersion: 1 as const
})

const errorTags = new Set([
  'DuplicateScheduleError',
  'JobDefinitionError',
  'JobNotFoundError',
  'JobStoreFailure',
  'InvalidJobTransitionError',
  'LeaseLostError',
  'ScheduleDefinitionError',
  'ScheduleNotFoundError',
  'ScheduleStoreFailure',
  'SettlementConflictError',
  'UnsupportedJobStoreOperationError'
])

const isTaggedError = (value: unknown): boolean => {
  try {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { readonly _tag?: unknown })._tag === 'string' &&
      errorTags.has((value as { readonly _tag: string })._tag)
    )
  } catch {
    return false
  }
}

const ok = <Value>(value: Value): ScheduleResult<Value> => Result.ok(value)

const fail = <Value>(operation: string, cause: unknown): ScheduleResult<Value> => {
  if (isTaggedError(cause)) return Result.err(cause as ScheduleStoreError)
  return Result.err(
    new ScheduleStoreFailure({
      operation,
      retryable:
        cause !== null &&
        typeof cause === 'object' &&
        'code' in cause &&
        /BUSY|LOCKED/u.test(String((cause as { readonly code?: unknown }).code)),
      message: `SQLite ${operation} failed`,
      cause
    })
  )
}

const definition = <Value>(field: string, message: string): ScheduleResult<Value> =>
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

const validateText = (value: unknown, field: string): ScheduleResult<string> => {
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
  return ok(value)
}

const nonNegativeInteger = (value: unknown, field: string): ScheduleResult<number> =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? ok(value)
    : definition(field, 'must be a non-negative safe integer')

const safeInteger = (value: unknown, field: string): ScheduleResult<number> =>
  typeof value === 'number' && Number.isSafeInteger(value)
    ? ok(value)
    : definition(field, 'must be a safe integer')

const positiveInteger = (value: unknown, field: string): ScheduleResult<number> =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? ok(value)
    : definition(field, 'must be a positive safe integer')

const snapshotJson = (
  value: unknown,
  field: string,
  ancestors = new Set<object>()
): ScheduleResult<JsonValue> => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return ok(value)
  if (typeof value === 'number')
    return Number.isFinite(value) ? ok(value) : definition(field, 'must be JSON-safe')
  if (typeof value !== 'object') return definition(field, 'must be JSON-safe')
  if (ancestors.has(value)) return definition(field, 'must not contain cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const output: JsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index))
          return definition(`${field}[${index}]`, 'must not be sparse')
        const child = snapshotJson(value[index], `${field}[${index}]`, ancestors)
        if (Result.isError(child)) return child
        output.push(child.value)
      }
      return ok(Object.freeze(output))
    }
    if (!isPlainObject(value)) return definition(field, 'must contain only plain objects')
    const output: Record<string, JsonValue> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return definition(field, 'must contain only string keys')
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (property === undefined || !('value' in property))
        return definition(`${field}.${key}`, 'must contain data properties')
      const child = snapshotJson(property.value, `${field}.${key}`, ancestors)
      if (Result.isError(child)) return child
      output[key] = child.value
    }
    return ok(Object.freeze(output))
  } catch {
    return definition(field, 'must be JSON-safe')
  } finally {
    ancestors.delete(value)
  }
}

const parseJson = (value: unknown, field: string): JsonValue => {
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

const optionalJson = (value: unknown, field: string): JsonValue | undefined =>
  value === null || value === undefined ? undefined : parseJson(value, field)

const stableJson = (value: unknown): string => {
  if (value === undefined) return 'undefined'
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

const cloneRecord = (record: ScheduleRecord): ScheduleRecord => {
  const payload = parseJson(record.payload, 'payload')
  return Object.freeze({
    ...record,
    job: Object.freeze({ ...record.job }),
    payload,
    metadata: Object.freeze({ ...record.metadata }),
    backoff: record.backoff === undefined ? undefined : Object.freeze({ ...record.backoff }),
    misfire: Object.freeze({ ...record.misfire }) as MisfirePolicy
  })
}

const normalizePolicy = (value: unknown): ScheduleResult<MisfirePolicy> => {
  if (!isPlainObject(value)) return definition('misfire', 'must be an object')
  if (value.strategy === 'skip' || value.strategy === 'run-once')
    return ok(Object.freeze({ strategy: value.strategy }))
  if (value.strategy === 'catch-up') {
    const maximum = positiveInteger(value.maxOccurrences, 'misfire.maxOccurrences')
    return Result.isError(maximum)
      ? maximum
      : ok(Object.freeze({ strategy: 'catch-up', maxOccurrences: maximum.value }))
  }
  return definition('misfire.strategy', 'must be skip, run-once or catch-up')
}

const normalizeRecord = (value: unknown): ScheduleResult<ScheduleRecord> => {
  if (!isPlainObject(value)) return definition('record', 'must be an object')
  const key = validateText(value.key, 'key')
  const group = validateText(value.group, 'group')
  const queue = makeQueueName(value.queue)
  if (!isPlainObject(value.job)) return definition('job', 'must be an object')
  const jobQueue = makeQueueName(value.job.queue)
  const jobName = makeJobName(value.job.name)
  const jobVersion = positiveInteger(value.job.version, 'job.version')
  const payload = snapshotJson(value.payload, 'payload')
  const metadata = normalizeMetadata(value.metadata)
  const priority = safeInteger(value.priority, 'priority')
  const attemptsMax = positiveInteger(value.attemptsMax, 'attemptsMax')
  const timeout =
    value.timeoutMs === undefined
      ? ok<number | undefined>(undefined)
      : validateDuration(value.timeoutMs, 'timeoutMs')
  const backoff =
    value.backoff === undefined
      ? ok<PersistedBackoff | undefined>(undefined)
      : makePersistedBackoff(value.backoff)
  const revision = nonNegativeInteger(value.revision, 'revision')
  const nextRunAtMs = validateTimestamp(value.nextRunAtMs, 'nextRunAtMs')
  const createdAtMs = validateTimestamp(value.createdAtMs, 'createdAtMs')
  const updatedAtMs = validateTimestamp(value.updatedAtMs, 'updatedAtMs')
  const lastScheduledAtMs =
    value.lastScheduledAtMs === undefined
      ? ok<number | undefined>(undefined)
      : validateTimestamp(value.lastScheduledAtMs, 'lastScheduledAtMs')
  const lastJobId =
    value.lastJobId === undefined ? ok<JobId | undefined>(undefined) : makeJobId(value.lastJobId)
  const timeZoneInput = value.timeZone
  const timeZone: ScheduleResult<string | undefined> =
    timeZoneInput === undefined
      ? ok<string | undefined>(undefined)
      : typeof timeZoneInput === 'string' && isValidTimeZone(timeZoneInput)
        ? ok<string | undefined>(timeZoneInput)
        : definition('timeZone', 'must be a valid IANA timezone')
  const policy = normalizePolicy(value.misfire)

  if (Result.isError(key)) return key
  if (Result.isError(group)) return group
  if (Result.isError(queue)) return queue as ScheduleResult<ScheduleRecord>
  if (Result.isError(jobQueue)) return jobQueue as ScheduleResult<ScheduleRecord>
  if (Result.isError(jobName)) return jobName as ScheduleResult<ScheduleRecord>
  if (Result.isError(jobVersion)) return jobVersion
  if (Result.isError(payload)) return payload
  if (Result.isError(metadata)) return metadata as ScheduleResult<ScheduleRecord>
  if (Result.isError(priority)) return priority
  if (Result.isError(attemptsMax)) return attemptsMax
  if (Result.isError(timeout)) return timeout as ScheduleResult<ScheduleRecord>
  if (Result.isError(backoff)) return backoff as ScheduleResult<ScheduleRecord>
  if (Result.isError(revision)) return revision
  if (Result.isError(nextRunAtMs)) return nextRunAtMs
  if (Result.isError(createdAtMs)) return createdAtMs
  if (Result.isError(updatedAtMs)) return updatedAtMs
  if (Result.isError(lastScheduledAtMs)) return lastScheduledAtMs
  if (Result.isError(lastJobId)) return lastJobId as ScheduleResult<ScheduleRecord>
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
        ? (Result.err(cause as ScheduleStoreError) as ScheduleResult<ScheduleRecord>)
        : definition('cron', 'must be valid')
    }
    cron = value.cron
  } else {
    const cadence = positiveInteger(value.everyMs, 'everyMs')
    if (Result.isError(cadence)) return cadence
    everyMs = cadence.value
  }
  if (value.overlap !== 'allow' && value.overlap !== 'skip')
    return definition('overlap', 'must be allow or skip')
  if (typeof value.paused !== 'boolean') return definition('paused', 'must be boolean')
  if (timeout.value === 0) return definition('timeoutMs', 'must be greater than zero')
  if (updatedAtMs.value < createdAtMs.value)
    return definition('updatedAtMs', 'must not be earlier than createdAtMs')
  return ok(
    Object.freeze({
      key: key.value,
      group: group.value,
      job: Object.freeze({ queue: jobQueue.value, name: jobName.value, version: jobVersion.value }),
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

const parseSelector = (value: unknown): ScheduleResult<ParsedSelector> => {
  if (typeof value === 'string') {
    const key = validateText(value, 'key')
    return Result.isError(key) ? key : ok({ key: key.value, group: undefined })
  }
  if (!isPlainObject(value)) return definition('key', 'must be a key or address')
  const key = validateText(value.key, 'key')
  const group = validateText(value.group, 'group')
  if (Result.isError(key)) return key
  if (Result.isError(group)) return group
  return ok({ key: key.value, group: group.value })
}

const notFound = (selector: ParsedSelector): ScheduleNotFoundError =>
  selector.group === undefined
    ? new ScheduleNotFoundError({ key: selector.key })
    : new ScheduleNotFoundError({ key: selector.key, group: selector.group })

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
  'order_sequence',
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
  'cancellation_requested_at_ms',
  'result',
  'failure'
] as const

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
  JSON.stringify(record.payload),
  JSON.stringify(record.metadata),
  record.priority,
  record.attemptsMax,
  record.backoff === undefined ? null : JSON.stringify(record.backoff),
  record.timeoutMs ?? null,
  JSON.stringify(record.misfire),
  record.overlap,
  record.paused ? 1 : 0,
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
  const checked = validateText(value, field)
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const decodeSchedule = (row: Row): ScheduleRecord => {
  const decoded = normalizeRecord({
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
    paused: Number(row.paused) === 1,
    revision: integer(row.revision, 'revision'),
    nextRunAtMs: integer(row.next_run_at_ms, 'next_run_at_ms'),
    lastScheduledAtMs: optionalInteger(row.last_scheduled_at_ms, 'last_scheduled_at_ms'),
    lastJobId: optionalString(row.last_job_id, 'last_job_id'),
    createdAtMs: integer(row.created_at_ms, 'created_at_ms'),
    updatedAtMs: integer(row.updated_at_ms, 'updated_at_ms')
  })
  if (Result.isError(decoded)) throw decoded.error
  return decoded.value
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
    orderingSequence: integer(row.order_sequence, 'order_sequence', 1),
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
): ScheduleResult<readonly ScheduleOccurrence[]> => {
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
      checked.push({ slotMs: slot.value, enqueueRequest: request as EnqueueRequest })
    }
    return ok(Object.freeze(checked))
  }
  if (source === undefined) return definition('decision.occurrences', 'is required')
  if (!Array.isArray(source)) return definition('decision.occurrences', 'must be an array')
  if (source.length > maxOccurrencesPerTick)
    return definition('decision.occurrences', `must contain at most ${maxOccurrencesPerTick} items`)
  const checked: ScheduleOccurrence[] = []
  for (const item of source) {
    if (typeof item !== 'number' && !isPlainObject(item))
      return definition('decision.occurrence', 'must be a slot or object')
    const slot = validateTimestamp(
      typeof item === 'number' ? item : item.slotMs,
      'decision.occurrence.slotMs'
    )
    if (Result.isError(slot)) return slot
    checked.push(typeof item === 'number' ? slot.value : { ...item, slotMs: slot.value })
  }
  return ok(Object.freeze(checked))
}

const occurrenceId = (record: ScheduleRecord, slotMs: number): JobId =>
  makeJobId(makeScheduleOccurrenceId(record.key, slotMs)).unwrap()

const tickResult = (
  status: TickScheduleResult['status'],
  schedule: ScheduleRecord,
  jobs: readonly JobRecord[],
  skippedSlots: readonly number[]
): TickScheduleResult =>
  Object.freeze({
    status,
    schedule: cloneRecord(schedule),
    jobs: Object.freeze([...jobs]),
    fired: Object.freeze([...jobs]),
    skippedSlots: Object.freeze([...skippedSlots]),
    lastJobId: jobs.at(-1)?.id ?? schedule.lastJobId
  })

class SqliteJobScheduleStoreImplementation implements JobScheduleStoreContract {
  readonly descriptor = descriptor
  private chain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly config: ReturnType<typeof normalizeSqliteJobStoreConfig>) {}

  private execute<Value>(
    operation: string,
    mutable: boolean,
    callback: () => ScheduleResult<Value>
  ): Promise<ScheduleResult<Value>> {
    const run = async (): Promise<ScheduleResult<Value>> => {
      if (this.closed) return fail(operation, new Error('store is closed'))
      try {
        if (mutable) this.config.database.exec('BEGIN IMMEDIATE')
        const result = callback()
        if (mutable) this.config.database.exec(Result.isOk(result) ? 'COMMIT' : 'ROLLBACK')
        return result
      } catch (cause) {
        if (mutable) {
          try {
            this.config.database.exec('ROLLBACK')
          } catch {
            /* preserve the primary operation failure */
          }
        }
        return fail(operation, cause)
      }
    }
    const result = this.chain.then(run, run)
    this.chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private resolve(selector: ParsedSelector): ScheduleRecord | undefined {
    const rows =
      selector.group === undefined
        ? this.config.database
            .prepare(
              `SELECT ${scheduleColumns.join(',')} FROM ${SQLITE_TABLES.schedules} WHERE namespace=? AND schedule_key=? ORDER BY schedule_group ASC`
            )
            .all(this.config.namespace, selector.key)
        : this.config.database
            .prepare(
              `SELECT ${scheduleColumns.join(',')} FROM ${SQLITE_TABLES.schedules} WHERE namespace=? AND schedule_group=? AND schedule_key=?`
            )
            .all(this.config.namespace, selector.group, selector.key)
    if (selector.group === undefined && rows.length > 1) {
      throw new DuplicateScheduleError({
        group: '*',
        key: selector.key,
        message: `Schedule key "${selector.key}" is ambiguous`
      })
    }
    const row = rows[0]
    return row === undefined ? undefined : decodeSchedule(row)
  }

  private updateSchedule(record: ScheduleRecord): void {
    const result = this.config.database
      .prepare(
        `UPDATE ${SQLITE_TABLES.schedules} SET ${scheduleColumns.map((column) => `${column}=?`).join(',')} WHERE namespace=? AND schedule_group=? AND schedule_key=?`
      )
      .run(...scheduleValues(record), this.config.namespace, record.group, record.key)
    if (result.changes !== 1) throw new Error('schedule update lost its row')
  }

  private nextJobSequence(): number {
    const state = this.config.database
      .prepare(`SELECT state_json FROM ${SQLITE_TABLES.state} WHERE namespace=?`)
      .get(this.config.namespace)
    let configured = 1
    if (state !== undefined && state !== null) {
      if (typeof state.state_json !== 'string') throw new Error('SQLite state is corrupt')
      const parsed = JSON.parse(state.state_json)
      if (
        !isPlainObject(parsed) ||
        typeof parsed.sequence !== 'number' ||
        !Number.isSafeInteger(parsed.sequence) ||
        parsed.sequence < 1
      )
        throw new Error('SQLite state sequence is corrupt')
      configured = parsed.sequence
    }
    const row = this.config.database
      .prepare(`SELECT MAX(order_sequence) AS maximum FROM ${SQLITE_TABLES.jobs} WHERE namespace=?`)
      .get(this.config.namespace)
    const maximum = row === undefined || row === null ? undefined : Number(row.maximum)
    if (maximum !== undefined && Number.isSafeInteger(maximum))
      configured = Math.max(configured, maximum + 1)
    if (!Number.isSafeInteger(configured) || configured >= maxSafeInteger)
      throw new ScheduleDefinitionError({
        field: 'orderingSequence',
        message: 'cannot exceed safe integer range'
      })
    return configured
  }

  private persistSequence(sequence: number, nowMs: number): void {
    const existing = this.config.database
      .prepare(`SELECT state_json FROM ${SQLITE_TABLES.state} WHERE namespace=?`)
      .get(this.config.namespace)
    const state =
      existing !== undefined && existing !== null && typeof existing.state_json === 'string'
        ? JSON.parse(existing.state_json)
        : {}
    if (!isPlainObject(state)) throw new Error('SQLite state is corrupt')
    state.sequence = sequence
    this.config.database
      .prepare(
        `INSERT INTO ${SQLITE_TABLES.state}(namespace,state_json,updated_at_ms) VALUES(?,?,?) ON CONFLICT(namespace) DO UPDATE SET state_json=excluded.state_json, updated_at_ms=excluded.updated_at_ms`
      )
      .run(this.config.namespace, JSON.stringify(state), nowMs)
  }

  private insertJob(
    record: ScheduleRecord,
    occurrence: ScheduleOccurrence,
    nowMs: number,
    orderingSequence: number
  ): InsertedJob {
    const item = typeof occurrence === 'number' ? { slotMs: occurrence } : occurrence
    const supplied = item.enqueueRequest
    const payload = supplied === undefined ? record.payload : supplied.payload
    const metadata = supplied === undefined ? record.metadata : (supplied.metadata ?? {})
    const priority = supplied === undefined ? record.priority : (supplied.priority ?? 0)
    const attemptsMax = supplied === undefined ? record.attemptsMax : supplied.attemptsMax
    const backoff = supplied === undefined ? record.backoff : supplied.backoff
    const timeoutMs = supplied === undefined ? record.timeoutMs : supplied.timeoutMs
    const parsedPayload = snapshotJson(payload, 'decision.enqueueRequest.payload')
    const parsedMetadata = normalizeMetadata(metadata)
    const parsedPriority = safeInteger(priority, 'decision.enqueueRequest.priority')
    const parsedAttempts = positiveInteger(attemptsMax, 'decision.enqueueRequest.attemptsMax')
    const parsedRunAt = validateTimestamp(item.slotMs, 'decision.occurrence.slotMs')
    const parsedBackoff =
      backoff === undefined
        ? ok<PersistedBackoff | undefined>(undefined)
        : makePersistedBackoff(backoff)
    const parsedTimeout =
      timeoutMs === undefined
        ? ok<number | undefined>(undefined)
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
    const existing = this.config.database
      .prepare(
        `SELECT ${jobColumns.join(',')} FROM ${SQLITE_TABLES.jobs} WHERE namespace=? AND id=?`
      )
      .get(this.config.namespace, id)
    if (existing !== undefined && existing !== null)
      return { job: decodeJob(existing), duplicate: true }
    const job = makeJobRecord({
      id,
      name: record.job.name,
      version: record.job.version,
      queue: record.job.queue,
      state: parsedRunAt.value <= nowMs ? 'waiting' : 'delayed',
      payload: parsedPayload.value,
      metadata: parsedMetadata.value,
      priority: parsedPriority.value,
      runAt: parsedRunAt.value,
      orderingSequence,
      attemptsMax: parsedAttempts.value,
      attemptsMade: 0,
      attemptSequence: 0,
      deliveryCount: 0,
      stalledCount: 0,
      backoff: parsedBackoff.value,
      timeoutMs: parsedTimeout.value,
      idempotencyKey: parsedIdempotency.value,
      createdAt: nowMs,
      updatedAt: nowMs,
      processedAt: undefined,
      finishedAt: undefined,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      cancellationRequestedAt: undefined,
      result: undefined,
      failure: undefined
    })
    if (Result.isError(job)) throw job.error
    const value = job.value
    const values = [
      this.config.namespace,
      value.id,
      value.queue,
      value.name,
      value.version,
      value.state,
      JSON.stringify(value.payload),
      JSON.stringify(value.metadata),
      JSON.stringify(value),
      value.priority,
      value.runAt,
      value.orderingSequence,
      value.attemptsMax,
      value.attemptsMade,
      value.attemptSequence,
      value.deliveryCount,
      value.stalledCount,
      value.backoff === undefined ? null : JSON.stringify(value.backoff),
      value.timeoutMs ?? null,
      value.idempotencyKey ?? null,
      value.createdAt,
      value.updatedAt,
      null,
      null,
      null,
      null,
      null,
      0,
      null,
      null,
      null
    ]
    const inserted = this.config.database
      .prepare(
        `INSERT INTO ${SQLITE_TABLES.jobs}(namespace,id,queue,name,version,state,payload,metadata,record_json,priority,run_at_ms,order_sequence,attempts_max,attempts_made,attempt_sequence,delivery_count,stalled_count,backoff,timeout_ms,idempotency_key,created_at_ms,updated_at_ms,processed_at_ms,finished_at_ms,lease_owner,lease_token,lease_expires_at_ms,cancel_requested,cancellation_requested_at_ms,result,failure) VALUES(${values.map(() => '?').join(',')}) ON CONFLICT(namespace,id) DO NOTHING`
      )
      .run(...values)
    if (inserted.changes === 1) return { job: value, duplicate: false }
    const conflict = this.config.database
      .prepare(
        `SELECT ${jobColumns.join(',')} FROM ${SQLITE_TABLES.jobs} WHERE namespace=? AND id=?`
      )
      .get(this.config.namespace, id)
    if (conflict === undefined || conflict === null)
      throw new Error('schedule occurrence conflict row is missing')
    return { job: decodeJob(conflict), duplicate: true }
  }

  private notify(queue: string, nowMs: number): void {
    this.config.database
      .prepare(
        `INSERT INTO ${SQLITE_TABLES.queues}(namespace,queue,paused,wake_version,updated_at_ms) VALUES(?,?,0,1,?) ON CONFLICT(namespace,queue) DO UPDATE SET wake_version=MIN(wake_version+1,9007199254740991),updated_at_ms=excluded.updated_at_ms`
      )
      .run(this.config.namespace, queue, nowMs)
  }

  upsertSchedule(value: ScheduleRecord): Operation<UpsertScheduleResult> {
    const checked = normalizeRecord(value)
    if (Result.isError(checked)) return checked as unknown as Operation<UpsertScheduleResult>
    return this.execute('upsertSchedule', true, () => {
      const existing = this.resolve({ group: checked.value.group, key: checked.value.key })
      if (existing === undefined) {
        this.config.database
          .prepare(
            `INSERT INTO ${SQLITE_TABLES.schedules}(namespace,${scheduleColumns.join(',')}) VALUES(?,${scheduleColumns.map(() => '?').join(',')})`
          )
          .run(this.config.namespace, ...scheduleValues(checked.value))
        return ok({ record: cloneRecord(checked.value), created: true, changed: true })
      }
      if (logicalDigest(existing) === logicalDigest(checked.value))
        return ok({ record: cloneRecord(existing), created: false, changed: false })
      if (existing.revision >= maxSafeInteger)
        return definition('revision', 'cannot exceed the safe integer range')
      const updated = cloneRecord({
        ...checked.value,
        revision: existing.revision + 1,
        createdAtMs: existing.createdAtMs,
        updatedAtMs: Math.max(checked.value.updatedAtMs, existing.updatedAtMs)
      })
      this.updateSchedule(updated)
      return ok({ record: cloneRecord(updated), created: false, changed: true })
    }) as unknown as Operation<UpsertScheduleResult>
  }

  removeSchedule(selector: ScheduleSelector): Operation<boolean> {
    const parsed = parseSelector(selector)
    if (Result.isError(parsed)) return parsed as unknown as Operation<boolean>
    return this.execute('removeSchedule', true, () => {
      const current = this.resolve(parsed.value)
      if (current === undefined) return ok(false)
      const result = this.config.database
        .prepare(
          `DELETE FROM ${SQLITE_TABLES.schedules} WHERE namespace=? AND schedule_group=? AND schedule_key=?`
        )
        .run(this.config.namespace, current.group, current.key)
      return ok(result.changes === 1)
    }) as unknown as Operation<boolean>
  }

  getSchedule(selector: ScheduleSelector): Operation<ScheduleRecord | undefined> {
    const parsed = parseSelector(selector)
    if (Result.isError(parsed)) return parsed as unknown as Operation<ScheduleRecord | undefined>
    return this.execute('getSchedule', false, () => {
      const current = this.resolve(parsed.value)
      return ok(current === undefined ? undefined : cloneRecord(current))
    }) as unknown as Operation<ScheduleRecord | undefined>
  }

  listSchedules(options: ListSchedulesOptions = {}): Operation<readonly ScheduleRecord[]> {
    if (!isPlainObject(options))
      return definition('options', 'must be an object') as unknown as Operation<
        readonly ScheduleRecord[]
      >
    const limit = options.limit === undefined ? undefined : positiveInteger(options.limit, 'limit')
    if (limit !== undefined && Result.isError(limit))
      return limit as unknown as Operation<readonly ScheduleRecord[]>
    const group = options.group === undefined ? undefined : validateText(options.group, 'group')
    if (group !== undefined && Result.isError(group))
      return group as unknown as Operation<readonly ScheduleRecord[]>
    if (options.paused !== undefined && typeof options.paused !== 'boolean')
      return definition('paused', 'must be boolean') as unknown as Operation<
        readonly ScheduleRecord[]
      >
    return this.execute('listSchedules', false, () => {
      const predicates = ['namespace=?']
      const values: unknown[] = [this.config.namespace]
      if (group !== undefined) {
        predicates.push('schedule_group=?')
        values.push(group.value)
      }
      if (options.paused !== undefined) {
        predicates.push('paused=?')
        values.push(options.paused ? 1 : 0)
      }
      const limitSql = limit === undefined ? '' : ' LIMIT ?'
      if (limit !== undefined) values.push(limit.value)
      const rows = this.config.database
        .prepare(
          `SELECT ${scheduleColumns.join(',')} FROM ${SQLITE_TABLES.schedules} WHERE ${predicates.join(' AND ')} ORDER BY schedule_group ASC, schedule_key ASC${limitSql}`
        )
        .all(...values)
      return ok(
        Object.freeze(
          rows.flatMap((row) => (row === undefined ? [] : [cloneRecord(decodeSchedule(row))]))
        )
      )
    }) as unknown as Operation<readonly ScheduleRecord[]>
  }

  dueSchedules(options: DueSchedulesOptions): Operation<readonly ScheduleRecord[]> {
    if (!isPlainObject(options))
      return definition('options', 'must be an object') as unknown as Operation<
        readonly ScheduleRecord[]
      >
    const now = validateTimestamp(options.nowMs, 'nowMs')
    if (Result.isError(now)) return now as unknown as Operation<readonly ScheduleRecord[]>
    const limit = options.limit === undefined ? undefined : positiveInteger(options.limit, 'limit')
    if (limit !== undefined && Result.isError(limit))
      return limit as unknown as Operation<readonly ScheduleRecord[]>
    const group = options.group === undefined ? undefined : validateText(options.group, 'group')
    if (group !== undefined && Result.isError(group))
      return group as unknown as Operation<readonly ScheduleRecord[]>
    return this.execute('dueSchedules', false, () => {
      const predicates = ['namespace=?', 'paused=0', 'next_run_at_ms<=?']
      const values: unknown[] = [this.config.namespace, now.value]
      if (group !== undefined) {
        predicates.push('schedule_group=?')
        values.push(group.value)
      }
      const limitSql = limit === undefined ? '' : ' LIMIT ?'
      if (limit !== undefined) values.push(limit.value)
      const rows = this.config.database
        .prepare(
          `SELECT ${scheduleColumns.join(',')} FROM ${SQLITE_TABLES.schedules} WHERE ${predicates.join(' AND ')} ORDER BY next_run_at_ms ASC, schedule_group ASC, schedule_key ASC${limitSql}`
        )
        .all(...values)
      return ok(
        Object.freeze(
          rows.flatMap((row) => (row === undefined ? [] : [cloneRecord(decodeSchedule(row))]))
        )
      )
    }) as unknown as Operation<readonly ScheduleRecord[]>
  }

  tickSchedule(command: TickScheduleCommand): Operation<TickScheduleResult> {
    if (!isPlainObject(command))
      return definition('command', 'must be an object') as unknown as Operation<TickScheduleResult>
    if (!isPlainObject(command.decision))
      return definition('decision', 'must be an object') as unknown as Operation<TickScheduleResult>
    const parsed = parseSelector(command.key)
    const revision = nonNegativeInteger(command.expectedRevision, 'expectedRevision')
    const expectedRunAt = validateTimestamp(command.expectedRunAtMs, 'expectedRunAtMs')
    const now = validateTimestamp(command.nowMs, 'nowMs')
    const slots = readSlots(command.decision)
    const nextRunAt = validateTimestamp(command.decision.nextRunAtMs, 'decision.nextRunAtMs')
    if (Result.isError(parsed)) return parsed as unknown as Operation<TickScheduleResult>
    if (Result.isError(revision)) return revision as unknown as Operation<TickScheduleResult>
    if (Result.isError(expectedRunAt))
      return expectedRunAt as unknown as Operation<TickScheduleResult>
    if (Result.isError(now)) return now as unknown as Operation<TickScheduleResult>
    if (Result.isError(slots)) return slots as unknown as Operation<TickScheduleResult>
    if (Result.isError(nextRunAt)) return nextRunAt as unknown as Operation<TickScheduleResult>
    if (nextRunAt.value <= expectedRunAt.value)
      return definition(
        'decision.nextRunAtMs',
        'must advance beyond expectedRunAtMs'
      ) as unknown as Operation<TickScheduleResult>
    const skippedValue = command.decision.skippedSlots
    if (skippedValue !== undefined && !Array.isArray(skippedValue))
      return definition(
        'decision.skippedSlots',
        'must be an array'
      ) as unknown as Operation<TickScheduleResult>
    for (const slot of skippedValue ?? []) {
      const checked = validateTimestamp(slot, 'decision.skippedSlots')
      if (Result.isError(checked)) return checked as unknown as Operation<TickScheduleResult>
    }
    return this.execute('tickSchedule', true, () => {
      const current = this.resolve(parsed.value)
      if (current === undefined) return Result.err(notFound(parsed.value))
      if (current.paused) return ok(tickResult('paused', current, [], []))
      if (current.revision !== revision.value || current.nextRunAtMs !== expectedRunAt.value)
        return ok(tickResult('stale', current, [], []))
      const skippedSlots = [...(skippedValue ?? [])]
      let effective = slots.value
      if (current.overlap === 'skip' && current.lastJobId !== undefined) {
        const prior = this.config.database
          .prepare(`SELECT state FROM ${SQLITE_TABLES.jobs} WHERE namespace=? AND id=?`)
          .get(this.config.namespace, current.lastJobId)
        const state = prior === undefined || prior === null ? undefined : prior.state
        if (state === 'waiting' || state === 'delayed' || state === 'active') {
          effective = []
          skippedSlots.push(
            ...slots.value.map((item) => (typeof item === 'number' ? item : item.slotMs))
          )
        }
      }
      let sequence = this.nextJobSequence()
      const jobs: JobRecord[] = []
      let createdJob = false
      for (const item of effective) {
        const result = this.insertJob(current, item, now.value, sequence)
        jobs.push(result.job)
        if (!result.duplicate) {
          createdJob = true
          sequence += 1
        }
      }
      if (createdJob) {
        this.persistSequence(sequence, now.value)
        this.notify(current.queue, now.value)
      }
      const updated = cloneRecord({
        ...current,
        revision: current.revision + 1,
        nextRunAtMs: nextRunAt.value,
        lastScheduledAtMs:
          jobs.length > 0
            ? Math.max(...effective.map((item) => (typeof item === 'number' ? item : item.slotMs)))
            : current.lastScheduledAtMs,
        lastJobId: jobs.at(-1)?.id ?? current.lastJobId,
        updatedAtMs: now.value
      })
      this.updateSchedule(updated)
      return ok(tickResult(jobs.length > 0 ? 'fired' : 'skipped', updated, jobs, skippedSlots))
    }) as unknown as Operation<TickScheduleResult>
  }

  pauseSchedule(selector: ScheduleSelector): Operation<void> {
    return this.setPaused(selector, true)
  }

  resumeSchedule(selector: ScheduleSelector): Operation<void> {
    return this.setPaused(selector, false)
  }

  private setPaused(selector: ScheduleSelector, paused: boolean): Operation<void> {
    const parsed = parseSelector(selector)
    if (Result.isError(parsed)) return parsed as unknown as Operation<void>
    return this.execute(paused ? 'pauseSchedule' : 'resumeSchedule', true, () => {
      const current = this.resolve(parsed.value)
      if (current === undefined) return Result.err(notFound(parsed.value))
      if (current.paused === paused) return ok(undefined)
      if (current.revision >= maxSafeInteger)
        return definition('revision', 'cannot exceed the safe integer range')
      this.updateSchedule(
        cloneRecord({
          ...current,
          paused,
          revision: current.revision + 1,
          updatedAtMs: current.updatedAtMs
        })
      )
      return ok(undefined)
    }) as unknown as Operation<void>
  }

  async dispose(): Promise<void> {
    this.closed = true
    await this.chain
  }
}

type ScheduleLayer<Token extends AnyJobScheduleStoreToken> = Layer<
  InstanceType<Token>,
  InstanceType<Token['jobStore']>
>

const namespaceFor = (token: AnyJobScheduleStoreToken, namespace: string): string =>
  token.jobStore.serviceTag === JobStore.serviceTag
    ? namespace
    : `${namespace}:${encodeURIComponent(token.jobStore.serviceTag)}`

const makeLayer = <Token extends AnyJobScheduleStoreToken>(
  token: Token,
  config: SqliteJobStoreConfig
): ScheduleLayer<Token> => {
  const normalized = normalizeSqliteJobStoreConfig(config)
  return Layer.scopedGen(
    token,
    async function* () {
      yield* token.jobStore
      const scoped = Object.freeze({
        ...normalized,
        namespace: namespaceFor(token, normalized.namespace)
      })
      if (scoped.configurePragmas) {
        scoped.database.exec(
          `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${scoped.busyTimeoutMs};`
        )
      }
      if (scoped.validateSchema) SqliteMigrator.validate(scoped.database)
      const implementation = new SqliteJobScheduleStoreImplementation(scoped)
      try {
        return JobScheduleStore.of(implementation as never) as unknown as ServiceContract<
          InstanceType<Token>
        >
      } catch (cause) {
        await implementation.dispose()
        throw cause
      }
    },
    async (store) => (store as unknown as SqliteJobScheduleStoreImplementation).dispose()
  ) as ScheduleLayer<Token>
}

export const SqliteJobScheduleStore: {
  readonly layer: (config: SqliteJobStoreConfig) => ScheduleLayer<typeof JobScheduleStore>
  readonly layerFor: <Token extends AnyJobScheduleStoreToken>(
    token: Token,
    config: SqliteJobStoreConfig
  ) => ScheduleLayer<Token>
  readonly make: (config: SqliteJobStoreConfig) => JobScheduleStoreContract
} = Object.freeze({
  layer(config: SqliteJobStoreConfig) {
    return makeLayer(JobScheduleStore, config)
  },
  layerFor<Token extends AnyJobScheduleStoreToken>(token: Token, config: SqliteJobStoreConfig) {
    return makeLayer(token, config)
  },
  make(config: SqliteJobStoreConfig): JobScheduleStoreContract {
    const normalized = normalizeSqliteJobStoreConfig(config)
    if (normalized.validateSchema) SqliteMigrator.validate(normalized.database)
    return JobScheduleStore.of(new SqliteJobScheduleStoreImplementation(normalized) as never)
  }
})
