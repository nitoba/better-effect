// oxlint-disable anti-slop/no-runtime-typeof -- public token and DTO boundaries validate untyped callers.
// oxlint-disable anti-slop/no-unknown-parameters -- event-store guards inspect public request values.
// oxlint-disable anti-slop/no-chained-type-assertions -- Service token erasure is restored at one boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- token and Memory adapter bridges are checked boundaries.

import { Service } from 'better-effect'
import type { AnyService, Effect, ServiceClass, ServiceRequirement } from 'better-effect'

import type { JobFailureKind, JobState, ProtocolVersion } from '../protocol'
import type { JobIdentity } from '../job'
import type { JobId, QueueName, WorkerId } from '../protocol'
import { JobStore, isJobStoreToken, jobStoreTag } from './store'
import type { AnyJobStoreToken, DefaultJobStoreToken, JobStoreToken } from './store'
import type { JobEventStoreError, JobEventStoreFailure } from './event-errors'

export const jobEventStoreTag = '@better-effect/mq/JobEventStore' as const
export const jobEventExtension = 'better-effect-mq/events' as const
export const jobEventExtensionVersion = 1 as const

declare const JobEventCursorBrand: unique symbol
export type JobEventCursor = string & { readonly [JobEventCursorBrand]: 'JobEventCursor' }

/** The versioned protocol family that owns a durable event transition. */
export type DurableJobEventFamily = 'job' | 'flow' | 'schedule' | 'controls'
export type DurableJobEventProtocolVersion = 1 | 2 | 3
export type DurableJobEventOperation =
  | 'enqueue'
  | 'claim'
  | 'settle'
  | 'requestCancellation'
  | 'release'
  | 'recoverStalled'
  | 'promote'
  | 'adminRetry'
  | 'remove'
  | 'pause'
  | 'resume'
  | 'fanOut'
  | 'recordChildResults'
  | 'cancel'
  | 'markCascaded'
  | 'outbox'
  | 'upsertSchedule'
  | 'removeSchedule'
  | 'tickSchedule'
  | 'pauseSchedule'
  | 'resumeSchedule'
  | 'reconcile'
  | 'claimControlled'
  | 'settleControlled'
  | 'releaseControlled'
  | 'recoverStalledControlled'
  | 'cancelControlled'

/** The stable v1 job transitions and the additive extension transitions. */
const jobEventTypes = Object.freeze([
  'job-enqueued',
  'job-claimed',
  'job-completed',
  'job-retry-scheduled',
  'job-failed',
  'job-cancelled',
  'job-cancel-requested',
  'job-released',
  'job-stalled-recovered',
  'job-promoted',
  'job-admin-retried',
  'job-removed',
  'queue-paused',
  'queue-resumed'
] as const)

const flowEventTypes = Object.freeze([
  'flow-fan-out',
  'flow-child-results-recorded',
  'flow-cancelled',
  'flow-cascaded',
  'flow-outbox-appended'
] as const)

const scheduleEventTypes = Object.freeze([
  'schedule-upserted',
  'schedule-removed',
  'schedule-ticked',
  'schedule-paused',
  'schedule-resumed'
] as const)

const controlsEventTypes = Object.freeze([
  'controls-reconciled',
  'controls-claimed',
  'controls-settled',
  'controls-released',
  'controls-stalled-recovered',
  'controls-cancelled'
] as const)

export const durableJobEventTypes = Object.freeze([
  ...jobEventTypes,
  ...flowEventTypes,
  ...scheduleEventTypes,
  ...controlsEventTypes
] as const)

export type DurableJobEventType = (typeof durableJobEventTypes)[number]

export interface DurableJobEventTypeDescriptor {
  readonly type: DurableJobEventType
  readonly family: DurableJobEventFamily
  readonly protocolVersion: DurableJobEventProtocolVersion
  /** The storage operation represented by this transition. */
  readonly operation: DurableJobEventOperation
}

export interface DurableJobEventTaxonomyDescriptor {
  readonly family: DurableJobEventFamily
  readonly protocolVersion: DurableJobEventProtocolVersion
  readonly types: readonly DurableJobEventType[]
}

