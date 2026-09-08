// oxlint-disable anti-slop/no-runtime-typeof -- the reference driver validates untyped DTO and host capability boundaries.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- DTO fields are parsed immediately at the public request boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- public JobStore requests are runtime validation boundaries.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts are confined to JobStore's structural service boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- internal erasure restores checked protocol types.

import { Layer } from 'better-effect'
import type { ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

import {
  InvalidJobTransitionError,
  JobDefinitionError,
  JobNotFoundError,
  JobStoreFailure,
  LeaseLostError,
  SettlementConflictError,
  UnsupportedJobStoreOperationError,
  compareJobOrder,
  makeJobId,
  makeJobName,
  makeJobRecord,
  makeLeaseToken,
  makeQueueName,
  makeWorkerId,
  reduceJob,
  makeFlowMigration,
  protocolVersionV2,
  validateAttemptRecord,
  validateDuration,
  validateOptionalDuration,
  validateTimestamp,
  validateJobRecordV2,
  validateParentEnvelope
} from '../protocol'
import { recoverStalledWithPolicy } from '../protocol/transitions'
import type {
  AnyQueueControlsRegistry,
  ControlsReconcileOptions,
  ControlsReconcileReport
} from '../controls'
import {
  ControlsRevisionMismatchError,
  noDispatchKey,
  type ControlledClaimRequest,
  type ControlledClaimResult,
  type ControlledEmptyClaim,
  type ControlledCancelRequest,
  type ControlledRecoverStalledRequest,
  type ControlledReleaseRequest,
  type ControlledSettleRequest,
  type ControlledJobStoreContract,
  type QueueControlsRecord
} from './controlled'

import type { JobId, JobName, LeaseToken, QueueName } from '../protocol'

import type {
  ActiveJobSnapshot,
  ClaimIdentity,
  ClaimRequest,
  CountsRequest,
  EnqueueRequest,
  HeartbeatLease,
  HeartbeatRequest,
  JobCounts,
  JobListCursor,
  JobListOrder,
  JobListOrderBy,
  JobStoreCapabilities,
  JobStoreContract,
  JobStoreDescriptor,
  JobStoreOperation,
  JobIdRequest,
  ListJobsRequest,
  LostLease,
  QueuePauseResult,
  RecoverStalledRequest,
  SettleRequest,
  TransactionalEnqueue,
  WakeToken
} from './types'

import type {
  AttemptRecord,
  AttemptRecordV2,
  JobRecord,
  JobRecordV2,
  JobStateV2,
  JobTransition,
  ParentEnvelope
} from '../protocol'
import type { JobStoreError } from './errors'
import type { AnyJobStoreToken, JobStore as JobStoreNamespace } from './store'
import type {
  DurableJobEventInput,
  DurableJobEventType,
  JobEventStoreContract,
  JobEventStoreWriter
} from './event-store'
import { getMemoryJobEventStoreInternals } from './memory-event-store'
import type { MemoryJobEventStoreInternals } from './memory-event-store'

import { JobStore } from './store'
import { JobStoreWakeAbortedError } from './errors'
import { JobEventWriterRejectedError } from './event-errors'
import type {
  JobCountsV2,
  JobStoreV2Contract,
  JobStoreV2Descriptor,
  JobStoreV2Operation,
  ListJobsV2Request,
  ListJobsV2Result
} from './job-v2'
import type {
  CancelFlowRequest,
  CancelFlowResult,
  FlowFanOutRequest,
  FlowFanOutResult,
  FlowParentRecord,
  FlowSnapshot,
  MarkCascadedRequest,
  PeekOutboxRequest,
  ReconcileFlowRequest,
  RecordChildResultsRequest,
  RecordChildResultsResult,
  AppendChildReportRequest,
  AckOutboxRequest
} from './flow-v2'
import { MemoryFlowStore } from './memory-flow'
import { validatePreparedEnqueue } from '../job/prepared'
import type { PreparedEnqueue } from '../job/prepared'

/** A deterministic clock accepted by the in-process reference driver. */
export interface MemoryJobStoreClock {
  now(): number | Date
}

/** An ID source accepted by the in-process reference driver. */
export type MemoryJobStoreIdGenerator =
  | {
      readonly next: () => string
    }
  | (() => string)

/** Construction controls for one isolated MemoryJobStore instance. */
export interface MemoryJobStoreOptions {
  /** Optional clock used to verify every request timestamp that affects state. */
  readonly clock?: MemoryJobStoreClock | (() => number | Date)
  /** Optional deterministic source for generated job IDs and lease tokens. */
  readonly idGenerator?: MemoryJobStoreIdGenerator
  /** Optional reference EventStore to receive atomic transition appends. */
  readonly eventStore?: JobEventStoreContract
  /** Writer capability advertised to the event-store rollout handshake. */
  readonly eventWriter?: JobEventStoreWriter
}

type Operation<Value> = JobStoreOperation<Value, JobStoreError>

/** Internal synchronous bridge used only by the Memory schedule extension. */
export interface MemoryJobStoreInternals {
  readonly runCriticalSection: <Value>(callback: () => Value) => Value
  readonly ensureEventWriterReady: (operation: string) => JobStoreError | undefined
  readonly appendDurableEvent: (event: DurableJobEventInput) => void
  readonly enqueueManyWithinCritical: (
    requests: readonly EnqueueRequest[]
  ) => ResultType<JobStoreNamespace.EnqueueManyResult, JobStoreError>
  readonly getJobWithinCritical: (
    jobId: JobStoreNamespace.GetJobRequest['jobId']
  ) => ResultType<JobRecord | undefined, JobStoreError>
}

const memoryJobStoreInternals = new WeakMap<object, MemoryJobStoreInternals>()
type MemoryIdentity = {
  readonly queue: string
  readonly name: string
  readonly version: number
}
type NormalizedEnqueue = {
  readonly id: JobId
  readonly explicitId: boolean
  readonly identity: MemoryIdentity
  readonly payload: JobRecord['payload']
  readonly dispatchKey: string | undefined
  readonly metadata: Readonly<Record<string, string>>
  readonly priority: number
  readonly runAt: number
  readonly attemptsMax: number
  readonly backoff: JobRecord['backoff']
  readonly timeoutMs: number | undefined
  readonly idempotencyKey: string | undefined
  readonly parent: ParentEnvelope | undefined
  readonly now: number
}
type WakeBaseline = {
  readonly global: number
  readonly queue: string | undefined
  readonly queueVersion: number
  readonly queueGlobal: number
  readonly broadcast: number
}
type WakeWaiter = {
  readonly queues: ReadonlySet<string>
  readonly baseline: WakeBaseline
  readonly signal: AbortSignal
  readonly onAbort: () => void
  readonly resolve: (value: Operation<void>) => void
  settled: boolean
}
type PreparedTransition = {
  readonly transition: JobTransition
  readonly previous: JobRecord
  readonly nextSequence: number
}
type NormalizedLease = {
  readonly jobId: JobId
  readonly leaseToken: LeaseToken
}

const maxGenerationAttempts = 32
const maxSafeInteger = Number.MAX_SAFE_INTEGER
const cursorVersion = 1 as const
const defaultListOrderBy: JobListOrderBy = 'enqueuedAt'
const defaultListOrder: JobListOrder = 'asc'
const validationId = makeJobId('memory-validation-id').unwrap()
const memoryCapabilities: JobStoreCapabilities = Object.freeze({
  queueFilteredNotifications: true,
  nativeBatchEnqueue: false,
  nativeBatchClaim: true,
  metadataIndex: 'none',
  transactionalEnqueue: false,
  durableChangeFeed: false,
  globalConcurrency: false,
  rateLimiting: false
})

const memoryDescriptor: JobStoreDescriptor = Object.freeze({
  protocolVersion: 1,
  adapter: 'memory',
  adapterVersion: '0.1.0',
  layoutVersion: 1,
  capabilities: memoryCapabilities
})
const memoryV2Descriptor: JobStoreV2Descriptor = Object.freeze({
  protocolVersion: protocolVersionV2,
  adapter: 'memory',
  adapterVersion: '0.2.0',
  layoutVersion: 1,
  migration: makeFlowMigration({ status: 'not-required', from: undefined, to: 1 }),
  capabilities: memoryCapabilities
})
const listStates = new Set(['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'])
const listStatesV2 = new Set([...listStates, 'waiting-children'])
const listStateOrder = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'] as const

const ok = <Value>(value: Value): Operation<Value> =>
  Result.ok(value) as unknown as Operation<Value>

const fail = <Value>(cause: JobStoreError): Operation<Value> =>
  Result.err(cause) as unknown as Operation<Value>

const syncV2 = <Value>(operation: JobStoreV2Operation<Value>): ResultType<Value, JobStoreError> =>
  // SAFETY: MemoryFlowStore is the synchronous reference implementation. Durable adapters may
  // return a PromiseLike through the same public contract, but this bridge only owns MemoryFlowStore.
  operation as ResultType<Value, JobStoreError>

const okV2 = <Value>(value: Value): JobStoreV2Operation<Value> =>
  Result.ok(value) as JobStoreV2Operation<Value>

const failV2 = <Value>(cause: JobStoreError): JobStoreV2Operation<Value> =>
  Result.err(cause) as JobStoreV2Operation<Value>

const syncJob = <Value>(operation: Operation<Value>): ResultType<Value, JobStoreError> =>
  // SAFETY: MemoryJobStore completes synchronously; this is used only by its v2 bridge.
  operation as ResultType<Value, JobStoreError>

const definitionFailure = <Value>(
  field: string,
  message: string
): ResultType<Value, JobStoreError> => Result.err(new JobDefinitionError({ field, message }))

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAbortSignal = (value: unknown): value is AbortSignal =>
  isObject(value) &&
  typeof (value as { readonly addEventListener?: unknown }).addEventListener === 'function' &&
  typeof (value as { readonly removeEventListener?: unknown }).removeEventListener === 'function' &&
  typeof (value as { readonly aborted?: unknown }).aborted === 'boolean'

const readDto = (
  value: unknown,
  fields: readonly string[],
  field: string
): ResultType<Readonly<Record<string, unknown>>, JobStoreError> => {
  if (!isObject(value)) {
    return definitionFailure(field, 'must be an object')
  }

  try {
    const allowed = new Set(fields)
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        return definitionFailure(field, 'contains unsupported fields')
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor)) {
        return definitionFailure(field, 'contains an accessor field')
      }

      output[key] = descriptor.value
    }

    return Result.ok(Object.freeze(output))
  } catch {
    return definitionFailure(field, 'could not read fields')
  }
}

const readIdentity = (value: unknown, field: string): ResultType<MemoryIdentity, JobStoreError> => {
  const fields = readDto(value, ['queue', 'name', 'version'], field)
  if (Result.isError(fields)) return fields

  const queue = makeQueueName(fields.value.queue)
  const name = makeJobName(fields.value.name)
  const version = fields.value.version

  if (Result.isError(queue)) return Result.err(queue.error)
  if (Result.isError(name)) return Result.err(name.error)
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
    return definitionFailure('version', 'must be a positive safe integer')
  }

  return Result.ok({ queue: queue.value, name: name.value, version })
}

const identityFromFields = (
  fields: Readonly<Record<string, unknown>>
): ResultType<MemoryIdentity, JobStoreError> => {
  const job = fields['job']
  const identity = fields['identity']

  if (job !== undefined && identity !== undefined) {
    return definitionFailure('identity', 'must provide either job or identity, not both')
  }

  if (job === undefined && identity === undefined) {
    return definitionFailure('identity', 'must provide job or identity')
  }

  return readIdentity(job ?? identity, job === undefined ? 'identity' : 'job')
}

const identityKey = (identity: MemoryIdentity): string =>
  JSON.stringify([identity.queue, identity.name, identity.version])

const canonicalJson = (value: unknown): string => {
  const seen = new Set<object>()
  const visit = (current: unknown): string => {
    if (current === null || typeof current !== 'object') {
      const encoded = JSON.stringify(current)
      if (encoded === undefined) throw new TypeError('value is not JSON encodable')
      return encoded
    }
    if (seen.has(current)) throw new TypeError('value is cyclic')
    seen.add(current)
    try {
      if (Array.isArray(current)) return `[${current.map(visit).join(',')}]`
      const entries = Object.keys(current)
        .filter((key) => (current as Record<string, unknown>)[key] !== undefined)
        .sort(compareText)
        .map((key) => `${JSON.stringify(key)}:${visit((current as Record<string, unknown>)[key])}`)
      return `{${entries.join(',')}}`
    } finally {
      seen.delete(current)
    }
  }
  return visit(value)
}

const compareText = (left: string, right: string): number => {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)

  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index] ?? 0
    const rightByte = rightBytes[index] ?? 0
    if (leftByte < rightByte) return -1
    if (leftByte > rightByte) return 1
  }

  if (leftBytes.length < rightBytes.length) return -1
  if (leftBytes.length > rightBytes.length) return 1
  return 0
}

const listPrimaryValue = (record: JobRecord, orderBy: JobListOrderBy): number | null => {
  if (orderBy === 'enqueuedAt') return record.createdAt
  if (orderBy === 'runAt') return record.runAt
  return record.finishedAt ?? null
}

const compareNumbers = (left: number, right: number): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const comparePrimaryValues = (left: number | null, right: number | null): number => {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  return compareNumbers(left, right)
}

const compareListRecords = (
  left: JobRecord,
  right: JobRecord,
  orderBy: JobListOrderBy,
  order: JobListOrder
): number => {
  const direction = order === 'asc' ? 1 : -1
  const primary = comparePrimaryValues(
    listPrimaryValue(left, orderBy),
    listPrimaryValue(right, orderBy)
  )
  if (primary !== 0) return primary * direction

  const sequence = compareNumbers(left.orderingSequence, right.orderingSequence)
  if (sequence !== 0) return sequence * direction
  return compareText(left.id, right.id) * direction
}

const compareRecordCursor = (record: JobRecord, cursor: JobListCursor): number => {
  const direction = cursor.order === 'asc' ? 1 : -1
  const primary = comparePrimaryValues(listPrimaryValue(record, cursor.orderBy), cursor.value)
  if (primary !== 0) return primary * direction

  const sequence = compareNumbers(record.orderingSequence, cursor.orderingSequence)
  if (sequence !== 0) return sequence * direction
  return compareText(record.id, cursor.id) * direction
}

const cursorOrderingFor = (orderBy: JobListOrderBy): JobListCursor['ordering'] =>
  orderBy === 'enqueuedAt'
    ? 'createdAt,orderingSequence,id'
    : orderBy === 'runAt'
      ? 'runAt,orderingSequence,id'
      : 'finishedAt,orderingSequence,id'

const cloneRecord = (record: JobRecord): JobRecord => {
  const checked = makeJobRecord(record)
  return checked.isOk() ? checked.value : record
}

