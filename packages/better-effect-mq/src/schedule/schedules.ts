// oxlint-disable anti-slop/no-runtime-typeof -- schedule definitions validate untyped public input.
// oxlint-disable anti-slop/no-unknown-parameters -- schedule factories are runtime trust boundaries.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- field maps are created only after strict key checks.
// oxlint-disable anti-slop/no-unknown-returns -- dynamic option readers return values after validation.
// oxlint-disable anti-slop/no-reflect-get -- the private schedule marker is declaration-only.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions follow boundary checks.

import { Result, UnhandledException } from 'better-result'
import type { Err, Result as ResultType } from 'better-result'

import { Clock, CurrentAbortSignal } from 'better-effect/standard-services'
import type { ServiceRequirement } from 'better-effect'

import { normalizeMetadata } from '../job'
import type {
  AnyJobDefinition,
  Job,
  JobDefaults,
  JobDefaultsInput,
  JobDefinition,
  JobIdentity
} from '../job'
import { isJobStoreToken } from '../store'
import type { AnyJobStoreToken } from '../store'
import { JobScheduleStore } from './store'
import type { JobScheduleStoreInstance } from './store'
import { ScheduleDefinitionError } from './errors'
import type {
  ScheduleAddress,
  ScheduleReconcileError,
  ScheduleReconcileOptions,
  ScheduleReconcileReport,
  ScheduleStoreOperation,
  ScheduleStoreError,
  ScheduleRecord,
  JobScheduleStoreContract
} from './types'
import { JobDefinitionError } from '../protocol'
import type { PersistedBackoff } from '../protocol'
import { normalizeRetryPolicy } from '../retry'
import type { RetryPolicy } from '../retry'
import { isValidTimeZone, nextCronOccurrence, normalizeTimeZone, parseCron } from './cron'
import { firstEveryMsOccurrence, makeEveryMs, nextEveryMsOccurrence } from './every-ms'
import { makeScheduleOccurrenceId, validateScheduleIdentityPart } from './identity'

type NonEmptyString<Value extends string> = string extends Value
  ? Value
  : Value extends ''
    ? never
    : Value

type PayloadFor<Definition extends AnyJobDefinition> = [Job.Payload<Definition>] extends [never]
  ? unknown
  : Job.Payload<Definition>

export type MisfirePolicy =
  | { readonly strategy: 'skip' }
  | { readonly strategy: 'run-once' }
  | { readonly strategy: 'catch-up'; readonly maxOccurrences: number }

export type OverlapPolicy = 'allow' | 'skip'

export type ScheduleDefaultsInput = JobDefaultsInput

type ScheduleCommonOptions<Definition extends AnyJobDefinition> = {
  readonly timeZone?: string
  readonly payload: PayloadFor<Definition>
  readonly metadata?: Readonly<Record<string, string>>
  readonly defaults?: ScheduleDefaultsInput
  readonly attempts?: number
  readonly backoff?: PersistedBackoff | RetryPolicy
  readonly timeoutMs?: number
  readonly priority?: number
  readonly misfire?: MisfirePolicy
  readonly overlap?: OverlapPolicy
}

export type JobScheduleOptions<Definition extends AnyJobDefinition> =
  | (ScheduleCommonOptions<Definition> & {
      readonly cron: string
      readonly everyMs?: never
    })
  | (ScheduleCommonOptions<Definition> & {
      readonly cron?: never
      readonly everyMs: number
    })

type ScheduleCore<Definition extends AnyJobDefinition, Key extends string> = {
  readonly key: Key
  readonly job: Definition
  readonly strategy: 'cron' | 'everyMs'
  readonly cron: string | undefined
  readonly everyMs: number | undefined
  readonly timeZone: string
  readonly payload: PayloadFor<Definition>
  readonly metadata: Readonly<Record<string, string>>
  readonly defaults: JobDefaults
  readonly misfire: MisfirePolicy
  readonly overlap: OverlapPolicy
}

export type JobScheduleDraft<
  Definition extends AnyJobDefinition = AnyJobDefinition,
  Key extends string = string
> = ScheduleCore<Definition, Key> & {
  readonly _scheduleDraft: true
}

export type ScheduleIdentity<
  Definition extends AnyJobDefinition = AnyJobDefinition,
  Key extends string = string,
  Group extends string = string
