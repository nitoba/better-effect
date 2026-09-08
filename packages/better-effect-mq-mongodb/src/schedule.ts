// oxlint-disable anti-slop/no-runtime-typeof -- MongoDB documents and public schedule values are validated at this boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- BSON queries and updates are owned by this adapter.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- field-based BSON documents are narrowed before decoding.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts are limited to the optional driver boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions restore types after explicit validation.
// oxlint-disable anti-slop/no-known-value-widening -- BSON filter and document objects are intentionally open at this adapter boundary.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional BSON fields must be omitted from persisted documents.

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
  validateTimestamp
} from 'better-effect-mq'
import type {
  AnyJobScheduleStoreToken,
  DueSchedulesOptions,
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
  UpsertScheduleResult
} from 'better-effect-mq'
import type {
  DurableJobEventInput,
  DurableJobEventType,
  JobEventStoreWriter
} from 'better-effect-mq'
import {
  metadataEntries,
  metadataFromEntries,
  mongoCollections,
  namespaceId,
  type MongoCollections
} from './collections'
import { MongoJobStoreClient } from './client'
import type { MongoJobStoreConfig, MongoJobStoreConnectionConfig, MongoSession } from './config'
import { MongoJobStoreLayoutError, MongoJobStoreTopologyError } from './errors'
import { MongoJobStoreMigrator } from './migrator'
import { appendMongoExtensionEvent, assertMongoExtensionEventWriterReady } from './extension-events'

type Doc = Record<string, unknown>
type Operation<Value> = import('better-effect-mq').ScheduleStoreOperation<Value, ScheduleStoreError>
type ScheduleResult<Value> = ResultType<Value, ScheduleStoreError>
type TxBody<Value> = (session: MongoSession) => Promise<Value>

const MAX = Number.MAX_SAFE_INTEGER
const MAX_OCCURRENCES = 256
const descriptor = Object.freeze({
  extension: 'better-effect-mq/schedules' as const,
  extensionVersion: 1 as const,
  jobStoreProtocolVersion: 1 as const
})
const taggedErrors = new Set([
  'DuplicateScheduleError',
  'JobDefinitionError',
  'JobNotFoundError',
  'JobStoreFailure',
  'ScheduleDefinitionError',
  'ScheduleNotFoundError',
  'ScheduleStoreFailure'
])

const ok = <Value>(value: Value): ScheduleResult<Value> => Result.ok(value) as ScheduleResult<Value>
const failed = <Value>(error: ScheduleStoreError): Operation<Value> =>
  Result.err(error) as Operation<Value>
const pending = <Value>(value: PromiseLike<ScheduleResult<Value>>): Operation<Value> =>
  value as unknown as Operation<Value>

const isTagged = (value: unknown): value is ScheduleStoreError =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { readonly _tag?: unknown })._tag === 'string' &&
  taggedErrors.has((value as { readonly _tag: string })._tag)

const isRetryable = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const error = value as { readonly code?: unknown; readonly errorLabels?: unknown }
  return (
    error.code === 91 ||
    error.code === 10107 ||
    (Array.isArray(error.errorLabels) &&
      error.errorLabels.some(
        (label) =>
          label === 'TransientTransactionError' || label === 'UnknownTransactionCommitResult'
      ))
  )
}

const failure = (operation: string, cause: unknown): ScheduleStoreFailure =>
  new ScheduleStoreFailure({
    operation,
    retryable: isRetryable(cause),
    message: `MongoDB ${operation} failed`,
    cause
  })

const fail = <Value>(operation: string, cause: unknown): ScheduleResult<Value> =>
  Result.err(isTagged(cause) ? cause : failure(operation, cause)) as ScheduleResult<Value>

const findOneResult = (value: unknown): Doc | undefined => {
  if (value === null) return undefined
  if (typeof value === 'object' && value !== null && 'lastErrorObject' in value && 'value' in value)
    return (value as { readonly value?: Doc | null }).value ?? undefined
  return value as Doc
}

class MongoDuplicateConflict extends Error {}

const isPlainObject = (value: unknown): value is Doc => {
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
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

const definition = <Value>(field: string, message: string): ScheduleResult<Value> =>
  Result.err(new ScheduleDefinitionError({ field, message })) as ScheduleResult<Value>
const definitionError = (field: string, message: string): ScheduleDefinitionError =>
  new ScheduleDefinitionError({ field, message })

const validateText = (value: unknown, field: string): ScheduleResult<string> => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxScheduleIdentityLength ||
    value.includes('\u0000') ||
    hasUnpairedSurrogate(value)
  )
    return definition(
      field,
      `must be a non-empty string of at most ${maxScheduleIdentityLength} characters`
    )
  return Result.ok(value)
}

const positive = (value: unknown, field: string): ScheduleResult<number> =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Result.ok(value)
    : definition(field, 'must be a positive safe integer')

const nonNegative = (value: unknown, field: string): ScheduleResult<number> =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Result.ok(value)
    : definition(field, 'must be a non-negative safe integer')

const safeInteger = (value: unknown, field: string): ScheduleResult<number> =>
  typeof value === 'number' && Number.isSafeInteger(value)
    ? Result.ok(value)
    : definition(field, 'must be a safe integer')