const cloneAttempt = (attempt: AttemptRecord): AttemptRecord => {
  const checked = validateAttemptRecord(attempt)
  return checked.isOk() ? checked.value : attempt
}

const snapshotTransition = (transition: JobTransition): JobTransition =>
  Object.freeze({
    record: cloneRecord(transition.record),
    attempt: transition.attempt === undefined ? undefined : cloneAttempt(transition.attempt)
  })

const isJobState = (value: unknown): value is JobRecord['state'] =>
  typeof value === 'string' && listStates.has(value)

const jobStoreFailure = (operation: string, message: string): JobStoreFailure =>
  new JobStoreFailure({ operation, retryable: false, message })

const wakeFailure = (message: string): JobStoreFailure => jobStoreFailure('awaitWake', message)

const makeWakeToken = (baseline: WakeBaseline): WakeToken =>
  `memory-wake-v1-${encodeURIComponent(JSON.stringify(baseline))}` as WakeToken

const parseWakeToken = (token: unknown): ResultType<WakeBaseline, JobStoreError> => {
  if (typeof token !== 'string' || token.length === 0) {
    return Result.err(wakeFailure('wakeToken must be a non-empty token'))
  }

  const prefix = 'memory-wake-v1-'
  if (!token.startsWith(prefix)) {
    return Result.err(wakeFailure('wakeToken was not created by this protocol'))
  }

  try {
    const value: unknown = JSON.parse(decodeURIComponent(token.slice(prefix.length)))
    const fields = readDto(
      value,
      ['global', 'queue', 'queueVersion', 'queueGlobal', 'broadcast'],
      'wakeToken'
    )
    if (Result.isError(fields)) return Result.err(wakeFailure(fields.error.message))

    const numbers = ['global', 'queueVersion', 'queueGlobal', 'broadcast'] as const
    for (const field of numbers) {
      const numberValue = fields.value[field]
      if (
        typeof numberValue !== 'number' ||
        !Number.isSafeInteger(numberValue) ||
        numberValue < 0
      ) {
        return Result.err(wakeFailure(`wakeToken.${field} must be a non-negative safe integer`))
      }
    }

    const queue = fields.value.queue
    if (queue !== undefined && (typeof queue !== 'string' || queue.length === 0)) {
      return Result.err(wakeFailure('wakeToken.queue must be a non-empty string'))
    }

    return Result.ok({
      global: fields.value.global as number,
      queue: queue as string | undefined,
      queueVersion: fields.value.queueVersion as number,
      queueGlobal: fields.value.queueGlobal as number,
      broadcast: fields.value.broadcast as number
    })
  } catch {
    return Result.err(wakeFailure('wakeToken could not be decoded'))
  }
}

const normalizeClockValue = (value: unknown): ResultType<number, JobStoreError> => {
  const timestamp = value instanceof Date ? value.getTime() : value
  return validateTimestamp(timestamp, 'clock.now')
}

const isRequeue = (previous: JobRecord, next: JobRecord): boolean =>
  (next.state === 'waiting' || next.state === 'delayed') &&
  (previous.state === 'active' ||
    previous.state === 'failed' ||
    previous.state === 'cancelled' ||
    previous.state === 'delayed')

class MemoryJobStoreImplementation {
  readonly descriptor = memoryDescriptor
  private readonly jobs = new Map<string, JobRecord>()
  private readonly attempts = new Map<string, AttemptRecord[]>()
  private readonly v2Attempts = new Map<string, AttemptRecordV2[]>()
  // Terminal records clear active lease fields; retain the fencing token and
  // canonical outcome so a lost settlement response can be safely replayed.
  private readonly settled = new Map<
    string,
    { readonly leaseToken: LeaseToken; readonly outcomeDigest: string }
  >()
  private readonly idempotency = new Map<string, string>()
  private readonly generatedJobIds = new Set<string>()
  private readonly issuedLeaseTokens = new Set<string>()
  private readonly paused = new Set<string>()
  private readonly waiters = new Set<WakeWaiter>()
  private readonly queueWakeVersions = new Map<string, number>()
  private readonly queueWakeGlobals = new Map<string, number>()
  private sequence = 1
  private defaultIdSequence = 0
  private defaultLeaseSequence = 0
  private wakeGlobal = 0
  private wakeBroadcast = 0
  private readonly listOrders = new Map<string, readonly JobRecord[]>()
  private readonly controls = new Map<string, QueueControlsRecord>()
  private readonly controlledPermits = new Map<
    string,
    { readonly leaseToken: LeaseToken; readonly dispatchKey: string }
  >()
  private readonly rateWindows = new Map<
    string,
    { readonly startedAtMs: number; readonly count: number }
  >()
  private readonly rotations = new Map<string, number>()
  private readonly clock: MemoryJobStoreOptions['clock']
  private readonly idGenerator: MemoryJobStoreIdGenerator | undefined
  private readonly eventAppender: MemoryJobEventStoreInternals | undefined
  private readonly eventWriter: JobEventStoreWriter | undefined
  private readonly flowStoreV2: import('./flow-v2').FlowStoreV2
  private readonly flowParentIds = new Set<string>()
  private readonly flowChildParents = new Map<string, ParentEnvelope>()
  readonly v2: JobStoreV2Contract
  private claimInProgress = false
  private criticalSectionDepth = 0

  constructor(options: MemoryJobStoreOptions = {}) {
    this.clock = options.clock
    this.idGenerator = options.idGenerator
    this.eventWriter = options.eventWriter
    this.eventAppender =
      options.eventStore === undefined
        ? undefined
        : getMemoryJobEventStoreInternals(options.eventStore)
    if (options.eventStore !== undefined && this.eventAppender === undefined) {
      throw new TypeError('MemoryJobStore eventStore must be a MemoryJobEventStore instance')
    }
    const flowOptions: import('./memory-flow').MemoryFlowStoreOptions = {}
    if (this.eventAppender !== undefined) flowOptions.eventAppender = this.eventAppender
    if (this.eventWriter !== undefined) flowOptions.eventWriter = this.eventWriter
    this.flowStoreV2 = MemoryFlowStore.make(flowOptions)
    this.v2 = this.makeV2Contract()
    this.validateOptions(options)
  }

  private makeV2Contract(): JobStoreV2Contract {
    return Object.freeze({
      descriptor: memoryV2Descriptor,
      flow: this.flowStoreV2,
      fanOut: (request: FlowFanOutRequest) => this.fanOutV2(request),
      recordChildResults: (request: RecordChildResultsRequest) =>
        this.recordChildResultsV2(request),
      cancelFlow: (request: CancelFlowRequest) => this.cancelFlowV2(request),
      reconcile: (request: ReconcileFlowRequest) =>
        this.withEventWriter('reconcileFlow', () => this.flowStoreV2.reconcile(request)),
      markCascaded: (request: MarkCascadedRequest) =>
        this.withEventWriter('markCascaded', () => this.flowStoreV2.markCascaded(request)),
      appendChildReport: (request: AppendChildReportRequest) =>
        this.withEventWriter('appendChildReport', () =>
          this.flowStoreV2.appendChildReport(request)
        ),
      peekOutbox: (request: PeekOutboxRequest) => this.flowStoreV2.peekOutbox(request),
      ackOutbox: (request: AckOutboxRequest) =>
        this.withEventWriter('ackOutbox', () => this.flowStoreV2.ackOutbox(request)),
      getFlow: (request: { readonly flowId: JobId }) => this.flowStoreV2.getFlow(request),
      getJob: (request: { readonly jobId: JobId }) => this.getJobV2(request),
      getAttempts: (request: { readonly jobId: JobId }) => this.getAttemptsV2(request),
      list: (request: ListJobsV2Request) => this.listV2(request),
      counts: (request?: { readonly queue?: QueueName; readonly name?: JobName }) =>
        this.countsV2(request)
    })
  }

  private withEventWriter<Value>(
    operation: string,
    callback: () => JobStoreV2Operation<Value>
  ): JobStoreV2Operation<Value> {
    const eventFailure = this.eventWriterFailure(operation)
    return eventFailure === undefined ? callback() : failV2(eventFailure)
  }

  private fanOutV2(request: FlowFanOutRequest): JobStoreV2Operation<FlowFanOutResult> {
    const eventFailure = this.eventWriterFailure('fanOut')
    if (eventFailure !== undefined) return failV2(eventFailure)
    const fields = readDto(
      request,
      [
        'flowId',
        'flowName',
        'parentStoreKey',
        'depth',
        'leaseToken',
        'failFast',
        'children',
        'now',
        'maxChildren'
      ],
      'request'
    )
    if (Result.isError(fields)) return failV2(fields.error)
    const currentId = makeJobId(fields.value.flowId)
    const leaseToken = makeLeaseToken(fields.value.leaseToken)
    if (Result.isError(currentId)) return failV2(currentId.error)
    if (Result.isError(leaseToken)) return failV2(leaseToken.error)
    const current = this.jobs.get(currentId.value)
    if (current === undefined) return failV2(new JobNotFoundError({ jobId: currentId.value }))
    if (this.flowParentIds.has(currentId.value) && current.state !== 'active') {
      // A materialized manifest is the replay identity. The original lease is
      // intentionally gone, so let the flow store compare the full digest.
      return syncV2(this.flowStoreV2.fanOut(request))
    }
    if (current.state !== 'active' || current.leaseToken !== leaseToken.value) {
      return failV2(
        new LeaseLostError({
          jobId: currentId.value,
          leaseToken: leaseToken.value,
          reason: 'mismatched-token'
        })
      )
    }
    const result = syncV2(this.flowStoreV2.fanOut(request))
    if (Result.isError(result)) return failV2(result.error)
    if (result.value.status === 'applied') {
      const applied = this.applyFlowParent(result.value.parent, request.now, true)
      if (Result.isError(applied)) return failV2(applied.error)
      for (const child of request.children) {
        const parent: ParentEnvelope = Object.freeze({
          flowName: request.flowName,
          flowId: request.flowId,
          childKey: child.childKey,
          parentStoreKey: request.parentStoreKey,
          depth: request.depth
        })
        this.flowChildParents.set(child.childJobId, parent)
      }
    }
    return result as JobStoreV2Operation<FlowFanOutResult>
  }

  private recordChildResultsV2(
    request: RecordChildResultsRequest
  ): JobStoreV2Operation<RecordChildResultsResult> {
    const eventFailure = this.eventWriterFailure('recordChildResults')
    if (eventFailure !== undefined) return failV2(eventFailure)
    const result = syncV2(this.flowStoreV2.recordChildResults(request))
    if (Result.isError(result)) return failV2(result.error)
    if (result.value.parentSettled) {
      const applied = this.applyFlowParent(result.value.parent, request.now)
      if (Result.isError(applied)) return failV2(applied.error)
    }
    return result as JobStoreV2Operation<RecordChildResultsResult>
  }

  private cancelFlowV2(request: CancelFlowRequest): JobStoreV2Operation<CancelFlowResult> {
    const eventFailure = this.eventWriterFailure('cancelFlow')
    if (eventFailure !== undefined) return failV2(eventFailure)
    const result = syncV2(this.flowStoreV2.cancel(request))
    if (Result.isError(result)) return failV2(result.error)
    if (result.value.parentSettled) {
      const applied = this.applyFlowParent(result.value.parent, request.now)
      if (Result.isError(applied)) return failV2(applied.error)
    }
    return result as JobStoreV2Operation<CancelFlowResult>
  }

  private applyFlowParent(
    parent: FlowParentRecord,
    now: number,
    fanOut = false
  ): ResultType<void, JobStoreError> {
    const current = this.jobs.get(parent.flowId)
    if (current === undefined) return Result.err(new JobNotFoundError({ jobId: parent.flowId }))
    const state = parent.state === 'waiting-children' ? 'waiting' : parent.state
    const checked = makeJobRecord({
      ...current,
      state,
      attemptSequence: fanOut
        ? (current.attemptSequence ?? current.deliveryCount) + 1
        : current.attemptSequence,
      updatedAt: now,
      processedAt:
        state === 'completed' || state === 'failed' || state === 'cancelled' ? now : undefined,
      finishedAt:
        state === 'completed' || state === 'failed' || state === 'cancelled' ? now : undefined,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      cancellationRequestedAt: undefined,
      result: undefined,
      failure: parent.failure
    })
    if (Result.isError(checked)) return Result.err(checked.error)
    this.appendTerminalFlowReport(current, checked.value)
    this.jobs.set(parent.flowId, checked.value)
    if (fanOut) {
      const sequence = checked.value.attemptSequence ?? checked.value.deliveryCount
      const attempt: AttemptRecordV2 = Object.freeze({
        attempt: checked.value.attemptsMade,
        attemptSequence: sequence,
        delivery: checked.value.deliveryCount,
        startedAt: undefined,
        finishedAt: now,
        outcome: 'fanned-out',
        result: undefined,
        failure: undefined
      })
      this.v2Attempts.set(parent.flowId, [attempt])
    }
    this.flowParentIds.add(parent.flowId)
    this.invalidateListOrder(checked.value.queue)
    this.notifyQueues([checked.value.queue])
    return Result.ok()
  }

  private toV2Record(record: JobRecord): ResultType<JobRecordV2, JobStoreError> {
    const flow = this.flowParentIds.has(record.id)
      ? syncV2(this.flowStoreV2.getFlow({ flowId: record.id }))
      : Result.ok<FlowSnapshot | undefined>(undefined)
    if (Result.isError(flow)) return Result.err(flow.error)
    const parent = this.flowChildParents.get(record.id)
    const parentRecord = flow.value?.parent
    const state = parentRecord?.state ?? (parent ? record.state : record.state)
    const candidate = {
      ...record,
      state,
      parent,
      flow: parentRecord?.flow
    }
    const checked = validateJobRecordV2(candidate)
    if (Result.isError(checked)) return Result.err(checked.error)
    return checked
  }

  private getJobV2(request: {
    readonly jobId: JobId
  }): JobStoreV2Operation<JobRecordV2 | undefined> {
    const fields = readDto(request, ['jobId'], 'request')
    if (Result.isError(fields)) return failV2(fields.error)
    const jobId = makeJobId(fields.value.jobId)
    if (Result.isError(jobId)) return failV2(jobId.error)
    const record = this.jobs.get(jobId.value)
    if (record === undefined) return okV2(undefined)
    const v2 = this.toV2Record(record)
    return Result.isError(v2) ? failV2(v2.error) : okV2(v2.value)
  }