> = {
  readonly group: Group
  readonly key: Key
  readonly job: JobIdentity<Job.Queue<Definition>, Job.Name<Definition>, Job.Version<Definition>>
}

export type JobSchedule<
  Definition extends AnyJobDefinition = AnyJobDefinition,
  Key extends string = string,
  Group extends string = string
> = ScheduleCore<Definition, Key> & {
  readonly group: Group
  readonly identity: ScheduleIdentity<Definition, Key, Group>
}

export type AnyJobScheduleDraft = JobScheduleDraft<AnyJobDefinition, string>
export type AnyJobSchedule = JobSchedule<AnyJobDefinition, string, string>
export type AnyJobScheduleLike = AnyJobScheduleDraft | AnyJobSchedule

export type JobSchedulesDefinition<
  Group extends string = string,
  Drafts extends readonly AnyJobScheduleDraft[] = readonly AnyJobScheduleDraft[],
  Stores extends readonly AnyJobStoreToken[] = readonly []
> = {
  readonly group: Group
  readonly schedules: Readonly<{
    [Index in keyof Drafts]: Drafts[Index] extends JobScheduleDraft<infer Definition, infer Key>
      ? JobSchedule<Definition, Key, Group>
      : never
  }>
  readonly stores: Stores
}

export type AnyJobSchedulesDefinition = JobSchedulesDefinition<
  string,
  readonly AnyJobScheduleDraft[],
  readonly AnyJobStoreToken[]
>

type JobStoresForDefinition<Definition extends AnyJobSchedulesDefinition> =
  Definition['schedules'] extends readonly []
    ? never
    : Definition['schedules'][number] extends JobSchedule<infer JobDefinition, string, string>
      ? Job.StoreToken<JobDefinition>
      : never

export type JobSchedulesStoreTokens<Definition extends AnyJobSchedulesDefinition> =
  | Definition['stores'][number]
  | JobStoresForDefinition<Definition>

type ReconcileStoreInstances<Stores extends AnyJobStoreToken> = Stores extends AnyJobStoreToken
  ? JobScheduleStoreInstance<Stores>
  : never

type ReconcileRequirements<Definition extends AnyJobSchedulesDefinition> =
  | InstanceType<typeof Clock>
  | ReconcileStoreInstances<JobSchedulesStoreTokens<Definition>>

type ReconcileYield<Definition extends AnyJobSchedulesDefinition> =
  | ServiceRequirement<ReconcileRequirements<Definition>>
  | Err<never, ScheduleReconcileError>

export type JobSchedulesReconcileGenerator<Definition extends AnyJobSchedulesDefinition> =
  AsyncGenerator<ReconcileYield<Definition>, ScheduleReconcileReport, unknown>

const scheduleTypeId = Symbol('better-effect-mq/schedule')

type ScheduleFields = {
  readonly [key: string]: unknown
}

const invalid = (field: string, message: string): never => {
  throw new JobDefinitionError({ field, message })
}

const isPlainObject = (value: unknown): value is object => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const readFields = (
  value: unknown,
  allowedFields: readonly string[],
  field: string
): ScheduleFields => {
  if (!isPlainObject(value)) {
    return invalid(field, 'must be a plain object')
  }

  const allowed = new Set(allowedFields)
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      return invalid(field, 'contains unsupported fields')
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (descriptor === undefined || !('value' in descriptor)) {
      return invalid(field, 'contains an accessor field')
    }

    fields[key] = descriptor.value
  }

  return Object.freeze(fields)
}

const hasField = (fields: ScheduleFields, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(fields, field)

const field = (fields: ScheduleFields, name: string): unknown => fields[name]

const checkedInteger = (value: unknown, fieldName: string, minimum: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    return invalid(fieldName, `must be a safe integer greater than or equal to ${minimum}`)
  }

  return value
}

