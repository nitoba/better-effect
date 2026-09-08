// oxlint-disable anti-slop/no-runtime-typeof -- public schedule DTOs are validated at this boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- Redis replies and JavaScript callers are untyped.
// oxlint-disable anti-slop/no-unknown-returns -- decoded Redis values are narrowed before returning.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- Redis hashes and JSON records are explicit wire data.
// oxlint-disable anti-slop/no-chained-type-assertions -- assertions stay at validated persistence boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- each cast follows validation or erasure.

import { Layer, type ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

import {
  DuplicateScheduleError,
  JobScheduleStore,
  JobStore,
  ScheduleDefinitionError,
  ScheduleNotFoundError,
  ScheduleStoreFailure,
  makeJobId,
  makeJobName,
  makeJobRecord,
  makePersistedBackoff,
  makeQueueName,
  makeScheduleOccurrenceId,
  validateDuration,
  validateTimestamp,
  type AnyJobScheduleStoreToken,
  type AnyJobStoreToken,
  type EnqueueRequest,
  type JobRecord,
  type JsonValue,
  type MisfirePolicy,
  type ScheduleOccurrence,
  type ScheduleRecord,
  type ScheduleSelector,
  type ScheduleStoreError,
  type ScheduleTickDecision,
  type TickScheduleCommand,
  type TickScheduleResult,
  type UpsertScheduleResult
} from 'better-effect-mq'

import { RedisClient } from './client'
import {
  sendRedisCommand,
  type RedisJobStoreConfig,
  type RedisJobStoreConnectionConfig
} from './config'
import { decodeJobRecord, encodeJobRecord } from './codec'
import { RedisLayoutError } from './errors'
import { hashReply, numberReply, scriptReply, stringsReply } from './internal/replies'
import { runScript } from './internal/run-script'
import {
  assertRedisJobEventWriterReady,
  ensureRedisOptionalJobEventActivation
} from './event-store'
import {
  makeExtensionEvent,
  normalizeEventOptions,
  type RedisEventAppendOptions,
  type RedisJobEventStoreOptions
} from './event-codec'
import {
  decodeKeySegment,
  encodeDelayedMember,
  encodeIdentity,
  encodeKeySegment,
  encodeListingMember,
  encodeWaitingMember,
  type RedisKeyLayout
} from './keys'

type Operation<Value> = ResultType<Value, ScheduleStoreError>

const ok = <Value>(value: Value): Operation<Value> => Result.ok(value)

const taggedErrors = new Set([
  'DuplicateScheduleError',
  'JobDefinitionError',
  'ScheduleDefinitionError',
  'ScheduleNotFoundError',
  'ScheduleStoreFailure'
])

const fail = <Value>(operation: string, cause: unknown): Operation<Value> => {
  if (
    cause !== null &&
    typeof cause === 'object' &&
    taggedErrors.has((cause as { readonly _tag?: string })._tag ?? '')
  ) {
    return Result.err(cause as ScheduleStoreError)
  }
  return Result.err(
    new ScheduleStoreFailure({
      operation,
      retryable: false,
      message: `Redis schedule ${operation} failed`,
      cause
    })
  )
}

const descriptor = Object.freeze({
  extension: 'better-effect-mq/schedules' as const,
  extensionVersion: 1 as const,
  jobStoreProtocolVersion: 1 as const
})

const MAX_OCCURRENCES_PER_TICK = 256
const MAX_DUE_SCAN = 10_000

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const definitionFailure = <Value>(field: string, message: string): Operation<Value> =>
  Result.err(new ScheduleDefinitionError({ field, message }))

const validateText = (value: unknown, field: string): Operation<string> => {
  if (typeof value !== 'string' || value.length === 0)
    return definitionFailure(field, 'must be non-empty')
  if (value.length > 512) return definitionFailure(field, 'must be at most 512 characters')
  return ok(value)
}

const validateNonNegativeInteger = (value: unknown, field: string): Operation<number> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return definitionFailure(field, 'must be a non-negative safe integer')
  return ok(value)
}

const validateSafeInteger = (value: unknown, field: string): Operation<number> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    return definitionFailure(field, 'must be a safe integer')
  return ok(value)
}

const validatePositiveInteger = (value: unknown, field: string): Operation<number> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    return definitionFailure(field, 'must be a positive safe integer')
  return ok(value)
}

const cloneJson = (
  value: unknown,
  field: string,
  seen = new Set<object>()
): Operation<JsonValue> => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return ok(value)
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? ok(value)
      : definitionFailure(field, 'must contain finite JSON numbers')
  }
  if (typeof value !== 'object') return definitionFailure(field, 'must be JSON data')
  if (seen.has(value)) return definitionFailure(field, 'must not contain cycles')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype)
        return definitionFailure(field, 'must use the standard array prototype')
      const output: JsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        const item = cloneJson(value[index], `${field}.${index}`, seen)
        if (Result.isError(item)) return item
        output.push(item.value)
      }
      return ok(Object.freeze(output))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      return definitionFailure(field, 'must contain plain objects')
    const object = value as Record<string, unknown>
    const output: Record<string, JsonValue> = {}
    for (const key of Object.keys(object)) {
      const item = cloneJson(object[key], `${field}.${key}`, seen)
      if (Result.isError(item)) return item
      output[key] = item.value
    }
    return ok(Object.freeze(output))
  } finally {
    seen.delete(value)
  }
}

const cloneMetadata = (
  value: unknown,
  field: string
): Operation<Readonly<Record<string, string>>> => {
  if (!isObject(value)) return definitionFailure(field, 'must be an object')
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return definitionFailure(`${field}.${key}`, 'must be a string')
    output[key] = item
  }
  return ok(Object.freeze(output))
}