  private getAttemptsV2(request: {
    readonly jobId: JobId
  }): JobStoreV2Operation<readonly AttemptRecordV2[]> {
    const fields = readDto(request, ['jobId'], 'request')
    if (Result.isError(fields)) return failV2(fields.error)
    const jobId = makeJobId(fields.value.jobId)
    if (Result.isError(jobId)) return failV2(jobId.error)
    const legacy = this.attempts.get(jobId.value) ?? []
    const fanOut = this.v2Attempts.get(jobId.value) ?? []
    return okV2(Object.freeze([...legacy, ...fanOut]))
  }

  private listV2(request: ListJobsV2Request): JobStoreV2Operation<ListJobsV2Result> {
    try {
      const limit = this.positiveInteger(request.limit, 'limit')
      const queue =
        request.queue === undefined
          ? Result.ok<string | undefined>(undefined)
          : makeQueueName(request.queue)
      const name =
        request.name === undefined
          ? Result.ok<string | undefined>(undefined)
          : makeJobName(request.name)
      const version =
        request.version === undefined
          ? Result.ok<number | undefined>(undefined)
          : this.positiveInteger(request.version, 'version')
      const metadata = this.normalizeMetadataFilter(request.metadata)
      const orderBy = this.normalizeListOrderBy(request.orderBy)
      const order = this.normalizeListOrder(request.order)
      const cursor = this.normalizeCursor(request.cursor)
      const stateValues =
        request.state === undefined
          ? undefined
          : Array.isArray(request.state)
            ? request.state
            : [request.state]
      const states: ResultType<ReadonlySet<JobStateV2> | undefined, JobStoreError> =
        stateValues === undefined
          ? Result.ok<ReadonlySet<JobStateV2> | undefined>(undefined)
          : (() => {
              const normalized = new Set<JobStateV2>()
              for (const state of stateValues) {
                if (typeof state !== 'string' || !listStatesV2.has(state)) {
                  return definitionFailure('state', 'unsupported job state')
                }
                normalized.add(state as JobStateV2)
              }
              return Result.ok<ReadonlySet<JobStateV2>>(normalized)
            })()
      if (Result.isError(limit)) return failV2(limit.error)
      if (Result.isError(queue)) return failV2(queue.error)
      if (Result.isError(name)) return failV2(name.error)
      if (Result.isError(version)) return failV2(version.error)
      if (Result.isError(metadata)) return failV2(metadata.error)
      if (Result.isError(orderBy)) return failV2(orderBy.error)
      if (Result.isError(order)) return failV2(order.error)
      if (Result.isError(cursor)) return failV2(cursor.error)
      if (Result.isError(states)) return failV2(states.error)

      const stateSignature =
        states.value === undefined
          ? '*'
          : [...states.value].sort((left, right) => compareText(left, right)).join(',')
      const metadataSignature =
        metadata.value === undefined
          ? null
          : Object.entries(metadata.value)
              .sort(([left], [right]) => compareText(left, right))
              .map(([key, value]) => [key, value])
      const signature = JSON.stringify([
        queue.value ?? null,
        name.value ?? null,
        version.value ?? null,
        stateSignature,
        metadataSignature,
        orderBy.value,
        order.value
      ])
      if (
        cursor.value !== undefined &&
        (cursor.value.filterSignature !== signature ||
          cursor.value.orderBy !== orderBy.value ||
          cursor.value.order !== order.value)
      ) {
        return failV2(new UnsupportedJobStoreOperationError({ operation: 'list.cursor-options' }))
      }

      const entries: { readonly record: JobRecord; readonly value: JobRecordV2 }[] = []
      for (const record of this.jobs.values()) {
        if (queue.value !== undefined && record.queue !== queue.value) continue
        if (name.value !== undefined && record.name !== name.value) continue
        if (version.value !== undefined && record.version !== version.value) continue
        if (metadata.value !== undefined && !this.matchesMetadata(record, metadata.value)) continue
        const value = this.toV2Record(record)
        if (Result.isError(value)) return failV2(value.error)
        if (states.value !== undefined && !states.value.has(value.value.state)) continue
        entries.push({ record, value: value.value })
      }
      entries.sort((left, right) =>
        compareListRecords(left.record, right.record, orderBy.value, order.value)
      )

      const start =
        cursor.value === undefined
          ? 0
          : (() => {
              let low = 0
              let high = entries.length
              while (low < high) {
                const middle = Math.floor((low + high) / 2)
                const entry = entries[middle]
                if (entry !== undefined && compareRecordCursor(entry.record, cursor.value) <= 0) {
                  low = middle + 1
                } else {
                  high = middle
                }
              }
              return low
            })()
      const selected = entries.slice(start, start + limit.value)
      const hasMore = start + selected.length < entries.length
      const last = selected.at(-1)
      return okV2({
        jobs: Object.freeze(selected.map((entry) => entry.value)),
        nextCursor:
          hasMore && last !== undefined
            ? this.makeCursor(last.record, signature, orderBy.value, order.value)
            : undefined
      })
    } catch {
      return failV2(
        new JobDefinitionError({ field: 'request', message: 'could not read list request' })
      )
    }
  }

  private countsV2(request?: {
    readonly queue?: QueueName
    readonly name?: JobName
  }): JobStoreV2Operation<JobCountsV2> {
    const base = syncJob(this.counts(request))
    if (Result.isError(base)) return failV2(base.error)
    let waitingChildren = 0
    for (const id of this.flowParentIds) {
      const parent = syncV2(this.flowStoreV2.getFlow({ flowId: makeJobId(id).unwrap() }))
      if (Result.isOk(parent) && parent.value?.parent.state === 'waiting-children') {
        const record = this.jobs.get(id)
        if (
          record !== undefined &&
          (request?.queue === undefined || request.queue === record.queue) &&
          (request?.name === undefined || request.name === record.name)
        ) {
          waitingChildren += 1
        }
      }
    }
    return okV2({ ...base.value, waiting: base.value.waiting - waitingChildren, waitingChildren })
  }

  runCriticalSection<Value>(callback: () => Value): Value {
    if (this.criticalSectionDepth > 0) {
      return callback()
    }

    this.criticalSectionDepth += 1
    try {
      return callback()
    } finally {
      this.criticalSectionDepth -= 1
    }
  }

  ensureEventWriterReady(operation: string): JobStoreError | undefined {
    return this.eventWriterFailure(operation)
  }

  appendDurableEvent(event: DurableJobEventInput): void {
    if (this.eventAppender === undefined || this.eventWriter?.canAppend === false) return
    this.eventAppender.append(event)
  }

  enqueueManyWithinCritical(
    requests: readonly EnqueueRequest[]
  ): ResultType<JobStoreNamespace.EnqueueManyResult, JobStoreError> {
    return this.enqueueMany(requests) as ResultType<
      JobStoreNamespace.EnqueueManyResult,
      JobStoreError
    >
  }

  enqueuePrepared(request: PreparedEnqueue): Operation<JobStoreNamespace.EnqueueResult> {
    const checked = validatePreparedEnqueue(request)
    if (Result.isError(checked)) return fail(checked.error)

    const { protocolVersion: _protocolVersion, ...enqueue } = checked.value
    return this.enqueue(enqueue)
  }

  getJobWithinCritical(
    jobId: JobStoreNamespace.GetJobRequest['jobId']
  ): ResultType<JobRecord | undefined, JobStoreError> {
    return this.getJob({ jobId }) as ResultType<JobRecord | undefined, JobStoreError>
  }