const makeDescriptors = <
  const Family extends DurableJobEventFamily,
  const Version extends DurableJobEventProtocolVersion,
  const Types extends readonly DurableJobEventType[]
>(
  family: Family,
  protocolVersion: Version,
  entries: Types,
  operations: readonly DurableJobEventOperation[]
): readonly DurableJobEventTypeDescriptor[] =>
  Object.freeze(
    entries.map((type, index) =>
      Object.freeze({
        type,
        family,
        protocolVersion,
        operation: operations[index]!
      })
    )
  )

/** Public descriptors let adapters advertise support without duplicating names. */
export const durableJobEventTaxonomies = Object.freeze({
  jobV1: Object.freeze({ family: 'job', protocolVersion: 1, types: jobEventTypes }),
  flowV2: Object.freeze({ family: 'flow', protocolVersion: 2, types: flowEventTypes }),
  scheduleV1: Object.freeze({ family: 'schedule', protocolVersion: 1, types: scheduleEventTypes }),
  controlsV3: Object.freeze({ family: 'controls', protocolVersion: 3, types: controlsEventTypes })
}) satisfies Readonly<Record<string, DurableJobEventTaxonomyDescriptor>>

export const durableJobEventTypeDescriptors = Object.freeze([
  ...makeDescriptors('job', 1, jobEventTypes, [
    'enqueue',
    'claim',
    'settle',
    'settle',
    'settle',
    'settle',
    'requestCancellation',
    'release',
    'recoverStalled',
    'promote',
    'adminRetry',
    'remove',
    'pause',
    'resume'
  ]),
  ...makeDescriptors('flow', 2, flowEventTypes, [
    'fanOut',
    'recordChildResults',
    'cancel',
    'markCascaded',
    'outbox'
  ]),
  ...makeDescriptors('schedule', 1, scheduleEventTypes, [
    'upsertSchedule',
    'removeSchedule',
    'tickSchedule',
    'pauseSchedule',
    'resumeSchedule'
  ]),
  ...makeDescriptors('controls', 3, controlsEventTypes, [
    'reconcile',
    'claimControlled',
    'settleControlled',
    'releaseControlled',
    'recoverStalledControlled',
    'cancelControlled'
  ])
]) satisfies readonly DurableJobEventTypeDescriptor[]

const durableJobEventTypeSet: ReadonlySet<string> = new Set(durableJobEventTypes)

export const isDurableJobEventType = (value: unknown): value is DurableJobEventType =>
  typeof value === 'string' && durableJobEventTypeSet.has(value)

export const assertDurableJobEventType = (
  value: unknown,
  field = 'event type'
): DurableJobEventType => {
  if (!isDurableJobEventType(value)) {
    throw new TypeError(`${field} is not a supported durable job event type`)
  }
  return value
}

export interface JobEventRetention {
  readonly ageMs?: number
  readonly count?: number
}

export interface JobEventStoreDescriptor {
  readonly extension: typeof jobEventExtension
  readonly extensionVersion: typeof jobEventExtensionVersion
  readonly jobStoreProtocolVersion: ProtocolVersion
}

/** The rollout mode recorded for one namespace. */
export type JobEventStoreMode = 'optional' | 'required'

/** The durable activation state for one namespace. */
export type JobEventStoreActivationState = 'inactive' | JobEventStoreMode

/** The state that is shared by all writers of one event-store namespace. */
export interface JobEventStoreActivation {
  readonly state: JobEventStoreActivationState
  readonly mode: JobEventStoreMode | undefined
  /** The last event before activation; events after this cursor belong to the rollout. */
  readonly activationCursor: JobEventCursor | undefined
  readonly revision: number
  readonly activatedAtMs: number | undefined
}

/** The capability identity used by the namespace readiness handshake. */
export interface JobEventStoreWriter {
  readonly id: string
  readonly version: string
  readonly canAppend: boolean
}

export type JobEventStoreReadinessReason =
  | 'inactive'
  | 'optional'
  | 'required'
  | 'append-unsupported'

export interface JobEventStoreReadiness extends JobEventStoreActivation {
  readonly ready: boolean
  readonly writer: JobEventStoreWriter
  readonly reason: JobEventStoreReadinessReason
}