const normalizeDefaults = (options: ScheduleFields): JobDefaults => {
  const nested =
    hasField(options, 'defaults') && field(options, 'defaults') !== undefined
      ? readFields(options.defaults, ['attempts', 'backoff', 'timeoutMs', 'priority'], 'defaults')
      : Object.freeze(Object.create(null) as ScheduleFields)

  const get = (name: string): unknown => {
    const topLevel = hasField(options, name)
    const nestedValue = hasField(nested, name)

    if (topLevel && nestedValue) {
      return invalid(name, 'must be provided either at the top level or inside defaults')
    }

    return topLevel ? field(options, name) : field(nested, name)
  }

  const attemptsValue = get('attempts')
  const attempts = attemptsValue === undefined ? 1 : checkedInteger(attemptsValue, 'attempts', 1)
  const timeoutValue = get('timeoutMs')
  let timeoutMs: number | undefined

  if (timeoutValue !== undefined) {
    timeoutMs = checkedInteger(timeoutValue, 'timeoutMs', 1)
  }

  const priorityValue = get('priority')
  const priority =
    priorityValue === undefined
      ? 0
      : checkedInteger(priorityValue, 'priority', -Number.MAX_SAFE_INTEGER)
  const backoffValue = get('backoff')
  let backoff: PersistedBackoff | undefined

  if (backoffValue !== undefined) {
    const policy = normalizeRetryPolicy(backoffValue)

    if (Result.isError(policy)) {
      throw policy.error
    }

    if (
      policy.value !== undefined &&
      policy.value.type !== 'custom' &&
      policy.value.type !== 'never'
    ) {
      backoff = policy.value.backoff

      if (policy.value.maxAttempts !== undefined && attemptsValue === undefined) {
        return Object.freeze({ attempts: policy.value.maxAttempts, backoff, timeoutMs, priority })
      }

      if (policy.value.maxAttempts !== undefined && policy.value.maxAttempts !== attempts) {
        return invalid('backoff.maxAttempts', 'must match attempts')
      }
    }
  }

  return Object.freeze({ attempts, backoff, timeoutMs, priority })
}

const normalizeMisfire = (value: unknown): MisfirePolicy => {
  if (value === undefined) {
    return Object.freeze({ strategy: 'run-once' })
  }

  const fields = readFields(value, ['strategy', 'maxOccurrences'], 'misfire')
  const strategy = field(fields, 'strategy')

  if (strategy === 'skip' || strategy === 'run-once') {
    if (hasField(fields, 'maxOccurrences')) {
      return invalid('misfire.maxOccurrences', 'is only valid for catch-up')
    }

    return Object.freeze({ strategy })
  }

  if (strategy === 'catch-up') {
    const maxOccurrences = checkedInteger(
      field(fields, 'maxOccurrences'),
      'misfire.maxOccurrences',
      1
    )
    return Object.freeze({ strategy, maxOccurrences })
  }

  return invalid('misfire.strategy', 'must be skip, run-once or catch-up')
}

const normalizeMetadataSnapshot = (value: unknown): Readonly<Record<string, string>> => {
  if (value === undefined) {
    return Object.freeze({})
  }

  const metadata = normalizeMetadata(value)

  if (Result.isError(metadata)) {
    throw metadata.error
  }

  return metadata.value
}

const isScheduleDraft = (value: unknown): value is AnyJobScheduleDraft => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  return Reflect.get(value, scheduleTypeId) === true && Object.isFrozen(value)
}