const jsonValue = (
  value: unknown,
  field: string,
  ancestors = new Set<object>()
): ScheduleResult<import('better-effect-mq').JsonValue> => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return Result.ok(value)
  if (typeof value === 'number')
    return Number.isFinite(value) ? Result.ok(value) : definition(field, 'must be JSON-safe')
  if (!isPlainObject(value) && !Array.isArray(value)) return definition(field, 'must be JSON-safe')
  if (ancestors.has(value)) return definition(field, 'must not contain cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const result: import('better-effect-mq').JsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index))
          return definition(field, 'must not be sparse')
        const child = jsonValue(value[index], `${field}[${index}]`, ancestors)
        if (Result.isError(child)) return child
        result.push(child.value)
      }
      return Result.ok(Object.freeze(result))
    }
    const result: Record<string, import('better-effect-mq').JsonValue> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return definition(field, 'must contain only string keys')
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (property === undefined || !('value' in property))
        return definition(`${field}.${key}`, 'must contain data properties')
      const child = jsonValue(property.value, `${field}.${key}`, ancestors)
      if (Result.isError(child)) return child
      result[key] = child.value
    }
    return Result.ok(Object.freeze(result))
  } catch {
    return definition(field, 'must be JSON-safe')
  } finally {
    ancestors.delete(value)
  }
}

const cloneJson = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Doc
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
    payload: cloneJson(record.payload),
    metadata: Object.freeze({ ...record.metadata }),
    backoff: record.backoff === undefined ? undefined : Object.freeze({ ...record.backoff }),
    misfire: Object.freeze({ ...record.misfire }) as MisfirePolicy
  })

const normalizePolicy = (value: unknown): ScheduleResult<MisfirePolicy> => {
  if (!isPlainObject(value)) return definition('misfire', 'must be an object')
  if (value.strategy === 'skip' || value.strategy === 'run-once')
    return Result.ok(Object.freeze({ strategy: value.strategy }))
  if (value.strategy === 'catch-up') {
    const maximum = positive(value.maxOccurrences, 'misfire.maxOccurrences')
    return Result.isError(maximum)
      ? maximum
      : Result.ok(Object.freeze({ strategy: 'catch-up', maxOccurrences: maximum.value }))
  }
  return definition('misfire.strategy', 'must be skip, run-once or catch-up')
}

const normalizeRecord = (value: unknown): ScheduleResult<ScheduleRecord> => {
  if (!isPlainObject(value)) return definition('record', 'must be an object')
  const key = validateText(value.key, 'key')
  const group = validateText(value.group, 'group')
  const queue = makeQueueName(value.queue)
  const jobValue = value.job
  if (!isPlainObject(jobValue)) return definition('job', 'must be an object')
  const jobQueue = makeQueueName(jobValue.queue)
  const jobName = makeJobName(jobValue.name)
  const jobVersion = positive(jobValue.version, 'job.version')
  const payload = jsonValue(value.payload, 'payload')
  const metadata = normalizeMetadata(value.metadata)
  const priority = safeInteger(value.priority, 'priority')
  const attemptsMax = positive(value.attemptsMax, 'attemptsMax')
  const timeout =
    value.timeoutMs === undefined
      ? Result.ok<number | undefined>(undefined)
      : validateDuration(value.timeoutMs, 'timeoutMs')
  const backoff =
    value.backoff === undefined
      ? Result.ok<PersistedBackoff | undefined>(undefined)
      : makePersistedBackoff(value.backoff)
  const revision = nonNegative(value.revision, 'revision')
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
  const timeZone: ScheduleResult<string | undefined> =
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
      return isTagged(cause)
        ? (Result.err(cause) as ScheduleResult<ScheduleRecord>)
        : definition('cron', 'must be valid')
    }
    cron = value.cron
  } else {
    const cadence = positive(value.everyMs, 'everyMs')
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
    return Result.isError(key) ? key : Result.ok({ key: key.value, group: undefined })
  }
  if (!isPlainObject(value)) return definition('key', 'must be a key or address')
  const key = validateText(value.key, 'key')
  const group = validateText(value.group, 'group')
  if (Result.isError(key)) return key
  if (Result.isError(group)) return group
  return Result.ok({ key: key.value, group: group.value })
}

const notFound = (selector: ParsedSelector): ScheduleNotFoundError =>
  selector.group === undefined
    ? new ScheduleNotFoundError({ key: selector.key })
    : new ScheduleNotFoundError({ key: selector.key, group: selector.group })

const integer = (value: unknown, field: string, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new MongoJobStoreLayoutError(`MongoDB document has invalid ${field}`)
  return value
}

const optionalInteger = (value: unknown, field: string): number | undefined =>
  value == null ? undefined : integer(value, field)
const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0)
    throw new MongoJobStoreLayoutError(`MongoDB document has invalid ${field}`)
  return value
}
const optionalText = (value: unknown, field: string): string | undefined =>
  value == null ? undefined : text(value, field)