const normalizePolicy = (value: unknown): Operation<MisfirePolicy> => {
  if (
    !isObject(value) ||
    (value.strategy !== 'skip' && value.strategy !== 'run-once' && value.strategy !== 'catch-up')
  )
    return definitionFailure('misfire', 'has an unsupported strategy')
  if (value.strategy === 'catch-up') {
    const maximum = validatePositiveInteger(value.maxOccurrences, 'misfire.maxOccurrences')
    if (Result.isError(maximum)) return maximum
    return ok(Object.freeze({ strategy: 'catch-up', maxOccurrences: maximum.value }))
  }
  return ok(Object.freeze({ strategy: value.strategy }))
}

const validCron = (value: string): boolean => {
  const fields = value.trim().split(/\s+/u)
  return fields.length === 5 && fields.every((field) => /^[0-9*/?,-]+$/u.test(field))
}

const normalizeRecord = (value: unknown): Operation<ScheduleRecord> => {
  if (!isObject(value)) return definitionFailure('record', 'must be an object')
  const key = validateText(value.key, 'key')
  const group = validateText(value.group, 'group')
  const queue = makeQueueName(value.queue)
  const jobValue = value.job
  if (!isObject(jobValue)) return definitionFailure('job', 'must be an object')
  const jobQueue = makeQueueName(jobValue.queue)
  const jobName = makeJobName(jobValue.name)
  const jobVersion = validatePositiveInteger(jobValue.version, 'job.version')
  const payload = cloneJson(value.payload, 'payload')
  const metadata = cloneMetadata(value.metadata, 'metadata')
  const priority = validateSafeInteger(value.priority, 'priority')
  const attemptsMax = validatePositiveInteger(value.attemptsMax, 'attemptsMax')
  const timeout =
    value.timeoutMs === undefined
      ? ok<number | undefined>(undefined)
      : validateDuration(value.timeoutMs, 'timeoutMs')
  const backoff =
    value.backoff === undefined
      ? ok<ScheduleRecord['backoff']>(undefined)
      : makePersistedBackoff(value.backoff)
  const revision = validateNonNegativeInteger(value.revision, 'revision')
  const nextRunAtMs = validateTimestamp(value.nextRunAtMs, 'nextRunAtMs')
  const createdAtMs = validateTimestamp(value.createdAtMs, 'createdAtMs')
  const updatedAtMs = validateTimestamp(value.updatedAtMs, 'updatedAtMs')
  const lastScheduledAtMs =
    value.lastScheduledAtMs === undefined
      ? ok<number | undefined>(undefined)
      : validateTimestamp(value.lastScheduledAtMs, 'lastScheduledAtMs')
  const lastJobId =
    value.lastJobId === undefined
      ? ok<ScheduleRecord['lastJobId']>(undefined)
      : makeJobId(value.lastJobId)
  const timeZone: Operation<string | undefined> =
    value.timeZone === undefined
      ? ok<string | undefined>(undefined)
      : (() => {
          if (typeof value.timeZone !== 'string')
            return definitionFailure('timeZone', 'must be a string')
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }).format(0)
            return ok<string | undefined>(value.timeZone)
          } catch {
            return definitionFailure('timeZone', 'must be a valid IANA time zone')
          }
        })()
  const policy = normalizePolicy(value.misfire)

  if (Result.isError(key)) return key
  if (Result.isError(group)) return group
  if (Result.isError(queue)) return definitionFailure('queue', queue.error.message)
  if (Result.isError(jobQueue)) return definitionFailure('job.queue', jobQueue.error.message)
  if (Result.isError(jobName)) return definitionFailure('job.name', jobName.error.message)
  if (Result.isError(jobVersion)) return jobVersion
  if (Result.isError(payload)) return payload
  if (Result.isError(metadata)) return metadata
  if (Result.isError(priority)) return priority
  if (Result.isError(attemptsMax)) return attemptsMax
  if (Result.isError(timeout)) return timeout
  if (Result.isError(backoff)) return definitionFailure('backoff', backoff.error.message)
  if (Result.isError(revision)) return revision
  if (Result.isError(nextRunAtMs)) return nextRunAtMs
  if (Result.isError(createdAtMs)) return createdAtMs
  if (Result.isError(updatedAtMs)) return updatedAtMs
  if (Result.isError(lastScheduledAtMs)) return lastScheduledAtMs
  if (Result.isError(lastJobId)) return definitionFailure('lastJobId', lastJobId.error.message)
  if (Result.isError(timeZone)) return timeZone
  if (Result.isError(policy)) return policy
  if (jobQueue.value !== queue.value) return definitionFailure('job.queue', 'must match queue')

  const cron = value.cron
  const everyMs = value.everyMs
  if (cron !== undefined && typeof cron !== 'string')
    return definitionFailure('cron', 'must be a string')
  if (everyMs !== undefined && typeof everyMs !== 'number')
    return definitionFailure('everyMs', 'must be a number')
  if ((cron === undefined) === (everyMs === undefined))
    return definitionFailure('cadence', 'must provide exactly one of cron or everyMs')
  if (cron !== undefined && !validCron(cron))
    return definitionFailure('cron', 'must contain five valid fields')
  if (everyMs !== undefined) {
    const cadence = validatePositiveInteger(everyMs, 'everyMs')
    if (Result.isError(cadence)) return cadence
  }
  if (value.overlap !== 'allow' && value.overlap !== 'skip')
    return definitionFailure('overlap', 'must be allow or skip')
  if (typeof value.paused !== 'boolean') return definitionFailure('paused', 'must be boolean')
  if (timeout.value === 0) return definitionFailure('timeoutMs', 'must be greater than zero')
  if (updatedAtMs.value < createdAtMs.value)
    return definitionFailure('updatedAtMs', 'must not be earlier than createdAtMs')

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

const freezeRecord = (record: ScheduleRecord): ScheduleRecord =>
  Object.freeze({
    ...record,
    job: Object.freeze({ ...record.job }),
    metadata: Object.freeze({ ...record.metadata }),
    misfire: Object.freeze({ ...record.misfire }),
    backoff: record.backoff === undefined ? undefined : Object.freeze({ ...record.backoff })
  })

const parseJson = (value: string, field: string): unknown => {
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw new RedisLayoutError(`invalid ${field} JSON`, field, 'INVALID_DATA', { cause })
  }
}