const makeSchedule = <const Definition extends AnyJobDefinition, const Key extends string>(
  job: Definition,
  key: NonEmptyString<Key>,
  options: JobScheduleOptions<Definition>
): JobScheduleDraft<Definition, Key> => {
  const checkedKey = validateScheduleIdentityPart(key, 'key') as Key
  const fields = readFields(
    options,
    [
      'cron',
      'everyMs',
      'timeZone',
      'payload',
      'metadata',
      'defaults',
      'attempts',
      'backoff',
      'timeoutMs',
      'priority',
      'misfire',
      'overlap'
    ],
    'options'
  )

  if (!hasField(fields, 'payload')) {
    return invalid('payload', 'is required')
  }

  const hasCron = field(fields, 'cron') !== undefined
  const hasEveryMs = field(fields, 'everyMs') !== undefined

  if (hasCron === hasEveryMs) {
    return invalid('strategy', 'must provide exactly one of cron or everyMs')
  }

  let cron: string | undefined
  let everyMs: number | undefined
  let strategy: 'cron' | 'everyMs'

  if (hasCron) {
    if (typeof field(fields, 'cron') !== 'string') {
      return invalid('cron', 'must be a five-field expression')
    }

    cron = field(fields, 'cron') as string
    parseCron(cron)
    strategy = 'cron'
  } else {
    everyMs = makeEveryMs(field(fields, 'everyMs'))
    strategy = 'everyMs'
  }

  const timeZoneValue = field(fields, 'timeZone')

  if (timeZoneValue !== undefined && !isValidTimeZone(timeZoneValue)) {
    return invalid('timeZone', 'must be a valid IANA timezone')
  }

  const descriptor = {
    key: checkedKey,
    job,
    strategy,
    cron,
    everyMs,
    timeZone: normalizeTimeZone(timeZoneValue),
    payload: field(fields, 'payload') as Job.Payload<Definition>,
    metadata: normalizeMetadataSnapshot(field(fields, 'metadata')),
    defaults: normalizeDefaults(fields),
    misfire: normalizeMisfire(field(fields, 'misfire')),
    overlap: field(fields, 'overlap') === undefined ? 'allow' : field(fields, 'overlap')
  }

  if (descriptor.overlap !== 'allow' && descriptor.overlap !== 'skip') {
    return invalid('overlap', 'must be allow or skip')
  }

  Object.defineProperty(descriptor, scheduleTypeId, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  })

  return Object.freeze(descriptor) as JobScheduleDraft<Definition, Key>
}

const defineSchedules = <
  const Group extends string,
  const Drafts extends readonly AnyJobScheduleDraft[],
  const Stores extends readonly AnyJobStoreToken[] = readonly []
>(options: {
  readonly group: NonEmptyString<Group>
  readonly schedules: Drafts
  readonly stores?: Stores
}): JobSchedulesDefinition<Group, Drafts, Stores> => {
  const fields = readFields(options, ['group', 'schedules', 'stores'], 'definitions')
  const group = validateScheduleIdentityPart(field(fields, 'group'), 'group') as Group
  const schedulesValue = field(fields, 'schedules')

  if (!Array.isArray(schedulesValue)) {
    return invalid('schedules', 'must be an array')
  }

  const keys = new Set<string>()
  const schedules = schedulesValue.map((draft) => {
    if (!isScheduleDraft(draft)) {
      return invalid('schedules', 'must contain JobSchedules.schedule definitions')
    }

    if (keys.has(draft.key)) {
      return invalid('schedules', `contains duplicate key "${draft.key}"`)
    }

    keys.add(draft.key)
    const identity = Object.freeze({ group, key: draft.key, job: draft.job.identity })

    return Object.freeze({ ...draft, group, identity }) as AnyJobSchedule
  }) as JobSchedulesDefinition<Group, Drafts, Stores>['schedules']

  const storesValue = field(fields, 'stores')
  const stores = storesValue === undefined ? [] : storesValue

  if (!Array.isArray(stores)) {
    return invalid('stores', 'must be an array')
  }

  for (const [index, store] of stores.entries()) {
    if (!isJobStoreToken(store)) {
      return invalid(`stores[${index}]`, 'must be a JobStore token')
    }
  }

  return Object.freeze({
    group,
    schedules: Object.freeze(schedules),
    stores: Object.freeze([...stores])
  }) as JobSchedulesDefinition<Group, Drafts, Stores>
}

type PayloadCodecOf<Definition extends AnyJobDefinition> =
  Definition extends JobDefinition<
    infer _Queue,
    infer _Name,
    infer _Version,
    infer PayloadCodec,
    infer _ResultCodec,
    infer _FailureCodec,
    infer _Store
  >
    ? PayloadCodec
    : never

export type SchedulePayloadEncoding<Definition extends AnyJobDefinition> =
  PayloadCodecOf<Definition> extends {
    readonly encode: (...arguments_: never[]) => infer Encoded
  }
    ? Encoded
    : unknown

export const encodeSchedulePayload = <
  Definition extends AnyJobDefinition,
  Key extends string,
  Group extends string = string
>(
  schedule: JobScheduleDraft<Definition, Key> | JobSchedule<Definition, Key, Group>
): SchedulePayloadEncoding<Definition> =>
  // SAFETY: `schedule` was built by `JobSchedules.schedule`, which retains the
  // JobDefinition payload codec and its matching payload value.
  schedule.job.payload.encode(schedule.payload as never) as SchedulePayloadEncoding<Definition>