  enqueue(request: EnqueueRequest): Operation<JobStoreNamespace.EnqueueResult> {
    try {
      const eventFailure = this.eventWriterFailure('enqueue')
      if (eventFailure !== undefined) return fail(eventFailure)
      const clock = this.readConfiguredClock()
      if (Result.isError(clock)) return fail(clock.error)
      const normalized = this.normalizeEnqueue(request, clock.value)
      if (Result.isError(normalized)) return fail(normalized.error)
      return this.enqueueNormalized(
        normalized.value,
        new Set()
      ) as unknown as Operation<JobStoreNamespace.EnqueueResult>
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read enqueue request' })
      )
    }
  }

  enqueueMany(requests: readonly EnqueueRequest[]): Operation<JobStoreNamespace.EnqueueManyResult> {
    try {
      const eventFailure = this.eventWriterFailure('enqueueMany')
      if (eventFailure !== undefined) return fail(eventFailure)
      if (!Array.isArray(requests)) {
        return fail(new JobDefinitionError({ field: 'requests', message: 'must be an array' }))
      }
      if (requests.length === 0) return ok(Object.freeze([]))

      const clock = this.readConfiguredClock()
      if (Result.isError(clock)) return fail(clock.error)
      const normalized: NormalizedEnqueue[] = []
      const explicitIds = new Set<string>()

      for (const request of requests) {
        const value = this.normalizeEnqueue(request, clock.value)
        if (Result.isError(value)) return fail(value.error)
        normalized.push(value.value)
        if (value.value.explicitId) explicitIds.add(value.value.id)
      }

      const results: JobStoreNamespace.EnqueueResult[] = []
      const reservedIds = new Set(explicitIds)
      for (const item of normalized) {
        const result = this.enqueueNormalized(item, reservedIds)
        if (Result.isError(result)) return fail(result.error)
        results.push(result.value)
        reservedIds.add(result.value.job.id)
      }

      return ok(Object.freeze(results))
    } catch {
      return fail(
        new JobDefinitionError({ field: 'requests', message: 'could not read enqueue requests' })
      )
    }
  }

  claim(request: ClaimRequest): Operation<JobStoreNamespace.ClaimResult> {
    const eventFailure = this.eventWriterFailure('claim')
    if (eventFailure !== undefined) return fail(eventFailure)
    if (this.claimInProgress) {
      return fail(
        jobStoreFailure('claim', 'claim cannot be re-enter while an ID is being generated')
      )
    }

    this.claimInProgress = true
    try {
      const fields = readDto(
        request,
        ['queue', 'accepted', 'limit', 'workerId', 'leaseDurationMs', 'now'],
        'request'
      )
      if (Result.isError(fields)) return fail(fields.error)
      const clock = this.readConfiguredClock()
      if (Result.isError(clock)) return fail(clock.error)
      const now = this.readOperationNow(fields.value.now, clock.value)
      if (Result.isError(now)) return fail(now.error)
      const queue = makeQueueName(fields.value.queue)
      const workerId = makeWorkerId(fields.value.workerId)
      const accepted = this.normalizeAccepted(fields.value.accepted)
      const limit = this.positiveInteger(fields.value.limit, 'limit')
      const leaseDuration = this.positiveDuration(fields.value.leaseDurationMs, 'leaseDurationMs')

      if (Result.isError(queue)) return fail(queue.error)
      if (Result.isError(workerId)) return fail(workerId.error)
      if (Result.isError(accepted)) return fail(accepted.error)
      if (Result.isError(limit)) return fail(limit.error)
      if (Result.isError(leaseDuration)) return fail(leaseDuration.error)
      const controls = this.controls.get(queue.value)
      if (controls?.enabled)
        return fail(
          new ControlsRevisionMismatchError({
            queue: queue.value,
            expected: controls.revision,
            actual: undefined
          })
        )
      if (now.value > maxSafeInteger - leaseDuration.value) {
        return fail(
          new JobDefinitionError({
            field: 'leaseDurationMs',
            message: 'lease expiry exceeds safe integer range'
          })
        )
      }

      const baseline = this.wakeBaseline(queue.value)
      const nextRunAt = this.nextRunAt(queue.value, accepted.value, now.value)
      if (this.paused.has(queue.value)) {
        return ok({
          jobs: Object.freeze([]),
          wakeToken: makeWakeToken(baseline),
          nextRunAt: undefined
        })
      }

      const candidates = this.claimCandidates(queue.value, accepted.value, now.value)
      const selected = candidates.slice(0, limit.value)
      const planned: { readonly previous: JobRecord; readonly transition: JobTransition }[] = []
      const reservedTokens = new Set<string>()

      for (const candidate of selected) {
        const token = this.generateLeaseToken(reservedTokens)
        if (Result.isError(token)) return fail(token.error)
        reservedTokens.add(token.value)
        const transition = reduceJob(candidate, {
          type: 'claim',
          jobId: candidate.id,
          workerId: workerId.value,
          leaseToken: token.value,
          leaseExpiresAt: now.value + leaseDuration.value,
          now: now.value
        })
        if (Result.isError(transition)) return fail(transition.error)
        planned.push({ previous: candidate, transition: transition.value })
      }

      for (const item of planned) {
        this.jobs.set(item.transition.record.id, item.transition.record)
        this.issuedLeaseTokens.add(item.transition.record.leaseToken!)
        this.appendEvent('job-claimed', item.transition.record, item.transition.record.updatedAt, {
          previous: item.previous
        })
      }
      if (planned.length > 0) this.invalidateListOrder(queue.value)

      const jobs = planned.map((item) => cloneRecord(item.transition.record) as ActiveJobSnapshot)
      return ok({ jobs: Object.freeze(jobs), wakeToken: makeWakeToken(baseline), nextRunAt })
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read claim request' })
      )
    } finally {
      this.claimInProgress = false
    }
  }

  getControls(request: { readonly queue: QueueName }): Operation<QueueControlsRecord | undefined> {
    const queue = makeQueueName(request.queue)
    if (Result.isError(queue)) return fail(queue.error)
    const record = this.controls.get(queue.value)
    return ok(record === undefined ? undefined : Object.freeze({ ...record }))
  }

  get(queue: QueueName): Operation<QueueControlsRecord | undefined> {
    return this.getControls({ queue })
  }

  reconcile(
    registry: AnyQueueControlsRegistry,
    options: ControlsReconcileOptions = {}
  ): Operation<ControlsReconcileReport> {
    try {
      if (registry === null || typeof registry !== 'object' || !Array.isArray(registry.controls)) {
        return fail(
          new JobDefinitionError({ field: 'registry', message: 'must be a controls registry' })
        )
      }
      const group = registry.group
      if (typeof group !== 'string' || group.length === 0 || group.length > 128) {
        return fail(
          new JobDefinitionError({
            field: 'registry.group',
            message: 'must be a bounded non-empty string'
          })
        )
      }
      const clock = this.readConfiguredClock()
      if (Result.isError(clock)) return fail(clock.error)
      const now = clock.value ?? Date.now()
      const requested = new Map<string, QueueControlsRecord>()
      for (const [index, definition] of registry.controls.entries()) {
        const queue = makeQueueName(definition?.queue)
        if (Result.isError(queue))
          return fail(
            new JobDefinitionError({
              field: `controls[${index}].queue`,
              message: queue.error.message
            })
          )
        const record = this.normalizeControlRecord(queue.value, group, definition.options, now)
        if (Result.isError(record)) return fail(record.error)
        if (requested.has(queue.value))
          return fail(
            new JobDefinitionError({ field: 'controls', message: 'contains a duplicate queue' })
          )
        requested.set(queue.value, record.value)
      }
      const created: QueueControlsRecord[] = []
      const updated: QueueControlsRecord[] = []
      const unchanged: QueueControlsRecord[] = []
      const disabled: QueueControlsRecord[] = []
      const warnings: string[] = []
      let eventWriterChecked = false
      const ensureEventWriter = (): JobStoreError | undefined => {
        if (eventWriterChecked) return undefined
        const failure = this.eventWriterFailure('reconcile')
        if (failure === undefined) eventWriterChecked = true
        return failure
      }
      for (const [queue, proposed] of requested) {
        const current = this.controls.get(queue)
        if (current === undefined) {
          const eventFailure = ensureEventWriter()
          if (eventFailure !== undefined) return fail(eventFailure)
          this.controls.set(queue, proposed)
          created.push(proposed)
        } else if (
          current.enabled &&
          current.group === proposed.group &&
          this.sameControlConfig(current, proposed)
        ) {
          unchanged.push(current)
        } else {
          const eventFailure = ensureEventWriter()
          if (eventFailure !== undefined) return fail(eventFailure)
          const next = Object.freeze({
            ...proposed,
            revision: current.revision + 1,
            createdAtMs: current.createdAtMs
          })
          this.controls.set(queue, next)
          updated.push(next)
        }
      }
      const removal = options.removal ?? 'warn'
      for (const [queue, current] of this.controls) {
        if (requested.has(queue)) continue
        if (removal === 'warn')
          warnings.push(`controls for queue "${queue}" are not present in the registry`)
        if (removal === 'disable' && current.enabled) {
          const eventFailure = ensureEventWriter()
          if (eventFailure !== undefined) return fail(eventFailure)
          const next = Object.freeze({
            ...current,
            enabled: false,
            revision: current.revision + 1,
            updatedAtMs: now
          })
          this.controls.set(queue, next)
          disabled.push(next)
        }
      }
      for (const record of created) {
        this.appendEvent('controls-reconciled', undefined, now, {
          queue: record.queue,
          attributes: { action: 'created' }
        })
      }
      for (const record of updated) {
        this.appendEvent('controls-reconciled', undefined, now, {
          queue: record.queue,
          attributes: { action: 'updated' }
        })
      }
      for (const record of disabled) {
        this.appendEvent('controls-reconciled', undefined, now, {
          queue: record.queue,
          attributes: { action: 'disabled' }
        })
      }
      return ok({
        created: Object.freeze(created),
        updated: Object.freeze(updated),
        unchanged: Object.freeze(unchanged),
        disabled: Object.freeze(disabled),
        warnings: Object.freeze(warnings),
        records: Object.freeze(
          [...this.controls.values()].map((record) => Object.freeze({ ...record }))
        )
      })
    } catch {
      return fail(
        new JobDefinitionError({ field: 'registry', message: 'could not read controls registry' })
      )
    }
  }

  claimControlled(request: ControlledClaimRequest): Operation<ControlledClaimResult> {
    const eventFailure = this.eventWriterFailure('claimControlled')
    if (eventFailure !== undefined) return fail(eventFailure)
    if (this.claimInProgress) {
      return fail(
        jobStoreFailure('claim', 'claim cannot be re-enter while an ID is being generated')
      )
    }

    this.claimInProgress = true
    try {
      return this.runCriticalSection(() => {
        try {
          const fields = readDto(
            request,
            [
              'queue',
              'accepted',
              'limit',
              'workerId',
              'leaseDurationMs',
              'now',
              'controlsRevision'
            ],
            'request'
          )
          if (Result.isError(fields)) return fail(fields.error)
          const clock = this.readConfiguredClock()
          if (Result.isError(clock)) return fail(clock.error)
          const now = this.readOperationNow(fields.value.now, clock.value)
          if (Result.isError(now)) return fail(now.error)
          const queue = makeQueueName(fields.value.queue)
          const workerId = makeWorkerId(fields.value.workerId)
          const accepted = this.normalizeAccepted(fields.value.accepted)
          const limit = this.positiveInteger(fields.value.limit, 'limit')
          const leaseDuration = this.positiveDuration(
            fields.value.leaseDurationMs,
            'leaseDurationMs'
          )
          const revision = this.positiveInteger(fields.value.controlsRevision, 'controlsRevision')
          if (Result.isError(queue)) return fail(queue.error)
          if (Result.isError(workerId)) return fail(workerId.error)
          if (Result.isError(accepted)) return fail(accepted.error)
          if (Result.isError(limit)) return fail(limit.error)
          if (Result.isError(leaseDuration)) return fail(leaseDuration.error)
          if (Result.isError(revision)) return fail(revision.error)
          const control = this.controls.get(queue.value)
          if (control === undefined || !control.enabled || control.revision !== revision.value) {
            return fail(
              new ControlsRevisionMismatchError({
                queue: queue.value,
                expected: revision.value,
                actual: control?.revision
              })
            )
          }
          const baseline = this.wakeBaseline(queue.value)
          const nextRunAtMs = this.nextRunAt(queue.value, accepted.value, now.value)
          if (this.paused.has(queue.value))
            return ok(
              this.emptyControlledClaim(makeWakeToken(baseline), nextRunAtMs, undefined, 'paused')
            )
          if (
            control.globalConcurrency !== undefined &&
            this.countPermits(queue.value) >= control.globalConcurrency
          ) {
            return ok(
              this.emptyControlledClaim(
                makeWakeToken(baseline),
                nextRunAtMs,
                undefined,
                'global-concurrency'
              )
            )
          }
          let window = this.rateWindows.get(queue.value)
          if (
            control.rateLimit !== undefined &&
            (window === undefined || now.value >= window.startedAtMs + control.rateLimit.durationMs)
          )
            window = undefined
          const rateRemaining =
            control.rateLimit === undefined
              ? maxSafeInteger
              : control.rateLimit.max - (window?.count ?? 0)
          if (rateRemaining <= 0)
            return ok(
              this.emptyControlledClaim(
                makeWakeToken(baseline),
                nextRunAtMs,
                window!.startedAtMs + control.rateLimit!.durationMs,
                'rate-limited'
              )
            )
          const candidates = this.claimCandidates(queue.value, accepted.value, now.value)
          if (candidates.length === 0)
            return ok(
              this.emptyControlledClaim(makeWakeToken(baseline), nextRunAtMs, undefined, 'empty')
            )
          const start = this.rotations.get(queue.value) ?? 0
          const globalRemaining =
            control.globalConcurrency === undefined
              ? maxSafeInteger
              : control.globalConcurrency - this.countPermits(queue.value)
          const capacity = Math.min(limit.value, rateRemaining, globalRemaining)
          const scanBudget = Math.min(candidates.length, Math.max(limit.value * 4, 32))
          const planned: {
            readonly transition: JobTransition
            readonly token: LeaseToken
            readonly dispatchKey: string
          }[] = []
          let blockedByKey = false
          let examined = 0
          for (let step = 0; step < scanBudget && planned.length < capacity; step += 1) {
            const candidate = candidates[(start + step) % candidates.length]
            if (candidate === undefined) continue
            examined = step + 1
            const dispatchKey = candidate.dispatchKey ?? noDispatchKey
            const plannedForKey = planned.filter((item) => item.dispatchKey === dispatchKey).length
            if (
              control.perKeyConcurrency !== undefined &&
              this.countPermits(queue.value, dispatchKey) + plannedForKey >=
                control.perKeyConcurrency
            ) {
              blockedByKey = true
              continue
            }
            const token = this.generateLeaseToken(new Set(planned.map((item) => item.token)))
            if (Result.isError(token)) return fail(token.error)
            const transition = reduceJob(candidate, {
              type: 'claim',
              jobId: candidate.id,
              workerId: workerId.value,
              leaseToken: token.value,
              leaseExpiresAt: now.value + leaseDuration.value,
              now: now.value
            })
            if (Result.isError(transition)) return fail(transition.error)
            planned.push({ transition: transition.value, token: token.value, dispatchKey })
          }
          this.rotations.set(queue.value, (start + Math.max(1, examined)) % candidates.length)
          for (const item of planned) {
            this.jobs.set(item.transition.record.id, item.transition.record)
            this.issuedLeaseTokens.add(item.token)
            this.controlledPermits.set(item.transition.record.id, {
              leaseToken: item.token,
              dispatchKey: item.dispatchKey
            })
            this.appendEvent('controls-claimed', item.transition.record, now.value)
          }
          if (planned.length > 0) {
            if (control.rateLimit !== undefined)
              this.rateWindows.set(queue.value, {
                startedAtMs: window?.startedAtMs ?? now.value,
                count: (window?.count ?? 0) + planned.length
              })
            this.invalidateListOrder(queue.value)
            this.notifyQueues([queue.value])
          }
          if (planned.length === 0)
            return ok(
              this.emptyControlledClaim(
                makeWakeToken(baseline),
                nextRunAtMs,
                undefined,
                blockedByKey ? 'per-key-concurrency' : 'empty'
              )
            )
          const jobs = Object.freeze(
            planned.map((item) => cloneRecord(item.transition.record) as ActiveJobSnapshot)
          )
          return ok({
            jobs,
            wakeToken: makeWakeToken(baseline),
            nextRunAtMs,
            nextEligibleAtMs: undefined,
            reason: undefined
          })
        } catch {
          return fail(
            new JobDefinitionError({
              field: 'request',
              message: 'could not read controlled claim request'
            })
          )
        }
      })
    } finally {
      this.claimInProgress = false
    }
  }

  settleControlled(
    request: ControlledSettleRequest
  ): Operation<JobStoreNamespace.SettlementResult> {
    const checked = this.assertControlledJobRevision(request.jobId, request.controlsRevision)
    if (Result.isError(checked)) return fail(checked.error)
    const { controlsRevision: _controlsRevision, ...settlement } = request
    return this.settle(
      settlement,
      'controls-settled'
    ) as Operation<JobStoreNamespace.SettlementResult>
  }

  releaseControlled(request: ControlledReleaseRequest): Operation<JobStoreNamespace.ReleaseResult> {
    const checked = this.assertControlledJobRevision(request.jobId, request.controlsRevision)
    if (Result.isError(checked)) return fail(checked.error)
    const { controlsRevision: _controlsRevision, ...release } = request
    return this.release(release, 'controls-released')
  }

  recoverStalledControlled(
    request: ControlledRecoverStalledRequest
  ): Operation<JobStoreNamespace.RecoverStalledResult> {
    const queue = makeQueueName(request.queue)
    if (Result.isError(queue)) return fail(queue.error)
    const control = this.controls.get(queue.value)
    if (control === undefined || !control.enabled || control.revision !== request.controlsRevision)
      return fail(
        new ControlsRevisionMismatchError({
          queue: queue.value,
          expected: request.controlsRevision,
          actual: control?.revision
        })
      )
    const { controlsRevision: _controlsRevision, ...recovery } = request
    return this.recoverStalled(recovery, 'controls-stalled-recovered')
  }

  cancelControlled(request: ControlledCancelRequest): Operation<JobStoreNamespace.CancelResult> {
    const checked = this.assertControlledJobRevision(request.jobId, request.controlsRevision)
    if (Result.isError(checked)) return fail(checked.error)
    const current = this.jobs.get(request.jobId)
    const { controlsRevision: _controlsRevision, ...cancel } = request
    return current?.state === 'active'
      ? this.requestCancellation(cancel, 'controls-cancelled')
      : this.cancel(cancel, 'controls-cancelled')
  }

  settle(
    request: SettleRequest,
    additionalEventType?: DurableJobEventType
  ): Operation<JobStoreNamespace.SettlementResult> {
    try {
      const eventFailure = this.eventWriterFailure('settle')
      if (eventFailure !== undefined) return fail(eventFailure)
      const fields = readDto(
        request,
        ['jobId', 'leaseToken', 'outcome', 'now', 'startedAt'],
        'request'
      )
      if (Result.isError(fields)) return fail(fields.error)
      const clock = this.readConfiguredClock()
      if (Result.isError(clock)) return fail(clock.error)
      const now = this.readOperationNow(fields.value.now, clock.value)
      if (Result.isError(now)) return fail(now.error)
      const jobId = makeJobId(fields.value.jobId)
      const leaseToken = makeLeaseToken(fields.value.leaseToken)
      if (Result.isError(jobId)) return fail(jobId.error)
      if (Result.isError(leaseToken)) return fail(leaseToken.error)
      const current = this.jobs.get(jobId.value)
      if (current === undefined) return fail(new JobNotFoundError({ jobId: jobId.value }))
      const outcomeDigest = canonicalJson(fields.value.outcome)
      if (current.state !== 'active') {
        const settled = this.settled.get(jobId.value)
        const previousAttempt = this.attempts.get(jobId.value)?.at(-1)
        if (settled?.leaseToken === leaseToken.value && previousAttempt !== undefined) {
          if (settled.outcomeDigest !== outcomeDigest) {
            return fail(
              new SettlementConflictError({
                jobId: jobId.value,
                leaseToken: leaseToken.value
              })
            )
          }
          return ok({
            record: cloneRecord(current),
            attempt: cloneAttempt(previousAttempt),
            status: 'already-applied'
          })
        }
        return fail(
          new LeaseLostError({
            jobId: jobId.value,
            reason: 'missing-lease',
            leaseToken: leaseToken.value
          })
        )
      }

      const command =
        fields.value.startedAt === undefined
          ? {
              type: 'settle' as const,
              jobId: jobId.value,
              leaseToken: leaseToken.value,
              outcome: fields.value.outcome as SettleRequest['outcome'],
              now: now.value
            }
          : {
              type: 'settle' as const,
              jobId: jobId.value,
              leaseToken: leaseToken.value,
              outcome: fields.value.outcome as SettleRequest['outcome'],
              now: now.value,
              startedAt: fields.value.startedAt as number
            }
      const transition = reduceJob(current, command)
      if (Result.isError(transition)) return fail(transition.error)
      const attempt = transition.value.attempt
      if (attempt === undefined) {
        return fail(
          new JobDefinitionError({
            field: 'attempt',
            message: 'settlement did not record an attempt'
          })
        )
      }
      const prepared = this.prepareTransition(transition.value, current)
      if (Result.isError(prepared)) return fail(prepared.error)
      this.commitPrepared(
        [prepared.value],
        true,
        additionalEventType ?? this.settlementEventType(attempt)
      )
      this.releaseControlledPermit(jobId.value, leaseToken.value)
      this.settled.set(jobId.value, { leaseToken: leaseToken.value, outcomeDigest })
      return ok({
        record: cloneRecord(prepared.value.transition.record),
        attempt: cloneAttempt(attempt),
        status: 'applied'
      })
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read settlement request' })
      )
    }
  }

  release(
    request: JobStoreNamespace.ReleaseRequest,
    additionalEventType?: DurableJobEventType
  ): Operation<JobStoreNamespace.ReleaseResult> {
    try {
      const eventFailure = this.eventWriterFailure('release')
      if (eventFailure !== undefined) return fail(eventFailure)
      const fields = readDto(request, ['jobId', 'leaseToken', 'now'], 'request')
      if (Result.isError(fields)) return fail(fields.error)
      const clock = this.readConfiguredClock()
      if (Result.isError(clock)) return fail(clock.error)
      const now = this.readOperationNow(fields.value.now, clock.value)
      if (Result.isError(now)) return fail(now.error)
      const jobId = makeJobId(fields.value.jobId)
      const leaseToken = makeLeaseToken(fields.value.leaseToken)
      if (Result.isError(jobId)) return fail(jobId.error)
      if (Result.isError(leaseToken)) return fail(leaseToken.error)
      const current = this.jobs.get(jobId.value)
      if (current === undefined) return fail(new JobNotFoundError({ jobId: jobId.value }))
      if (current.state !== 'active') {
        return fail(
          new LeaseLostError({
            jobId: jobId.value,
            reason: 'missing-lease',
            leaseToken: leaseToken.value
          })
        )
      }
      const transition = reduceJob(current, {
        type: 'release',
        jobId: jobId.value,
        leaseToken: leaseToken.value,
        now: now.value
      })
      if (Result.isError(transition)) return fail(transition.error)
      const prepared = this.prepareTransition(transition.value, current)
      if (Result.isError(prepared)) return fail(prepared.error)
      this.commitPrepared([prepared.value], true, additionalEventType ?? 'job-released')
      this.releaseControlledPermit(jobId.value, leaseToken.value)
      return ok(snapshotTransition(prepared.value.transition))
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read release request' })
      )
    }
  }

  heartbeat(request: HeartbeatRequest): Operation<JobStoreNamespace.HeartbeatResult> {
    try {
      const eventFailure = this.eventWriterFailure('heartbeat')
      if (eventFailure !== undefined) return fail(eventFailure)
      const fields = readDto(request, ['leases', 'leaseDurationMs', 'now'], 'request')
      if (Result.isError(fields)) return fail(fields.error)
      const clock = this.readConfiguredClock()
      if (Result.isError(clock)) return fail(clock.error)
      const now = this.readOperationNow(fields.value.now, clock.value)
      if (Result.isError(now)) return fail(now.error)
      const leases = this.normalizeLeases(fields.value.leases)
      const duration = this.positiveDuration(fields.value.leaseDurationMs, 'leaseDurationMs')
      if (Result.isError(leases)) return fail(leases.error)
      if (Result.isError(duration)) return fail(duration.error)
      if (now.value > maxSafeInteger - duration.value) {
        return fail(
          new JobDefinitionError({
            field: 'leaseDurationMs',
            message: 'lease expiry exceeds safe integer range'
          })
        )
      }

      const renewed: ActiveJobSnapshot[] = []
      const lost: LostLease[] = []
      const cancellationRequested: JobId[] = []
      const changes: JobRecord[] = []

      for (const lease of leases.value) {
        const current = this.jobs.get(lease.jobId)
        if (current === undefined) {
          lost.push(
            Object.freeze({
              jobId: lease.jobId,
              leaseToken: lease.leaseToken,
              reason: 'missing-lease'
            })
          )
          continue
        }
        if (current.state !== 'active') {
          lost.push(
            Object.freeze({
              jobId: lease.jobId,
              leaseToken: lease.leaseToken,
              reason: 'missing-lease'
            })
          )
          continue
        }
        if (now.value < current.updatedAt) {
          return fail(
            new JobDefinitionError({
              field: 'now',
              message: 'must not be earlier than updatedAt'
            })
          )
        }
        if (current.leaseToken !== lease.leaseToken) {
          lost.push(
            Object.freeze({
              jobId: lease.jobId,
              leaseToken: lease.leaseToken,
              reason: 'mismatched-token'
            })
          )
          continue
        }
        if (current.leaseExpiresAt === undefined || now.value >= current.leaseExpiresAt) {
          lost.push(
            Object.freeze({
              jobId: lease.jobId,
              leaseToken: lease.leaseToken,
              reason: 'expired-lease'
            })
          )
          continue
        }
        if (current.cancellationRequestedAt !== undefined) {
          cancellationRequested.push(current.id)
          continue
        }

        const next = makeJobRecord({
          ...current,
          leaseExpiresAt: now.value + duration.value,
          updatedAt: now.value
        })
        if (Result.isError(next)) return fail(next.error)
        changes.push(next.value)
        renewed.push(cloneRecord(next.value) as ActiveJobSnapshot)
      }

      for (const change of changes) {
        this.jobs.set(change.id, change)
        this.invalidateListOrder(change.queue)
      }

      return ok({
        renewed: Object.freeze(renewed),
        lost: Object.freeze(lost),
        cancellationRequested: Object.freeze(cancellationRequested)
      })
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read heartbeat request' })
      )
    }
  }

  recoverStalled(
    request: RecoverStalledRequest,
    additionalEventType?: DurableJobEventType
  ): Operation<JobStoreNamespace.RecoverStalledResult> {
    try {
      const eventFailure = this.eventWriterFailure('recoverStalled')
      if (eventFailure !== undefined) return fail(eventFailure)
      const fields = readDto(request, ['queue', 'maxStalledCount', 'limit', 'now'], 'request')
      if (Result.isError(fields)) return fail(fields.error)
      const queue =
        fields.value.queue === undefined
          ? Result.ok<QueueName | undefined>(undefined)
          : makeQueueName(fields.value.queue)
      if (Result.isError(queue)) return fail(queue.error)
      const clock = this.readConfiguredClock()
      if (Result.isError(clock)) return fail(clock.error)
      const now = this.readOperationNow(fields.value.now, clock.value)
      if (Result.isError(now)) return fail(now.error)
      const maximum = this.nonNegativeInteger(fields.value.maxStalledCount, 'maxStalledCount')
      const limit =
        fields.value.limit === undefined
          ? Result.ok(maxSafeInteger)
          : this.positiveInteger(fields.value.limit, 'limit')
      if (Result.isError(maximum)) return fail(maximum.error)
      if (Result.isError(limit)) return fail(limit.error)

      const planned: PreparedTransition[] = []
      let nextSequence = this.sequence
      for (const current of this.jobs.values()) {
        if (planned.length >= limit.value) break
        if (queue.value !== undefined && current.queue !== queue.value) continue
        if (
          current.state !== 'active' ||
          current.leaseExpiresAt === undefined ||
          now.value < current.leaseExpiresAt
        ) {
          continue
        }

        const transition = recoverStalledWithPolicy(
          current,
          {
            type: 'recover-stalled',
            jobId: current.id,
            now: now.value
          },
          current.stalledCount >= maximum.value
        )
        if (Result.isError(transition)) return fail(transition.error)
        const prepared = this.prepareTransitionAt(transition.value, current, nextSequence)
        if (Result.isError(prepared)) return fail(prepared.error)
        nextSequence = prepared.value.nextSequence
        planned.push(prepared.value)
      }

      this.commitPrepared(planned, true, additionalEventType ?? 'job-stalled-recovered')
      for (const item of planned) {
        if (item.transition.record.state !== 'active') {
          const permit = this.controlledPermits.get(item.transition.record.id)
          if (permit?.leaseToken === item.previous.leaseToken)
            this.controlledPermits.delete(item.transition.record.id)
        }
      }
      return ok({
        transitions: Object.freeze(planned.map(({ transition }) => snapshotTransition(transition))),
        recovered: planned.length
      })
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read recovery request' })
      )
    }
  }

  awaitWake(request: JobStoreNamespace.AwaitWakeRequest): Operation<void> {
    try {
      const fields = readDto(request, ['queues', 'wakeToken', 'signal'], 'request')
      if (Result.isError(fields)) return fail(fields.error)
      const queues = this.normalizeWakeQueues(fields.value.queues)
      if (Result.isError(queues)) return fail(queues.error)
      const baseline = parseWakeToken(fields.value.wakeToken)
      if (Result.isError(baseline)) return fail(baseline.error)
      const signal = fields.value.signal
      if (!isAbortSignal(signal)) return fail(wakeFailure('signal must be an AbortSignal'))
      if (signal.aborted) return fail(new JobStoreWakeAbortedError())
      if (this.hasRelevantWake(baseline.value, queues.value)) return ok(undefined)

      return new Promise<Operation<void>>((resolve) => {
        const waiter: WakeWaiter = {
          queues: queues.value,
          baseline: baseline.value,
          signal,
          onAbort: () => this.finishWaiter(waiter, fail<void>(new JobStoreWakeAbortedError())),
          resolve,
          settled: false
        }

        try {
          this.waiters.add(waiter)
          signal.addEventListener('abort', waiter.onAbort, { once: true })
          if (signal.aborted) {
            this.finishWaiter(waiter, fail<void>(new JobStoreWakeAbortedError()))
          } else if (this.hasRelevantWake(waiter.baseline, waiter.queues)) {
            this.finishWaiter(waiter, ok(undefined))
          }
        } catch {
          this.finishWaiter(waiter, fail<void>(wakeFailure('could not install wake waiter')))
        }
      }) as unknown as Operation<void>
    } catch {
      return fail(wakeFailure('could not read wake request'))
    }
  }

  getJob(request: JobStoreNamespace.GetJobRequest): Operation<JobRecord | undefined> {
    try {
      const fields = readDto(request, ['jobId'], 'request')
      if (Result.isError(fields)) return fail(fields.error)
      const jobId = makeJobId(fields.value.jobId)
      if (Result.isError(jobId)) return fail(jobId.error)
      const record = this.jobs.get(jobId.value)
      return ok(record === undefined ? undefined : cloneRecord(record))
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read getJob request' })
      )
    }
  }

  getAttempts(request: JobStoreNamespace.GetAttemptsRequest): Operation<readonly AttemptRecord[]> {
    try {
      const fields = readDto(request, ['jobId'], 'request')
      if (Result.isError(fields)) return fail(fields.error)
      const jobId = makeJobId(fields.value.jobId)
      if (Result.isError(jobId)) return fail(jobId.error)
      const attempts = this.attempts.get(jobId.value) ?? []
      return ok(Object.freeze(attempts.map(cloneAttempt)))
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read getAttempts request' })
      )
    }
  }

  list(request: ListJobsRequest): Operation<JobStoreNamespace.ListJobsResult> {
    try {
      const unknown = this.firstUnsupportedField(request, [
        'queue',
        'name',
        'version',
        'state',
        'metadata',
        'orderBy',
        'order',
        'limit',
        'cursor'
      ])
      if (unknown !== undefined)
        return fail(new UnsupportedJobStoreOperationError({ operation: `list.${unknown}` }))
      const fields = readDto(
        request,
        ['queue', 'name', 'version', 'state', 'metadata', 'orderBy', 'order', 'limit', 'cursor'],
        'request'
      )
      if (Result.isError(fields)) return fail(fields.error)
      const limit = this.positiveInteger(fields.value.limit, 'limit')
      const queue =
        fields.value.queue === undefined
          ? Result.ok<string | undefined>(undefined)
          : makeQueueName(fields.value.queue)
      const name =
        fields.value.name === undefined
          ? Result.ok<string | undefined>(undefined)
          : makeJobName(fields.value.name)
      const version =
        fields.value.version === undefined
          ? Result.ok<number | undefined>(undefined)
          : this.positiveInteger(fields.value.version, 'version')
      const states = this.normalizeStates(fields.value.state)
      const metadata = this.normalizeMetadataFilter(fields.value.metadata)
      const orderBy = this.normalizeListOrderBy(fields.value.orderBy)
      const order = this.normalizeListOrder(fields.value.order)
      if (Result.isError(limit)) return fail(limit.error)
      if (Result.isError(queue)) return fail(queue.error)
      if (Result.isError(name)) return fail(name.error)
      if (Result.isError(version)) return fail(version.error)
      if (Result.isError(states)) return fail(states.error)
      if (Result.isError(metadata)) return fail(metadata.error)
      if (Result.isError(orderBy)) return fail(orderBy.error)
      if (Result.isError(order)) return fail(order.error)
      const cursor = this.normalizeCursor(fields.value.cursor)
      if (Result.isError(cursor)) return fail(cursor.error)

      const signature = this.listSignature(
        queue.value,
        name.value,
        version.value,
        states.value,
        metadata.value,
        orderBy.value,
        order.value
      )
      if (
        cursor.value !== undefined &&
        (cursor.value.filterSignature !== signature ||
          cursor.value.orderBy !== orderBy.value ||
          cursor.value.order !== order.value)
      ) {
        return fail(new UnsupportedJobStoreOperationError({ operation: 'list.cursor-options' }))
      }

      const ordered = this.getListOrder(orderBy.value, order.value)
      const start = this.findCursorStart(ordered, cursor.value)
      const matched: JobRecord[] = []
      let hasMore = false
      for (let index = start; index < ordered.length; index += 1) {
        const record = ordered[index]
        if (
          record === undefined ||
          !this.matchesList(
            record,
            queue.value,
            name.value,
            version.value,
            states.value,
            metadata.value
          )
        )
          continue
        if (matched.length < limit.value) {
          matched.push(cloneRecord(record))
        } else {
          hasMore = true
          break
        }
      }

      const last = matched[matched.length - 1]
      const nextCursor =
        hasMore && last !== undefined
          ? this.makeCursor(last, signature, orderBy.value, order.value)
          : undefined
      return ok({ jobs: Object.freeze(matched), nextCursor })
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read list request' })
      )
    }
  }

  counts(request?: CountsRequest): Operation<JobCounts> {
    try {
      const unknown = this.firstUnsupportedField(request, ['queue', 'name'])
      if (unknown !== undefined)
        return fail(new UnsupportedJobStoreOperationError({ operation: `counts.${unknown}` }))
      const fields =
        request === undefined
          ? Result.ok<Readonly<Record<string, unknown>>>({})
          : readDto(request, ['queue', 'name'], 'request')
      if (Result.isError(fields)) return fail(fields.error)
      const queue =
        fields.value.queue === undefined
          ? Result.ok<string | undefined>(undefined)
          : makeQueueName(fields.value.queue)
      const name =
        fields.value.name === undefined
          ? Result.ok<string | undefined>(undefined)
          : makeJobName(fields.value.name)
      if (Result.isError(queue)) return fail(queue.error)
      if (Result.isError(name)) return fail(name.error)

      const counts = {
        total: 0,
        waiting: 0,
        delayed: 0,
        active: 0,
        completed: 0,
        failed: 0,
        cancelled: 0
      }
      for (const record of this.jobs.values()) {
        if (
          (queue.value !== undefined && record.queue !== queue.value) ||
          (name.value !== undefined && record.name !== name.value)
        ) {
          continue
        }
        counts.total += 1
        const state = record.state as keyof Omit<typeof counts, 'total'>
        counts[state] += 1
      }
      return ok(Object.freeze(counts))
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read counts request' })
      )
    }
  }

  retry(request: JobStoreNamespace.RetryRequest): Operation<JobStoreNamespace.RetryResult> {
    try {
      const eventFailure = this.eventWriterFailure('retry')
      if (eventFailure !== undefined) return fail(eventFailure)
      const fields = readDto(request, ['jobId', 'runAt', 'now'], 'request')
      if (Result.isError(fields)) return fail(fields.error)
      const clock = this.readConfiguredClock()
      if (Result.isError(clock)) return fail(clock.error)
      const now = this.readOperationNow(fields.value.now, clock.value)
      if (Result.isError(now)) return fail(now.error)
      const jobId = makeJobId(fields.value.jobId)
      const runAt = validateTimestamp(fields.value.runAt, 'runAt')
      if (Result.isError(jobId)) return fail(jobId.error)
      if (Result.isError(runAt)) return fail(runAt.error)
      const current = this.jobs.get(jobId.value)
      if (current === undefined) return fail(new JobNotFoundError({ jobId: jobId.value }))
      return this.transitionById(current, {
        type: 'retry',
        jobId: current.id,
        runAt: runAt.value,
        now: now.value
      }) as Operation<JobStoreNamespace.RetryResult>
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read retry request' })
      )
    }
  }

  cancel(
    request: JobStoreNamespace.CancelRequest,
    additionalEventType?: DurableJobEventType
  ): Operation<JobStoreNamespace.CancelResult> {
    return this.simpleTransition(
      request,
      'cancel',
      additionalEventType
    ) as Operation<JobStoreNamespace.CancelResult>
  }

  requestCancellation(
    request: JobStoreNamespace.RequestCancellationRequest,
    additionalEventType?: DurableJobEventType
  ): Operation<JobStoreNamespace.RequestCancellationResult> {
    return this.simpleTransition(
      request,
      'request-cancellation',
      additionalEventType
    ) as Operation<JobStoreNamespace.RequestCancellationResult>
  }

  promote(request: JobStoreNamespace.PromoteRequest): Operation<JobStoreNamespace.PromoteResult> {
    return this.simpleTransition(request, 'promote') as Operation<JobStoreNamespace.PromoteResult>
  }

  remove(request: JobStoreNamespace.RemoveRequest): Operation<JobStoreNamespace.RemoveResult> {
    try {
      const eventFailure = this.eventWriterFailure('remove')
      if (eventFailure !== undefined) return fail(eventFailure)
      const fields = readDto(request, ['jobId', 'now', 'expectedState'], 'request')
      if (Result.isError(fields)) return fail(fields.error)
      const clock = this.readConfiguredClock()
      if (Result.isError(clock)) return fail(clock.error)
      const now = this.readOperationNow(fields.value.now, clock.value)
      if (Result.isError(now)) return fail(now.error)
      const jobId = makeJobId(fields.value.jobId)
      if (Result.isError(jobId)) return fail(jobId.error)
      if (fields.value.expectedState !== undefined && !isJobState(fields.value.expectedState)) {
        return fail(
          new JobDefinitionError({ field: 'expectedState', message: 'unsupported job state' })
        )
      }
      const current = this.jobs.get(jobId.value)
      if (current === undefined) return fail(new JobNotFoundError({ jobId: jobId.value }))
      if (now.value < current.updatedAt) {
        return fail(
          new JobDefinitionError({ field: 'now', message: 'must not be earlier than updatedAt' })
        )
      }
      if (
        fields.value.expectedState !== undefined &&
        fields.value.expectedState !== current.state
      ) {
        return fail(
          new InvalidJobTransitionError({
            jobId: current.id,
            from: current.state,
            operation: 'remove'
          })
        )
      }
      if (current.state === 'active') {
        return fail(
          new InvalidJobTransitionError({
            jobId: current.id,
            from: current.state,
            operation: 'remove'
          })
        )
      }

      this.appendEvent('job-removed', current, now.value)
      this.jobs.delete(current.id)
      this.attempts.delete(current.id)
      this.removeIdempotency(current)
      this.invalidateListOrder(current.queue)
      return ok({ job: cloneRecord(current), removed: true })
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read remove request' })
      )
    }
  }

  pause(request: JobStoreNamespace.PauseQueueRequest): Operation<QueuePauseResult> {
    return this.pauseOrResume(request, true) as Operation<QueuePauseResult>
  }

  resume(request: JobStoreNamespace.PauseQueueRequest): Operation<QueuePauseResult> {
    return this.pauseOrResume(request, false) as Operation<QueuePauseResult>
  }

  pausedQueues(): Operation<readonly QueueName[]> {
    try {
      const queues = [...this.paused].map((queue) => makeQueueName(queue))
      const values: QueueName[] = []
      for (const queue of queues) {
        if (Result.isError(queue)) return fail(queue.error)
        values.push(queue.value)
      }
      return ok(Object.freeze(values))
    } catch {
      return fail(
        new JobDefinitionError({ field: 'queues', message: 'could not read paused queues' })
      )
    }
  }

  private normalizeControlRecord(
    queue: QueueName,
    group: string,
    options: AnyQueueControlsRegistry['controls'][number]['options'],
    now: number
  ): ResultType<QueueControlsRecord, JobStoreError> {
    const positive = (value: unknown, field: string): ResultType<number, JobStoreError> =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? Result.ok(value)
        : definitionFailure(field, 'must be a positive safe integer')
    const global =
      options.globalConcurrency === undefined
        ? Result.ok<number | undefined>(undefined)
        : positive(options.globalConcurrency, 'globalConcurrency')
    const perKey =
      options.perKeyConcurrency === undefined
        ? Result.ok<number | undefined>(undefined)
        : positive(options.perKeyConcurrency, 'perKeyConcurrency')
    if (Result.isError(global)) return global
    if (Result.isError(perKey)) return perKey
    let rateLimit: QueueControlsRecord['rateLimit']
    if (options.rateLimit === undefined) rateLimit = undefined
    else {
      const max = positive(options.rateLimit.max, 'rateLimit.max')
      const durationMs = positive(options.rateLimit.durationMs, 'rateLimit.durationMs')
      if (Result.isError(max)) return max
      if (Result.isError(durationMs)) return durationMs
      rateLimit = Object.freeze({ max: max.value, durationMs: durationMs.value })
    }
    return Result.ok(
      Object.freeze({
        queue,
        group,
        enabled: true,
        revision: 1,
        globalConcurrency: global.value,
        perKeyConcurrency: perKey.value,
        rateLimit,
        createdAtMs: now,
        updatedAtMs: now
      })
    )
  }

  private sameControlConfig(left: QueueControlsRecord, right: QueueControlsRecord): boolean {
    return (
      left.enabled === right.enabled &&
      left.globalConcurrency === right.globalConcurrency &&
      left.perKeyConcurrency === right.perKeyConcurrency &&
      left.rateLimit?.max === right.rateLimit?.max &&
      left.rateLimit?.durationMs === right.rateLimit?.durationMs
    )
  }

  private emptyControlledClaim(
    wakeToken: WakeToken,
    nextRunAtMs: number | undefined,
    nextEligibleAtMs: number | undefined,
    reason: ControlledEmptyClaim['reason']
  ): ControlledClaimResult {
    return { jobs: Object.freeze([]), wakeToken, nextRunAtMs, nextEligibleAtMs, reason }
  }

  private countPermits(queue: string, dispatchKey?: string): number {
    let count = 0
    for (const job of this.jobs.values()) {
      if (
        job.queue === queue &&
        job.state === 'active' &&
        (dispatchKey === undefined || (job.dispatchKey ?? noDispatchKey) === dispatchKey)
      )
        count += 1
    }
    return count
  }

  private releaseControlledPermit(jobId: JobId, leaseToken: LeaseToken): void {
    const permit = this.controlledPermits.get(jobId)
    if (permit?.leaseToken === leaseToken) {
      this.controlledPermits.delete(jobId)
      const job = this.jobs.get(jobId)
      if (job !== undefined) this.notifyQueues([job.queue])
    }
  }

  private assertControlledJobRevision(
    jobId: import('../protocol').JobId,
    expected: number
  ): ResultType<void, JobStoreError> {
    const job = this.jobs.get(jobId)
    if (job === undefined) return Result.err(new JobNotFoundError({ jobId }))
    const control = this.controls.get(job.queue)
    if (control === undefined || !control.enabled || control.revision !== expected) {
      return Result.err(
        new ControlsRevisionMismatchError({ queue: job.queue, expected, actual: control?.revision })
      )
    }
    return Result.ok()
  }

  private validateOptions(options: MemoryJobStoreOptions): void {
    if (!isObject(options)) throw new TypeError('MemoryJobStore options must be an object')
    if (options.clock !== undefined) {
      const clock = options.clock
      if (
        typeof clock !== 'function' &&
        (!isObject(clock) || typeof (clock as { readonly now?: unknown }).now !== 'function')
      ) {
        throw new TypeError('MemoryJobStore clock must expose now()')
      }
    }
    if (options.idGenerator !== undefined) {
      const generator = options.idGenerator
      if (
        typeof generator !== 'function' &&
        (!isObject(generator) ||
          typeof (generator as { readonly next?: unknown }).next !== 'function')
      ) {
        throw new TypeError('MemoryJobStore idGenerator must expose next()')
      }
    }
  }

  private readConfiguredClock(): ResultType<number | undefined, JobStoreError> {
    if (this.clock === undefined) return Result.ok(undefined)
    try {
      const value = typeof this.clock === 'function' ? this.clock() : this.clock.now()
      const checked = normalizeClockValue(value)
      return checked
    } catch {
      return Result.err(jobStoreFailure('clock', 'configured clock failed'))
    }
  }

  private readOperationNow(
    value: unknown,
    configured: number | undefined
  ): ResultType<number, JobStoreError> {
    const now = validateTimestamp(value, 'now')
    if (Result.isError(now)) return now
    if (configured !== undefined && configured !== now.value) {
      return definitionFailure('now', 'does not match the configured clock')
    }
    return now
  }

  private normalizeEnqueue(
    request: EnqueueRequest,
    configuredClock: number | undefined
  ): ResultType<NormalizedEnqueue, JobStoreError> {
    const fields = readDto(
      request,
      [
        'id',
        'idempotencyKey',
        'payload',
        'dispatchKey',
        'metadata',
        'priority',
        'runAt',
        'attemptsMax',
        'backoff',
        'timeoutMs',
        'parent',
        'now',
        'job',
        'identity'
      ],
      'request'
    )
    if (Result.isError(fields)) return fields
    const now = this.readOperationNow(fields.value.now, configuredClock)
    if (Result.isError(now)) return now
    const identity = identityFromFields(fields.value)
    if (Result.isError(identity)) return identity
    const id =
      fields.value.id === undefined ? Result.ok<JobId>(validationId) : makeJobId(fields.value.id)
    if (Result.isError(id)) return id
    const runAt = validateTimestamp(fields.value.runAt, 'runAt')
    if (Result.isError(runAt)) return runAt
    const timeout = validateOptionalDuration(fields.value.timeoutMs, 'timeoutMs')
    if (Result.isError(timeout)) return timeout
    if (timeout.value === 0) {
      return definitionFailure('timeoutMs', 'must be greater than zero')
    }
    const parent =
      fields.value.parent === undefined
        ? Result.ok<ParentEnvelope | undefined>(undefined)
        : validateParentEnvelope(fields.value.parent)
    if (Result.isError(parent)) return parent

    const candidate = makeJobRecord({
      id: id.value,
      name: identity.value.name,
      version: identity.value.version,
      queue: identity.value.queue,
      state: runAt.value <= now.value ? 'waiting' : 'delayed',
      payload: fields.value.payload,
      dispatchKey: fields.value.dispatchKey,
      metadata: fields.value.metadata === undefined ? {} : fields.value.metadata,
      priority: fields.value.priority === undefined ? 0 : fields.value.priority,
      runAt: runAt.value,
      orderingSequence: 0,
      attemptsMax: fields.value.attemptsMax,
      attemptsMade: 0,
      attemptSequence: 0,
      deliveryCount: 0,
      stalledCount: 0,
      backoff: fields.value.backoff,
      timeoutMs: timeout.value,
      idempotencyKey: fields.value.idempotencyKey,
      createdAt: now.value,
      updatedAt: now.value,
      processedAt: undefined,
      finishedAt: undefined,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      cancellationRequestedAt: undefined,
      result: undefined,
      failure: undefined
    })
    if (Result.isError(candidate)) return candidate

    return Result.ok({
      id: fields.value.id === undefined ? validationId : id.value,
      explicitId: fields.value.id !== undefined,
      identity: identity.value,
      payload: candidate.value.payload,
      dispatchKey: candidate.value.dispatchKey,
      metadata: candidate.value.metadata,
      priority: candidate.value.priority,
      runAt: runAt.value,
      attemptsMax: candidate.value.attemptsMax,
      backoff: candidate.value.backoff,
      timeoutMs: candidate.value.timeoutMs,
      idempotencyKey: candidate.value.idempotencyKey,
      parent: parent.value,
      now: now.value
    })
  }

  private enqueueNormalized(
    input: NormalizedEnqueue,
    reservedIds: Set<string>
  ): ResultType<JobStoreNamespace.EnqueueResult, JobStoreError> {
    // Explicit IDs are the primary identity. Check them before idempotency and
    // never let a secondary key return a different existing Job.
    if (input.explicitId) {
      const existing = this.jobs.get(input.id)
      if (existing !== undefined) return Result.ok({ job: cloneRecord(existing), duplicate: true })
    }

    const dedupe =
      input.explicitId || input.idempotencyKey === undefined
        ? undefined
        : `${identityKey(input.identity)}\u0000${input.idempotencyKey}`
    if (dedupe !== undefined) {
      const existingId = this.idempotency.get(dedupe)
      if (existingId !== undefined) {
        const existing = this.jobs.get(existingId)
        if (existing !== undefined)
          return Result.ok({ job: cloneRecord(existing), duplicate: true })
        this.idempotency.delete(dedupe)
      }
    }

    const id = input.explicitId ? Result.ok(input.id) : this.generateJobId(reservedIds)
    if (Result.isError(id)) return Result.err(id.error)
    if (this.jobs.has(id.value))
      return Result.err(jobStoreFailure('enqueue', 'generated job ID collided'))
    if (this.sequence >= maxSafeInteger) {
      return Result.err(
        new JobDefinitionError({
          field: 'orderingSequence',
          message: 'cannot exceed safe integer range'
        })
      )
    }

    const record = makeJobRecord({
      id: id.value,
      name: input.identity.name,
      version: input.identity.version,
      queue: input.identity.queue,
      state: input.runAt <= input.now ? 'waiting' : 'delayed',
      payload: input.payload,
      dispatchKey: input.dispatchKey,
      metadata: input.metadata,
      priority: input.priority,
      runAt: input.runAt,
      orderingSequence: this.sequence,
      attemptsMax: input.attemptsMax,
      attemptsMade: 0,
      attemptSequence: 0,
      deliveryCount: 0,
      stalledCount: 0,
      backoff: input.backoff,
      timeoutMs: input.timeoutMs,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
      updatedAt: input.now,
      processedAt: undefined,
      finishedAt: undefined,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      cancellationRequestedAt: undefined,
      result: undefined,
      failure: undefined
    })
    if (Result.isError(record)) return Result.err(record.error)

    this.sequence += 1
    this.jobs.set(record.value.id, record.value)
    if (input.parent !== undefined) this.flowChildParents.set(record.value.id, input.parent)
    if (!input.explicitId) this.generatedJobIds.add(record.value.id)
    if (dedupe !== undefined) this.idempotency.set(dedupe, record.value.id)
    this.invalidateListOrder(record.value.queue)
    this.appendEvent('job-enqueued', record.value, record.value.createdAt, {
      duplicate: false
    })
    this.notifyQueues([record.value.queue])
    return Result.ok({ job: cloneRecord(record.value), duplicate: false })
  }

  private generateJobId(reservedIds: Set<string>): ResultType<JobId, JobStoreError> {
    for (let attempt = 0; attempt < maxGenerationAttempts; attempt += 1) {
      const raw = this.nextGeneratedId('job')
      if (Result.isError(raw)) return raw
      const id = makeJobId(raw.value)
      if (Result.isError(id))
        return Result.err(jobStoreFailure('enqueue', 'ID generator returned an invalid job ID'))
      if (
        !this.jobs.has(id.value) &&
        !reservedIds.has(id.value) &&
        !this.generatedJobIds.has(id.value)
      ) {
        return id
      }
    }
    return Result.err(jobStoreFailure('enqueue', 'could not generate a unique job ID'))
  }

  private generateLeaseToken(reserved: Set<string>): ResultType<LeaseToken, JobStoreError> {
    for (let attempt = 0; attempt < maxGenerationAttempts; attempt += 1) {
      const raw = this.nextGeneratedId('lease')
      if (Result.isError(raw)) return raw
      const token = makeLeaseToken(raw.value)
      if (Result.isError(token)) {
        return Result.err(jobStoreFailure('claim', 'ID generator returned an invalid lease token'))
      }
      if (!this.issuedLeaseTokens.has(token.value) && !reserved.has(token.value)) return token
    }
    return Result.err(jobStoreFailure('claim', 'could not generate a unique lease token'))
  }

  private nextGeneratedId(kind: 'job' | 'lease'): ResultType<string, JobStoreError> {
    try {
      if (this.idGenerator !== undefined) {
        const value =
          typeof this.idGenerator === 'function' ? this.idGenerator() : this.idGenerator.next()
        if (typeof value !== 'string') {
          return Result.err(
            jobStoreFailure(
              kind === 'job' ? 'enqueue' : 'claim',
              'ID generator must return a string'
            )
          )
        }
        return Result.ok(value)
      }
      if (kind === 'job') {
        const value = `memory-job-${this.defaultIdSequence}`
        this.defaultIdSequence += 1
        return Result.ok(value)
      }
      const value = `memory-lease-${this.defaultLeaseSequence}`
      this.defaultLeaseSequence += 1
      return Result.ok(value)
    } catch {
      return Result.err(
        jobStoreFailure(kind === 'job' ? 'enqueue' : 'claim', 'ID generator failed')
      )
    }
  }

  private positiveInteger(value: unknown, field: string): ResultType<number, JobStoreError> {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      return definitionFailure(field, 'must be a positive safe integer')
    }
    return Result.ok(value)
  }

  private nonNegativeInteger(value: unknown, field: string): ResultType<number, JobStoreError> {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return definitionFailure(field, 'must be a non-negative safe integer')
    }
    return Result.ok(value)
  }

  private positiveDuration(value: unknown, field: string): ResultType<number, JobStoreError> {
    const checked = validateDuration(value, field)
    if (Result.isError(checked)) return checked
    if (checked.value === 0) return definitionFailure(field, 'must be greater than zero')
    return checked
  }

  private normalizeAccepted(value: unknown): ResultType<readonly ClaimIdentity[], JobStoreError> {
    if (!Array.isArray(value)) return definitionFailure('accepted', 'must be an array')
    const identities: ClaimIdentity[] = []
    for (const item of value) {
      const identity = readIdentity(item, 'accepted')
      if (Result.isError(identity)) return identity
      identities.push(identity.value as ClaimIdentity)
    }
    return Result.ok(Object.freeze(identities))
  }

  private normalizeLeases(value: unknown): ResultType<readonly NormalizedLease[], JobStoreError> {
    if (!Array.isArray(value)) return definitionFailure('leases', 'must be an array')
    const leases: NormalizedLease[] = []
    const seen = new Set<string>()
    for (const item of value as readonly HeartbeatLease[]) {
      const fields = readDto(item, ['jobId', 'leaseToken'], 'lease')
      if (Result.isError(fields)) return fields
      const jobId = makeJobId(fields.value.jobId)
      const leaseToken = makeLeaseToken(fields.value.leaseToken)
      if (Result.isError(jobId)) return jobId
      if (Result.isError(leaseToken)) return leaseToken
      if (seen.has(jobId.value))
        return definitionFailure('leases', 'must not contain duplicate job IDs')
      seen.add(jobId.value)
      leases.push({ jobId: jobId.value, leaseToken: leaseToken.value })
    }
    return Result.ok(Object.freeze(leases))
  }

  private normalizeWakeQueues(value: unknown): ResultType<ReadonlySet<string>, JobStoreError> {
    if (!Array.isArray(value)) return definitionFailure('queues', 'must be an array')
    const queues = new Set<string>()
    for (const item of value) {
      const queue = makeQueueName(item)
      if (Result.isError(queue)) return queue
      queues.add(queue.value)
    }
    return Result.ok(queues)
  }

  private isWaitingChildrenParent(jobId: string): boolean {
    if (!this.flowParentIds.has(jobId)) return false
    const flowId = makeJobId(jobId)
    if (Result.isError(flowId)) return false
    const snapshot = syncV2(this.flowStoreV2.getFlow({ flowId: flowId.value }))
    return Result.isOk(snapshot) && snapshot.value?.parent.state === 'waiting-children'
  }

  private claimCandidates(
    queue: string,
    accepted: readonly ClaimIdentity[],
    now: number
  ): readonly JobRecord[] {
    const acceptedKeys = new Set(accepted.map((identity) => identityKey(identity)))
    const candidates = [...this.jobs.values()].filter(
      (record) =>
        !this.isWaitingChildrenParent(record.id) &&
        record.queue === queue &&
        (record.state === 'waiting' || (record.state === 'delayed' && record.runAt <= now)) &&
        acceptedKeys.has(identityKey(record))
    )
    candidates.sort(compareJobOrder)
    return candidates
  }

  private nextRunAt(
    queue: string,
    accepted: readonly ClaimIdentity[],
    now: number
  ): number | undefined {
    const acceptedKeys = new Set(accepted.map((identity) => identityKey(identity)))
    let next: number | undefined
    for (const record of this.jobs.values()) {
      if (
        record.queue !== queue ||
        record.state !== 'delayed' ||
        record.runAt <= now ||
        !acceptedKeys.has(identityKey(record))
      ) {
        continue
      }
      next = next === undefined ? record.runAt : Math.min(next, record.runAt)
    }
    return next
  }

  private prepareTransition(
    transition: JobTransition,
    previous: JobRecord
  ): ResultType<PreparedTransition, JobStoreError> {
    return this.prepareTransitionAt(transition, previous, this.sequence)
  }

  private prepareTransitionAt(
    transition: JobTransition,
    previous: JobRecord,
    sequence: number
  ): ResultType<PreparedTransition, JobStoreError> {
    let record = transition.record
    let nextSequence = sequence
    if (isRequeue(previous, record)) {
      if (sequence >= maxSafeInteger) {
        return definitionFailure('orderingSequence', 'cannot exceed safe integer range')
      }
      const checked = makeJobRecord({ ...record, orderingSequence: sequence })
      if (Result.isError(checked)) return checked
      record = checked.value
      nextSequence += 1
    }
    return Result.ok({
      previous,
      nextSequence,
      transition: Object.freeze({ record, attempt: transition.attempt })
    })
  }

  private commitPrepared(
    prepared: readonly PreparedTransition[],
    notify: boolean,
    eventType?: DurableJobEventType
  ): void {
    if (prepared.length === 0) return
    const queues = new Set<string>()
    for (const item of prepared) {
      const record = item.transition.record
      this.jobs.set(record.id, record)
      this.invalidateListOrder(record.queue)
      if (
        notify &&
        (record.state === 'waiting' || record.state === 'delayed') &&
        item.previous.state !== 'waiting'
      ) {
        queues.add(record.queue)
      }
      const attempt = item.transition.attempt
      if (attempt !== undefined) {
        const history = this.attempts.get(record.id) ?? []
        history.push(attempt)
        this.attempts.set(record.id, history)
      }
      if (eventType !== undefined) {
        if (attempt === undefined) {
          this.appendEvent(eventType, record, record.updatedAt, { previous: item.previous })
        } else {
          this.appendEvent(eventType, record, record.updatedAt, {
            previous: item.previous,
            attempt
          })
        }
      }
      this.appendTerminalFlowReport(item.previous, record)
    }
    this.sequence = Math.max(this.sequence, prepared[prepared.length - 1]!.nextSequence)
    if (queues.size > 0) this.notifyQueues(queues)
  }

  private settlementEventType(attempt: AttemptRecord): DurableJobEventType {
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

  private appendTerminalFlowReport(previous: JobRecord, record: JobRecord): void {
    if (
      previous.state === record.state ||
      (record.state !== 'completed' && record.state !== 'failed' && record.state !== 'cancelled')
    ) {
      return
    }
    const parent = this.flowChildParents.get(record.id)
    if (parent === undefined) return
    const outcome = record.state
    const sequence = record.attemptSequence ?? record.attemptsMade
    const entry: AppendChildReportRequest = {
      id: `flow-v2/report/${record.id}/${sequence}`,
      flowName: parent.flowName,
      parentStoreKey: parent.parentStoreKey,
      report: {
        flowId: parent.flowId,
        childKey: parent.childKey,
        outcome,
        result: outcome === 'completed' ? record.result : undefined,
        failure: outcome === 'failed' || outcome === 'cancelled' ? record.failure : undefined
      }
    }
    const appended = syncV2(this.flowStoreV2.appendChildReport(entry))
    if (Result.isError(appended)) {
      // The entry was built from a validated parent envelope and JobRecord, so
      // this can only indicate a broken adapter implementation in this memory
      // reference. Throwing prevents callers from observing a false ACK.
      throw appended.error
    }
  }

  private transitionEventType(
    command: Exclude<Parameters<typeof reduceJob>[1], { type: 'claim' }>,
    previous: JobRecord,
    next: JobRecord
  ): DurableJobEventType | undefined {
    switch (command.type) {
      case 'cancel':
        return 'job-cancelled'
      case 'request-cancellation':
        return previous.cancellationRequestedAt === next.cancellationRequestedAt
          ? undefined
          : 'job-cancel-requested'
      case 'promote':
        return 'job-promoted'
      case 'retry':
        return 'job-admin-retried'
      case 'recover-stalled':
        return 'job-stalled-recovered'
      case 'settle':
      case 'release':
        return undefined
    }
  }

  private appendEvent(
    type: DurableJobEventType,
    record: JobRecord | undefined,
    recordedAtMs: number,
    context: {
      readonly previous?: JobRecord
      readonly attempt?: AttemptRecord
      readonly duplicate?: boolean
      readonly queue?: QueueName
      readonly attributes?: Readonly<Record<string, string>>
    } = {}
  ): void {
    if (this.eventAppender === undefined || this.eventWriter?.canAppend === false) return
    const workerId = record?.leaseOwner ?? context.previous?.leaseOwner
    this.eventAppender.append({
      type,
      recordedAtMs,
      jobId: record?.id,
      queue: record?.queue ?? context.queue,
      name: record?.name,
      version: record?.version,
      state: record?.state,
      attempt: context.attempt?.attemptSequence ?? context.attempt?.attempt,
      delivery: context.attempt?.delivery ?? record?.deliveryCount,
      workerId,
      outcome: context.attempt?.outcome ?? (type === 'job-released' ? 'released' : undefined),
      failureKind: record?.failure?.kind ?? context.previous?.failure?.kind,
      duplicate: context.duplicate,
      attributes: Object.freeze({ ...context.attributes })
    })
  }

  private eventWriterFailure(operation: string): JobStoreError | undefined {
    if (this.eventAppender === undefined) return undefined
    try {
      this.eventAppender.ensureWriterReady(this.eventWriter)
      return undefined
    } catch (cause) {
      if (JobEventWriterRejectedError.is(cause)) {
        return new JobEventWriterRejectedError({
          operation,
          revision: cause.revision,
          writerId: cause.writerId,
          writerVersion: cause.writerVersion
        })
      }
      return jobStoreFailure(operation, 'event writer readiness check failed')
    }
  }

  private transitionById(
    current: JobRecord,
    command: Exclude<Parameters<typeof reduceJob>[1], { type: 'claim' }>,
    additionalEventType?: DurableJobEventType
  ): Operation<JobTransition> {
    const transition = reduceJob(current, command)
    if (Result.isError(transition)) return fail(transition.error)
    const prepared = this.prepareTransition(transition.value, current)
    if (Result.isError(prepared)) return fail(prepared.error)
    const notify = command.type === 'promote' || command.type === 'retry'
    const eventType = this.transitionEventType(command, current, prepared.value.transition.record)
    const effectiveCancellation =
      command.type !== 'request-cancellation' ||
      current.cancellationRequestedAt !== prepared.value.transition.record.cancellationRequestedAt
    this.commitPrepared(
      [prepared.value],
      notify,
      additionalEventType !== undefined && effectiveCancellation ? additionalEventType : eventType
    )
    if (command.type === 'retry') this.settled.delete(current.id)
    return ok(snapshotTransition(prepared.value.transition))
  }

  private simpleTransition(
    request: JobIdRequest,
    type: 'cancel' | 'request-cancellation' | 'promote',
    additionalEventType?: DurableJobEventType
  ): Operation<JobTransition> {
    try {
      const eventFailure = this.eventWriterFailure(type)
      if (eventFailure !== undefined) return fail(eventFailure)
      const fields = readDto(request, ['jobId', 'now'], 'request')
      if (Result.isError(fields)) return fail(fields.error)
      const clock = this.readConfiguredClock()
      if (Result.isError(clock)) return fail(clock.error)
      const now = this.readOperationNow(fields.value.now, clock.value)
      if (Result.isError(now)) return fail(now.error)
      const jobId = makeJobId(fields.value.jobId)
      if (Result.isError(jobId)) return fail(jobId.error)
      const current = this.jobs.get(jobId.value)
      if (current === undefined) return fail(new JobNotFoundError({ jobId: jobId.value }))
      return this.transitionById(
        current,
        { type, jobId: jobId.value, now: now.value },
        additionalEventType
      )
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read transition request' })
      )
    }
  }

  private pauseOrResume(
    request: JobStoreNamespace.PauseQueueRequest,
    shouldPause: boolean
  ): Operation<QueuePauseResult> {
    try {
      const eventFailure = this.eventWriterFailure(shouldPause ? 'pause' : 'resume')
      if (eventFailure !== undefined) return fail(eventFailure)
      const fields = readDto(request, ['queue', 'now'], 'request')
      if (Result.isError(fields)) return fail(fields.error)
      const clock = this.readConfiguredClock()
      if (Result.isError(clock)) return fail(clock.error)
      const now = this.readOperationNow(fields.value.now, clock.value)
      if (Result.isError(now)) return fail(now.error)
      const queue = makeQueueName(fields.value.queue)
      if (Result.isError(queue)) return fail(queue.error)
      const present = this.paused.has(queue.value)
      if (shouldPause && !present) {
        this.paused.add(queue.value)
        this.appendEvent('queue-paused', undefined, now.value, { queue: queue.value })
        this.notifyQueues([queue.value])
      } else if (!shouldPause && present) {
        this.paused.delete(queue.value)
        this.appendEvent('queue-resumed', undefined, now.value, { queue: queue.value })
        this.notifyQueues([queue.value])
      }
      return ok(Object.freeze({ queue: queue.value, paused: shouldPause }))
    } catch {
      return fail(
        new JobDefinitionError({ field: 'request', message: 'could not read pause request' })
      )
    }
  }

  private normalizeStates(
    value: unknown
  ): ResultType<ReadonlySet<JobRecord['state']> | undefined, JobStoreError> {
    if (value === undefined) return Result.ok(undefined)
    const values = Array.isArray(value) ? value : [value]
    const states = new Set<JobRecord['state']>()
    for (const item of values) {
      if (!isJobState(item)) return definitionFailure('state', 'unsupported job state')
      states.add(item)
    }
    return Result.ok(states)
  }

  private normalizeMetadataFilter(
    value: unknown
  ): ResultType<Readonly<Record<string, string>> | undefined, JobStoreError> {
    if (value === undefined) return Result.ok(undefined)
    if (!isObject(value)) return definitionFailure('metadata', 'must be an object')

    try {
      const metadata: Record<string, string> = {}
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') return definitionFailure('metadata', 'keys must be strings')
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor === undefined || !('value' in descriptor)) {
          return definitionFailure('metadata', 'must contain only data properties')
        }
        if (typeof descriptor.value !== 'string') {
          return definitionFailure('metadata', 'values must be strings')
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
      return definitionFailure('metadata', 'could not read metadata')
    }
  }

  private normalizeListOrderBy(value: unknown): ResultType<JobListOrderBy, JobStoreError> {
    if (value === undefined) return Result.ok(defaultListOrderBy)
    if (value === 'enqueuedAt' || value === 'runAt' || value === 'finishedAt') {
      return Result.ok(value)
    }
    return definitionFailure('orderBy', 'must be enqueuedAt, runAt, or finishedAt')
  }

  private normalizeListOrder(value: unknown): ResultType<JobListOrder, JobStoreError> {
    if (value === undefined) return Result.ok(defaultListOrder)
    if (value === 'asc' || value === 'desc') return Result.ok(value)
    return definitionFailure('order', 'must be asc or desc')
  }

  private normalizeLegacyOrderBy(value: unknown): ResultType<JobListOrderBy, JobStoreError> {
    if (value === 'createdAt,orderingSequence,id') return Result.ok('enqueuedAt')
    if (value === 'runAt,orderingSequence,id') return Result.ok('runAt')
    if (value === 'finishedAt,orderingSequence,id') return Result.ok('finishedAt')
    return Result.err(new UnsupportedJobStoreOperationError({ operation: 'list.cursor-version' }))
  }

  private normalizeCursor(value: unknown): ResultType<JobListCursor | undefined, JobStoreError> {
    if (value === undefined) return Result.ok(undefined)
    const fields = readDto(
      value,
      [
        'version',
        'orderBy',
        'order',
        'ordering',
        'direction',
        'filterSignature',
        'value',
        'createdAt',
        'orderingSequence',
        'id'
      ],
      'cursor'
    )
    if (Result.isError(fields)) return fields
    if (fields.value.version !== cursorVersion) {
      return Result.err(new UnsupportedJobStoreOperationError({ operation: 'list.cursor-version' }))
    }

    const orderBy =
      fields.value.orderBy === undefined
        ? this.normalizeLegacyOrderBy(fields.value.ordering)
        : this.normalizeListOrderBy(fields.value.orderBy)
    const order =
      fields.value.order === undefined
        ? this.normalizeListOrder(fields.value.direction)
        : this.normalizeListOrder(fields.value.order)
    if (Result.isError(orderBy)) return orderBy
    if (Result.isError(order)) return order
    if (
      (fields.value.ordering !== undefined &&
        fields.value.ordering !== cursorOrderingFor(orderBy.value)) ||
      (fields.value.direction !== undefined && fields.value.direction !== order.value)
    ) {
      return Result.err(new UnsupportedJobStoreOperationError({ operation: 'list.cursor-version' }))
    }
    if (typeof fields.value.filterSignature !== 'string') {
      return definitionFailure('cursor.filterSignature', 'must be a string')
    }

    const createdAt = validateTimestamp(fields.value.createdAt, 'cursor.createdAt')
    const sequence = validateDuration(fields.value.orderingSequence, 'cursor.orderingSequence')
    const id = makeJobId(fields.value.id)
    const rawValue =
      fields.value.value === undefined && orderBy.value === 'enqueuedAt'
        ? fields.value.createdAt
        : fields.value.value
    const primaryValue =
      rawValue === null
        ? Result.ok<number | null>(null)
        : validateTimestamp(rawValue, 'cursor.value')
    if (Result.isError(createdAt)) return createdAt
    if (Result.isError(sequence)) return sequence
    if (Result.isError(id)) return id
    if (Result.isError(primaryValue)) return primaryValue
    if (primaryValue.value === null && orderBy.value !== 'finishedAt') {
      return definitionFailure('cursor.value', 'null is only valid for finishedAt ordering')
    }

    return Result.ok(
      Object.freeze({
        version: cursorVersion,
        orderBy: orderBy.value,
        order: order.value,
        ordering: cursorOrderingFor(orderBy.value),
        direction: order.value,
        filterSignature: fields.value.filterSignature,
        value: primaryValue.value,
        createdAt: createdAt.value,
        orderingSequence: sequence.value,
        id: id.value
      })
    )
  }

  private makeCursor(
    record: JobRecord,
    filterSignature: string,
    orderBy: JobListOrderBy,
    order: JobListOrder
  ): JobListCursor {
    return Object.freeze({
      version: cursorVersion,
      orderBy,
      order,
      ordering: cursorOrderingFor(orderBy),
      direction: order,
      filterSignature,
      value: listPrimaryValue(record, orderBy),
      createdAt: record.createdAt,
      orderingSequence: record.orderingSequence,
      id: record.id
    })
  }

  private listSignature(
    queue: string | undefined,
    name: string | undefined,
    version: number | undefined,
    states: ReadonlySet<JobRecord['state']> | undefined,
    metadata: Readonly<Record<string, string>> | undefined,
    orderBy: JobListOrderBy,
    order: JobListOrder
  ): string {
    const stateSignature =
      states === undefined ? '*' : listStateOrder.filter((state) => states.has(state)).join(',')
    const metadataSignature =
      metadata === undefined
        ? null
        : Object.entries(metadata)
            .sort(([left], [right]) => compareText(left, right))
            .map(([key, value]) => [key, value])
    return JSON.stringify([
      queue ?? null,
      name ?? null,
      version ?? null,
      stateSignature,
      metadataSignature,
      orderBy,
      order
    ])
  }

  private firstUnsupportedField(value: unknown, fields: readonly string[]): string | undefined {
    if (!isObject(value)) return undefined
    try {
      const allowed = new Set(fields)
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !allowed.has(key))
          return typeof key === 'string' ? key : 'symbol'
      }
    } catch {
      return 'request'
    }
    return undefined
  }

  private matchesList(
    record: JobRecord,
    queue: string | undefined,
    name: string | undefined,
    version: number | undefined,
    states: ReadonlySet<JobRecord['state']> | undefined,
    metadata: Readonly<Record<string, string>> | undefined
  ): boolean {
    if (
      (queue !== undefined && record.queue !== queue) ||
      (name !== undefined && record.name !== name) ||
      (version !== undefined && record.version !== version) ||
      (states !== undefined && !states.has(record.state))
    ) {
      return false
    }
    if (metadata === undefined) return true
    const keys = Object.keys(metadata)
    return (
      keys.length === Object.keys(record.metadata).length &&
      keys.every((key) => record.metadata[key] === metadata[key])
    )
  }

  private matchesMetadata(record: JobRecord, metadata: Readonly<Record<string, string>>): boolean {
    const keys = Object.keys(metadata)
    return (
      keys.length === Object.keys(record.metadata).length &&
      keys.every((key) => record.metadata[key] === metadata[key])
    )
  }

  private getListOrder(orderBy: JobListOrderBy, order: JobListOrder): readonly JobRecord[] {
    const key = `${orderBy}:${order}`
    const cached = this.listOrders.get(key)
    if (cached !== undefined) return cached
    const records = [...this.jobs.values()]
    records.sort((left, right) => compareListRecords(left, right, orderBy, order))
    const result = Object.freeze(records)
    this.listOrders.set(key, result)
    return result
  }

  private findCursorStart(
    records: readonly JobRecord[],
    cursor: JobListCursor | undefined
  ): number {
    if (cursor === undefined) return 0
    let low = 0
    let high = records.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const record = records[middle]
      if (record !== undefined && compareRecordCursor(record, cursor) <= 0) low = middle + 1
      else high = middle
    }
    return low
  }

  private invalidateListOrder(_queue: string): void {
    this.listOrders.clear()
  }

  private removeIdempotency(record: JobRecord): void {
    if (record.idempotencyKey === undefined) return
    this.idempotency.delete(`${identityKey(record)}\u0000${record.idempotencyKey}`)
  }

  private wakeBaseline(queue: string | undefined): WakeBaseline {
    return {
      global: this.wakeGlobal,
      queue,
      queueVersion: queue === undefined ? 0 : (this.queueWakeVersions.get(queue) ?? 0),
      queueGlobal: queue === undefined ? 0 : (this.queueWakeGlobals.get(queue) ?? 0),
      broadcast: this.wakeBroadcast
    }
  }

  private hasRelevantWake(baseline: WakeBaseline, queues: ReadonlySet<string>): boolean {
    if (this.wakeBroadcast > baseline.broadcast) return true
    if (queues.size === 0) return this.wakeGlobal > baseline.global
    for (const queue of queues) {
      if ((this.queueWakeGlobals.get(queue) ?? 0) > baseline.global) return true
      if (
        baseline.queue === queue &&
        (this.queueWakeVersions.get(queue) ?? 0) > baseline.queueVersion
      ) {
        return true
      }
    }
    return false
  }

  private notifyQueues(queues: Iterable<string>): void {
    const unique = new Set(queues)
    if (unique.size === 0) return
    for (const queue of unique) {
      this.wakeGlobal += 1
      const version = (this.queueWakeVersions.get(queue) ?? 0) + 1
      this.queueWakeVersions.set(queue, version)
      this.queueWakeGlobals.set(queue, this.wakeGlobal)
    }
    const pending = [...this.waiters]
    for (const waiter of pending) {
      if (this.hasRelevantWake(waiter.baseline, waiter.queues)) {
        this.finishWaiter(waiter, ok(undefined))
      }
    }
  }

  private finishWaiter(waiter: WakeWaiter, result: Operation<void>): void {
    if (waiter.settled) return
    this.waiters.delete(waiter)
    waiter.settled = true
    try {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    } catch {
      // An AbortSignal implementation may reject removal; its waiter is already detached.
    }
    waiter.resolve(result)
  }
}

