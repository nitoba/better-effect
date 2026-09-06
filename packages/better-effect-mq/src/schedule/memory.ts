// oxlint-disable anti-slop/no-runtime-typeof -- the reference driver validates public DTO boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- persistence requests may come from JavaScript callers.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- metadata is copied after its values are checked.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts are confined to erased Service and store boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions restore validated protocol types.

import { Layer } from 'better-effect'
import type { ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

import { cloneJsonValue, parseJsonValue } from '../internal/json'
import {
  makeJobId,
  makeJobName,
  makePersistedBackoff,
  makeQueueName,
  validateDuration,
  validateTimestamp
} from '../protocol'
import type { JobId, JobRecord, QueueName } from '../protocol'
import type { JobStoreContract, JobStore as JobStoreNamespace } from '../store'
import {
  getMemoryJobStoreInternals,
  MemoryJobStore,
  type MemoryJobStoreInternals
} from '../store/memory'
import {
  DuplicateScheduleError,
  ScheduleDefinitionError,
  ScheduleNotFoundError,
  ScheduleStoreFailure
} from './errors'
import { JobScheduleStore } from './store'
import type {
  DueSchedulesOptions,
  JobScheduleStoreContract,
  ListSchedulesOptions,
  MisfirePolicy,
  ScheduleAddress,
  ScheduleKey,
  ScheduleOccurrence,
  ScheduleRecord,
  ScheduleSelector,
  ScheduleStoreError,
  ScheduleStoreOperation,
  ScheduleTickDecision,
  TickScheduleCommand,
  TickScheduleResult,
  UpsertScheduleResult
} from './types'
import type { AnyJobScheduleStoreToken } from './store'

type Operation<Value> = ScheduleStoreOperation<Value, ScheduleStoreError>

const ok = <Value>(value: Value): Operation<Value> =>
  Result.ok(value) as unknown as Operation<Value>

const fail = <Value>(cause: ScheduleStoreError): Operation<Value> =>
  Result.err(cause) as unknown as Operation<Value>

const descriptor = Object.freeze({
  extension: 'better-effect-mq/schedules' as const,
  extensionVersion: 1 as const,
  jobStoreProtocolVersion: 1 as const
})

const maxOccurrencesPerTick = 256

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const definitionFailure = <Value>(
  field: string,
  message: string
): ResultType<Value, ScheduleStoreError> =>
  Result.err(new ScheduleDefinitionError({ field, message }))

const validateText = (value: unknown, field: string): ResultType<string, ScheduleStoreError> => {
  if (typeof value !== 'string' || value.length === 0)
    return definitionFailure(field, 'must be non-empty')
  if (value.length > 512) return definitionFailure(field, 'must be at most 512 characters')
  return Result.ok(value)
}

const validateNonNegativeInteger = (
  value: unknown,
  field: string
): ResultType<number, ScheduleStoreError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return definitionFailure(field, 'must be a non-negative safe integer')
  }
  return Result.ok(value)
}

const validateSafeInteger = (
  value: unknown,
  field: string
): ResultType<number, ScheduleStoreError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return definitionFailure(field, 'must be a safe integer')
  }
  return Result.ok(value)
}

const validatePositiveInteger = (
  value: unknown,
  field: string
): ResultType<number, ScheduleStoreError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return definitionFailure(field, 'must be a positive safe integer')
  }
  return Result.ok(value)
}

const cloneMetadata = (
  value: unknown,
  field: string
): ResultType<Readonly<Record<string, string>>, ScheduleStoreError> => {
  if (!isObject(value)) return definitionFailure(field, 'must be an object')
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return definitionFailure(`${field}.${key}`, 'must be a string')
    output[key] = item
  }
  return Result.ok(Object.freeze(output))
}

const cloneBackoff = (backoff: ScheduleRecord['backoff']): ScheduleRecord['backoff'] => {
  if (backoff === undefined) return undefined
  return Object.freeze({ ...backoff })
}

const clonePolicy = (policy: MisfirePolicy): MisfirePolicy =>
  Object.freeze({ ...policy }) as MisfirePolicy

const cloneRecord = (record: ScheduleRecord): ScheduleRecord =>
  Object.freeze({
    ...record,
    job: Object.freeze({ ...record.job }),
    payload: cloneJsonValue(record.payload),
    metadata: Object.freeze({ ...record.metadata }),
    backoff: cloneBackoff(record.backoff),
    misfire: clonePolicy(record.misfire)
  })

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