export const nextScheduleOccurrence = (
  schedule: AnyJobScheduleLike,
  afterMs: number,
  anchorMs?: number
): number => {
  if (schedule.strategy === 'cron') {
    return nextCronOccurrence(schedule.cron as string, afterMs, schedule.timeZone)
  }

  const everyMs = schedule.everyMs as number
  const firstSlot = anchorMs === undefined ? firstEveryMsOccurrence(everyMs, afterMs) : anchorMs
  return nextEveryMsOccurrence(everyMs, afterMs, firstSlot)
}

export type ResolvedJobScheduleStore = {
  readonly token: AnyJobStoreToken
  readonly store: JobScheduleStoreContract
}

const failureFromCause = <Value>(cause: unknown): ResultType<Value, UnhandledException> =>
  Result.err(new UnhandledException({ cause }))

const resolveOperation = async <Value, Failure extends ScheduleStoreError>(
  operation: ScheduleStoreOperation<Value, Failure>
): Promise<ResultType<Value, Failure | UnhandledException>> => {
  try {
    const result = await operation

    if (Result.isOk(result)) {
      return Result.ok(result.value)
    }

    if (Result.isError(result)) {
      return Result.err(result.error)
    }

    return failureFromCause(new TypeError('Schedule store returned an invalid Result'))
  } catch (cause) {
    return failureFromCause(cause)
  }
}

const clockNow = (clock: InstanceType<typeof Clock>): ResultType<number, UnhandledException> => {
  try {
    const value = clock.now().getTime()

    if (!Number.isSafeInteger(value) || value < 0) {
      return failureFromCause(new RangeError('Clock.now must return a non-negative safe integer'))
    }

    return Result.ok(value)
  } catch (cause) {
    return failureFromCause(cause)
  }
}

const normalizeReconcileOptions = (
  options: ScheduleReconcileOptions
): ResultType<
  Required<Pick<ScheduleReconcileOptions, 'removal' | 'removeAfterMs'>>,
  ScheduleReconcileError
> => {
  const removal = options.removal ?? 'warn'
  const removeAfterMs = options.removeAfterMs ?? 0

  if (removal !== 'warn' && removal !== 'group') {
    return Result.err(
      new ScheduleDefinitionError({ field: 'removal', message: 'must be warn or group' })
    )
  }

  if (!Number.isSafeInteger(removeAfterMs) || removeAfterMs < 0) {
    return Result.err(
      new ScheduleDefinitionError({
        field: 'removeAfterMs',
        message: 'must be a non-negative safe integer'
      })
    )
  }

  if (removeAfterMs > 0 && removal !== 'group') {
    return Result.err(
      new ScheduleDefinitionError({
        field: 'removeAfterMs',
        message: 'requires removal to be group'
      })
    )
  }

  return Result.ok({ removal, removeAfterMs })
}

const sameCadence = (schedule: AnyJobSchedule, record: ScheduleRecord): boolean =>
  schedule.cron === record.cron &&
  schedule.everyMs === record.everyMs &&
  schedule.timeZone === record.timeZone

const makeScheduleRecord = (
  schedule: AnyJobSchedule,
  payload: import('../protocol').JsonValue,
  nowMs: number,
  existing: ScheduleRecord | undefined
): ScheduleRecord => {
  const preservePosition = existing !== undefined && sameCadence(schedule, existing)

  return Object.freeze({
    key: schedule.key,
    group: schedule.group,
    job: schedule.job.identity,
    // SAFETY: every Job definition carries its validated QueueName at runtime.
    queue: schedule.job.queue as ScheduleRecord['queue'],
    cron: schedule.cron,
    everyMs: schedule.everyMs,
    timeZone: schedule.timeZone,
    payload,
    metadata: schedule.metadata,
    priority: schedule.defaults.priority,
    attemptsMax: schedule.defaults.attempts,
    backoff: schedule.defaults.backoff,
    timeoutMs: schedule.defaults.timeoutMs,
    misfire: schedule.misfire,
    overlap: schedule.overlap,
    paused: existing?.paused ?? false,
    revision: existing?.revision ?? 0,
    nextRunAtMs: preservePosition ? existing.nextRunAtMs : nextScheduleOccurrence(schedule, nowMs),
    lastScheduledAtMs: existing?.lastScheduledAtMs,
    lastJobId: existing?.lastJobId,
    createdAtMs: existing?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs
  })
}