export interface JobEventStoreActivationOptions {
  readonly mode: JobEventStoreMode
  readonly now?: number
}

export interface DurableJobEvent {
  readonly cursor: JobEventCursor
  readonly type: DurableJobEventType
  readonly recordedAtMs: number
  readonly jobId: JobId | undefined
  readonly queue: QueueName | undefined
  readonly name: string | undefined
  readonly version: number | undefined
  readonly state: JobState | undefined
  readonly attempt: number | undefined
  readonly delivery: number | undefined
  readonly workerId: WorkerId | undefined
  readonly outcome: string | undefined
  readonly failureKind: JobFailureKind | undefined
  readonly duplicate: boolean | undefined
  readonly attributes: Readonly<Record<string, string>>
}

/** Internal append shape used by atomic reference-store transitions. */
export type DurableJobEventInput = Omit<DurableJobEvent, 'cursor'>

export interface JobEventReadOptions {
  readonly after?: JobEventCursor
  readonly limit?: number
  readonly queues?: readonly QueueName[]
  readonly jobs?: readonly JobIdentity[]
  readonly jobId?: JobId
  readonly types?: readonly DurableJobEventType[]
}

export interface JobEventPage {
  readonly events: readonly DurableJobEvent[]
  /** The last event examined, including non-matching filtered events. */
  readonly nextCursor: JobEventCursor | undefined
}

export interface AwaitEventsOptions {
  readonly after: JobEventCursor
  readonly queues?: readonly QueueName[]
  readonly signal: AbortSignal
}

export type JobEventStoreEffect<
  Success,
  Failure extends JobEventStoreError = JobEventStoreError,
  Requirements extends AnyService = never
> = Effect<Success, Failure, Requirements>

export type JobEventStoreOperation<
  Success,
  Failure extends JobEventStoreError = JobEventStoreError,
  Requirements extends AnyService = never
> =
  | JobEventStoreEffect<Success, Failure, Requirements>
  | PromiseLike<JobEventStoreEffect<Success, Failure, Requirements>>

export interface JobEventStoreContract {
  readonly descriptor: JobEventStoreDescriptor
  tailCursor(): JobEventStoreOperation<JobEventCursor, JobEventStoreFailure>
  activation(): JobEventStoreOperation<JobEventStoreActivation, JobEventStoreFailure>
  readiness(
    writer?: JobEventStoreWriter
  ): JobEventStoreOperation<JobEventStoreReadiness, JobEventStoreFailure>
  activate(
    options: JobEventStoreActivationOptions
  ): JobEventStoreOperation<JobEventStoreActivation, JobEventStoreFailure>
  read(
    options: JobEventReadOptions
  ): JobEventStoreOperation<
    JobEventPage,
    JobEventStoreFailure | import('./event-errors').JobEventCursorExpiredError
  >
  awaitEvents(options: AwaitEventsOptions): JobEventStoreOperation<void, JobEventStoreFailure>
}

type JobEventStoreName<Store extends AnyJobStoreToken> =
  Store extends JobStoreToken<infer Name> ? Name : never

export type JobEventStoreTag<Store extends AnyJobStoreToken = DefaultJobStoreToken> = [
  JobEventStoreName<Store>
] extends [undefined]
  ? typeof jobEventStoreTag
  : `${typeof jobEventStoreTag}/${Extract<JobEventStoreName<Store>, string>}`

export type JobEventStoreInstance<Store extends AnyJobStoreToken = DefaultJobStoreToken> =
  JobEventStoreContract & Service.Identity<JobEventStoreTag<Store>>

export type JobEventStoreToken<Store extends AnyJobStoreToken = DefaultJobStoreToken> =
  ServiceClass<JobEventStoreTag<Store>, JobEventStoreInstance<Store>> &
    (new () => JobEventStoreInstance<Store>) & {
      readonly [Symbol.asyncIterator]: () => AsyncGenerator<
        ServiceRequirement<JobEventStoreInstance<Store>>,
        JobEventStoreInstance<Store>,
        unknown
      >
    }