const mapKey = (group: string, key: string): string => JSON.stringify([group, key])

type ParsedAddress = { readonly group: string | undefined; readonly key: ScheduleKey }

const address = (selector: ScheduleSelector): ResultType<ParsedAddress, ScheduleStoreError> => {
  if (typeof selector === 'string') {
    const key = validateText(selector, 'key')
    if (Result.isError(key)) return key
    return Result.ok({ key: key.value, group: undefined })
  }
  if (!isObject(selector)) return definitionFailure('key', 'must be a key or address')
  const key = validateText(selector.key, 'key')
  const group = validateText(selector.group, 'group')
  if (Result.isError(key)) return key
  if (Result.isError(group)) return group
  return Result.ok({ key: key.value, group: group.value })
}

const cronIsValid = (value: string): boolean => {
  const fields = value.trim().split(/\s+/u)
  return fields.length === 5 && fields.every((field) => /^[0-9*/?,-]+$/u.test(field))
}

const validateTimeZone = (value: string): ResultType<string, ScheduleStoreError> => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return Result.ok(value)
  } catch {
    return definitionFailure('timeZone', 'must be a valid IANA time zone')
  }
}

const normalizePolicy = (value: unknown): ResultType<MisfirePolicy, ScheduleStoreError> => {
  if (
    !isObject(value) ||
    (value.strategy !== 'skip' && value.strategy !== 'run-once' && value.strategy !== 'catch-up')
  ) {
    return definitionFailure('misfire', 'has an unsupported strategy')
  }
  if (value.strategy === 'catch-up') {
    const maximum = validatePositiveInteger(value.maxOccurrences, 'misfire.maxOccurrences')
    if (Result.isError(maximum)) return maximum
    return Result.ok(Object.freeze({ strategy: 'catch-up', maxOccurrences: maximum.value }))
  }
  return Result.ok(Object.freeze({ strategy: value.strategy }))
}