const encodeSchedule = (namespace: string, record: ScheduleRecord): Doc => ({
  _id: namespaceId(namespace, record.group, record.key),
  namespace,
  scheduleKey: record.key,
  group: record.group,
  job: { queue: record.job.queue, name: record.job.name, version: record.job.version },
  queue: record.queue,
  ...(record.cron === undefined ? {} : { cron: record.cron }),
  ...(record.everyMs === undefined ? {} : { everyMs: record.everyMs }),
  ...(record.timeZone === undefined ? {} : { timeZone: record.timeZone }),
  payload: record.payload,
  metadataEntries: metadataEntries(record.metadata),
  priority: record.priority,
  attemptsMax: record.attemptsMax,
  ...(record.backoff === undefined ? {} : { backoff: record.backoff }),
  ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs }),
  misfire: record.misfire,
  overlap: record.overlap,
  paused: record.paused,
  revision: record.revision,
  nextRunAtMs: record.nextRunAtMs,
  ...(record.lastScheduledAtMs === undefined
    ? {}
    : { lastScheduledAtMs: record.lastScheduledAtMs }),
  ...(record.lastJobId === undefined ? {} : { lastJobId: record.lastJobId }),
  createdAtMs: record.createdAtMs,
  updatedAtMs: record.updatedAtMs
})

