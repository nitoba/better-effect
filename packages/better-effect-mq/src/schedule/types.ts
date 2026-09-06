import type { AnyService, Effect } from 'better-effect'
import type { UnhandledException } from 'better-result'

import type { JobIdentity } from '../job'
import type {
  JobDefinitionError,
  JobId,
  QueueName,
  JsonValue,
  PersistedBackoff,
  JobRecord
} from '../protocol'
import type { EnqueueRequest, EnqueueResult, JobStoreContract, JobStoreError } from '../store'
import type {
  DuplicateScheduleError,
  ScheduleDefinitionError,
  ScheduleNotFoundError,
  ScheduleStoreFailure
} from './errors'
import type { JobEncodeFailure } from '../codec'

export type ScheduleKey = string

export type MisfirePolicy =
  | { readonly strategy: 'skip' }
  | { readonly strategy: 'run-once' }
  | { readonly strategy: 'catch-up'; readonly maxOccurrences: number }

export type ScheduleOverlap = 'allow' | 'skip'

export interface ScheduleRecord {
  readonly key: ScheduleKey
  readonly group: string
  readonly job: JobIdentity
  readonly queue: QueueName
  readonly cron: string | undefined
  readonly everyMs: number | undefined
  readonly timeZone: string | undefined
  readonly payload: JsonValue
  readonly metadata: Readonly<Record<string, string>>
  readonly priority: number
  readonly attemptsMax: number
  readonly backoff: PersistedBackoff | undefined
  readonly timeoutMs: number | undefined
  readonly misfire: MisfirePolicy
  readonly overlap: ScheduleOverlap
  readonly paused: boolean
  readonly revision: number
  readonly nextRunAtMs: number
  readonly lastScheduledAtMs: number | undefined
  readonly lastJobId: JobId | undefined
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface UpsertScheduleResult {
  readonly record: ScheduleRecord
  readonly created: boolean
  readonly changed: boolean
}

export interface ListSchedulesOptions {
  readonly group?: string
  readonly paused?: boolean
  readonly limit?: number
}

export interface DueSchedulesOptions {
  readonly nowMs: number
  readonly group?: string
  readonly limit?: number
}

export interface ScheduleAddress {
  readonly group: string
  readonly key: ScheduleKey
}

export type ScheduleSelector = ScheduleKey | ScheduleAddress

export type ScheduleOccurrence =
  | number
  | {
      readonly slotMs: number
      readonly enqueueRequest?: EnqueueRequest
    }

export interface ScheduleTickDecision {
  readonly occurrences?: readonly ScheduleOccurrence[]
  readonly occurrenceSlots?: readonly number[]
  readonly enqueueRequests?: readonly EnqueueRequest[]
  readonly nextRunAtMs: number
  readonly skippedSlots?: readonly number[]
  readonly skipReason?: string
}

export interface TickScheduleCommand {
  readonly key: ScheduleSelector
  readonly expectedRevision: number
  readonly expectedRunAtMs: number
  readonly nowMs: number
  readonly decision: ScheduleTickDecision
}

export type ScheduleTickStatus = 'fired' | 'skipped' | 'stale' | 'paused'

export interface TickScheduleResult {
  readonly status: ScheduleTickStatus
  readonly schedule: ScheduleRecord
  readonly jobs: readonly JobRecord[]
  readonly fired: readonly JobRecord[]
  readonly skippedSlots: readonly number[]
  readonly lastJobId: JobId | undefined
}

export type ScheduleStoreError =
  | ScheduleStoreFailure
  | ScheduleDefinitionError
  | ScheduleNotFoundError
  | DuplicateScheduleError
  | JobDefinitionError
  | JobStoreError

export type ScheduleReconcileError = ScheduleStoreError | JobEncodeFailure | UnhandledException

export type ScheduleReconcileRemoval = 'warn' | 'group'

export interface ScheduleReconcileOptions {
  readonly nowMs?: number
  readonly removal?: ScheduleReconcileRemoval
  readonly removeAfterMs?: number
}

export interface ScheduleReconcileReport {
  readonly group: string
  readonly created: readonly ScheduleRecord[]
  readonly updated: readonly ScheduleRecord[]
  readonly unchanged: readonly ScheduleRecord[]
  readonly warned: readonly ScheduleAddress[]
  readonly removed: readonly ScheduleAddress[]
  readonly deferred: readonly ScheduleAddress[]
}

export type ScheduleStoreEffect<
  Success,
  Failure extends ScheduleStoreError = ScheduleStoreError,
  Requirements extends AnyService = never
> = Effect<Success, Failure, Requirements>

export type ScheduleStoreOperation<
  Success,
  Failure extends ScheduleStoreError = ScheduleStoreError,
  Requirements extends AnyService = never
> =
  | ScheduleStoreEffect<Success, Failure, Requirements>
  | PromiseLike<ScheduleStoreEffect<Success, Failure, Requirements>>

export interface JobScheduleStoreContract {
  readonly descriptor: JobScheduleStoreDescriptor

  upsertSchedule(record: ScheduleRecord): ScheduleStoreOperation<UpsertScheduleResult>
  removeSchedule(key: ScheduleSelector): ScheduleStoreOperation<boolean>
  getSchedule(key: ScheduleSelector): ScheduleStoreOperation<ScheduleRecord | undefined>
  listSchedules(options?: ListSchedulesOptions): ScheduleStoreOperation<readonly ScheduleRecord[]>
  dueSchedules(options: DueSchedulesOptions): ScheduleStoreOperation<readonly ScheduleRecord[]>
  tickSchedule(command: TickScheduleCommand): ScheduleStoreOperation<TickScheduleResult>
  pauseSchedule(key: ScheduleSelector): ScheduleStoreOperation<void>
  resumeSchedule(key: ScheduleSelector): ScheduleStoreOperation<void>
}

export interface JobScheduleStoreDescriptor {
  readonly extension: 'better-effect-mq/schedules'
  readonly extensionVersion: 1
  readonly jobStoreProtocolVersion: 1
}

export type ScheduleStoreRequirements<Store extends AnyService> = Store

export type ScheduleStoreJob = EnqueueResult

export type ScheduleStoreJobStore = JobStoreContract
