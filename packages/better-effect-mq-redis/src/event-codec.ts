// oxlint-disable anti-slop/no-unknown-parameters -- retention is validated at the public adapter boundary.
// oxlint-disable anti-slop/no-runtime-typeof -- runtime validation narrows JavaScript configuration values.

import type {
  AttemptRecord,
  DurableJobEventInput,
  DurableJobEventType,
  JobEventRetention,
  JobEventStoreWriter,
  JobRecord
} from 'better-effect-mq'

export interface RedisJobEventStoreOptions {
  readonly retention?: JobEventRetention
  readonly writer?: JobEventStoreWriter
}

export interface RedisEventAppendOptions {
  readonly retention: Readonly<JobEventRetention>
  readonly writer: JobEventStoreWriter
}

interface NormalizedEventRetention {
  ageMs?: number
  count?: number
}

const emptyAttributes: Readonly<Record<string, string>> = Object.freeze({})

const validRetentionNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export const normalizeEventOptions = (
  options: RedisJobEventStoreOptions = {}
): RedisEventAppendOptions => {
  const retention = options.retention ?? {}
  for (const field of Object.keys(retention)) {
    if (field !== 'ageMs' && field !== 'count') {
      throw new TypeError('Redis event retention has an unsupported field')
    }
  }
  if (retention.ageMs !== undefined && !validRetentionNumber(retention.ageMs)) {
    throw new TypeError('Redis event retention.ageMs must be a positive safe integer')
  }
  if (retention.count !== undefined && !validRetentionNumber(retention.count)) {
    throw new TypeError('Redis event retention.count must be a positive safe integer')
  }
  const normalizedRetention: NormalizedEventRetention = {}
  if (retention.ageMs !== undefined) normalizedRetention.ageMs = retention.ageMs
  if (retention.count !== undefined) normalizedRetention.count = retention.count
  const writer = options.writer ?? {
    id: 'better-effect-mq-redis',
    version: 'current',
    canAppend: true
  }
  if (
    writer === null ||
    typeof writer !== 'object' ||
    typeof writer.id !== 'string' ||
    typeof writer.version !== 'string' ||
    typeof writer.canAppend !== 'boolean'
  ) {
    throw new TypeError('Redis event writer must include string id/version and boolean canAppend')
  }
  return Object.freeze({
    retention: Object.freeze(normalizedRetention),
    writer: Object.freeze({
      id: writer.id,
      version: writer.version,
      canAppend: writer.canAppend
    })
  })
}

export const settlementEventType = (attempt: AttemptRecord): DurableJobEventType => {
  switch (attempt.outcome) {
    case 'completed':
      return 'job-completed'
    case 'retried':
      return 'job-retry-scheduled'
    case 'failed':
      return 'job-failed'
    case 'cancelled':
      return 'job-cancelled'
    case 'stalled':
      return 'job-stalled-recovered'
    case 'released':
      return 'job-released'
  }
}

export const transitionEventType = (
  operation: string,
  previous: JobRecord,
  next: JobRecord
): DurableJobEventType | undefined => {
  switch (operation) {
    case 'cancel':
      return 'job-cancelled'
    case 'requestCancellation':
      return previous.cancellationRequestedAt === next.cancellationRequestedAt
        ? undefined
        : 'job-cancel-requested'
    case 'promote':
      return 'job-promoted'
    case 'retry':
      return 'job-admin-retried'
    case 'recoverStalled':
      return 'job-stalled-recovered'
    case 'release':
      return 'job-released'
    default:
      return undefined
  }
}

export const makeJobEvent = (
  type: DurableJobEventType,
  record: JobRecord,
  context: {
    readonly previous?: JobRecord
    readonly attempt?: AttemptRecord
    readonly recordedAtMs?: number
    readonly duplicate?: boolean
  } = {}
): DurableJobEventInput => {
  const workerId = record.leaseOwner ?? context.previous?.leaseOwner
  return Object.freeze({
    type,
    recordedAtMs: context.recordedAtMs ?? record.updatedAt,
    jobId: record.id,
    queue: record.queue,
    name: record.name,
    version: record.version,
    state: record.state,
    attempt: context.attempt?.attemptSequence ?? context.attempt?.attempt,
    delivery: context.attempt?.delivery ?? record.deliveryCount,
    workerId,
    outcome: context.attempt?.outcome ?? (type === 'job-released' ? 'released' : undefined),
    failureKind: record.failure?.kind ?? context.previous?.failure?.kind,
    duplicate: context.duplicate,
    attributes: emptyAttributes
  })
}

export const makeQueueEvent = (
  type: 'queue-paused' | 'queue-resumed',
  queue: JobRecord['queue'],
  recordedAtMs: number
): DurableJobEventInput =>
  Object.freeze({
    type,
    recordedAtMs,
    jobId: undefined,
    queue,
    name: undefined,
    version: undefined,
    state: undefined,
    attempt: undefined,
    delivery: undefined,
    workerId: undefined,
    outcome: undefined,
    failureKind: undefined,
    duplicate: undefined,
    attributes: emptyAttributes
  })

export const makeExtensionEvent = (
  type: DurableJobEventType,
  fields: Omit<DurableJobEventInput, 'type' | 'attributes'> & {
    readonly attributes?: Readonly<Record<string, string>>
  }
): DurableJobEventInput =>
  Object.freeze({
    ...fields,
    type,
    attributes: fields.attributes ?? emptyAttributes
  })