const addressFor = (record: Pick<ScheduleRecord, 'group' | 'key'>): ScheduleAddress =>
  Object.freeze({ group: record.group, key: record.key })

const keyFor = (record: Pick<ScheduleRecord, 'group' | 'key'>): string =>
  `${record.group}\u0000${record.key}`

const emptyReconcileReport = (group: string): ScheduleReconcileReport => ({
  group,
  created: [],
  updated: [],
  unchanged: [],
  warned: [],
  removed: [],
  deferred: []
})

const isAbort = (signal: AbortSignal): boolean => signal.aborted

const sleepForGrace = async (
  clock: InstanceType<typeof Clock>,
  milliseconds: number,
  signal: AbortSignal
): Promise<ResultType<void, UnhandledException>> => {
  try {
    await clock.sleep(milliseconds, { signal })
    return Result.ok(undefined)
  } catch (cause) {
    return failureFromCause(cause)
  }
}

export const scheduleStoreTokens = (
  definition: AnyJobSchedulesDefinition
): readonly AnyJobStoreToken[] => {
  const tokens = new Map<string, AnyJobStoreToken>()

  for (const schedule of definition.schedules) {
    tokens.set(schedule.job.store.serviceTag, schedule.job.store)
  }

  for (const token of definition.stores) {
    tokens.set(token.serviceTag, token)
  }

  return Object.freeze([...tokens.values()])
}

const desiredForStore = (
  definition: AnyJobSchedulesDefinition,
  token: AnyJobStoreToken
): readonly AnyJobSchedule[] =>
  definition.schedules.filter((schedule) => schedule.job.store.serviceTag === token.serviceTag)