const normalizeRecord = (value: unknown): ResultType<ScheduleRecord, ScheduleStoreError> => {
  if (!isObject(value)) return definitionFailure('record', 'must be an object')
  const key = validateText(value.key, 'key')
  const group = validateText(value.group, 'group')
  const queue = makeQueueName(value.queue)
  const jobValue = value.job
  if (!isObject(jobValue)) return definitionFailure('job', 'must be an object')
  const jobQueue = makeQueueName(jobValue.queue)
  const jobName = makeJobName(jobValue.name)
  const jobVersion = validatePositiveInteger(jobValue.version, 'job.version')
  const payload = parseJsonValue(value.payload, 'payload')
  const metadata = cloneMetadata(value.metadata, 'metadata')
  const priority = validateSafeInteger(value.priority, 'priority')
  const attemptsMax = validatePositiveInteger(value.attemptsMax, 'attemptsMax')
  const timeout =
    value.timeoutMs === undefined
      ? Result.ok<number | undefined>(undefined)
      : validateDuration(value.timeoutMs, 'timeoutMs')
  const backoff =
    value.backoff === undefined
      ? Result.ok<ScheduleRecord['backoff']>(undefined)
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
      ? Result.ok<JobId | undefined>(undefined)
      : makeJobId(value.lastJobId)
  const timeZoneInput = value.timeZone
  if (timeZoneInput !== undefined && typeof timeZoneInput !== 'string') {
    return definitionFailure('timeZone', 'must be a string')
  }
  const timeZone =
    timeZoneInput === undefined
      ? Result.ok<string | undefined>(undefined)
      : validateTimeZone(timeZoneInput)
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

  if (jobQueue.value !== queue.value) return definitionFailure('job.queue', 'must match queue')
  const cron = value.cron
  const everyMs = value.everyMs
  if (typeof cron !== 'string' && cron !== undefined)
    return definitionFailure('cron', 'must be a string')
  if (typeof everyMs !== 'number' && everyMs !== undefined)
    return definitionFailure('everyMs', 'must be a number')
  if ((cron === undefined) === (everyMs === undefined)) {
    return definitionFailure('cadence', 'must provide exactly one of cron or everyMs')
  }
  if (cron !== undefined && !cronIsValid(cron))
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

  const identity = Object.freeze({
    queue: jobQueue.value,
    name: jobName.value,
    version: jobVersion.value
  })
  return Result.ok(
    Object.freeze({
      key: key.value,
      group: group.value,
      job: identity,
      queue: queue.value as QueueName,
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

const deterministicJobId = (record: ScheduleRecord, slotMs: number): JobId =>
  makeJobId(`sched/${encodeURIComponent(record.key)}/${slotMs}`).unwrap()

const scheduleResult = (
  status: TickScheduleResult['status'],
  schedule: ScheduleRecord,
  jobs: readonly JobRecord[],
  skippedSlots: readonly number[]
): TickScheduleResult =>
  Object.freeze({
    status,
    schedule: cloneRecord(schedule),
    jobs: Object.freeze(jobs.map((job) => Object.freeze(job))),
    fired: Object.freeze(jobs.map((job) => Object.freeze(job))),
    skippedSlots: Object.freeze([...skippedSlots]),
    lastJobId: jobs.at(-1)?.id ?? schedule.lastJobId
  })

const readSlots = (
  decision: ScheduleTickDecision
): ResultType<readonly ScheduleOccurrence[], ScheduleStoreError> => {
  const source = decision.occurrences ?? decision.occurrenceSlots
  if (source !== undefined && decision.enqueueRequests !== undefined) {
    return definitionFailure('decision', 'must not provide both occurrences and enqueueRequests')
  }
  if (decision.enqueueRequests !== undefined) {
    if (!Array.isArray(decision.enqueueRequests))
      return definitionFailure('decision.enqueueRequests', 'must be an array')
    if (decision.enqueueRequests.length > maxOccurrencesPerTick) {
      return definitionFailure(
        'decision.enqueueRequests',
        `must contain at most ${maxOccurrencesPerTick} items`
      )
    }
    return Result.ok(
      decision.enqueueRequests.map((request) => ({
        slotMs: request.runAt,
        enqueueRequest: request
      }))
    )
  }
  if (source === undefined) return definitionFailure('decision.occurrences', 'is required')
  if (!Array.isArray(source)) return definitionFailure('decision.occurrences', 'must be an array')
  if (source.length > maxOccurrencesPerTick)
    return definitionFailure(
      'decision.occurrences',
      `must contain at most ${maxOccurrencesPerTick} items`
    )
  const checked: ScheduleOccurrence[] = []
  for (const item of source) {
    if (typeof item !== 'number' && !isObject(item)) {
      return definitionFailure('decision.occurrence', 'must be a slot or object')
    }
    const slotMs = typeof item === 'number' ? item : item.slotMs
    const slot = validateTimestamp(slotMs, 'decision.occurrence.slotMs')
    if (Result.isError(slot)) return slot
    // SAFETY: the public union was narrowed to an object and its required slot was validated above.
    checked.push(item as ScheduleOccurrence)
  }
  return Result.ok(Object.freeze(checked))
}

class MemoryJobScheduleStoreImplementation implements JobScheduleStoreContract {
  readonly descriptor = descriptor

  private readonly schedules = new Map<string, ScheduleRecord>()
  private readonly memoryJobStore: MemoryJobStoreInternals | undefined
  private critical = false

  constructor(jobStore: JobStoreContract) {
    this.memoryJobStore = getMemoryJobStoreInternals(jobStore)
    if (this.memoryJobStore === undefined) {
      throw new TypeError('MemoryJobScheduleStore requires a MemoryJobStore instance')
    }
  }

  upsertSchedule(value: ScheduleRecord): Operation<UpsertScheduleResult> {
    return this.runCritical(() => this.upsertScheduleUnsafe(value))
  }

  private upsertScheduleUnsafe(value: ScheduleRecord): Operation<UpsertScheduleResult> {
    const checked = normalizeRecord(value)
    if (Result.isError(checked)) return fail(checked.error)
    const normalized = checked.value
    const existing = this.schedules.get(mapKey(normalized.group, normalized.key))
    if (existing === undefined) {
      const snapshot = cloneRecord(normalized)
      this.schedules.set(mapKey(snapshot.group, snapshot.key), snapshot)
      return ok({ record: cloneRecord(snapshot), created: true, changed: true })
    }
    if (logicalDigest(existing) === logicalDigest(normalized)) {
      return ok({ record: cloneRecord(existing), created: false, changed: false })
    }
    if (existing.revision >= Number.MAX_SAFE_INTEGER) {
      return fail(
        new ScheduleDefinitionError({
          field: 'revision',
          message: 'cannot exceed the safe integer range'
        })
      )
    }
    const updated = cloneRecord({
      ...normalized,
      revision: existing.revision + 1,
      createdAtMs: existing.createdAtMs,
      updatedAtMs: Math.max(normalized.updatedAtMs, existing.updatedAtMs)
    })
    this.schedules.set(mapKey(updated.group, updated.key), updated)
    return ok({ record: cloneRecord(updated), created: false, changed: true })
  }

  removeSchedule(selector: ScheduleSelector): Operation<boolean> {
    return this.runCritical(() => {
      const resolved = this.resolve(selector)
      if (Result.isError(resolved)) return fail(resolved.error)
      if (resolved.value === undefined) return ok(false)
      this.schedules.delete(mapKey(resolved.value.group, resolved.value.key))
      return ok(true)
    })
  }

  getSchedule(selector: ScheduleSelector): Operation<ScheduleRecord | undefined> {
    const resolved = this.resolve(selector)
    if (Result.isError(resolved)) return fail(resolved.error)
    const record = resolved.value === undefined ? undefined : this.resolveAddress(resolved.value)
    return ok(record === undefined ? undefined : cloneRecord(record))
  }

  listSchedules(options: ListSchedulesOptions = {}): Operation<readonly ScheduleRecord[]> {
    if (!isObject(options))
      return fail(new ScheduleDefinitionError({ field: 'options', message: 'must be an object' }))
    const limit = options.limit === undefined ? Number.MAX_SAFE_INTEGER : options.limit
    const checkedLimit = validatePositiveInteger(limit, 'limit')
    if (Result.isError(checkedLimit)) return fail(checkedLimit.error)
    if (options.group !== undefined) {
      const group = validateText(options.group, 'group')
      if (Result.isError(group)) return fail(group.error)
    }
    if (options.paused !== undefined && typeof options.paused !== 'boolean')
      return fail(new ScheduleDefinitionError({ field: 'paused', message: 'must be boolean' }))
    const records = [...this.schedules.values()]
      .filter((record) => options.group === undefined || record.group === options.group)
      .filter((record) => options.paused === undefined || record.paused === options.paused)
      .sort(
        (left, right) => left.group.localeCompare(right.group) || left.key.localeCompare(right.key)
      )
      .slice(0, checkedLimit.value)
      .map(cloneRecord)
    return ok(Object.freeze(records))
  }

  dueSchedules(options: DueSchedulesOptions): Operation<readonly ScheduleRecord[]> {
    if (!isObject(options))
      return fail(new ScheduleDefinitionError({ field: 'options', message: 'must be an object' }))
    const now = validateTimestamp(options?.nowMs, 'nowMs')
    if (Result.isError(now)) return fail(now.error)
    const limit =
      options.limit === undefined
        ? Result.ok<number, ScheduleStoreError>(Number.MAX_SAFE_INTEGER)
        : validatePositiveInteger(options.limit, 'limit')
    if (Result.isError(limit)) return fail(limit.error)
    if (options.group !== undefined) {
      const group = validateText(options.group, 'group')
      if (Result.isError(group)) return fail(group.error)
    }
    const records = [...this.schedules.values()]
      .filter((record) => !record.paused && record.nextRunAtMs <= now.value)
      .filter((record) => options.group === undefined || record.group === options.group)
      .sort(
        (left, right) =>
          left.nextRunAtMs - right.nextRunAtMs ||
          left.group.localeCompare(right.group) ||
          left.key.localeCompare(right.key)
      )
      .slice(0, limit.value)
      .map(cloneRecord)
    return ok(Object.freeze(records))
  }

  tickSchedule(command: TickScheduleCommand): Operation<TickScheduleResult> {
    if (!isObject(command))
      return fail(new ScheduleDefinitionError({ field: 'command', message: 'must be an object' }))
    if (!isObject(command.decision))
      return fail(new ScheduleDefinitionError({ field: 'decision', message: 'must be an object' }))
    const resolved = this.resolve(command.key)
    if (Result.isError(resolved)) return fail(resolved.error)
    if (resolved.value === undefined) {
      const parsed = address(command.key)
      if (Result.isError(parsed)) return fail(parsed.error)
      return fail(
        parsed.value.group === undefined
          ? new ScheduleNotFoundError({ key: parsed.value.key })
          : new ScheduleNotFoundError({ key: parsed.value.key, group: parsed.value.group })
      )
    }
    const revision = validateNonNegativeInteger(command.expectedRevision, 'expectedRevision')
    const expectedRunAt = validateTimestamp(command.expectedRunAtMs, 'expectedRunAtMs')
    const now = validateTimestamp(command.nowMs, 'nowMs')
    if (Result.isError(revision)) return fail(revision.error)
    if (Result.isError(expectedRunAt)) return fail(expectedRunAt.error)
    if (Result.isError(now)) return fail(now.error)
    const slots = readSlots(command.decision)
    if (Result.isError(slots)) return fail(slots.error)
    const requestedSkippedSlots = command.decision.skippedSlots
    if (requestedSkippedSlots !== undefined && !Array.isArray(requestedSkippedSlots))
      return fail(
        new ScheduleDefinitionError({
          field: 'decision.skippedSlots',
          message: 'must be an array'
        })
      )
    for (const slotMs of requestedSkippedSlots ?? []) {
      const slot = validateTimestamp(slotMs, 'decision.skippedSlots')
      if (Result.isError(slot)) return fail(slot.error)
    }
    const nextRunAt = validateTimestamp(command.decision.nextRunAtMs, 'decision.nextRunAtMs')
    if (Result.isError(nextRunAt)) return fail(nextRunAt.error)
    if (nextRunAt.value <= expectedRunAt.value)
      return fail(
        new ScheduleDefinitionError({
          field: 'decision.nextRunAtMs',
          message: 'must advance beyond expectedRunAtMs'
        })
      )

    return this.runCritical(() => {
      const current = this.resolveAddress(resolved.value!)
      if (current === undefined)
        return fail<TickScheduleResult>(new ScheduleNotFoundError(resolved.value!))
      if (current.paused) return ok(scheduleResult('paused', current, [], []))
      if (current.revision !== revision.value || current.nextRunAtMs !== expectedRunAt.value) {
        return ok(scheduleResult('stale', current, [], []))
      }

      const skippedSlots = [...(requestedSkippedSlots ?? [])]
      const overlap = current.overlap === 'skip' && this.hasActiveOverlap(current.lastJobId)
      const effectiveSlots = overlap ? [] : slots.value
      if (overlap)
        skippedSlots.push(
          ...slots.value.map((item) => (typeof item === 'number' ? item : item.slotMs))
        )

      const requests = effectiveSlots.map((item) => {
        const occurrence = typeof item === 'number' ? { slotMs: item } : item
        const supplied = occurrence.enqueueRequest
        const id = deterministicJobId(current, occurrence.slotMs)
        return {
          ...(supplied ?? {
            payload: current.payload,
            metadata: current.metadata,
            priority: current.priority,
            runAt: occurrence.slotMs,
            attemptsMax: current.attemptsMax,
            backoff: current.backoff,
            timeoutMs: current.timeoutMs,
            now: now.value,
            job: current.job
          }),
          id,
          now: now.value,
          runAt: occurrence.slotMs,
          job: current.job
        } as JobStoreNamespace.EnqueueRequest
      })

      const enqueued = this.memoryJobStore!.enqueueManyWithinCritical(requests)
      if (Result.isError(enqueued)) return fail(enqueued.error)
      const jobs = enqueued.value.map((item) => item.job)
      const updated: ScheduleRecord = cloneRecord({
        ...current,
        revision: current.revision + 1,
        nextRunAtMs: nextRunAt.value,
        lastScheduledAtMs:
          jobs.length > 0
            ? Math.max(...requests.map((request) => request.runAt))
            : current.lastScheduledAtMs,
        lastJobId: jobs.at(-1)?.id ?? current.lastJobId,
        updatedAtMs: now.value
      })
      this.schedules.set(mapKey(updated.group, updated.key), updated)
      return ok(scheduleResult(jobs.length > 0 ? 'fired' : 'skipped', updated, jobs, skippedSlots))
    })
  }

  pauseSchedule(selector: ScheduleSelector): Operation<void> {
    return this.setPaused(selector, true)
  }

  resumeSchedule(selector: ScheduleSelector): Operation<void> {
    return this.setPaused(selector, false)
  }

  private setPaused(selector: ScheduleSelector, paused: boolean): Operation<void> {
    const resolved = this.resolve(selector)
    if (Result.isError(resolved)) return fail(resolved.error)
    if (resolved.value === undefined) {
      const parsed = address(selector)
      if (Result.isError(parsed)) return fail(parsed.error)
      return fail(
        parsed.value.group === undefined
          ? new ScheduleNotFoundError({ key: parsed.value.key })
          : new ScheduleNotFoundError({ key: parsed.value.key, group: parsed.value.group })
      )
    }
    return this.runCritical(() => {
      const current = this.resolveAddress(resolved.value!)!
      if (current.paused === paused) return ok(undefined)
      const updated = cloneRecord({
        ...current,
        paused,
        revision: current.revision + 1,
        updatedAtMs: current.updatedAtMs
      })
      this.schedules.set(mapKey(updated.group, updated.key), updated)
      return ok(undefined)
    })
  }

  private resolve(
    selector: ScheduleSelector
  ): ResultType<ScheduleAddress | undefined, ScheduleStoreError> {
    const parsed = address(selector)
    if (Result.isError(parsed)) return parsed
    if (parsed.value.group !== undefined) {
      return Result.ok(
        this.schedules.has(mapKey(parsed.value.group, parsed.value.key))
          ? { group: parsed.value.group, key: parsed.value.key }
          : undefined
      )
    }
    const matches = [...this.schedules.values()].filter((item) => item.key === parsed.value.key)
    if (matches.length > 1)
      return Result.err(
        new DuplicateScheduleError({
          group: '*',
          key: parsed.value.key,
          message: `Schedule key "${parsed.value.key}" is ambiguous`
        })
      )
    const match = matches[0]
    return Result.ok(match === undefined ? undefined : { group: match.group, key: match.key })
  }

  private resolveAddress(value: ScheduleAddress): ScheduleRecord | undefined {
    return this.schedules.get(mapKey(value.group, value.key))
  }

  private hasActiveOverlap(jobId: JobId | undefined): boolean {
    if (jobId === undefined) return false
    const result = this.memoryJobStore!.getJobWithinCritical(jobId)
    if (Result.isError(result) || result.value === undefined) return false
    return (
      result.value.state === 'waiting' ||
      result.value.state === 'delayed' ||
      result.value.state === 'active'
    )
  }

  private runCritical<Value>(callback: () => Operation<Value>): Operation<Value> {
    if (this.critical)
      return fail(
        new ScheduleStoreFailure({
          operation: 'critical-section',
          message: 'schedule mutation re-entered'
        })
      )
    this.critical = true
    try {
      return this.memoryJobStore!.runCriticalSection(callback)
    } catch (cause) {
      return fail(
        new ScheduleStoreFailure({
          operation: 'critical-section',
          message: 'schedule mutation failed',
          cause
        })
      )
    } finally {
      this.critical = false
    }
  }
}

export interface MemoryJobScheduleStoreOptions {
  readonly jobStore?: JobStoreContract
}

export type MemoryJobScheduleStoreLayerOptions = Omit<MemoryJobScheduleStoreOptions, 'jobStore'>

const makeMemoryScheduleStore = (jobStore: JobStoreContract): JobScheduleStoreContract =>
  JobScheduleStore.of(new MemoryJobScheduleStoreImplementation(jobStore) as never)

type MemoryScheduleLayer<Token extends AnyJobScheduleStoreToken> = Layer<
  InstanceType<Token>,
  InstanceType<Token['jobStore']>
>

const makeMemoryLayer = <Token extends AnyJobScheduleStoreToken>(
  token: Token,
  _options?: MemoryJobScheduleStoreLayerOptions
): MemoryScheduleLayer<Token> =>
  Layer.gen(token, function* () {
    const jobStore = yield* token.jobStore
    return makeMemoryScheduleStore(jobStore) as unknown as ServiceContract<InstanceType<Token>>
  }) as MemoryScheduleLayer<Token>

export const MemoryJobScheduleStore: {
  readonly layer: MemoryScheduleLayer<typeof JobScheduleStore>
  readonly layerWith: (
    options?: MemoryJobScheduleStoreLayerOptions
  ) => MemoryScheduleLayer<typeof JobScheduleStore>
  readonly layerFor: <Token extends AnyJobScheduleStoreToken>(
    token: Token,
    options?: MemoryJobScheduleStoreLayerOptions
  ) => MemoryScheduleLayer<Token>
  readonly make: (options?: MemoryJobScheduleStoreOptions) => JobScheduleStoreContract
} = Object.freeze({
  layer: makeMemoryLayer(JobScheduleStore),
  layerWith(_options?: MemoryJobScheduleStoreLayerOptions) {
    return makeMemoryLayer(JobScheduleStore)
  },
  layerFor<Token extends import('./store').AnyJobScheduleStoreToken>(
    token: Token,
    _options?: MemoryJobScheduleStoreLayerOptions
  ) {
    return makeMemoryLayer(token)
  },
  make(options: MemoryJobScheduleStoreOptions = {}) {
    return makeMemoryScheduleStore(options.jobStore ?? MemoryJobStore.make())
  }
})