const decodeSchedule = (document: Doc): ScheduleRecord => {
  const job = document.job
  if (!isPlainObject(job)) throw new MongoJobStoreLayoutError('MongoDB schedule has invalid job')
  const checked = normalizeRecord({
    key: document.scheduleKey,
    group: document.group,
    job,
    queue: document.queue,
    cron: document.cron,
    everyMs: document.everyMs,
    timeZone: document.timeZone,
    payload: document.payload,
    metadata: metadataFromEntries(document.metadataEntries),
    priority: document.priority,
    attemptsMax: document.attemptsMax,
    backoff: document.backoff,
    timeoutMs: document.timeoutMs,
    misfire: document.misfire,
    overlap: document.overlap,
    paused: document.paused,
    revision: document.revision,
    nextRunAtMs: document.nextRunAtMs,
    lastScheduledAtMs: document.lastScheduledAtMs,
    lastJobId: document.lastJobId,
    createdAtMs: document.createdAtMs,
    updatedAtMs: document.updatedAtMs
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const identity = (queue: string, name: string, version: number): string =>
  JSON.stringify([queue, name, version])
const occurrenceId = (record: ScheduleRecord, slotMs: number): import('better-effect-mq').JobId =>
  makeJobId(makeScheduleOccurrenceId(record.key, slotMs)).unwrap()

const encodeJob = (namespace: string, record: JobRecord): Doc => ({
  _id: namespaceId(namespace, record.id),
  namespace,
  id: record.id,
  identity: identity(record.queue, record.name, record.version),
  queue: record.queue,
  name: record.name,
  version: record.version,
  state: record.state,
  payload: record.payload,
  metadataEntries: metadataEntries(record.metadata),
  priority: record.priority,
  runAtMs: record.runAt,
  orderSequence: record.orderingSequence,
  attemptsMax: record.attemptsMax,
  attemptsMade: record.attemptsMade,
  attemptSequence: record.attemptSequence ?? record.attemptsMade,
  deliveryCount: record.deliveryCount,
  stalledCount: record.stalledCount,
  ...(record.backoff === undefined ? {} : { backoff: record.backoff }),
  ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs }),
  ...(record.idempotencyKey === undefined ? {} : { idempotencyKey: record.idempotencyKey }),
  createdAtMs: record.createdAt,
  updatedAtMs: record.updatedAt,
  cancelRequested: record.cancellationRequestedAt !== undefined,
  ...(record.cancellationRequestedAt === undefined
    ? {}
    : { cancellationRequestedAtMs: record.cancellationRequestedAt }),
  ...(record.processedAt === undefined ? {} : { processedAtMs: record.processedAt }),
  ...(record.finishedAt === undefined ? {} : { finishedAtMs: record.finishedAt }),
  ...(record.leaseOwner === undefined ? {} : { leaseOwner: record.leaseOwner }),
  ...(record.leaseToken === undefined ? {} : { leaseToken: record.leaseToken }),
  ...(record.leaseExpiresAt === undefined ? {} : { leaseExpiresAtMs: record.leaseExpiresAt }),
  ...(record.result === undefined ? {} : { result: record.result }),
  ...(record.failure === undefined ? {} : { failure: record.failure }),
  ledgerCount: record.attemptSequence ?? record.attemptsMade
})

const decodeJob = (document: Doc): JobRecord => {
  const result = makeJobRecord({
    id: text(document.id, 'job.id'),
    name: text(document.name, 'job.name'),
    version: integer(document.version, 'job.version', 1),
    queue: text(document.queue, 'job.queue'),
    state: document.state,
    payload: document.payload as never,
    metadata: metadataFromEntries(document.metadataEntries),
    priority:
      typeof document.priority === 'number'
        ? document.priority
        : (() => {
            throw new MongoJobStoreLayoutError('MongoDB job has invalid priority')
          })(),
    runAt: integer(document.runAtMs, 'job.runAtMs'),
    orderingSequence: integer(document.orderSequence, 'job.orderSequence', 1),
    attemptsMax: integer(document.attemptsMax, 'job.attemptsMax', 1),
    attemptsMade: integer(document.attemptsMade, 'job.attemptsMade'),
    attemptSequence: integer(
      document.attemptSequence ?? document.attemptsMade,
      'job.attemptSequence'
    ),
    deliveryCount: integer(document.deliveryCount, 'job.deliveryCount'),
    stalledCount: integer(document.stalledCount, 'job.stalledCount'),
    backoff: document.backoff as JobRecord['backoff'],
    timeoutMs: optionalInteger(document.timeoutMs, 'job.timeoutMs'),
    idempotencyKey: optionalText(document.idempotencyKey, 'job.idempotencyKey'),
    createdAt: integer(document.createdAtMs, 'job.createdAtMs'),
    updatedAt: integer(document.updatedAtMs, 'job.updatedAtMs'),
    processedAt: optionalInteger(document.processedAtMs, 'job.processedAtMs'),
    finishedAt: optionalInteger(document.finishedAtMs, 'job.finishedAtMs'),
    leaseOwner: optionalText(document.leaseOwner, 'job.leaseOwner') as JobRecord['leaseOwner'],
    leaseToken: optionalText(document.leaseToken, 'job.leaseToken') as JobRecord['leaseToken'],
    leaseExpiresAt: optionalInteger(document.leaseExpiresAtMs, 'job.leaseExpiresAtMs'),
    cancellationRequestedAt: optionalInteger(
      document.cancellationRequestedAtMs,
      'job.cancellationRequestedAtMs'
    ),
    result: document.result as JobRecord['result'],
    failure: document.failure as JobRecord['failure']
  })
  if (Result.isError(result))
    throw new MongoJobStoreLayoutError('MongoDB job violates the JobStore record contract')
  return result.value
}

const readSlots = (
  decision: ScheduleTickDecision
): ScheduleResult<readonly ScheduleOccurrence[]> => {
  const source = decision.occurrences ?? decision.occurrenceSlots
  if (source !== undefined && decision.enqueueRequests !== undefined)
    return definition('decision', 'must not provide both occurrences and enqueueRequests')
  if (decision.enqueueRequests !== undefined) {
    if (
      !Array.isArray(decision.enqueueRequests) ||
      decision.enqueueRequests.length > MAX_OCCURRENCES
    )
      return definition('decision.enqueueRequests', 'must contain at most 256 items')
    return Result.ok(
      decision.enqueueRequests.map((request) => ({
        slotMs: request.runAt,
        enqueueRequest: request
      }))
    )
  }
  if (!Array.isArray(source) || source.length > MAX_OCCURRENCES)
    return definition('decision.occurrences', 'must contain at most 256 items')
  const result: ScheduleOccurrence[] = []
  for (const item of source) {
    const slot = typeof item === 'number' ? item : item?.slotMs
    const checked = validateTimestamp(slot, 'decision.occurrence.slotMs')
    if (Result.isError(checked)) return checked
    result.push(typeof item === 'number' ? checked.value : { ...item, slotMs: checked.value })
  }
  return Result.ok(Object.freeze(result))
}

const scheduleResult = (
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

class MongoJobScheduleStoreImplementation implements JobScheduleStoreContract {
  readonly descriptor = descriptor
  private disposed = false
  private disposal: Promise<void> | undefined
  private readonly collections: MongoCollections

  constructor(
    private readonly client: MongoJobStoreClient,
    private readonly eventWriter?: JobEventStoreWriter
  ) {
    this.collections = mongoCollections(client.db, client.collectionPrefix)
  }

  private async ensureEventWriterReady(session: MongoSession, operation: string): Promise<void> {
    await assertMongoExtensionEventWriterReady(
      session,
      this.collections,
      this.client.namespace,
      operation,
      this.eventWriter
    )
  }

  private async appendEvent(
    session: MongoSession,
    type: DurableJobEventType,
    record: ScheduleRecord,
    recordedAtMs: number,
    attributes: Readonly<Record<string, string>>
  ): Promise<void> {
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
    await appendMongoExtensionEvent(
      session,
      this.collections,
      this.client.namespace,
      this.eventWriter,
      input
    )
  }

  async start(): Promise<void> {
    const hello = await this.client.db.admin().command({ hello: 1 })
    if (
      typeof hello.logicalSessionTimeoutMinutes !== 'number' ||
      (typeof hello.setName !== 'string' && hello.msg !== 'isdbgrid')
    )
      throw new MongoJobStoreTopologyError(
        'standalone',
        'MongoDB JobScheduleStore requires a replica set or transaction-capable mongos deployment'
      )
    if (this.client.validateLayout)
      await MongoJobStoreMigrator.validate(this.client.db, this.client.collectionPrefix)
  }

  private async transaction<Value>(
    operation: string,
    body: TxBody<Value>
  ): Promise<ScheduleResult<Value>> {
    if (this.disposed) return fail(operation, new Error('store is disposed'))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = this.client.client.startSession()
      let value: Value | undefined
      try {
        await session.withTransaction(
          async () => {
            value = await body(session)
          },
          { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
        )
        return ok(value as Value)
      } catch (cause) {
        if ((cause instanceof MongoDuplicateConflict || isRetryable(cause)) && attempt < 2) continue
        return cause instanceof MongoDuplicateConflict
          ? fail(
              operation,
              new ScheduleStoreFailure({
                operation,
                retryable: true,
                message: 'MongoDB schedule contention did not settle after retries',
                cause
              })
            )
          : fail(operation, cause)
      } finally {
        try {
          await session.endSession()
        } catch {
          /* the transaction result remains primary */
        }
      }
    }
    return fail(operation, new Error('MongoDB transaction retry budget exhausted'))
  }

  private async resolve(
    session: MongoSession,
    selector: ParsedSelector
  ): Promise<ScheduleRecord | undefined> {
    const filter: Doc = { namespace: this.client.namespace, scheduleKey: selector.key }
    if (selector.group !== undefined) filter.group = selector.group
    const rows = await this.collections.schedules
      .find(filter, { sort: { group: 1, scheduleKey: 1 }, session })
      .toArray()
    if (selector.group === undefined && rows.length > 1)
      throw new DuplicateScheduleError({
        group: '*',
        key: selector.key,
        message: `Schedule key "${selector.key}" is ambiguous`
      })
    return rows[0] === undefined ? undefined : decodeSchedule(rows[0])
  }

  private async saveSchedule(
    session: MongoSession,
    record: ScheduleRecord,
    expected?: ScheduleRecord
  ): Promise<void> {
    const filter: Doc = { _id: namespaceId(this.client.namespace, record.group, record.key) }
    if (expected !== undefined)
      Object.assign(filter, { revision: expected.revision, nextRunAtMs: expected.nextRunAtMs })
    const document = encodeSchedule(this.client.namespace, record)
    delete document._id
    const unset: Doc = Object.create(null)
    for (const field of [
      'cron',
      'everyMs',
      'timeZone',
      'backoff',
      'timeoutMs',
      'lastScheduledAtMs',
      'lastJobId'
    ] as const)
      if (!(field in document)) unset[field] = ''
    const update =
      Object.keys(unset).length === 0 ? { $set: document } : { $set: document, $unset: unset }
    const result = await this.collections.schedules.updateOne(filter, update, { session })
    if (result.matchedCount !== 1)
      throw new ScheduleStoreFailure({
        operation: 'tickSchedule',
        retryable: true,
        message: 'MongoDB schedule compare-and-set conflicted'
      })
  }

  private async sequence(session: MongoSession): Promise<number> {
    const result = await this.collections.counters.findOneAndUpdate(
      {
        _id: namespaceId(this.client.namespace, 'job-order-sequence'),
        $or: [{ value: { $lt: MAX } }, { value: { $exists: false } }]
      },
      {
        $setOnInsert: { namespace: this.client.namespace, name: 'job-order-sequence' },
        $inc: { value: 1 }
      },
      { upsert: true, returnDocument: 'after', session }
    )
    const document = findOneResult(result)
    return integer(document?.value, 'counter.value', 1)
  }

  private async notify(queue: string, nowMs: number, session: MongoSession): Promise<void> {
    const result = await this.collections.queues.findOneAndUpdate(
      {
        _id: namespaceId(this.client.namespace, queue),
        $or: [{ wakeVersion: { $lt: MAX } }, { wakeVersion: { $exists: false } }]
      },
      {
        $setOnInsert: { namespace: this.client.namespace, queue, paused: false },
        $set: { updatedAtMs: nowMs },
        $inc: { wakeVersion: 1 }
      },
      { upsert: true, returnDocument: 'after', session }
    )
    const document = findOneResult(result)
    integer(document?.wakeVersion, 'queue.wakeVersion', 1)
  }

  private async readJob(session: MongoSession, jobId: string): Promise<JobRecord | undefined> {
    const document = await this.collections.jobs.findOne(
      { _id: namespaceId(this.client.namespace, jobId) },
      { session }
    )
    return document === null ? undefined : decodeJob(document)
  }

  private async insertJob(
    session: MongoSession,
    record: ScheduleRecord,
    occurrence: ScheduleOccurrence,
    nowMs: number
  ): Promise<{ readonly job: JobRecord; readonly duplicate: boolean }> {
    const item = typeof occurrence === 'number' ? { slotMs: occurrence } : occurrence
    const supplied = item.enqueueRequest
    const slotMs = item.slotMs
    const id = occurrenceId(record, slotMs)
    const existing = await this.readJob(session, id)
    if (existing !== undefined) return { job: existing, duplicate: true }
    const payload = jsonValue(
      supplied === undefined ? record.payload : supplied.payload,
      'decision.enqueueRequest.payload'
    )
    const metadata = normalizeMetadata(
      supplied === undefined ? record.metadata : (supplied.metadata ?? {})
    )
    const priority = safeInteger(
      supplied === undefined ? record.priority : (supplied.priority ?? 0),
      'decision.enqueueRequest.priority'
    )
    const attemptsMax = positive(
      supplied === undefined ? record.attemptsMax : supplied.attemptsMax,
      'decision.enqueueRequest.attemptsMax'
    )
    const runAt = validateTimestamp(slotMs, 'decision.occurrence.slotMs')
    const backoff =
      (supplied === undefined ? record.backoff : supplied.backoff) === undefined
        ? Result.ok<PersistedBackoff | undefined>(undefined)
        : makePersistedBackoff(supplied?.backoff)
    const timeout =
      (supplied === undefined ? record.timeoutMs : supplied.timeoutMs) === undefined
        ? Result.ok<number | undefined>(undefined)
        : validateDuration(supplied?.timeoutMs, 'decision.enqueueRequest.timeoutMs')
    const idempotency = normalizeIdempotencyKey(supplied?.idempotencyKey)
    if (Result.isError(payload)) throw payload.error
    if (Result.isError(metadata)) throw metadata.error
    if (Result.isError(priority)) throw priority.error
    if (Result.isError(attemptsMax)) throw attemptsMax.error
    if (Result.isError(runAt)) throw runAt.error
    if (Result.isError(backoff)) throw backoff.error
    if (Result.isError(timeout)) throw timeout.error
    if (Result.isError(idempotency)) throw idempotency.error
    const orderingSequence = await this.sequence(session)
    const created = makeJobRecord({
      id,
      name: record.job.name,
      version: record.job.version,
      queue: record.job.queue,
      state: runAt.value <= nowMs ? 'waiting' : 'delayed',
      payload: payload.value,
      metadata: metadata.value,
      priority: priority.value,
      runAt: runAt.value,
      orderingSequence,
      attemptsMax: attemptsMax.value,
      attemptsMade: 0,
      attemptSequence: 0,
      deliveryCount: 0,
      stalledCount: 0,
      backoff: backoff.value,
      timeoutMs: timeout.value,
      idempotencyKey: idempotency.value,
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
    if (Result.isError(created)) throw created.error
    try {
      await this.collections.jobs.insertOne(encodeJob(this.client.namespace, created.value), {
        session
      })
    } catch (cause) {
      if (
        typeof cause === 'object' &&
        cause !== null &&
        ((cause as { readonly code?: unknown }).code === 11000 ||
          (cause as { readonly codeName?: unknown }).codeName === 'DuplicateKey')
      )
        throw new MongoDuplicateConflict()
      throw cause
    }
    await this.notify(record.queue, nowMs, session)
    return { job: created.value, duplicate: false }
  }

  upsertSchedule(value: ScheduleRecord): Operation<UpsertScheduleResult> {
    const checked = normalizeRecord(value)
    if (Result.isError(checked)) return failed(checked.error)
    return pending(
      this.transaction('upsertSchedule', async (session) => {
        const normalized = checked.value
        const existing = await this.resolve(session, {
          group: normalized.group,
          key: normalized.key
        })
        if (existing === undefined) {
          await this.ensureEventWriterReady(session, 'upsertSchedule')
          try {
            await this.collections.schedules.insertOne(
              encodeSchedule(this.client.namespace, normalized),
              { session }
            )
          } catch (cause) {
            if (
              typeof cause === 'object' &&
              cause !== null &&
              ((cause as { readonly code?: unknown }).code === 11000 ||
                (cause as { readonly codeName?: unknown }).codeName === 'DuplicateKey')
            )
              throw new MongoDuplicateConflict()
            throw cause
          }
          await this.appendEvent(session, 'schedule-upserted', normalized, normalized.updatedAtMs, {
            created: 'true'
          })
          return { record: cloneRecord(normalized), created: true, changed: true }
        }
        if (logicalDigest(existing) === logicalDigest(normalized))
          return { record: cloneRecord(existing), created: false, changed: false }
        if (existing.revision >= MAX)
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
        await this.ensureEventWriterReady(session, 'upsertSchedule')
        await this.saveSchedule(session, updated)
        await this.appendEvent(session, 'schedule-upserted', updated, updated.updatedAtMs, {
          created: 'false'
        })
        return { record: cloneRecord(updated), created: false, changed: true }
      })
    )
  }

  removeSchedule(value: ScheduleSelector): Operation<boolean> {
    const parsed = parseSelector(value)
    if (Result.isError(parsed)) return failed(parsed.error)
    return pending(
      this.transaction('removeSchedule', async (session) => {
        const current = await this.resolve(session, parsed.value)
        if (current === undefined) return false
        await this.ensureEventWriterReady(session, 'removeSchedule')
        const result = await this.collections.schedules.deleteOne(
          { _id: namespaceId(this.client.namespace, current.group, current.key) },
          { session }
        )
        if (result.deletedCount !== 1) return false
        await this.appendEvent(session, 'schedule-removed', current, current.updatedAtMs, {})
        return true
      })
    )
  }

  getSchedule(value: ScheduleSelector): Operation<ScheduleRecord | undefined> {
    const parsed = parseSelector(value)
    if (Result.isError(parsed)) return failed(parsed.error)
    return pending(
      this.transaction('getSchedule', async (session) => {
        const current = await this.resolve(session, parsed.value)
        return current === undefined ? undefined : cloneRecord(current)
      })
    )
  }

  listSchedules(options: ListSchedulesOptions = {}): Operation<readonly ScheduleRecord[]> {
    if (!isPlainObject(options)) return failed(definitionError('options', 'must be an object'))
    const limit = options.limit === undefined ? Result.ok(MAX) : positive(options.limit, 'limit')
    const group =
      options.group === undefined
        ? Result.ok<string | undefined>(undefined)
        : validateText(options.group, 'group')
    if (Result.isError(limit)) return failed(limit.error)
    if (Result.isError(group)) return failed(group.error)
    if (options.paused !== undefined && typeof options.paused !== 'boolean')
      return failed(new ScheduleDefinitionError({ field: 'paused', message: 'must be boolean' }))
    return pending(
      this.transaction('listSchedules', async (session) => {
        const filter: Doc = { namespace: this.client.namespace }
        if (group.value !== undefined) filter.group = group.value
        if (options.paused !== undefined) filter.paused = options.paused
        const rows = await this.collections.schedules
          .find(filter, { sort: { group: 1, scheduleKey: 1 }, limit: limit.value, session })
          .toArray()
        return Object.freeze(rows.map(decodeSchedule).map(cloneRecord))
      })
    )
  }

  dueSchedules(options: DueSchedulesOptions): Operation<readonly ScheduleRecord[]> {
    if (!isPlainObject(options)) return failed(definitionError('options', 'must be an object'))
    const now = validateTimestamp(options.nowMs, 'nowMs')
    const limit = options.limit === undefined ? Result.ok(MAX) : positive(options.limit, 'limit')
    const group =
      options.group === undefined
        ? Result.ok<string | undefined>(undefined)
        : validateText(options.group, 'group')
    if (Result.isError(now)) return failed(now.error)
    if (Result.isError(limit)) return failed(limit.error)
    if (Result.isError(group)) return failed(group.error)
    return pending(
      this.transaction('dueSchedules', async (session) => {
        const filter: Doc = {
          namespace: this.client.namespace,
          paused: false,
          nextRunAtMs: { $lte: now.value }
        }
        if (group.value !== undefined) filter.group = group.value
        const rows = await this.collections.schedules
          .find(filter, {
            sort: { nextRunAtMs: 1, group: 1, scheduleKey: 1 },
            limit: limit.value,
            session
          })
          .toArray()
        return Object.freeze(rows.map(decodeSchedule).map(cloneRecord))
      })
    )
  }

  tickSchedule(command: TickScheduleCommand): Operation<TickScheduleResult> {
    if (!isPlainObject(command)) return failed(definitionError('command', 'must be an object'))
    if (!isPlainObject(command.decision))
      return failed(definitionError('decision', 'must be an object'))
    const parsed = parseSelector(command.key)
    const revision = nonNegative(command.expectedRevision, 'expectedRevision')
    const expectedRunAt = validateTimestamp(command.expectedRunAtMs, 'expectedRunAtMs')
    const now = validateTimestamp(command.nowMs, 'nowMs')
    const slots = readSlots(command.decision)
    const nextRunAt = validateTimestamp(command.decision.nextRunAtMs, 'decision.nextRunAtMs')
    if (Result.isError(parsed)) return failed(parsed.error)
    if (Result.isError(revision)) return failed(revision.error)
    if (Result.isError(expectedRunAt)) return failed(expectedRunAt.error)
    if (Result.isError(now)) return failed(now.error)
    if (Result.isError(slots)) return failed(slots.error)
    if (Result.isError(nextRunAt)) return failed(nextRunAt.error)
    if (nextRunAt.value <= expectedRunAt.value)
      return failed(
        new ScheduleDefinitionError({
          field: 'decision.nextRunAtMs',
          message: 'must advance beyond expectedRunAtMs'
        })
      )
    const skipped = command.decision.skippedSlots ?? []
    if (!Array.isArray(skipped))
      return failed(
        new ScheduleDefinitionError({ field: 'decision.skippedSlots', message: 'must be an array' })
      )
    for (const slot of skipped) {
      const checked = validateTimestamp(slot, 'decision.skippedSlots')
      if (Result.isError(checked)) return failed(checked.error)
    }
    return pending(
      this.transaction('tickSchedule', async (session) => {
        const current = await this.resolve(session, parsed.value)
        if (current === undefined) throw notFound(parsed.value)
        if (current.paused) return scheduleResult('paused', current, [], [])
        if (current.revision !== revision.value || current.nextRunAtMs !== expectedRunAt.value)
          return scheduleResult('stale', current, [], [])
        await this.ensureEventWriterReady(session, 'tickSchedule')
        const skippedSlots = [...skipped]
        let effective = slots.value
        if (current.overlap === 'skip' && current.lastJobId !== undefined) {
          const prior = await this.readJob(session, current.lastJobId)
          if (
            prior !== undefined &&
            (prior.state === 'waiting' || prior.state === 'delayed' || prior.state === 'active')
          ) {
            effective = []
            skippedSlots.push(
              ...slots.value.map((item) => (typeof item === 'number' ? item : item.slotMs))
            )
          }
        }
        const jobs: JobRecord[] = []
        for (const item of effective)
          jobs.push((await this.insertJob(session, current, item, now.value)).job)
        const updated = cloneRecord({
          ...current,
          revision: current.revision + 1,
          nextRunAtMs: nextRunAt.value,
          lastScheduledAtMs:
            effective.length > 0
              ? Math.max(
                  ...effective.map((item) => (typeof item === 'number' ? item : item.slotMs))
                )
              : current.lastScheduledAtMs,
          lastJobId: jobs.at(-1)?.id ?? current.lastJobId,
          updatedAtMs: now.value
        })
        await this.saveSchedule(session, updated, current)
        await this.appendEvent(session, 'schedule-ticked', updated, now.value, {
          status: jobs.length > 0 ? 'fired' : 'skipped',
          jobs: String(jobs.length),
          skipped: String(skippedSlots.length)
        })
        return scheduleResult(jobs.length > 0 ? 'fired' : 'skipped', updated, jobs, skippedSlots)
      })
    )
  }

  pauseSchedule(value: ScheduleSelector): Operation<void> {
    return this.setPaused(value, true)
  }
  resumeSchedule(value: ScheduleSelector): Operation<void> {
    return this.setPaused(value, false)
  }

  private setPaused(value: ScheduleSelector, paused: boolean): Operation<void> {
    const parsed = parseSelector(value)
    if (Result.isError(parsed)) return failed(parsed.error)
    return pending(
      this.transaction(paused ? 'pauseSchedule' : 'resumeSchedule', async (session) => {
        const current = await this.resolve(session, parsed.value)
        if (current === undefined) throw notFound(parsed.value)
        if (current.paused === paused) return undefined
        await this.ensureEventWriterReady(session, paused ? 'pauseSchedule' : 'resumeSchedule')
        const updated = { ...current, paused, revision: current.revision + 1 }
        await this.saveSchedule(session, updated, current)
        await this.appendEvent(
          session,
          paused ? 'schedule-paused' : 'schedule-resumed',
          updated,
          updated.updatedAtMs,
          {}
        )
        return undefined
      })
    )
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = this.client.ownsClient ? this.client.dispose() : Promise.resolve()
    return this.disposal
  }
}

type ScheduleLayer<Token extends AnyJobScheduleStoreToken> = Layer<
  InstanceType<Token>,
  InstanceType<Token['jobStore']>
>

const namespaceFor = (token: AnyJobScheduleStoreToken, namespace: string): string =>
  token.jobStore.serviceTag === JobStore.serviceTag
    ? namespace
    : `${namespace}:store-${token.jobStore.serviceTag}`

const makeLayer = <Token extends AnyJobScheduleStoreToken>(
  token: Token,
  acquire: () => Promise<MongoJobStoreClient>,
  eventWriter?: JobEventStoreWriter
): ScheduleLayer<Token> =>
  Layer.scopedGen(
    token,
    async function* () {
      yield* token.jobStore
      const client = await acquire()
      const store = new MongoJobScheduleStoreImplementation(client, eventWriter)
      try {
        await store.start()
        return JobScheduleStore.of(store as never) as unknown as ServiceContract<
          InstanceType<Token>
        >
      } catch (cause) {
        await store.dispose()
        if (client.ownsClient) await client.dispose()
        throw cause
      }
    },
    async (store) => {
      await (store as unknown as MongoJobScheduleStoreImplementation).dispose()
    }
  ) as ScheduleLayer<Token>

type MongoJobScheduleStoreApi = {
  readonly layer: (config: MongoJobStoreConfig) => ScheduleLayer<typeof JobScheduleStore>
  readonly layerFor: <Token extends AnyJobScheduleStoreToken>(
    token: Token,
    config: MongoJobStoreConfig
  ) => ScheduleLayer<Token>
  readonly layerFromConfig: (
    config: MongoJobStoreConnectionConfig
  ) => ScheduleLayer<typeof JobScheduleStore>
  readonly layerFromConfigFor: <Token extends AnyJobScheduleStoreToken>(
    token: Token,
    config: MongoJobStoreConnectionConfig
  ) => ScheduleLayer<Token>
}

export const MongoJobScheduleStore: MongoJobScheduleStoreApi = Object.freeze({
  layer(config: MongoJobStoreConfig) {
    return makeLayer(
      JobScheduleStore,
      async () => MongoJobStoreClient.fromDb(config),
      config.eventWriter
    )
  },
  layerFor<Token extends AnyJobScheduleStoreToken>(token: Token, config: MongoJobStoreConfig) {
    const namespace = namespaceFor(token, config.namespace ?? 'default')
    return makeLayer(
      token,
      async () => MongoJobStoreClient.fromDb({ ...config, namespace }),
      config.eventWriter
    )
  },
  layerFromConfig(config: MongoJobStoreConnectionConfig) {
    return makeLayer(
      JobScheduleStore,
      () => MongoJobStoreClient.fromConfig(config),
      config.eventWriter
    )
  },
  layerFromConfigFor<Token extends AnyJobScheduleStoreToken>(
    token: Token,
    config: MongoJobStoreConnectionConfig
  ) {
    const namespace = namespaceFor(token, config.namespace ?? 'default')
    return makeLayer(
      token,
      () => MongoJobStoreClient.fromConfig({ ...config, namespace }),
      config.eventWriter
    )
  }
})