export type DefaultJobEventStoreToken = JobEventStoreToken<DefaultJobStoreToken> & {
  readonly for: <Store extends AnyJobStoreToken>(store: Store) => JobEventStoreToken<Store>
}

export type AnyJobEventStoreToken = DefaultJobEventStoreToken | JobEventStoreToken<AnyJobStoreToken>

const eventStoreTypeId = Symbol.for('better-effect-mq/JobEventStore')

const makeToken = <Store extends AnyJobStoreToken>(store: Store): JobEventStoreToken<Store> => {
  if (!isJobStoreToken(store)) throw new TypeError('JobEventStore.for requires a JobStore token')
  const suffix =
    store.serviceTag === jobStoreTag ? undefined : store.serviceTag.slice(`${jobStoreTag}/`.length)
  if (suffix === '') throw new TypeError('JobEventStore.for received an invalid JobStore token')
  const tag = (
    suffix === undefined ? jobEventStoreTag : `${jobEventStoreTag}/${suffix}`
  ) as JobEventStoreTag<Store>
  const token = Service<JobEventStoreInstance<Store>>()(tag as never)
  Object.defineProperty(token, eventStoreTypeId, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  })
  return token as unknown as JobEventStoreToken<Store>
}

const defaultEventStore = makeToken(JobStore)
Object.defineProperty(defaultEventStore, 'for', {
  configurable: false,
  enumerable: true,
  value: makeToken,
  writable: false
})

export interface JobEventStore extends JobEventStoreInstance<DefaultJobStoreToken> {}

export declare namespace JobEventStore {
  export type Any =
    | JobEventStoreInstance<DefaultJobStoreToken>
    | JobEventStoreInstance<AnyJobStoreToken>
  export type Contract = JobEventStoreContract
  export type Cursor = JobEventCursor
  export type Descriptor = JobEventStoreDescriptor
  export type Activation = JobEventStoreActivation
  export type ActivationOptions = JobEventStoreActivationOptions
  export type Readiness = JobEventStoreReadiness
  export type Writer = JobEventStoreWriter
  export type Mode = JobEventStoreMode
  export type Event = DurableJobEvent
  export type EventType = DurableJobEventType
  export type EventFamily = DurableJobEventFamily
  export type EventProtocolVersion = DurableJobEventProtocolVersion
  export type EventOperation = DurableJobEventOperation
  export type EventTypeDescriptor = DurableJobEventTypeDescriptor
  export type EventTaxonomyDescriptor = DurableJobEventTaxonomyDescriptor
  export type Page = JobEventPage
  export type ReadOptions = JobEventReadOptions
  export type AwaitOptions = AwaitEventsOptions
  export type Retention = JobEventRetention
  export type Effect<
    Success,
    Failure extends JobEventStoreError = JobEventStoreError,
    Requirements extends AnyService = never
  > = JobEventStoreEffect<Success, Failure, Requirements>
  export type Operation<
    Success,
    Failure extends JobEventStoreError = JobEventStoreError,
    Requirements extends AnyService = never
  > = JobEventStoreOperation<Success, Failure, Requirements>
  export type Token<Store extends AnyJobStoreToken = DefaultJobStoreToken> =
    JobEventStoreToken<Store>
  export type Instance<Store extends AnyJobStoreToken = DefaultJobStoreToken> =
    JobEventStoreInstance<Store>
}

export const JobEventStore = defaultEventStore as DefaultJobEventStoreToken

export const isJobEventStoreToken = (value: unknown): value is AnyJobEventStoreToken => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  try {
    const marker = Object.getOwnPropertyDescriptor(value, eventStoreTypeId)
    const candidate = value as {
      readonly serviceTag?: unknown
      readonly [Symbol.asyncIterator]?: unknown
    }
    return (
      marker !== undefined &&
      'value' in marker &&
      marker.value === true &&
      typeof candidate.serviceTag === 'string' &&
      (candidate.serviceTag === jobEventStoreTag ||
        candidate.serviceTag.startsWith(`${jobEventStoreTag}/`)) &&
      typeof candidate[Symbol.asyncIterator] === 'function'
    )
  } catch {
    return false
  }
}