const redisInteger = (value: string | undefined, field: string): number => {
  if (value === undefined || !/^(?:0|[1-9]\d*)$/u.test(value))
    throw new RedisLayoutError(`invalid ${field}`, field, 'INVALID_DATA')
  const result = Number(value)
  if (!Number.isSafeInteger(result))
    throw new RedisLayoutError(`unsafe ${field}`, field, 'INVALID_DATA')
  return result
}

const redisSignedInteger = (value: string | undefined, field: string): number => {
  if (value === undefined || !/^(?:0|-?[1-9]\d*)$/u.test(value))
    throw new RedisLayoutError(`invalid ${field}`, field, 'INVALID_DATA')
  const result = Number(value)
  if (!Number.isSafeInteger(result))
    throw new RedisLayoutError(`unsafe ${field}`, field, 'INVALID_DATA')
  return result
}

const redisBoolean = (value: string | undefined, field: string): boolean => {
  if (value === '1') return true
  if (value === '0') return false
  throw new RedisLayoutError(`invalid ${field}`, field, 'INVALID_DATA')
}

const optionalRedisInteger = (value: string | undefined, field: string): number | undefined =>
  value === undefined || value === '' ? undefined : redisInteger(value, field)

type ScheduleHashFields = {
  key: string
  group: string
  job: string
  queue: string
  payload: string
  metadata: string
  priority: string
  attemptsMax: string
  misfire: string
  overlap: string
  paused: string
  revision: string
  nextRunAtMs: string
  createdAtMs: string
  updatedAtMs: string
  cron?: string
  everyMs?: string
  timeZone?: string
  backoff?: string
  timeoutMs?: string
  lastScheduledAtMs?: string
  lastJobId?: string
}

const encodeScheduleRecord = (record: ScheduleRecord): ScheduleHashFields => {
  const fields: ScheduleHashFields = {
    key: record.key,
    group: record.group,
    job: JSON.stringify(record.job),
    queue: record.queue,
    payload: JSON.stringify(record.payload),
    metadata: JSON.stringify(record.metadata),
    priority: String(record.priority),
    attemptsMax: String(record.attemptsMax),
    misfire: JSON.stringify(record.misfire),
    overlap: record.overlap,
    paused: record.paused ? '1' : '0',
    revision: String(record.revision),
    nextRunAtMs: String(record.nextRunAtMs),
    createdAtMs: String(record.createdAtMs),
    updatedAtMs: String(record.updatedAtMs)
  }
  if (record.cron !== undefined) fields.cron = record.cron
  if (record.everyMs !== undefined) fields.everyMs = String(record.everyMs)
  if (record.timeZone !== undefined) fields.timeZone = record.timeZone
  if (record.backoff !== undefined) fields.backoff = JSON.stringify(record.backoff)
  if (record.timeoutMs !== undefined) fields.timeoutMs = String(record.timeoutMs)
  if (record.lastScheduledAtMs !== undefined)
    fields.lastScheduledAtMs = String(record.lastScheduledAtMs)
  if (record.lastJobId !== undefined) fields.lastJobId = record.lastJobId
  return fields
}