const makeMemoryJobStore = (
  options?: MemoryJobStoreOptions
): JobStoreNamespace.Contract &
  TransactionalEnqueue &
  ControlledJobStoreContract & { readonly v2: JobStoreV2Contract } => {
  const implementation = new MemoryJobStoreImplementation(options)
  // SAFETY: MemoryJobStoreImplementation implements every operation in JobStore.Contract; JobStore.of restores the structural Service contract.
  const contract = JobStore.of(implementation as never)
  memoryJobStoreInternals.set(contract as object, implementation)
  return contract as unknown as JobStoreNamespace.Contract &
    TransactionalEnqueue &
    ControlledJobStoreContract & { readonly v2: JobStoreV2Contract }
}

export const getMemoryJobStoreInternals = (
  store: JobStoreContract
): MemoryJobStoreInternals | undefined => memoryJobStoreInternals.get(store as object)

const makeMemoryLayer = <Token extends AnyJobStoreToken>(
  token: Token,
  options?: MemoryJobStoreOptions
): Layer<InstanceType<Token>, never> =>
  // Layer.make defers construction until each Runtime resolves the provider, so a reused Layer never shares mutable store state.
  Layer.make(
    token,
    () => makeMemoryJobStore(options) as unknown as ServiceContract<InstanceType<Token>>
  ) as Layer<InstanceType<Token>, never>

const memoryJobStoreApi = {
  get layer() {
    return makeMemoryLayer(JobStore)
  },
  layerWith(options?: MemoryJobStoreOptions) {
    return makeMemoryLayer(JobStore, options)
  },
  layerFor<Token extends AnyJobStoreToken>(token: Token, options?: MemoryJobStoreOptions) {
    return makeMemoryLayer(token, options)
  },
  make(
    options?: MemoryJobStoreOptions
  ): JobStoreNamespace.Contract &
    TransactionalEnqueue &
    ControlledJobStoreContract & { readonly v2: JobStoreV2Contract } {
    return makeMemoryJobStore(options)
  }
}

/** The isolated, non-durable in-process JobStore reference driver. */
export const MemoryJobStore = Object.freeze(memoryJobStoreApi)