export const reconcileResolved = async (
  definition: AnyJobSchedulesDefinition,
  stores: readonly ResolvedJobScheduleStore[],
  options: ScheduleReconcileOptions,
  clock: InstanceType<typeof Clock>,
  signal: AbortSignal
): Promise<ResultType<ScheduleReconcileReport, ScheduleReconcileError>> => {
  const normalizedOptions = normalizeReconcileOptions(options)

  if (Result.isError(normalizedOptions)) {
    return normalizedOptions
  }

  let now: ResultType<number, ScheduleReconcileError>

  if (options.nowMs === undefined) {
    now = clockNow(clock)
  } else if (Number.isSafeInteger(options.nowMs) && options.nowMs >= 0) {
    now = Result.ok(options.nowMs)
  } else {
    now = Result.err(
      new ScheduleDefinitionError({
        field: 'nowMs',
        message: 'must be a non-negative safe integer'
      })
    )
  }

  if (Result.isError(now)) {
    return now
  }

  const encoded = new Map<AnyJobSchedule, import('../protocol').JsonValue>()

  for (const schedule of definition.schedules) {
    let result: ResultType<import('../protocol').JsonValue, unknown>

    try {
      // SAFETY: JobSchedules.schedule preserves the payload codec and encodeSchedulePayload returns its JSON result.
      result = (await Promise.resolve(encodeSchedulePayload(schedule))) as ResultType<
        import('../protocol').JsonValue,
        unknown
      >
    } catch (cause) {
      return failureFromCause(cause)
    }

    if (Result.isError(result)) {
      return Result.err(result.error as ScheduleReconcileError)
    }

    if (!Result.isOk(result)) {
      return failureFromCause(new TypeError('Schedule codec returned an invalid Result'))
    }

    encoded.set(schedule, result.value)
  }

  const report = emptyReconcileReport(definition.group)
  const created = [...report.created]
  const updated = [...report.updated]
  const unchanged = [...report.unchanged]
  const warned = [...report.warned]
  const removed = [...report.removed]
  const deferred = [...report.deferred]

  for (const resolved of stores) {
    const desired = desiredForStore(definition, resolved.token)
    const before = await resolveOperation(resolved.store.listSchedules({ group: definition.group }))

    if (Result.isError(before)) {
      return Result.err(before.error)
    }

    const existingByKey = new Map(before.value.map((record) => [keyFor(record), record]))

    for (const schedule of desired) {
      const existing = existingByKey.get(keyFor(schedule.identity))
      let record: ScheduleRecord

      try {
        const payload = encoded.get(schedule)

        if (payload === undefined) {
          return failureFromCause(new TypeError('Missing encoded schedule payload'))
        }

        record = makeScheduleRecord(schedule, payload, now.value, existing)
      } catch (cause) {
        return failureFromCause(cause)
      }

      const upserted = await resolveOperation(resolved.store.upsertSchedule(record))

      if (Result.isError(upserted)) {
        return Result.err(upserted.error)
      }

      if (upserted.value.created) {
        created.push(upserted.value.record)
      } else if (upserted.value.changed) {
        updated.push(upserted.value.record)
      } else {
        unchanged.push(upserted.value.record)
      }
    }

    const listed = await resolveOperation(resolved.store.listSchedules({ group: definition.group }))

    if (Result.isError(listed)) {
      return Result.err(listed.error)
    }

    const desiredKeys = new Set(desired.map((schedule) => keyFor(schedule.identity)))
    const missing = listed.value.filter((record) => !desiredKeys.has(keyFor(record)))

    if (normalizedOptions.value.removal === 'warn') {
      warned.push(...missing.map(addressFor))
      continue
    }

    let candidates = missing

    if (normalizedOptions.value.removeAfterMs > 0 && missing.length > 0) {
      if (isAbort(signal)) {
        deferred.push(...missing.map(addressFor))
        continue
      }

      const slept = await sleepForGrace(clock, normalizedOptions.value.removeAfterMs, signal)

      if (Result.isError(slept)) {
        if (isAbort(signal)) {
          deferred.push(...missing.map(addressFor))
          continue
        }

        return Result.err(slept.error)
      }

      if (isAbort(signal)) {
        deferred.push(...missing.map(addressFor))
        continue
      }

      const relisted = await resolveOperation(
        resolved.store.listSchedules({ group: definition.group })
      )

      if (Result.isError(relisted)) {
        return Result.err(relisted.error)
      }

      candidates = relisted.value.filter((record) => !desiredKeys.has(keyFor(record)))
    }

    for (const candidate of candidates) {
      const result = await resolveOperation(resolved.store.removeSchedule(addressFor(candidate)))

      if (Result.isError(result)) {
        return Result.err(result.error)
      }

      if (result.value) {
        removed.push(addressFor(candidate))
      }
    }
  }

  return Result.ok(
    Object.freeze({
      group: report.group,
      created: Object.freeze(created),
      updated: Object.freeze(updated),
      unchanged: Object.freeze(unchanged),
      warned: Object.freeze(warned),
      removed: Object.freeze(removed),
      deferred: Object.freeze(deferred)
    })
  )
}

export const reconcileSchedules = <
  const Group extends string,
  const Drafts extends readonly AnyJobScheduleDraft[],
  const Stores extends readonly AnyJobStoreToken[]
>(
  definition: JobSchedulesDefinition<Group, Drafts, Stores>,
  options: ScheduleReconcileOptions = {}
): JobSchedulesReconcileGenerator<JobSchedulesDefinition<Group, Drafts, Stores>> => {
  const generator = (async function* () {
    const clock = yield* Clock
    const signal = yield* CurrentAbortSignal
    const stores: ResolvedJobScheduleStore[] = []

    for (const token of scheduleStoreTokens(definition)) {
      const scheduleStore = yield* JobScheduleStore.for(token)
      stores.push({ token, store: scheduleStore })
    }

    return yield* Result.await(reconcileResolved(definition, stores, options, clock, signal))
  })()

  // SAFETY: runtime resolution erases the precise associated store token, while the public generator type restores it from the definition's Jobs and explicit stores.
  return generator as JobSchedulesReconcileGenerator<JobSchedulesDefinition<Group, Drafts, Stores>>
}

export const JobSchedules = {
  schedule: makeSchedule,
  define: defineSchedules,
  encodePayload: encodeSchedulePayload,
  nextOccurrence: nextScheduleOccurrence,
  occurrenceId: makeScheduleOccurrenceId,
  reconcile: reconcileSchedules
} as const