const decodeSchedule = (fields: Readonly<Record<string, string>>): ScheduleRecord | undefined => {
  if (Object.keys(fields).length === 0) return undefined
  const checked = normalizeRecord({
    key: fields.key,
    group: fields.group,
    job: parseJson(fields.job ?? '', 'job'),
    queue: fields.queue,
    cron: fields.cron,
    everyMs: optionalRedisInteger(fields.everyMs, 'everyMs'),
    timeZone: fields.timeZone,
    payload: parseJson(fields.payload ?? '', 'payload'),
    metadata: parseJson(fields.metadata ?? '', 'metadata'),
    priority:
      fields.priority === undefined ? undefined : redisSignedInteger(fields.priority, 'priority'),
    attemptsMax:
      fields.attemptsMax === undefined
        ? undefined
        : redisInteger(fields.attemptsMax, 'attemptsMax'),
    backoff: fields.backoff === undefined ? undefined : parseJson(fields.backoff, 'backoff'),
    timeoutMs: optionalRedisInteger(fields.timeoutMs, 'timeoutMs'),
    misfire: parseJson(fields.misfire ?? '', 'misfire'),
    overlap: fields.overlap,
    paused: redisBoolean(fields.paused, 'paused'),
    revision: redisInteger(fields.revision, 'revision'),
    nextRunAtMs: redisInteger(fields.nextRunAtMs, 'nextRunAtMs'),
    lastScheduledAtMs: optionalRedisInteger(fields.lastScheduledAtMs, 'lastScheduledAtMs'),
    lastJobId:
      fields.lastJobId === undefined || fields.lastJobId === '' ? undefined : fields.lastJobId,
    createdAtMs: redisInteger(fields.createdAtMs, 'createdAtMs'),
    updatedAtMs: redisInteger(fields.updatedAtMs, 'updatedAtMs')
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

type ParsedAddress = { readonly group: string | undefined; readonly key: string }

const parseAddress = (selector: ScheduleSelector): Operation<ParsedAddress> => {
  if (typeof selector === 'string') {
    const key = validateText(selector, 'key')
    return Result.isError(key) ? key : ok({ key: key.value, group: undefined })
  }
  if (!isObject(selector)) return definitionFailure('key', 'must be a key or address')
  const key = validateText(selector.key, 'key')
  const group = validateText(selector.group, 'group')
  if (Result.isError(key)) return key
  if (Result.isError(group)) return group
  return ok({ key: key.value, group: group.value })
}

const notFound = (address: ParsedAddress): ScheduleNotFoundError =>
  address.group === undefined
    ? new ScheduleNotFoundError({ key: address.key })
    : new ScheduleNotFoundError({ key: address.key, group: address.group })

const positiveLimit = (value: unknown, field: string): Operation<number> =>
  value === undefined ? ok(Number.MAX_SAFE_INTEGER) : validatePositiveInteger(value, field)

const scheduleMember = (layout: RedisKeyLayout, group: string, key: string): string =>
  layout.schedule(group, key)

const jobKeys = (layout: RedisKeyLayout, record: JobRecord) => ({
  job: layout.job(record.id),
  revision: `${layout.job(record.id)}:revision`,
  identities: layout.identities(record.queue),
  identityMember: encodeIdentity(record.name, record.version),
  byQueue: layout.byQueue(record.queue),
  byIdentity: layout.byIdentity(record.name, record.version),
  byState: layout.byState(record.state),
  newWaiting:
    record.state === 'waiting'
      ? layout.waiting(record.queue, record.name, record.version)
      : undefined,
  newDelayed:
    record.state === 'delayed'
      ? layout.delayed(record.queue, record.name, record.version)
      : undefined,
  newWaitingMember:
    record.state === 'waiting' ? encodeWaitingMember(record.runAt, 0, record.id) : undefined,
  newDelayedMember: record.state === 'delayed' ? encodeDelayedMember(0, record.id) : undefined,
  newCreatedMember: encodeListingMember(record.createdAt, 0, record.id),
  newRunAtMember: encodeListingMember(record.runAt, 0, record.id),
  newFinishedMember: encodeListingMember(record.finishedAt ?? null, 0, record.id)
})

const readArray = (value: unknown, field: string): readonly unknown[] => {
  if (!Array.isArray(value))
    throw new ScheduleStoreFailure({ operation: field, message: 'Redis reply was not an array' })
  return value
}

const readSlots = (decision: ScheduleTickDecision): Operation<readonly ScheduleOccurrence[]> => {
  const source = decision.occurrences ?? decision.occurrenceSlots
  if (source !== undefined && decision.enqueueRequests !== undefined)
    return definitionFailure('decision', 'must not provide both occurrences and enqueueRequests')
  if (decision.enqueueRequests !== undefined) {
    if (!Array.isArray(decision.enqueueRequests))
      return definitionFailure('decision.enqueueRequests', 'must be an array')
    if (decision.enqueueRequests.length > MAX_OCCURRENCES_PER_TICK)
      return definitionFailure(
        'decision.enqueueRequests',
        `must contain at most ${MAX_OCCURRENCES_PER_TICK} items`
      )
    return ok(
      decision.enqueueRequests.map((request) => ({
        slotMs: request.runAt,
        enqueueRequest: request
      }))
    )
  }
  if (source === undefined) return definitionFailure('decision.occurrences', 'is required')
  if (!Array.isArray(source)) return definitionFailure('decision.occurrences', 'must be an array')
  if (source.length > MAX_OCCURRENCES_PER_TICK)
    return definitionFailure(
      'decision.occurrences',
      `must contain at most ${MAX_OCCURRENCES_PER_TICK} items`
    )
  const checked: ScheduleOccurrence[] = []
  for (const item of source) {
    if (typeof item !== 'number' && !isObject(item))
      return definitionFailure('decision.occurrence', 'must be a slot or object')
    const slot = validateTimestamp(
      typeof item === 'number' ? item : item.slotMs,
      'decision.occurrence.slotMs'
    )
    if (Result.isError(slot)) return slot
    checked.push(item as ScheduleOccurrence)
  }
  return ok(Object.freeze(checked))
}

const namespaceFor = (token: AnyJobStoreToken, namespace: string): string =>
  token.serviceTag === JobStore.serviceTag
    ? namespace
    : `${namespace}:store-${Buffer.from(token.serviceTag).toString('base64url')}`

interface TickScriptKeys {
  readonly schedule: string
  readonly scheduleGroup: string
  readonly scheduleGroups: string
  readonly scheduleDue: string
  readonly all: string
  readonly counts: string
  readonly wake: string
  readonly wakeChannel: string
  readonly queueControls: string
  readonly sequenceJobs: string
  readonly created: string
  readonly runAt: string
  readonly finishedAt: string
  readonly events?: string
  readonly eventsMeta?: string
  overlapJob?: string
}

type ScheduleEventPayload = {
  readonly event?: ReturnType<typeof makeExtensionEvent>
  readonly eventKeys?: { readonly events: string; readonly eventsMeta: string } | undefined
  readonly eventRetention?: RedisEventAppendOptions['retention']
}

type ScheduleMutationPayload = ScheduleEventPayload & {
  readonly mode: 'upsert' | 'remove' | 'pause' | 'resume'
  readonly record: ScheduleHashFields
  readonly groupMember: string
}

class RedisJobScheduleStoreImplementation {
  readonly descriptor = descriptor
  private closed = false
  private disposal: Promise<void> | undefined
  private readonly eventOptions: RedisEventAppendOptions | undefined
  private readonly eventWriter: import('better-effect-mq').JobEventStoreWriter

  constructor(
    private readonly redis: RedisClient,
    options?: RedisJobEventStoreOptions
  ) {
    const normalized = options === undefined ? undefined : normalizeEventOptions(options)
    this.eventWriter =
      normalized?.writer ??
      Object.freeze({ id: 'better-effect-mq-redis', version: 'current', canAppend: false })
    this.eventOptions = normalized?.writer.canAppend ? normalized : undefined
  }

  private eventKeys(): { readonly events: string; readonly eventsMeta: string } | undefined {
    return this.eventOptions === undefined
      ? undefined
      : { events: this.redis.layout.events, eventsMeta: this.redis.layout.eventsMeta }
  }

  private eventPayload(factory: () => ReturnType<typeof makeExtensionEvent>): ScheduleEventPayload {
    if (this.eventOptions === undefined) return {}
    return {
      event: factory(),
      eventKeys: this.eventKeys(),
      eventRetention: this.eventOptions.retention
    }
  }

  private async prepareMutation(operation: string): Promise<void> {
    if (this.eventOptions !== undefined)
      await ensureRedisOptionalJobEventActivation(this.redis, Date.now())
    await assertRedisJobEventWriterReady(
      this.redis,
      operation,
      this.eventWriter,
      this.eventOptions !== undefined
    )
  }

  private get layout(): RedisKeyLayout {
    return this.redis.layout
  }

  private assertOpen(operation: string): void {
    if (this.closed)
      throw new ScheduleStoreFailure({
        operation,
        retryable: false,
        message: 'Redis JobScheduleStore has been disposed'
      })
  }

  private command<T = unknown>(args: readonly string[]): Promise<T> {
    this.assertOpen('command')
    return sendRedisCommand(this.redis.client, args, this.layout.base) as Promise<T>
  }

  private async readHash(hash: string): Promise<ScheduleRecord | undefined> {
    const fields = hashReply(await this.command(['HGETALL', hash]))
    return decodeSchedule(fields)
  }

  private async readAddress(group: string, key: string): Promise<ScheduleRecord | undefined> {
    return this.readHash(scheduleMember(this.layout, group, key))
  }

  private async resolve(selector: ScheduleSelector): Promise<ScheduleRecord | undefined> {
    const address = parseAddress(selector)
    if (Result.isError(address)) throw address.error
    if (address.value.group !== undefined)
      return this.readAddress(address.value.group, address.value.key)

    const groups = stringsReply(await this.command(['SMEMBERS', this.layout.scheduleGroups]))
    const matches: ScheduleRecord[] = []
    for (const encodedGroup of groups) {
      const group = decodeKeySegment(encodedGroup, 'schedule group')
      const record = await this.readAddress(group, address.value.key)
      if (record !== undefined) matches.push(record)
    }
    if (matches.length > 1)
      throw new DuplicateScheduleError({
        group: '*',
        key: address.value.key,
        message: `Schedule key "${address.value.key}" is ambiguous`
      })
    return matches[0]
  }

  private async mutate(
    mode: 'upsert' | 'remove' | 'pause' | 'resume',
    record: ScheduleRecord,
    event?: ReturnType<typeof makeExtensionEvent>
  ) {
    await this.prepareMutation(`schedule-${mode}`)
    const keys = [
      this.layout.schedule(record.group, record.key),
      this.layout.scheduleGroup(record.group),
      this.layout.scheduleGroups,
      this.layout.scheduleDue,
      ...(this.eventOptions === undefined ? [] : [this.layout.events, this.layout.eventsMeta])
    ]
    const body: ScheduleMutationPayload = {
      mode,
      record: encodeScheduleRecord(record),
      groupMember: encodeKeySegment(record.group)
    }
    if (event !== undefined)
      Object.assign(
        body,
        this.eventPayload(() => event)
      )
    const result = await runScript(this.redis.scripts, 'schedule-mutate', {
      keys,
      args: [JSON.stringify(body)],
      decode: (reply) => scriptReply(reply, 'schedule-mutate')
    })
    if (Result.isError(result)) throw result.error
    return result.value
  }

  async upsertSchedule(input: ScheduleRecord): Promise<Operation<UpsertScheduleResult>> {
    try {
      const checked = normalizeRecord(input)
      if (Result.isError(checked)) return checked
      const normalized = checked.value
      const existing = await this.readAddress(normalized.group, normalized.key)
      if (existing === undefined) {
        const reply = await this.mutate(
          'upsert',
          normalized,
          this.eventOptions === undefined
            ? undefined
            : makeExtensionEvent('schedule-upserted', {
                recordedAtMs: normalized.updatedAtMs,
                jobId: normalized.lastJobId,
                queue: normalized.queue,
                name: normalized.job.name,
                version: normalized.job.version,
                state: undefined,
                attempt: undefined,
                delivery: undefined,
                workerId: undefined,
                outcome: undefined,
                failureKind: undefined,
                duplicate: undefined,
                attributes: { created: 'true' }
              })
        )
        if (reply.status === 'error')
          throw new ScheduleStoreFailure({
            operation: 'upsertSchedule',
            retryable: false,
            message: `Redis schedule mutation rejected: ${reply.operation}`
          })
        return ok({ record: freezeRecord(normalized), created: true, changed: true })
      }
      if (logicalDigest(existing) === logicalDigest(normalized))
        return ok({ record: freezeRecord(existing), created: false, changed: false })
      if (existing.revision >= Number.MAX_SAFE_INTEGER)
        return definitionFailure('revision', 'cannot exceed the safe integer range')
      const updated = freezeRecord({
        ...normalized,
        revision: existing.revision + 1,
        createdAtMs: existing.createdAtMs,
        updatedAtMs: Math.max(normalized.updatedAtMs, existing.updatedAtMs)
      })
      const reply = await this.mutate(
        'upsert',
        updated,
        this.eventOptions === undefined
          ? undefined
          : makeExtensionEvent('schedule-upserted', {
              recordedAtMs: updated.updatedAtMs,
              jobId: updated.lastJobId,
              queue: updated.queue,
              name: updated.job.name,
              version: updated.job.version,
              state: undefined,
              attempt: undefined,
              delivery: undefined,
              workerId: undefined,
              outcome: undefined,
              failureKind: undefined,
              duplicate: undefined,
              attributes: { created: 'false' }
            })
      )
      if (reply.status === 'error')
        throw new ScheduleStoreFailure({
          operation: 'upsertSchedule',
          retryable: false,
          message: `Redis schedule mutation rejected: ${reply.operation}`
        })
      return ok({ record: freezeRecord(updated), created: false, changed: true })
    } catch (cause) {
      return fail('upsertSchedule', cause)
    }
  }

  async removeSchedule(selector: ScheduleSelector): Promise<Operation<boolean>> {
    try {
      const address = parseAddress(selector)
      if (Result.isError(address)) return address
      const record = await this.resolve(selector)
      if (record === undefined) return ok(false)
      const reply = await this.mutate(
        'remove',
        record,
        this.eventOptions === undefined
          ? undefined
          : makeExtensionEvent('schedule-removed', {
              recordedAtMs: record.updatedAtMs,
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
              attributes: {}
            })
      )
      if (reply.status === 'error')
        throw new ScheduleStoreFailure({
          operation: 'removeSchedule',
          retryable: false,
          message: `Redis schedule mutation rejected: ${reply.operation}`
        })
      return ok(true)
    } catch (cause) {
      return fail('removeSchedule', cause)
    }
  }

  async getSchedule(selector: ScheduleSelector): Promise<Operation<ScheduleRecord | undefined>> {
    try {
      const address = parseAddress(selector)
      if (Result.isError(address)) return address
      const record = await this.resolve(selector)
      return ok(record === undefined ? undefined : freezeRecord(record))
    } catch (cause) {
      return fail('getSchedule', cause)
    }
  }

  async listSchedules(
    options: { readonly group?: string; readonly paused?: boolean; readonly limit?: number } = {}
  ): Promise<Operation<readonly ScheduleRecord[]>> {
    try {
      if (!isObject(options)) return definitionFailure('options', 'must be an object')
      const limit = positiveLimit(options.limit, 'limit')
      if (Result.isError(limit)) return limit
      if (options.group !== undefined) {
        const group = validateText(options.group, 'group')
        if (Result.isError(group)) return group
      }
      if (options.paused !== undefined && typeof options.paused !== 'boolean')
        return definitionFailure('paused', 'must be boolean')
      const encodedGroups =
        options.group === undefined
          ? stringsReply(await this.command(['SMEMBERS', this.layout.scheduleGroups]))
          : [encodeKeySegment(options.group)]
      const records: ScheduleRecord[] = []
      for (const encodedGroup of encodedGroups) {
        const group = decodeKeySegment(encodedGroup, 'schedule group')
        const members = stringsReply(
          await this.command(['SMEMBERS', this.layout.scheduleGroup(group)])
        )
        for (const hash of members) {
          const record = await this.readHash(hash)
          if (
            record !== undefined &&
            (options.paused === undefined || record.paused === options.paused)
          )
            records.push(record)
        }
      }
      records.sort(
        (left, right) => left.group.localeCompare(right.group) || left.key.localeCompare(right.key)
      )
      return ok(Object.freeze(records.slice(0, limit.value).map(freezeRecord)))
    } catch (cause) {
      return fail('listSchedules', cause)
    }
  }

  async dueSchedules(options: {
    readonly nowMs: number
    readonly group?: string
    readonly limit?: number
  }): Promise<Operation<readonly ScheduleRecord[]>> {
    try {
      if (!isObject(options)) return definitionFailure('options', 'must be an object')
      const now = validateTimestamp(options.nowMs, 'nowMs')
      if (Result.isError(now)) return now
      const limit = positiveLimit(options.limit, 'limit')
      if (Result.isError(limit)) return limit
      if (options.group !== undefined) {
        const group = validateText(options.group, 'group')
        if (Result.isError(group)) return group
      }
      const scanLimit =
        limit.value === Number.MAX_SAFE_INTEGER
          ? MAX_DUE_SCAN
          : Math.min(MAX_DUE_SCAN, limit.value * 4)
      const members = stringsReply(
        await this.command([
          'ZRANGEBYSCORE',
          this.layout.scheduleDue,
          '-inf',
          String(now.value),
          'LIMIT',
          '0',
          String(scanLimit)
        ])
      )
      const records: ScheduleRecord[] = []
      for (const hash of members) {
        const record = await this.readHash(hash)
        if (record === undefined) {
          await this.command(['ZREM', this.layout.scheduleDue, hash]).catch(() => undefined)
          continue
        }
        if (record.paused || record.nextRunAtMs > now.value) continue
        if (options.group !== undefined && record.group !== options.group) continue
        records.push(record)
      }
      records.sort(
        (left, right) =>
          left.nextRunAtMs - right.nextRunAtMs ||
          left.group.localeCompare(right.group) ||
          left.key.localeCompare(right.key)
      )
      return ok(Object.freeze(records.slice(0, limit.value).map(freezeRecord)))
    } catch (cause) {
      return fail('dueSchedules', cause)
    }
  }

  async tickSchedule(command: TickScheduleCommand): Promise<Operation<TickScheduleResult>> {
    try {
      if (!isObject(command)) return definitionFailure('command', 'must be an object')
      if (!isObject(command.decision)) return definitionFailure('decision', 'must be an object')
      const address = parseAddress(command.key)
      if (Result.isError(address)) return address
      const current = await this.resolve(command.key)
      if (current === undefined) return Result.err(notFound(address.value))
      const expectedRevision = validateNonNegativeInteger(
        command.expectedRevision,
        'expectedRevision'
      )
      const expectedRunAtMs = validateTimestamp(command.expectedRunAtMs, 'expectedRunAtMs')
      const nowMs = validateTimestamp(command.nowMs, 'nowMs')
      if (Result.isError(expectedRevision)) return expectedRevision
      if (Result.isError(expectedRunAtMs)) return expectedRunAtMs
      if (Result.isError(nowMs)) return nowMs
      const slots = readSlots(command.decision)
      if (Result.isError(slots)) return slots
      if (
        command.decision.skippedSlots !== undefined &&
        !Array.isArray(command.decision.skippedSlots)
      )
        return definitionFailure('decision.skippedSlots', 'must be an array')
      const skippedSlots: number[] = []
      for (const slot of command.decision.skippedSlots ?? []) {
        const checked = validateTimestamp(slot, 'decision.skippedSlots')
        if (Result.isError(checked)) return checked
        skippedSlots.push(checked.value)
      }
      const nextRunAtMs = validateTimestamp(command.decision.nextRunAtMs, 'decision.nextRunAtMs')
      if (Result.isError(nextRunAtMs)) return nextRunAtMs
      if (nextRunAtMs.value <= expectedRunAtMs.value)
        return definitionFailure('decision.nextRunAtMs', 'must advance beyond expectedRunAtMs')

      const items: Record<string, unknown>[] = []
      for (const item of slots.value) {
        const occurrence = typeof item === 'number' ? { slotMs: item } : item
        const slotMs = occurrence.slotMs
        const supplied = occurrence.enqueueRequest as EnqueueRequest | undefined
        const id = makeJobId(makeScheduleOccurrenceId(current.key, slotMs))
        if (Result.isError(id))
          return definitionFailure('decision.occurrence.slotMs', id.error.message)
        const checkedJob = makeJobRecord({
          id: id.value,
          name: current.job.name,
          version: current.job.version,
          queue: current.queue,
          state: slotMs <= nowMs.value ? 'waiting' : 'delayed',
          payload: supplied?.payload ?? current.payload,
          metadata: supplied?.metadata ?? current.metadata,
          priority: supplied?.priority ?? current.priority,
          runAt: slotMs,
          orderingSequence: 0,
          attemptsMax: supplied?.attemptsMax ?? current.attemptsMax,
          attemptsMade: 0,
          attemptSequence: 0,
          deliveryCount: 0,
          stalledCount: 0,
          backoff: supplied?.backoff ?? current.backoff,
          timeoutMs: supplied?.timeoutMs ?? current.timeoutMs,
          idempotencyKey: undefined,
          createdAt: nowMs.value,
          updatedAt: nowMs.value,
          processedAt: undefined,
          finishedAt: undefined,
          leaseOwner: undefined,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          cancellationRequestedAt: undefined,
          result: undefined,
          failure: undefined
        })
        if (Result.isError(checkedJob)) return Result.err(checkedJob.error)
        const record = checkedJob.value
        const keys = jobKeys(this.layout, record)
        items.push({
          id: record.id,
          slotMs,
          record: encodeJobRecord(record),
          keys,
          newWaitingMember: keys.newWaitingMember,
          newDelayedMember: keys.newDelayedMember,
          newCreatedMember: keys.newCreatedMember,
          newRunAtMember: keys.newRunAtMember,
          newFinishedMember: keys.newFinishedMember,
          identityMember: keys.identityMember
        })
      }

      const scheduleHash = this.layout.schedule(current.group, current.key)
      const scriptKeys: TickScriptKeys = {
        schedule: scheduleHash,
        scheduleGroup: this.layout.scheduleGroup(current.group),
        scheduleGroups: this.layout.scheduleGroups,
        scheduleDue: this.layout.scheduleDue,
        all: this.layout.all,
        counts: this.layout.counts,
        wake: this.layout.wake,
        wakeChannel: this.layout.wakeChannel,
        queueControls: this.layout.queues,
        sequenceJobs: this.layout.sequenceJobs,
        created: this.layout.created,
        runAt: this.layout.runAt,
        finishedAt: this.layout.finishedAt
      }
      if (this.eventOptions !== undefined)
        Object.assign(scriptKeys, {
          events: this.layout.events,
          eventsMeta: this.layout.eventsMeta
        })
      if (current.lastJobId !== undefined)
        scriptKeys.overlapJob = this.layout.job(current.lastJobId)
      const keyList = [
        ...Object.values(scriptKeys),
        ...items.flatMap((item) =>
          Object.entries(item.keys as Record<string, unknown>)
            .filter(([name, value]) => !name.endsWith('Member') && typeof value === 'string')
            .map(([, value]) => value as string)
        )
      ]
      const reply = await this.runTickScript(
        [...new Set(keyList)],
        JSON.stringify({
          reply: 'tick-schedule',
          mode: 'tick-schedule',
          keys: scriptKeys,
          expectedRevision: String(expectedRevision.value),
          expectedRunAtMs: String(expectedRunAtMs.value),
          now: String(nowMs.value),
          nextRunAtMs: String(nextRunAtMs.value),
          skippedSlots,
          items,
          ...this.eventPayload(() =>
            makeExtensionEvent('schedule-ticked', {
              recordedAtMs: nowMs.value,
              jobId: current.lastJobId,
              queue: current.queue,
              name: current.job.name,
              version: current.job.version,
              state: undefined,
              attempt: undefined,
              delivery: undefined,
              workerId: undefined,
              outcome: undefined,
              failureKind: undefined,
              duplicate: undefined,
              attributes: { status: 'tick', jobs: '0', skipped: String(skippedSlots.length) }
            })
          )
        })
      )
      return this.decodeTickResult(reply, address.value)
    } catch (cause) {
      return fail('tickSchedule', cause)
    }
  }

  private async runTickScript(keys: readonly string[], body: string) {
    await this.prepareMutation('tickSchedule')
    const result = await runScript(this.redis.scripts, 'tick-schedule', {
      keys,
      args: [body],
      decode: (reply) => scriptReply(reply, 'tick-schedule')
    })
    if (Result.isError(result)) throw result.error
    return result.value
  }

  private decodeTickResult(
    reply: ReturnType<typeof scriptReply>,
    address: ParsedAddress
  ): Operation<TickScheduleResult> {
    if (reply.status === 'error') {
      if (reply.operation === 'MQ_NOT_FOUND') return Result.err(notFound(address))
      if (reply.operation === 'MQ_CORRUPT_SCHEDULE')
        return Result.err(
          new ScheduleStoreFailure({
            operation: 'tickSchedule',
            message: 'Redis schedule hash is corrupt'
          })
        )
      return Result.err(
        new ScheduleStoreFailure({
          operation: 'tickSchedule',
          message: `Redis tick rejected the request: ${reply.operation}`
        })
      )
    }
    if (
      reply.values.length !== 5 ||
      !['fired', 'skipped', 'stale', 'paused'].includes(String(reply.values[0]))
    )
      throw new ScheduleStoreFailure({
        operation: 'tickSchedule',
        message: 'Redis tick returned an invalid reply'
      })
    const status = reply.values[0] as TickScheduleResult['status']
    const schedule = decodeSchedule(hashReply(reply.values[1]))
    if (schedule === undefined)
      throw new ScheduleStoreFailure({
        operation: 'tickSchedule',
        message: 'Redis tick returned no schedule'
      })
    const rawJobs = readArray(reply.values[2], 'tickSchedule.jobs')
    const jobs: JobRecord[] = []
    for (const [index, value] of rawJobs.entries()) {
      const decoded = decodeJobRecord(hashReply(value))
      if (Result.isError(decoded))
        throw new ScheduleStoreFailure({
          operation: `tickSchedule.jobs.${index}`,
          message: decoded.error.message,
          cause: decoded.error
        })
      jobs.push(decoded.value)
    }
    const skipped = readArray(reply.values[3], 'tickSchedule.skippedSlots').map((value) =>
      numberReply(value, 'skippedSlot')
    )
    const lastJobId =
      typeof reply.values[4] === 'string' && reply.values[4] !== ''
        ? makeJobId(reply.values[4])
        : ok(undefined)
    if (Result.isError(lastJobId)) throw lastJobId.error
    return ok(
      Object.freeze({
        status,
        schedule: freezeRecord(schedule),
        jobs: Object.freeze(jobs),
        fired: Object.freeze(jobs),
        skippedSlots: Object.freeze(skipped),
        lastJobId: lastJobId.value
      })
    )
  }

  private async setPaused(selector: ScheduleSelector, paused: boolean): Promise<Operation<void>> {
    try {
      const address = parseAddress(selector)
      if (Result.isError(address)) return address
      const current = await this.resolve(selector)
      if (current === undefined) return Result.err(notFound(address.value))
      if (current.paused === paused) return ok(undefined)
      if (current.revision >= Number.MAX_SAFE_INTEGER)
        return definitionFailure('revision', 'cannot exceed the safe integer range')
      const updated = freezeRecord({
        ...current,
        paused,
        revision: current.revision + 1,
        updatedAtMs: current.updatedAtMs
      })
      const reply = await this.mutate(
        paused ? 'pause' : 'resume',
        updated,
        this.eventOptions === undefined
          ? undefined
          : makeExtensionEvent(paused ? 'schedule-paused' : 'schedule-resumed', {
              recordedAtMs: updated.updatedAtMs,
              jobId: updated.lastJobId,
              queue: updated.queue,
              name: updated.job.name,
              version: updated.job.version,
              state: undefined,
              attempt: undefined,
              delivery: undefined,
              workerId: undefined,
              outcome: undefined,
              failureKind: undefined,
              duplicate: undefined,
              attributes: {}
            })
      )
      if (reply.status === 'error')
        throw new ScheduleStoreFailure({
          operation: paused ? 'pauseSchedule' : 'resumeSchedule',
          retryable: false,
          message: `Redis schedule mutation rejected: ${reply.operation}`
        })
      return ok(undefined)
    } catch (cause) {
      return fail(paused ? 'pauseSchedule' : 'resumeSchedule', cause)
    }
  }

  async pauseSchedule(selector: ScheduleSelector): Promise<Operation<void>> {
    return this.setPaused(selector, true)
  }

  async resumeSchedule(selector: ScheduleSelector): Promise<Operation<void>> {
    return this.setPaused(selector, false)
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = this.redis.dispose()
    return this.disposal
  }
}

type RedisScheduleLayer<Token extends AnyJobScheduleStoreToken> = Layer<
  InstanceType<Token>,
  InstanceType<Token['jobStore']>
>

const makeLayer = <Token extends AnyJobScheduleStoreToken>(
  token: Token,
  acquire: () => Promise<RedisClient>,
  eventOptions?: RedisJobEventStoreOptions
): RedisScheduleLayer<Token> =>
  Layer.scopedGen(
    token,
    async function* () {
      yield* token.jobStore
      const client = await acquire()
      let implementation: RedisJobScheduleStoreImplementation | undefined
      try {
        await client.initialize()
        implementation = new RedisJobScheduleStoreImplementation(client, eventOptions)
        return JobScheduleStore.of(implementation as never) as unknown as ServiceContract<
          InstanceType<Token>
        >
      } catch (cause) {
        try {
          await (implementation?.dispose() ?? client.dispose())
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            'Redis JobScheduleStore acquisition cleanup failed'
          )
        }
        throw cause
      }
    },
    async (store) => {
      await (store as unknown as RedisJobScheduleStoreImplementation).dispose()
    }
  ) as RedisScheduleLayer<Token>

export const RedisJobScheduleStore: {
  readonly layer: (
    config: RedisJobStoreConfig,
    options?: RedisJobEventStoreOptions
  ) => RedisScheduleLayer<typeof JobScheduleStore>
  readonly layerFor: <Token extends AnyJobScheduleStoreToken>(
    token: Token,
    config: RedisJobStoreConfig,
    options?: RedisJobEventStoreOptions
  ) => RedisScheduleLayer<Token>
  readonly layerFromConfig: (
    config: RedisJobStoreConnectionConfig,
    options?: RedisJobEventStoreOptions
  ) => RedisScheduleLayer<typeof JobScheduleStore>
  readonly layerFromConfigFor: <Token extends AnyJobScheduleStoreToken>(
    token: Token,
    config: RedisJobStoreConnectionConfig,
    options?: RedisJobEventStoreOptions
  ) => RedisScheduleLayer<Token>
} = Object.freeze({
  layer(config: RedisJobStoreConfig, options?: RedisJobEventStoreOptions) {
    return makeLayer(JobScheduleStore, async () => RedisClient.fromClients(config), options)
  },
  layerFor<Token extends AnyJobScheduleStoreToken>(
    token: Token,
    config: RedisJobStoreConfig,
    options?: RedisJobEventStoreOptions
  ) {
    return makeLayer(
      token,
      async () =>
        RedisClient.fromClients({
          ...config,
          namespace: namespaceFor(token.jobStore, config.namespace ?? 'default')
        }),
      options
    )
  },
  layerFromConfig(config: RedisJobStoreConnectionConfig, options?: RedisJobEventStoreOptions) {
    return makeLayer(JobScheduleStore, () => RedisClient.fromConfig(config), options)
  },
  layerFromConfigFor<Token extends AnyJobScheduleStoreToken>(
    token: Token,
    config: RedisJobStoreConnectionConfig,
    options?: RedisJobEventStoreOptions
  ) {
    return makeLayer(
      token,
      () =>
        RedisClient.fromConfig({
          ...config,
          namespace: namespaceFor(token.jobStore, config.namespace ?? 'default')
        }),
      options
    )
  }
})
