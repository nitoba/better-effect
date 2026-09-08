// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- this module is the untrusted HTTP and adapter boundary for the reference application.

import { Hono } from 'hono'

import { Effect, Layer, Scope, Service } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import type { HonoContext, HonoEffectOptions, HonoJsonValue } from 'better-effect/hono'
import type { WebEffectStream } from 'better-effect/web'
import { Clock, CurrentRequest } from 'better-effect/standard-services'
import {
  JobAdmin,
  JobEventCursorExpiredError,
  JobEventStore,
  JobEvents,
  JobId,
  JobNotFoundError,
  JobScheduleStore,
  JobStore,
  FlowStore,
  QueueControls,
  QueueName,
  ScheduleNotFoundError,
  isDurableJobEventType
} from 'better-effect-mq'
import type {
  AnyJobEventStoreToken,
  AnyJobStoreToken,
  AttemptRecord,
  AwaitEventsOptions,
  CancelFlowRequest,
  DurableJobEvent,
  FlowSnapshot,
  FlowStoreV2Operation,
  JobAdminListOptions,
  JobEventCursor,
  JobEventPage,
  JobEventReadOptions,
  JobEventStoreError,
  JobEventStoreOperation,
  JobHealthMonitor,
  JobHealthSnapshot,
  JobMetricAttributes,
  JobMetricsSink,
  DurableJobEventType,
  JobStoreError,
  JobListCursor,
  JobRecord,
  JobState,
  JobStoreOperation,
  ListSchedulesOptions,
  QueueControlsRecord,
  ScheduleRecord,
  ScheduleSelector,
  ScheduleStoreError,
  ScheduleStoreOperation
} from 'better-effect-mq'
import { Result } from 'better-result'
import type { Result as ResultType } from 'better-result'

export type DashboardRole = 'viewer' | 'operator' | 'admin'

export interface DashboardPrincipal {
  readonly role: DashboardRole
  readonly subject?: string
}

export interface DashboardAuthorizationRequest {
  readonly request: Request
  readonly requiredRole: DashboardRole
}

/** Host-owned authorization boundary; the dashboard never invents identity. */
export class DashboardAuthorization extends Service<DashboardAuthorization>()(
  '@better-effect/mq-dashboard/Authorization'
) {
  declare readonly authorize: (
    request: DashboardAuthorizationRequest
  ) => DashboardPrincipal | null | PromiseLike<DashboardPrincipal | null>
}

export type DashboardJobRedactionTarget = 'list' | 'detail' | 'attempts' | 'mutation'

/** Stable job-definition identity supplied to host-owned dashboard policies. */
export interface DashboardJobIdentity {
  readonly id: string
  readonly queue: string
  readonly name: string
  readonly version: number
}

export interface DashboardJobRedactionRequest {
  readonly request: Request
  readonly principal: DashboardPrincipal
  readonly job: DashboardJobIdentity
  readonly target: DashboardJobRedactionTarget
  readonly action?: DashboardMutationAction
}

export interface DashboardJobRedactionDecision {
  /** Denied jobs are omitted from lists and rejected by detail/attempt routes. */
  readonly allowed: boolean
  readonly payload: boolean
  readonly result: boolean
  readonly failure: boolean
  /** Only these persisted metadata keys may appear in a response. */
  readonly metadataKeys: readonly string[]
}

export interface DashboardJobRedactionPolicyContract {
  readonly available: boolean
  readonly decide: (
    request: DashboardJobRedactionRequest
  ) => DashboardJobRedactionDecision | PromiseLike<DashboardJobRedactionDecision>
}

/** Host-owned, identity-aware authorization and sensitive-field redaction boundary. */
export class DashboardJobRedactionPolicy extends Service<DashboardJobRedactionPolicy>()(
  '@better-effect/mq-dashboard/JobRedactionPolicy'
) {
  declare readonly available: boolean
  declare readonly decide: DashboardJobRedactionPolicyContract['decide']
}

export const DashboardJobRedactionPolicyDisabled = Layer.succeed(
  DashboardJobRedactionPolicy,
  DashboardJobRedactionPolicy.of({
    available: false,
    decide: () => ({
      allowed: true,
      payload: false,
      result: false,
      failure: false,
      metadataKeys: []
    })
  })
)

export type DashboardMutationAction =
  | 'job.cancel'
  | 'job.promote'
  | 'job.retry'
  | 'job.redrive'
  | 'job.remove'
  | 'queue.pause'
  | 'queue.resume'
  | 'schedule.pause'
  | 'schedule.resume'
  | 'schedule.remove'
  | 'flow.cancel'

export type DashboardMutationPolicyRejection =
  | 'confirmation_required'
  | 'csrf_invalid'
  | 'policy_unavailable'

export interface DashboardMutationPolicyRequest {
  readonly request: Request
  readonly principal: DashboardPrincipal
  readonly action: DashboardMutationAction
}

export type DashboardMutationPolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DashboardMutationPolicyRejection }

export interface DashboardMutationPolicyContract {
  readonly available: boolean
  readonly check: (
    request: DashboardMutationPolicyRequest
  ) => DashboardMutationPolicyDecision | PromiseLike<DashboardMutationPolicyDecision>
}

/** Host-owned confirmation/CSRF boundary for administrative mutations. */
export class DashboardMutationPolicy extends Service<DashboardMutationPolicy>()(
  '@better-effect/mq-dashboard/MutationPolicy'
) {
  declare readonly available: boolean
  declare readonly check: DashboardMutationPolicyContract['check']
}

export const DashboardMutationPolicyDisabled = Layer.succeed(
  DashboardMutationPolicy,
  DashboardMutationPolicy.of({
    available: false,
    check: () => ({ allowed: false, reason: 'policy_unavailable' as const })
  })
)

export interface DashboardAuditEvent {
  readonly action: DashboardMutationAction
  readonly method: string
  readonly path: string
  readonly role: DashboardRole
  readonly subject: string | undefined
  readonly outcome: 'success' | 'failure' | 'denied'
  readonly errorCode: string | undefined
}

export interface DashboardAuditSinkContract {
  readonly available: boolean
  readonly record: ((event: DashboardAuditEvent) => void | PromiseLike<void>) | undefined
}

/** Optional host-owned audit sink for operator/admin actions. */
export class DashboardAuditSink extends Service<DashboardAuditSink>()(
  '@better-effect/mq-dashboard/AuditSink'
) {
  declare readonly available: boolean
  declare readonly record: DashboardAuditSinkContract['record']
}

export const DashboardAuditSinkDisabled = Layer.succeed(
  DashboardAuditSink,
  DashboardAuditSink.of({ available: false, record: undefined })
)

export interface DashboardRateLimitRequest {
  readonly request: Request
  readonly principal: DashboardPrincipal
  readonly action: DashboardMutationAction
}

export interface DashboardRateLimitDecision {
  readonly allowed: boolean
  readonly retryAfterSeconds: number | undefined
}

export interface DashboardRateLimiterContract {
  readonly available: boolean
  readonly check: (
    request: DashboardRateLimitRequest
  ) => DashboardRateLimitDecision | PromiseLike<DashboardRateLimitDecision>
}

/** Optional process/host-owned limiter for administrative mutations. */
export class DashboardRateLimiter extends Service<DashboardRateLimiter>()(
  '@better-effect/mq-dashboard/RateLimiter'
) {
  declare readonly available: boolean
  declare readonly check: DashboardRateLimiterContract['check']
}

export const DashboardRateLimiterDisabled = Layer.succeed(
  DashboardRateLimiter,
  DashboardRateLimiter.of({
    available: false,
    check: () => ({ allowed: true, retryAfterSeconds: undefined })
  })
)

export type DashboardEventFeedPage = (
  options: JobEventReadOptions
) => PromiseLike<ResultType<JobEventPage, JobEventStoreError>>

export interface DashboardEventFeedContract {
  readonly available: boolean
  /** Optional process-local dashboard health sink for SSE instrumentation. */
  readonly health?: DashboardHealthContract
  readonly page: DashboardEventFeedPage | undefined
  readonly tailCursor:
    | (() => JobEventStoreOperation<JobEventCursor, JobEventStoreError>)
    | undefined
  readonly awaitEvents:
    | ((options: AwaitEventsOptions) => JobEventStoreOperation<void, JobEventStoreError>)
    | undefined
}

/** Optional durable feed boundary. A disabled feed keeps polling endpoints available. */
export class DashboardEventFeed extends Service<DashboardEventFeed>()(
  '@better-effect/mq-dashboard/EventFeed'
) {
  declare readonly available: boolean
  declare readonly health: DashboardHealthContract | undefined
  declare readonly page: DashboardEventFeedPage | undefined
  declare readonly tailCursor:
    | (() => JobEventStoreOperation<JobEventCursor, JobEventStoreError>)
    | undefined
  declare readonly awaitEvents:
    | ((options: AwaitEventsOptions) => JobEventStoreOperation<void, JobEventStoreError>)
    | undefined
}

export const DashboardEventFeedDisabled = Layer.succeed(
  DashboardEventFeed,
  DashboardEventFeed.of({
    available: false,
    health: undefined,
    page: undefined,
    tailCursor: undefined,
    awaitEvents: undefined
  })
)

export type DashboardHealthState = 'idle' | 'active' | 'degraded'

export type DashboardNotificationStatus = 'available' | 'unavailable' | 'degraded'

export interface DashboardNotificationSnapshot {
  readonly awaitEventsAvailable: boolean
  readonly status: DashboardNotificationStatus
  readonly failures: number
  readonly fallbackPolls: number
}

export type DashboardHealthSignal =
  | { readonly type: 'connection-opened'; readonly reconnect: boolean }
  | {
      readonly type: 'connection-closed'
      readonly reason: 'completed' | 'aborted' | 'cursor-expired' | 'failure'
    }
  | { readonly type: 'event-observed'; readonly lagMs: number }
  | { readonly type: 'backpressure'; readonly dropped?: number; readonly coalesced?: number }
  | { readonly type: 'stream-failed'; readonly kind: 'store' | 'consumer' | 'internal' }
  | { readonly type: 'notification-failed'; readonly source: 'awaitEvents' }
  | { readonly type: 'notification-fallback'; readonly reason: 'unavailable' | 'failure' }

export interface DashboardHealthSnapshot {
  readonly state: DashboardHealthState
  readonly activeConnections: number
  readonly connectionsOpened: number
  readonly connectionsClosed: number
  readonly reconnects: number
  readonly cursorExpiries: number
  readonly latestObservedLagMs: number | undefined
  readonly maxObservedLagMs: number | undefined
  readonly backpressureDropped: number
  readonly eventsCoalesced: number
  readonly streamFailures: number
  /** Optional for compatibility with pre-health implementations. */
  readonly notifications?: DashboardNotificationSnapshot
  readonly job: JobHealthSnapshot | undefined
}

export interface DashboardHealthOptions {
  readonly jobHealth?: JobHealthMonitor
  readonly metrics?: JobMetricsSink
  /** Whether this feed exposes the process-local awaitEvents wake capability. */
  readonly awaitEventsAvailable?: boolean
}

export interface DashboardHealthMonitor {
  readonly record: (signal: DashboardHealthSignal) => void
  readonly snapshot: () => DashboardHealthSnapshot
  readonly reset: () => void
}

export interface DashboardHealthContract extends DashboardHealthMonitor {
  readonly available: boolean
}

const initialDashboardHealth = (
  job: JobHealthSnapshot | undefined,
  awaitEventsAvailable: boolean
): DashboardHealthSnapshot => ({
  state: 'idle',
  activeConnections: 0,
  connectionsOpened: 0,
  connectionsClosed: 0,
  reconnects: 0,
  cursorExpiries: 0,
  latestObservedLagMs: undefined,
  maxObservedLagMs: undefined,
  backpressureDropped: 0,
  eventsCoalesced: 0,
  streamFailures: 0,
  notifications: {
    awaitEventsAvailable,
    status: awaitEventsAvailable ? 'available' : 'unavailable',
    failures: 0,
    fallbackPolls: 0
  },
  job
})

export const DashboardHealthMetricNames = Object.freeze({
  activeConnections: 'better_effect_mq_dashboard_sse_connections_active',
  connectionsOpened: 'better_effect_mq_dashboard_sse_connections_opened_total',
  connectionsClosed: 'better_effect_mq_dashboard_sse_connections_closed_total',
  reconnects: 'better_effect_mq_dashboard_sse_reconnects_total',
  cursorExpiries: 'better_effect_mq_dashboard_sse_cursor_expired_total',
  eventLag: 'better_effect_mq_dashboard_sse_event_lag_ms',
  dropped: 'better_effect_mq_dashboard_sse_events_dropped_total',
  coalesced: 'better_effect_mq_dashboard_sse_events_coalesced_total',
  streamFailures: 'better_effect_mq_dashboard_sse_stream_failures_total',
  notificationFailures: 'better_effect_mq_dashboard_sse_notification_failures_total',
  notificationFallbackPolls: 'better_effect_mq_dashboard_sse_notification_fallback_polls_total'
} as const)

const nonNegativeInteger = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0

const defaultDashboardNotifications = (
  awaitEventsAvailable: boolean
): DashboardNotificationSnapshot => ({
  awaitEventsAvailable,
  status: awaitEventsAvailable ? 'available' : 'unavailable',
  failures: 0,
  fallbackPolls: 0
})

const observeMetric = (
  metrics: JobMetricsSink | undefined,
  method: keyof JobMetricsSink,
  name: string,
  value: number,
  attributes: JobMetricAttributes = {}
): void => {
  if (metrics === undefined) return
  try {
    const result = metrics[method](name, value, attributes)
    if (result !== undefined) void Promise.resolve(result).catch(() => undefined)
  } catch {
    // Dashboard metrics are advisory and must not affect request handling.
  }
}

export const makeDashboardHealth = (
  options: DashboardHealthOptions = {}
): DashboardHealthMonitor => {
  const metrics = options.metrics
  const awaitEventsAvailable = options.awaitEventsAvailable === true
  let current = initialDashboardHealth(options.jobHealth?.snapshot(), awaitEventsAvailable)

  const record = (signal: DashboardHealthSignal): void => {
    switch (signal.type) {
      case 'connection-opened':
        current = {
          ...current,
          state: 'active',
          activeConnections: current.activeConnections + 1,
          connectionsOpened: current.connectionsOpened + 1,
          reconnects: current.reconnects + (signal.reconnect ? 1 : 0)
        }
        observeMetric(
          metrics,
          'gauge',
          DashboardHealthMetricNames.activeConnections,
          current.activeConnections
        )
        observeMetric(metrics, 'increment', DashboardHealthMetricNames.connectionsOpened, 1)
        if (signal.reconnect) {
          observeMetric(metrics, 'increment', DashboardHealthMetricNames.reconnects, 1)
        }
        break
      case 'connection-closed':
        current = {
          ...current,
          state:
            current.state === 'degraded' || signal.reason === 'cursor-expired'
              ? 'degraded'
              : current.activeConnections <= 1
                ? 'idle'
                : 'active',
          activeConnections: Math.max(0, current.activeConnections - 1),
          connectionsClosed: current.connectionsClosed + 1,
          cursorExpiries: current.cursorExpiries + (signal.reason === 'cursor-expired' ? 1 : 0)
        }
        observeMetric(
          metrics,
          'gauge',
          DashboardHealthMetricNames.activeConnections,
          current.activeConnections
        )
        observeMetric(metrics, 'increment', DashboardHealthMetricNames.connectionsClosed, 1, {
          reason: signal.reason
        })
        if (signal.reason === 'cursor-expired') {
          observeMetric(metrics, 'increment', DashboardHealthMetricNames.cursorExpiries, 1)
        }
        break
      case 'event-observed': {
        const lagMs = nonNegativeInteger(signal.lagMs)
        current = {
          ...current,
          latestObservedLagMs: lagMs,
          maxObservedLagMs: Math.max(current.maxObservedLagMs ?? 0, lagMs)
        }
        observeMetric(metrics, 'observe', DashboardHealthMetricNames.eventLag, lagMs)
        break
      }
      case 'backpressure': {
        const dropped = nonNegativeInteger(signal.dropped)
        const coalesced = nonNegativeInteger(signal.coalesced)
        current = {
          ...current,
          state: 'degraded',
          backpressureDropped: current.backpressureDropped + dropped,
          eventsCoalesced: current.eventsCoalesced + coalesced
        }
        if (dropped > 0) {
          observeMetric(metrics, 'increment', DashboardHealthMetricNames.dropped, dropped)
        }
        if (coalesced > 0) {
          observeMetric(metrics, 'increment', DashboardHealthMetricNames.coalesced, coalesced)
        }
        break
      }
      case 'stream-failed':
        current = { ...current, state: 'degraded', streamFailures: current.streamFailures + 1 }
        observeMetric(metrics, 'increment', DashboardHealthMetricNames.streamFailures, 1, {
          kind: signal.kind
        })
        break
      case 'notification-failed': {
        const notifications =
          current.notifications ?? defaultDashboardNotifications(awaitEventsAvailable)
        current = {
          ...current,
          state: 'degraded',
          notifications: {
            ...notifications,
            status: 'degraded',
            failures: notifications.failures + 1,
            fallbackPolls: notifications.fallbackPolls + 1
          }
        }
        observeMetric(metrics, 'increment', DashboardHealthMetricNames.notificationFailures, 1, {
          source: signal.source
        })
        observeMetric(
          metrics,
          'increment',
          DashboardHealthMetricNames.notificationFallbackPolls,
          1,
          { reason: 'failure' }
        )
        break
      }
      case 'notification-fallback': {
        const notifications =
          current.notifications ?? defaultDashboardNotifications(awaitEventsAvailable)
        current = {
          ...current,
          state: signal.reason === 'failure' ? 'degraded' : current.state,
          notifications: {
            ...notifications,
            status: signal.reason === 'failure' ? 'degraded' : 'unavailable',
            fallbackPolls: notifications.fallbackPolls + 1
          }
        }
        observeMetric(
          metrics,
          'increment',
          DashboardHealthMetricNames.notificationFallbackPolls,
          1,
          { reason: signal.reason }
        )
        break
      }
    }
  }

  return Object.freeze({
    record,
    snapshot: () =>
      Object.freeze({
        ...current,
        job: options.jobHealth?.snapshot()
      }),
    reset: () => {
      current = initialDashboardHealth(options.jobHealth?.snapshot(), awaitEventsAvailable)
    }
  })
}

const unavailableDashboardHealth: DashboardHealthContract = {
  available: false,
  ...makeDashboardHealth()
}

/** Compose the public JobEvents reader into the dashboard's optional feed boundary. */
export const dashboardEventFeedLayer = (
  options: {
    readonly health?: DashboardHealthContract
  } = {}
) =>
  Layer.gen(DashboardEventFeed, async function* () {
    const eventStore = yield* JobEventStore

    const page: DashboardEventFeedPage = async (options) => {
      const read = Effect.fn(async function* () {
        return Result.ok(yield* JobEvents.page(JobEventStore, options))
      })

      return await read()
    }

    return DashboardEventFeed.of({
      available: true,
      health: options.health,
      page,
      tailCursor: () => eventStore.tailCursor(),
      awaitEvents: (options) => eventStore.awaitEvents(options)
    })
  })

type DashboardScheduleOperation<Value> = ScheduleStoreOperation<Value, ScheduleStoreError>

export interface DashboardScheduleCapabilityContract {
  readonly available: boolean
  readonly list:
    | ((options?: ListSchedulesOptions) => DashboardScheduleOperation<readonly ScheduleRecord[]>)
    | undefined
  readonly get:
    | ((selector: ScheduleSelector) => DashboardScheduleOperation<ScheduleRecord | undefined>)
    | undefined
  readonly pause: ((selector: ScheduleSelector) => DashboardScheduleOperation<void>) | undefined
  readonly resume: ((selector: ScheduleSelector) => DashboardScheduleOperation<void>) | undefined
  readonly remove: ((selector: ScheduleSelector) => DashboardScheduleOperation<boolean>) | undefined
}

/** Optional schedule inspection and administration boundary for the dashboard. */
export class DashboardScheduleCapability extends Service<DashboardScheduleCapability>()(
  '@better-effect/mq-dashboard/Schedules'
) {
  declare readonly available: boolean
  declare readonly list: DashboardScheduleCapabilityContract['list']
  declare readonly get: DashboardScheduleCapabilityContract['get']
  declare readonly pause: DashboardScheduleCapabilityContract['pause']
  declare readonly resume: DashboardScheduleCapabilityContract['resume']
  declare readonly remove: DashboardScheduleCapabilityContract['remove']
}

export const DashboardScheduleCapabilityDisabled = Layer.succeed(
  DashboardScheduleCapability,
  DashboardScheduleCapability.of({
    available: false,
    list: undefined,
    get: undefined,
    pause: undefined,
    resume: undefined,
    remove: undefined
  })
)

/** Compose the public JobScheduleStore token into a dashboard capability. */
export const dashboardScheduleCapabilityLayer = () =>
  Layer.gen(DashboardScheduleCapability, async function* () {
    const schedules = yield* JobScheduleStore
    return DashboardScheduleCapability.of({
      available: true,
      list: schedules.listSchedules.bind(schedules),
      get: schedules.getSchedule.bind(schedules),
      pause: schedules.pauseSchedule.bind(schedules),
      resume: schedules.resumeSchedule.bind(schedules),
      remove: schedules.removeSchedule.bind(schedules)
    })
  })

export interface DashboardFlowCapabilityContract {
  readonly available: boolean
  readonly get:
    | ((request: {
        readonly flowId: import('better-effect-mq').JobId
      }) => FlowStoreV2Operation<FlowSnapshot | undefined>)
    | undefined
  readonly cancel:
    | ((
        request: CancelFlowRequest
      ) => FlowStoreV2Operation<import('better-effect-mq').CancelFlowResult>)
    | undefined
}

/** Optional flow inspection and cancellation boundary for the dashboard. */
export class DashboardFlowCapability extends Service<DashboardFlowCapability>()(
  '@better-effect/mq-dashboard/Flows'
) {
  declare readonly available: boolean
  declare readonly get: DashboardFlowCapabilityContract['get']
  declare readonly cancel: DashboardFlowCapabilityContract['cancel']
}

export const DashboardFlowCapabilityDisabled = Layer.succeed(
  DashboardFlowCapability,
  DashboardFlowCapability.of({ available: false, get: undefined, cancel: undefined })
)

/** Compose the public FlowStore token into a dashboard capability. */
export const dashboardFlowCapabilityLayer = () =>
  Layer.gen(DashboardFlowCapability, async function* () {
    const flows = yield* FlowStore
    return DashboardFlowCapability.of({
      available: true,
      get: flows.getFlow.bind(flows),
      cancel: flows.cancel.bind(flows)
    })
  })

export interface DashboardControlCapabilityContract {
  readonly available: boolean
  readonly get:
    | ((
        queue: import('better-effect-mq').QueueName
      ) => PromiseLike<ResultType<QueueControlsRecord | undefined, JobStoreError>>)
    | undefined
}

/** Optional distributed-controls inspection boundary for the dashboard. */
export class DashboardControlCapability extends Service<DashboardControlCapability>()(
  '@better-effect/mq-dashboard/Controls'
) {
  declare readonly available: boolean
  declare readonly get: DashboardControlCapabilityContract['get']
}

export const DashboardControlCapabilityDisabled = Layer.succeed(
  DashboardControlCapability,
  DashboardControlCapability.of({ available: false, get: undefined })
)

/** Compose the public QueueControls token into a dashboard capability. */
export const dashboardControlCapabilityLayer = () =>
  Layer.gen(DashboardControlCapability, async function* () {
    const controls = yield* QueueControls
    const get: NonNullable<DashboardControlCapabilityContract['get']> = (queue) => {
      const read = Effect.fn(async function* () {
        return Result.ok(yield* controls.get(queue))
      })
      return Promise.resolve(read())
    }
    return DashboardControlCapability.of({ available: true, get })
  })

export class DashboardHttpError extends Error {
  readonly status: number
  readonly code: string
  readonly oldestAvailableCursor: string | undefined
  readonly retryAfterSeconds: number | undefined

  constructor(
    status: number,
    code: string,
    message: string,
    oldestAvailableCursor?: string,
    retryAfterSeconds?: number
  ) {
    super(message)
    this.name = 'DashboardHttpError'
    this.status = status
    this.code = code
    this.oldestAvailableCursor = oldestAvailableCursor
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type DashboardJson = HonoJsonValue
type DashboardResult<Value> = ResultType<Value, DashboardHttpError>

const roleRank = {
  viewer: 1,
  operator: 2,
  admin: 3
} satisfies Readonly<Record<DashboardRole, number>>

const requireRole = async (
  authorization: InstanceType<typeof DashboardAuthorization>,
  request: Request,
  requiredRole: DashboardRole
): Promise<DashboardResult<DashboardPrincipal>> => {
  let principal: DashboardPrincipal | null

  try {
    principal = await authorization.authorize({ request, requiredRole })
  } catch {
    return Result.err(
      new DashboardHttpError(503, 'authorization_unavailable', 'Authorization unavailable')
    )
  }

  if (principal === null) {
    return Result.err(new DashboardHttpError(401, 'unauthorized', 'Authentication required'))
  }

  if (roleRank[principal.role] < roleRank[requiredRole]) {
    return Result.err(new DashboardHttpError(403, 'forbidden', 'Insufficient dashboard role'))
  }

  return Result.ok(principal)
}

const recordMutationAudit = async (
  sink: InstanceType<typeof DashboardAuditSink>,
  request: Request,
  principal: DashboardPrincipal,
  action: DashboardMutationAction,
  outcome: DashboardAuditEvent['outcome'],
  errorCode: string | undefined
): Promise<void> => {
  if (sink.record === undefined) return
  try {
    await sink.record({
      action,
      method: request.method,
      path: new URL(request.url).pathname,
      role: principal.role,
      subject: principal.subject,
      outcome,
      errorCode
    })
  } catch {
    // Audit is best-effort and must never change the storage result.
  }
}

const mutationPolicyError = (reason: DashboardMutationPolicyRejection): DashboardHttpError => {
  switch (reason) {
    case 'confirmation_required':
      return new DashboardHttpError(
        428,
        'confirmation_required',
        'Mutation confirmation is required'
      )
    case 'csrf_invalid':
      return new DashboardHttpError(403, 'csrf_invalid', 'Mutation confirmation is invalid')
    case 'policy_unavailable':
      return new DashboardHttpError(
        503,
        'mutation_policy_unavailable',
        'Dashboard mutations are disabled'
      )
  }
}

interface DashboardMutationGuardOptions {
  readonly authorization: InstanceType<typeof DashboardAuthorization>
  readonly policy: InstanceType<typeof DashboardMutationPolicy>
  readonly rateLimiter: InstanceType<typeof DashboardRateLimiter>
  readonly auditSink: InstanceType<typeof DashboardAuditSink>
  readonly request: Request
  readonly requiredRole: DashboardRole
  readonly action: DashboardMutationAction
}

const requireMutation = async (
  options: DashboardMutationGuardOptions
): Promise<DashboardResult<DashboardPrincipal>> => {
  const authorized = await requireRole(options.authorization, options.request, options.requiredRole)
  if (Result.isError(authorized)) return authorized

  const principal = authorized.value
  let rateLimit: DashboardRateLimitDecision
  try {
    rateLimit = await options.rateLimiter.check({
      request: options.request,
      principal,
      action: options.action
    })
  } catch {
    const error = new DashboardHttpError(
      503,
      'rate_limiter_unavailable',
      'Dashboard rate limiter unavailable'
    )
    await recordMutationAudit(
      options.auditSink,
      options.request,
      principal,
      options.action,
      'denied',
      error.code
    )
    return Result.err(error)
  }

  if (!rateLimit.allowed) {
    const error = new DashboardHttpError(
      429,
      'rate_limited',
      'Too many dashboard mutations',
      undefined,
      rateLimit.retryAfterSeconds
    )
    await recordMutationAudit(
      options.auditSink,
      options.request,
      principal,
      options.action,
      'denied',
      error.code
    )
    return Result.err(error)
  }

  if (!options.policy.available) {
    const error = mutationPolicyError('policy_unavailable')
    await recordMutationAudit(
      options.auditSink,
      options.request,
      principal,
      options.action,
      'denied',
      error.code
    )
    return Result.err(error)
  }

  let policy: DashboardMutationPolicyDecision
  try {
    policy = await options.policy.check({
      request: options.request,
      principal,
      action: options.action
    })
  } catch {
    const error = new DashboardHttpError(
      503,
      'mutation_policy_unavailable',
      'Dashboard mutation policy unavailable'
    )
    await recordMutationAudit(
      options.auditSink,
      options.request,
      principal,
      options.action,
      'denied',
      error.code
    )
    return Result.err(error)
  }

  if (!policy.allowed) {
    const error = mutationPolicyError(policy.reason)
    await recordMutationAudit(
      options.auditSink,
      options.request,
      principal,
      options.action,
      'denied',
      error.code
    )
    return Result.err(error)
  }

  return Result.ok(principal)
}

const auditMutationResult = async <Value>(
  sink: InstanceType<typeof DashboardAuditSink>,
  request: Request,
  principal: DashboardPrincipal,
  action: DashboardMutationAction,
  result: DashboardResult<Value>
): Promise<DashboardResult<Value>> => {
  await recordMutationAudit(
    sink,
    request,
    principal,
    action,
    Result.isError(result) ? 'failure' : 'success',
    Result.isError(result) ? result.error.code : undefined
  )
  return result
}

const storageError = (error: unknown): DashboardHttpError => {
  if (JobNotFoundError.is(error)) {
    return new DashboardHttpError(404, 'job_not_found', 'Job not found')
  }

  if (JobEventCursorExpiredError.is(error)) {
    return new DashboardHttpError(
      409,
      'cursor_expired',
      'The event cursor has expired; refresh from the available cursor',
      error.oldestAvailableCursor
    )
  }

  if (ScheduleNotFoundError.is(error)) {
    return new DashboardHttpError(404, 'schedule_not_found', 'Schedule not found')
  }

  return new DashboardHttpError(500, 'storage_failure', 'Dashboard storage operation failed')
}

const jsonError = (
  error: unknown,
  context: { json: (body: DashboardJson, status?: number) => Response }
): Response => {
  const dashboardError =
    error instanceof DashboardHttpError ||
    JobNotFoundError.is(error) ||
    JobEventCursorExpiredError.is(error)
      ? error instanceof DashboardHttpError
        ? error
        : storageError(error)
      : undefined

  if (dashboardError !== undefined) {
    const body = {
      error: dashboardError.code,
      message: dashboardError.message,
      ...(dashboardError.oldestAvailableCursor === undefined
        ? {}
        : {
            oldestAvailableCursor: dashboardError.oldestAvailableCursor,
            refreshRequired: true
          }),
      ...(dashboardError.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: dashboardError.retryAfterSeconds })
    }

    return context.json(body, dashboardError.status)
  }

  return context.json({ error: 'internal_error', message: 'Internal Server Error' }, 500)
}

const defaultJobRedactionDecision: DashboardJobRedactionDecision = {
  allowed: true,
  payload: false,
  result: false,
  failure: false,
  metadataKeys: []
}

const jobIdentity = (job: JobRecord): DashboardJobIdentity => ({
  id: job.id,
  queue: job.queue,
  name: job.name,
  version: job.version
})

const normalizeJobRedactionDecision = (
  decision: unknown
): DashboardJobRedactionDecision | undefined => {
  if (decision === null || typeof decision !== 'object') return undefined
  const candidate = decision as Partial<DashboardJobRedactionDecision>
  if (
    typeof candidate.allowed !== 'boolean' ||
    typeof candidate.payload !== 'boolean' ||
    typeof candidate.result !== 'boolean' ||
    typeof candidate.failure !== 'boolean' ||
    !Array.isArray(candidate.metadataKeys) ||
    candidate.metadataKeys.some((key) => typeof key !== 'string')
  ) {
    return undefined
  }
  return {
    allowed: candidate.allowed,
    payload: candidate.payload,
    result: candidate.result,
    failure: candidate.failure,
    metadataKeys: candidate.metadataKeys.filter((key) => key.length <= 128).slice(0, 32)
  }
}

const sanitizeMetadata = (
  metadata: Readonly<Record<string, string>>,
  metadataKeys: readonly string[]
): Readonly<Record<string, string>> | undefined => {
  const selected = metadataKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(metadata, key))
    .slice(0, 32)
    .map((key) => [key, metadata[key]!.slice(0, 256)] as const)
  return selected.length === 0 ? undefined : Object.fromEntries(selected)
}

const sanitizeJob = (job: JobRecord, decision: DashboardJobRedactionDecision) => {
  const metadata = sanitizeMetadata(job.metadata, decision.metadataKeys)
  return {
    id: job.id,
    name: job.name,
    version: job.version,
    queue: job.queue,
    state: job.state,
    priority: job.priority,
    runAt: job.runAt,
    orderingSequence: job.orderingSequence,
    attemptsMax: job.attemptsMax,
    attemptsMade: job.attemptsMade,
    attemptSequence: job.attemptSequence,
    deliveryCount: job.deliveryCount,
    stalledCount: job.stalledCount,
    timeoutMs: job.timeoutMs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    processedAt: job.processedAt,
    finishedAt: job.finishedAt,
    cancellationRequestedAt: job.cancellationRequestedAt,
    ...(decision.payload ? { payload: job.payload } : {}),
    ...(decision.result ? { result: job.result } : {}),
    ...(decision.failure ? { failure: job.failure } : {}),
    ...(metadata === undefined ? {} : { metadata })
  }
}

const sanitizeAttempt = (attempt: AttemptRecord, decision: DashboardJobRedactionDecision) => ({
  attempt: attempt.attempt,
  attemptSequence: attempt.attemptSequence,
  delivery: attempt.delivery,
  startedAt: attempt.startedAt,
  finishedAt: attempt.finishedAt,
  outcome: attempt.outcome,
  retryAt: attempt.retryAt,
  retryDelayMs: attempt.retryDelayMs,
  ...(decision.result ? { result: attempt.result } : {}),
  ...(decision.failure ? { failure: attempt.failure } : {})
})

const jobRedactionPolicyError = (): DashboardHttpError =>
  new DashboardHttpError(
    503,
    'job_redaction_policy_unavailable',
    'Job redaction policy unavailable'
  )

const decideJobRedaction = async (
  policy: InstanceType<typeof DashboardJobRedactionPolicy>,
  request: Request,
  principal: DashboardPrincipal,
  job: JobRecord,
  target: DashboardJobRedactionTarget,
  action?: DashboardMutationAction
): Promise<DashboardResult<DashboardJobRedactionDecision>> => {
  if (!policy.available) return Result.ok(defaultJobRedactionDecision)
  try {
    const decision = normalizeJobRedactionDecision(
      await policy.decide({
        request,
        principal,
        job: jobIdentity(job),
        target,
        ...(action === undefined ? {} : { action })
      })
    )
    return decision === undefined ? Result.err(jobRedactionPolicyError()) : Result.ok(decision)
  } catch {
    return Result.err(jobRedactionPolicyError())
  }
}

const jobAccessDenied = (): DashboardHttpError =>
  new DashboardHttpError(403, 'job_forbidden', 'Job access is not permitted')

interface DashboardJobMutationAuthorization {
  readonly principal: DashboardPrincipal
  readonly job: JobRecord
  readonly decision: DashboardJobRedactionDecision
}

interface DashboardJobMutationGuardOptions {
  readonly authorization: InstanceType<typeof DashboardAuthorization>
  readonly policy: InstanceType<typeof DashboardMutationPolicy>
  readonly rateLimiter: InstanceType<typeof DashboardRateLimiter>
  readonly auditSink: InstanceType<typeof DashboardAuditSink>
  readonly jobRedactionPolicy: InstanceType<typeof DashboardJobRedactionPolicy>
  readonly store: InstanceType<typeof JobStore>
  readonly request: Request
  readonly requiredRole: DashboardRole
  readonly action: DashboardMutationAction
  readonly jobId: JobId
}

const requireJobMutation = async (
  options: DashboardJobMutationGuardOptions
): Promise<DashboardResult<DashboardJobMutationAuthorization>> => {
  const authorized = await requireMutation(options)
  if (Result.isError(authorized)) return authorized

  const job = await runOperation(options.store.getJob({ jobId: options.jobId }))
  if (Result.isError(job)) {
    await recordMutationAudit(
      options.auditSink,
      options.request,
      authorized.value,
      options.action,
      'failure',
      job.error.code
    )
    return job
  }
  if (job.value === undefined) {
    const error = new DashboardHttpError(404, 'job_not_found', 'Job not found')
    await recordMutationAudit(
      options.auditSink,
      options.request,
      authorized.value,
      options.action,
      'failure',
      error.code
    )
    return Result.err(error)
  }

  const decision = await decideJobRedaction(
    options.jobRedactionPolicy,
    options.request,
    authorized.value,
    job.value,
    'mutation',
    options.action
  )
  if (Result.isError(decision)) {
    await recordMutationAudit(
      options.auditSink,
      options.request,
      authorized.value,
      options.action,
      'denied',
      decision.error.code
    )
    return decision
  }
  if (!decision.value.allowed) {
    const error = jobAccessDenied()
    await recordMutationAudit(
      options.auditSink,
      options.request,
      authorized.value,
      options.action,
      'denied',
      error.code
    )
    return Result.err(error)
  }

  return Result.ok({ principal: authorized.value, job: job.value, decision: decision.value })
}

const safeEventAttributeKeys = new Set(['action', 'mq.flow.phase', 'mq.flow.name'])

const sanitizeEventAttributes = (
  attributes: Readonly<Record<string, string>>
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(attributes)
      .filter(([key]) => safeEventAttributeKeys.has(key))
      .slice(0, 8)
      .map(([key, value]) => [key, value.slice(0, 256)])
  )

const sanitizeEvent = (event: DurableJobEvent) => ({
  cursor: event.cursor,
  type: event.type,
  recordedAtMs: event.recordedAtMs,
  jobId: event.jobId,
  queue: event.queue,
  name: event.name,
  version: event.version,
  state: event.state,
  attempt: event.attempt,
  delivery: event.delivery,
  workerId: event.workerId,
  outcome: event.outcome,
  failureKind: event.failureKind,
  duplicate: event.duplicate,
  attributes: sanitizeEventAttributes(event.attributes)
})

const sanitizeSchedule = (schedule: ScheduleRecord) => ({
  key: schedule.key,
  group: schedule.group,
  job: schedule.job,
  queue: schedule.queue,
  cron: schedule.cron,
  everyMs: schedule.everyMs,
  timeZone: schedule.timeZone,
  priority: schedule.priority,
  attemptsMax: schedule.attemptsMax,
  timeoutMs: schedule.timeoutMs,
  misfire: schedule.misfire,
  overlap: schedule.overlap,
  paused: schedule.paused,
  revision: schedule.revision,
  nextRunAtMs: schedule.nextRunAtMs,
  lastScheduledAtMs: schedule.lastScheduledAtMs,
  lastJobId: schedule.lastJobId,
  createdAtMs: schedule.createdAtMs,
  updatedAtMs: schedule.updatedAtMs
})

const sanitizeFlowParent = (parent: FlowSnapshot['parent']) => ({
  flowId: parent.flowId,
  flowName: parent.flowName,
  depth: parent.depth,
  state: parent.state,
  flow: parent.flow
})

const sanitizeFlowChild = (child: FlowSnapshot['children'][number]) => ({
  flowId: child.flowId,
  childKey: child.childKey,
  name: child.name,
  version: child.version,
  childJobId: child.childJobId,
  status: child.status,
  cascaded: child.cascaded,
  pendingSinceMs: child.pendingSinceMs
})

const sanitizeFlow = (snapshot: FlowSnapshot) => ({
  parent: sanitizeFlowParent(snapshot.parent),
  children: snapshot.children.map(sanitizeFlowChild),
  outbox: snapshot.outbox.map((entry) => ({
    id: entry.id,
    flowName: entry.flowName,
    report: {
      flowId: entry.report.flowId,
      childKey: entry.report.childKey,
      outcome: entry.report.outcome
    }
  }))
})

const sanitizeControl = (control: QueueControlsRecord) => ({
  queue: control.queue,
  group: control.group,
  enabled: control.enabled,
  revision: control.revision,
  globalConcurrency: control.globalConcurrency,
  perKeyConcurrency: control.perKeyConcurrency,
  rateLimit: control.rateLimit,
  createdAtMs: control.createdAtMs,
  updatedAtMs: control.updatedAtMs
})

const parsePositiveInteger = (
  value: string | undefined,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER
): DashboardResult<number | undefined> => {
  if (value === undefined || value === '') return Result.ok(undefined)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    return Result.err(
      new DashboardHttpError(400, 'invalid_query', `${field} must be a positive integer`)
    )
  }
  return Result.ok(parsed)
}

const parseOpaqueJson = (value: string, field: string): DashboardResult<unknown> => {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    let binary = atob(padded)
    const bytes: number[] = []
    for (let index = 0; index < binary.length; index += 1) bytes.push(binary.charCodeAt(index))
    return Result.ok(JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))))
  } catch {
    return Result.err(new DashboardHttpError(400, 'invalid_query', `${field} is invalid`))
  }
}

const encodeOpaqueJson = (value: JobListCursor): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

const parseCursor = (value: string | undefined): DashboardResult<JobListCursor | undefined> => {
  if (value === undefined || value === '') return Result.ok(undefined)
  const decoded = parseOpaqueJson(value, 'cursor')
  if (Result.isError(decoded) || decoded.value === null || typeof decoded.value !== 'object') {
    return Result.err(
      Result.isError(decoded)
        ? decoded.error
        : new DashboardHttpError(400, 'invalid_query', 'cursor is invalid')
    )
  }

  // SAFETY: JobAdmin validates the public cursor shape before passing it to a store.
  return Result.ok(decoded.value as JobListCursor)
}

const validStates = new Set<JobState>([
  'waiting',
  'delayed',
  'active',
  'completed',
  'failed',
  'cancelled'
])

const parseStates = (
  query: URLSearchParams
): DashboardResult<JobState | readonly JobState[] | undefined> => {
  const values = query
    .getAll('state')
    .flatMap((value) => value.split(',').map((item) => item.trim()))
    .filter((value) => value.length > 0)
  if (values.length === 0) return Result.ok(undefined)
  if (values.some((value) => !validStates.has(value as JobState))) {
    return Result.err(new DashboardHttpError(400, 'invalid_query', 'state is invalid'))
  }
  const states = values as JobState[]
  return Result.ok(states.length === 1 ? states[0] : states)
}

const parseMetadata = (
  query: URLSearchParams
): DashboardResult<Readonly<Record<string, string>> | undefined> => {
  const values = query.getAll('metadata')
  if (values.length === 0) return Result.ok(undefined)
  const metadata: Record<string, string> = {}
  for (const value of values) {
    const separator = value.indexOf(':')
    if (separator < 1 || separator === value.length - 1) {
      return Result.err(new DashboardHttpError(400, 'invalid_query', 'metadata must use key:value'))
    }
    metadata[value.slice(0, separator)] = value.slice(separator + 1)
  }
  return Result.ok(metadata)
}

const parseListOptions = (request: Request): DashboardResult<JobAdminListOptions> => {
  const query = new URL(request.url).searchParams
  const queue = query.get('queue')
  const name = query.get('name')
  const orderBy = query.get('orderBy')
  const order = query.get('order')
  const version = parsePositiveInteger(query.get('version') ?? undefined, 'version')
  const limit = parsePositiveInteger(query.get('limit') ?? undefined, 'limit', 100)
  const cursor = parseCursor(query.get('cursor') ?? undefined)
  const states = parseStates(query)
  const metadata = parseMetadata(query)
  if (Result.isError(version)) return Result.err(version.error)
  if (Result.isError(limit)) return Result.err(limit.error)
  if (Result.isError(cursor)) return Result.err(cursor.error)
  if (Result.isError(states)) return Result.err(states.error)
  if (Result.isError(metadata)) return Result.err(metadata.error)
  if (orderBy !== null && !['enqueuedAt', 'runAt', 'finishedAt'].includes(orderBy)) {
    return Result.err(new DashboardHttpError(400, 'invalid_query', 'orderBy is invalid'))
  }
  if (order !== null && !['asc', 'desc'].includes(order)) {
    return Result.err(new DashboardHttpError(400, 'invalid_query', 'order is invalid'))
  }

  const options: JobAdminListOptions = {
    ...(queue === null ? {} : { queue }),
    ...(name === null ? {} : { name }),
    ...(version.value === undefined ? {} : { version: version.value }),
    ...(metadata.value === undefined ? {} : { metadata: metadata.value }),
    ...(orderBy === null
      ? {}
      : { orderBy: orderBy as NonNullable<JobAdminListOptions['orderBy']> }),
    ...(order === null ? {} : { order: order as NonNullable<JobAdminListOptions['order']> }),
    ...(limit.value === undefined ? {} : { limit: limit.value }),
    ...(cursor.value === undefined ? {} : { cursor: cursor.value }),
    ...(states.value === undefined ? {} : { state: states.value })
  }
  return Result.ok(options)
}

const parseEventOptions = (
  request: Request,
  after?: string
): DashboardResult<JobEventReadOptions> => {
  const query = new URL(request.url).searchParams
  const queueValues = query
    .getAll('queue')
    .flatMap((value) => value.split(',').map((item) => item.trim()))
    .filter((value) => value.length > 0)
  const queues: QueueName[] = []
  for (const value of queueValues) {
    const queue = QueueName.make(value)
    if (Result.isError(queue))
      return Result.err(new DashboardHttpError(400, 'invalid_query', 'queue is invalid'))
    queues.push(queue.value)
  }

  const jobIdValue = query.get('jobId') ?? undefined
  const jobId =
    jobIdValue === undefined ? Result.ok<JobId | undefined>(undefined) : JobId.make(jobIdValue)
  if (Result.isError(jobId))
    return Result.err(new DashboardHttpError(400, 'invalid_query', 'jobId is invalid'))

  const types = query
    .getAll('type')
    .flatMap((value) => value.split(',').map((item) => item.trim()))
    .filter((value) => value.length > 0)
  if (types.some((value) => !isDurableJobEventType(value))) {
    return Result.err(new DashboardHttpError(400, 'invalid_query', 'type is invalid'))
  }

  const limit = parsePositiveInteger(query.get('limit') ?? undefined, 'limit', 100)
  if (Result.isError(limit)) return Result.err(limit.error)

  const checkedTypes = types.filter(isDurableJobEventType)
  const options: JobEventReadOptions = {
    ...(after === undefined ? {} : { after: after as JobEventCursor }),
    ...(limit.value === undefined ? {} : { limit: limit.value }),
    ...(queues.length === 0 ? {} : { queues }),
    ...(jobId.value === undefined ? {} : { jobId: jobId.value }),
    ...(checkedTypes.length === 0 ? {} : { types: checkedTypes as DurableJobEventType[] })
  }
  return Result.ok(options)
}

const parseRetryBody = async (
  request: Request,
  now: number
): Promise<DashboardResult<{ runAt: number }>> => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Result.err(new DashboardHttpError(400, 'invalid_body', 'Request body must be JSON'))
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return Result.err(new DashboardHttpError(400, 'invalid_body', 'Request body must be an object'))
  }
  const fields = body as Record<string, unknown>
  const at = fields.at
  const delayMs = fields.delayMs
  if (at !== undefined && delayMs !== undefined) {
    return Result.err(new DashboardHttpError(400, 'invalid_body', 'Use either at or delayMs'))
  }
  if (at !== undefined) {
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
      return Result.err(new DashboardHttpError(400, 'invalid_body', 'at must be a timestamp'))
    }
    return Result.ok({ runAt: at })
  }
  if (delayMs !== undefined) {
    if (typeof delayMs !== 'number' || !Number.isSafeInteger(delayMs) || delayMs < 0) {
      return Result.err(new DashboardHttpError(400, 'invalid_body', 'delayMs must be non-negative'))
    }
    return Result.ok({ runAt: now + delayMs })
  }
  return Result.ok({ runAt: now })
}

const parseJobId = (value: string | undefined): DashboardResult<JobId> => {
  if (value === undefined) {
    return Result.err(new DashboardHttpError(400, 'invalid_path', 'jobId is invalid'))
  }
  const jobId = JobId.make(value)
  return Result.isError(jobId)
    ? Result.err(new DashboardHttpError(400, 'invalid_path', 'jobId is invalid'))
    : Result.ok(jobId.value)
}

const parseQueue = (value: string | undefined): DashboardResult<string> =>
  value === undefined || value.length === 0
    ? Result.err(new DashboardHttpError(400, 'invalid_path', 'queue is invalid'))
    : Result.ok(value)

const parseQueueName = (value: string | undefined): DashboardResult<QueueName> => {
  const queue = parseQueue(value)
  if (Result.isError(queue)) return queue
  const parsed = QueueName.make(queue.value)
  return Result.isError(parsed)
    ? Result.err(new DashboardHttpError(400, 'invalid_path', 'queue is invalid'))
    : Result.ok(parsed.value)
}

const runOperation = async <Value, Failure extends JobStoreError>(
  operation: JobStoreOperation<Value, Failure>
): Promise<DashboardResult<Value>> => {
  try {
    const result = await operation
    return Result.isError(result) ? Result.err(storageError(result.error)) : Result.ok(result.value)
  } catch (error) {
    return Result.err(storageError(error))
  }
}

const runCapabilityOperation = async <Value>(
  operation: ResultType<Value, unknown> | PromiseLike<ResultType<Value, unknown>>
): Promise<DashboardResult<Value>> => {
  try {
    const result = await operation
    return Result.isError(result) ? Result.err(storageError(result.error)) : Result.ok(result.value)
  } catch (error) {
    return Result.err(storageError(error))
  }
}

const runEventPage = async (
  feed: InstanceType<typeof DashboardEventFeed>,
  options: JobEventReadOptions
): Promise<DashboardResult<JobEventPage>> => {
  if (feed.page === undefined) {
    return Result.err(
      new DashboardHttpError(503, 'events_unavailable', 'Durable events are not installed')
    )
  }
  try {
    const result = await feed.page(options)
    return Result.isError(result) ? Result.err(storageError(result.error)) : Result.ok(result.value)
  } catch (error) {
    return Result.err(storageError(error))
  }
}

type SsePayload = Readonly<Record<string, unknown>>

const writeSse = (event: string, data: SsePayload, id?: string): Uint8Array => {
  const lines = JSON.stringify(data)
    .split('\n')
    .map((line) => `data: ${line}`)
  const prefix = [`event: ${event}`, ...(id === undefined ? [] : [`id: ${id}`])]
  return new TextEncoder().encode(`${[...prefix, ...lines, ''].join('\n')}\n`)
}

interface LinkedAbortSignals {
  readonly signal: AbortSignal
  readonly dispose: () => void
}

const linkAbortSignals = (signals: readonly AbortSignal[]): LinkedAbortSignals => {
  const controller = new AbortController()
  const listeners: Array<readonly [AbortSignal, () => void]> = []
  const dispose = (): void => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
    listeners.length = 0
  }
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
    dispose()
  }
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal)
      break
    }
    const listener = (): void => abort(signal)
    listeners.push([signal, listener])
    signal.addEventListener('abort', listener, { once: true })
  }
  return { signal: controller.signal, dispose }
}

const waitForEventOrHeartbeat = async (
  feed: InstanceType<typeof DashboardEventFeed>,
  health: DashboardHealthContract,
  cursor: JobEventCursor,
  queues: readonly import('better-effect-mq').QueueName[] | undefined,
  heartbeatMs: number,
  signal: AbortSignal
): Promise<'event' | 'heartbeat' | 'aborted'> => {
  if (signal.aborted) return 'aborted'
  if (feed.awaitEvents === undefined) {
    health.record({ type: 'notification-fallback', reason: 'unavailable' })
    return await new Promise<'heartbeat' | 'aborted'>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        resolve('aborted')
      }
      timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(signal.aborted ? 'aborted' : 'heartbeat')
      }, heartbeatMs)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  const event = Promise.resolve().then(() =>
    queues === undefined
      ? feed.awaitEvents!({ after: cursor, signal })
      : feed.awaitEvents!({ after: cursor, queues, signal })
  )
  const heartbeat = new Promise<'heartbeat'>((resolve) => {
    timer = setTimeout(() => resolve('heartbeat'), heartbeatMs)
  })
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) {
      resolve('aborted')
      return
    }
    abortListener = () => resolve('aborted')
    signal.addEventListener('abort', abortListener, { once: true })
  })

  try {
    const result = await Promise.race([event, heartbeat, aborted])
    if (result === 'aborted') return 'aborted'
    if (result === 'heartbeat') return signal.aborted ? 'aborted' : 'heartbeat'
    if (Result.isError(result)) {
      if (signal.aborted) return 'aborted'
      health.record({ type: 'notification-failed', source: 'awaitEvents' })
      return 'heartbeat'
    }
    return signal.aborted ? 'aborted' : 'event'
  } catch {
    if (signal.aborted) return 'aborted'
    health.record({ type: 'notification-failed', source: 'awaitEvents' })
    return 'heartbeat'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener)
  }
}

const makeEventSource = (
  feed: InstanceType<typeof DashboardEventFeed>,
  health: DashboardHealthContract,
  options: JobEventReadOptions,
  heartbeatMs: number,
  requestSignal: AbortSignal,
  stopSignal: AbortSignal,
  reconnect: boolean
): AsyncIterable<Uint8Array> =>
  (async function* () {
    const linked = linkAbortSignals([requestSignal, stopSignal])
    let closeReason: Extract<DashboardHealthSignal, { type: 'connection-closed' }>['reason'] =
      'aborted'
    health.record({ type: 'connection-opened', reconnect })
    try {
      const initialCursor = options.after
      let cursor: JobEventCursor
      if (initialCursor === undefined) {
        if (feed.tailCursor === undefined) return
        const tail = await feed.tailCursor()
        if (Result.isError(tail)) {
          closeReason = 'failure'
          health.record({ type: 'stream-failed', kind: 'store' })
          yield writeSse('error', { error: 'internal_error', message: 'Event feed failed' })
          return
        }
        cursor = tail.value
      } else {
        cursor = initialCursor
      }

      for (;;) {
        if (linked.signal.aborted) return
        const page = await runEventPage(feed, { ...options, after: cursor })
        if (Result.isError(page)) {
          if (page.error.code === 'cursor_expired') {
            closeReason = 'cursor-expired'
            health.record({ type: 'connection-closed', reason: 'cursor-expired' })
            yield writeSse('cursor-expired', {
              error: 'cursor_expired',
              ...(page.error.oldestAvailableCursor === undefined
                ? {}
                : { oldestAvailableCursor: page.error.oldestAvailableCursor }),
              refreshRequired: true
            })
          } else {
            closeReason = 'failure'
            health.record({ type: 'stream-failed', kind: 'store' })
            yield writeSse('error', { error: 'internal_error', message: 'Event feed failed' })
          }
          return
        }

        for (const event of page.value.events) {
          if (linked.signal.aborted) return
          health.record({
            type: 'event-observed',
            lagMs: Math.max(0, Date.now() - event.recordedAtMs)
          })
          yield writeSse('job-event', sanitizeEvent(event), event.cursor)
          cursor = event.cursor
        }
        if (page.value.nextCursor !== undefined) cursor = page.value.nextCursor
        if (page.value.events.length > 0 || page.value.nextCursor !== undefined) continue

        const wait = await waitForEventOrHeartbeat(
          feed,
          health,
          cursor,
          options.queues,
          heartbeatMs,
          linked.signal
        )
        if (wait === 'aborted') return
        if (wait === 'heartbeat') yield writeSse('heartbeat', {})
      }
    } finally {
      if (closeReason !== 'cursor-expired') {
        health.record({ type: 'connection-closed', reason: closeReason })
      }
      linked.dispose()
    }
  })()

const authFailureOptions = {
  onSuccess: ({ value, status }, context) => {
    const body = { data: value }
    return status === undefined ? context.json(body) : context.json(body, status as never)
  },
  onFailure: (error: unknown, context: HonoContext) => jsonError(error, context)
} satisfies HonoEffectOptions<unknown>

/** Reference dashboard application. It is a Layer, not a hidden Runtime. */
export const DashboardApp = HonoEffect.app(
  '@better-effect/mq-dashboard/App',
  authFailureOptions,
  async function* (http) {
    const app = new Hono()
    app.use('*', yield* http.middleware())
    const authorization = yield* DashboardAuthorization
    const jobRedactionPolicy = yield* DashboardJobRedactionPolicy
    const mutationPolicy = yield* DashboardMutationPolicy
    const auditSink = yield* DashboardAuditSink
    const rateLimiter = yield* DashboardRateLimiter
    const schedules = yield* DashboardScheduleCapability
    const flows = yield* DashboardFlowCapability
    const controls = yield* DashboardControlCapability

    const authorizeMutation = (
      request: Request,
      requiredRole: DashboardRole,
      action: DashboardMutationAction
    ): Promise<DashboardResult<DashboardPrincipal>> =>
      requireMutation({
        authorization,
        policy: mutationPolicy,
        rateLimiter,
        auditSink,
        request,
        requiredRole,
        action
      })

    const authorizeJobMutation = (
      request: Request,
      requiredRole: DashboardRole,
      action: DashboardMutationAction,
      jobId: JobId,
      store: InstanceType<typeof JobStore>
    ): Promise<DashboardResult<DashboardJobMutationAuthorization>> =>
      requireJobMutation({
        authorization,
        policy: mutationPolicy,
        rateLimiter,
        auditSink,
        jobRedactionPolicy,
        store,
        request,
        requiredRole,
        action,
        jobId
      })

    app.get(
      '/health',
      yield* http.gen(async function* () {
        yield* Result.await(Promise.resolve(Result.ok(undefined)))
        return Result.ok({
          ok: true,
          service: 'better-effect-mq-dashboard',
          capabilities: {
            jobRedactionPolicy: jobRedactionPolicy.available,
            mutationPolicy: mutationPolicy.available,
            audit: auditSink.available,
            rateLimit: rateLimiter.available
          }
        })
      })
    )

    app.get(
      '/api/capabilities',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'viewer')
        if (Result.isError(authorized)) return authorized
        return Result.ok({
          events: (yield* DashboardEventFeed).available,
          schedules: schedules.available,
          flows: flows.available,
          controls: controls.available,
          security: {
            jobRedactionPolicy: jobRedactionPolicy.available,
            mutationPolicy: mutationPolicy.available,
            audit: auditSink.available,
            rateLimit: rateLimiter.available
          }
        })
      })
    )

    app.get(
      '/api/health',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'viewer')
        if (Result.isError(authorized)) return authorized
        const feed = yield* DashboardEventFeed
        const health = feed.health
        if (health === undefined || !health.available) {
          return Result.err(
            new DashboardHttpError(503, 'health_unavailable', 'Dashboard health is not installed')
          )
        }
        return Result.ok(health.snapshot())
      })
    )

    app.get(
      '/api/overview',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'viewer')
        if (Result.isError(authorized)) return authorized
        const feed = yield* DashboardEventFeed
        const counts = yield* JobAdmin.for(JobStore).counts()
        const pausedQueues = yield* JobAdmin.for(JobStore).pausedQueues()
        const store = yield* JobStore
        return Result.ok({
          store: {
            protocolVersion: store.descriptor.protocolVersion,
            adapter: store.descriptor.adapter,
            adapterVersion: store.descriptor.adapterVersion,
            layoutVersion: store.descriptor.layoutVersion,
            capabilities: store.descriptor.capabilities
          },
          counts,
          pausedQueues,
          events: { available: feed.available },
          capabilities: {
            events: feed.available,
            schedules: schedules.available,
            flows: flows.available,
            controls: controls.available,
            security: {
              jobRedactionPolicy: jobRedactionPolicy.available,
              mutationPolicy: mutationPolicy.available,
              audit: auditSink.available,
              rateLimit: rateLimiter.available
            }
          }
        })
      })
    )

    app.get(
      '/api/jobs',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'viewer')
        if (Result.isError(authorized)) return authorized
        const options = parseListOptions(context.req.raw)
        if (Result.isError(options)) return options
        const result = yield* JobAdmin.for(JobStore).list(options.value)
        const jobs = []
        for (const job of result.jobs) {
          const decision = await decideJobRedaction(
            jobRedactionPolicy,
            context.req.raw,
            authorized.value,
            job,
            'list'
          )
          if (Result.isError(decision)) return decision
          if (!decision.value.allowed) continue
          jobs.push(sanitizeJob(job, decision.value))
        }
        return Result.ok({
          jobs,
          nextCursor:
            result.nextCursor === undefined ? undefined : encodeOpaqueJson(result.nextCursor)
        })
      })
    )

    app.get(
      '/api/jobs/:id',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'viewer')
        if (Result.isError(authorized)) return authorized
        const jobId = parseJobId(context.req.param('id'))
        if (Result.isError(jobId)) return jobId
        const store = yield* JobStore
        const result = await runOperation(store.getJob({ jobId: jobId.value }))
        if (Result.isError(result)) return result
        if (result.value === undefined) {
          return Result.err(new DashboardHttpError(404, 'job_not_found', 'Job not found'))
        }
        const decision = await decideJobRedaction(
          jobRedactionPolicy,
          context.req.raw,
          authorized.value,
          result.value,
          'detail'
        )
        if (Result.isError(decision)) return decision
        if (!decision.value.allowed) return Result.err(jobAccessDenied())
        return Result.ok({ job: sanitizeJob(result.value, decision.value) })
      })
    )

    app.get(
      '/api/jobs/:id/attempts',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'viewer')
        if (Result.isError(authorized)) return authorized
        const jobId = parseJobId(context.req.param('id'))
        if (Result.isError(jobId)) return jobId
        const store = yield* JobStore
        const job = await runOperation(store.getJob({ jobId: jobId.value }))
        if (Result.isError(job)) return job
        if (job.value === undefined) {
          return Result.err(new DashboardHttpError(404, 'job_not_found', 'Job not found'))
        }
        const decision = await decideJobRedaction(
          jobRedactionPolicy,
          context.req.raw,
          authorized.value,
          job.value,
          'attempts'
        )
        if (Result.isError(decision)) return decision
        if (!decision.value.allowed) return Result.err(jobAccessDenied())
        const result = await runOperation(store.getAttempts({ jobId: jobId.value }))
        if (Result.isError(result)) return result
        return Result.ok({
          attempts: result.value.map((attempt) => sanitizeAttempt(attempt, decision.value))
        })
      })
    )

    if (schedules.available) {
      const listSchedules = schedules.list
      const getSchedule = schedules.get
      const pauseSchedule = schedules.pause
      const resumeSchedule = schedules.resume
      const removeSchedule = schedules.remove

      if (listSchedules !== undefined) {
        app.get(
          '/api/schedules',
          yield* http.gen(async function* (context) {
            const authorization = yield* DashboardAuthorization
            const authorized = await requireRole(authorization, context.req.raw, 'viewer')
            if (Result.isError(authorized)) return authorized
            const query = new URL(context.req.raw.url).searchParams
            const limit = parsePositiveInteger(query.get('limit') ?? undefined, 'limit', 100)
            if (Result.isError(limit)) return limit
            const pausedValue = query.get('paused')
            if (pausedValue !== null && pausedValue !== 'true' && pausedValue !== 'false') {
              return Result.err(new DashboardHttpError(400, 'invalid_query', 'paused is invalid'))
            }
            const result = await runCapabilityOperation(
              listSchedules({
                ...(query.get('group') === null ? {} : { group: query.get('group')! }),
                ...(pausedValue === null ? {} : { paused: pausedValue === 'true' }),
                ...(limit.value === undefined ? {} : { limit: limit.value })
              })
            )
            if (Result.isError(result)) return result
            return Result.ok({ schedules: result.value.map(sanitizeSchedule) })
          })
        )
      }

      if (getSchedule !== undefined) {
        app.get(
          '/api/schedules/:group/:key',
          yield* http.gen(async function* (context) {
            const authorization = yield* DashboardAuthorization
            const authorized = await requireRole(authorization, context.req.raw, 'viewer')
            if (Result.isError(authorized)) return authorized
            const group = context.req.param('group')
            const key = context.req.param('key')
            if (
              group === undefined ||
              key === undefined ||
              group.length === 0 ||
              key.length === 0
            ) {
              return Result.err(new DashboardHttpError(400, 'invalid_path', 'schedule is invalid'))
            }
            const result = await runCapabilityOperation(getSchedule({ group, key }))
            if (Result.isError(result)) return result
            if (result.value === undefined) {
              return Result.err(
                new DashboardHttpError(404, 'schedule_not_found', 'Schedule not found')
              )
            }
            return Result.ok({ schedule: sanitizeSchedule(result.value) })
          })
        )
      }

      if (pauseSchedule !== undefined) {
        app.post(
          '/api/schedules/:group/:key/pause',
          yield* http.gen(async function* (context) {
            yield* Result.await(Promise.resolve(Result.ok(undefined)))
            const authorized = await authorizeMutation(
              context.req.raw,
              'operator',
              'schedule.pause'
            )
            if (Result.isError(authorized)) return authorized
            const group = context.req.param('group')
            const key = context.req.param('key')
            if (
              group === undefined ||
              key === undefined ||
              group.length === 0 ||
              key.length === 0
            ) {
              return Result.err(new DashboardHttpError(400, 'invalid_path', 'schedule is invalid'))
            }
            const selector: ScheduleSelector = { group, key }
            const result = await runCapabilityOperation(pauseSchedule(selector))
            const audited = await auditMutationResult(
              auditSink,
              context.req.raw,
              authorized.value,
              'schedule.pause',
              result
            )
            if (Result.isError(audited)) return audited
            return Result.ok({ paused: true })
          })
        )
      }

      if (resumeSchedule !== undefined) {
        app.post(
          '/api/schedules/:group/:key/resume',
          yield* http.gen(async function* (context) {
            yield* Result.await(Promise.resolve(Result.ok(undefined)))
            const authorized = await authorizeMutation(
              context.req.raw,
              'operator',
              'schedule.resume'
            )
            if (Result.isError(authorized)) return authorized
            const group = context.req.param('group')
            const key = context.req.param('key')
            if (
              group === undefined ||
              key === undefined ||
              group.length === 0 ||
              key.length === 0
            ) {
              return Result.err(new DashboardHttpError(400, 'invalid_path', 'schedule is invalid'))
            }
            const selector: ScheduleSelector = { group, key }
            const result = await runCapabilityOperation(resumeSchedule(selector))
            const audited = await auditMutationResult(
              auditSink,
              context.req.raw,
              authorized.value,
              'schedule.resume',
              result
            )
            if (Result.isError(audited)) return audited
            return Result.ok({ paused: false })
          })
        )
      }

      if (removeSchedule !== undefined) {
        app.delete(
          '/api/schedules/:group/:key',
          yield* http.gen(async function* (context) {
            yield* Result.await(Promise.resolve(Result.ok(undefined)))
            const authorized = await authorizeMutation(context.req.raw, 'admin', 'schedule.remove')
            if (Result.isError(authorized)) return authorized
            const group = context.req.param('group')
            const key = context.req.param('key')
            if (
              group === undefined ||
              key === undefined ||
              group.length === 0 ||
              key.length === 0
            ) {
              return Result.err(new DashboardHttpError(400, 'invalid_path', 'schedule is invalid'))
            }
            const selector: ScheduleSelector = { group, key }
            const result = await runCapabilityOperation(removeSchedule(selector))
            const normalized =
              Result.isError(result) || result.value
                ? result
                : Result.err(
                    new DashboardHttpError(404, 'schedule_not_found', 'Schedule not found')
                  )
            const audited = await auditMutationResult(
              auditSink,
              context.req.raw,
              authorized.value,
              'schedule.remove',
              normalized
            )
            if (Result.isError(audited)) return audited
            return Result.ok({ removed: true })
          })
        )
      }
    }

    if (flows.available) {
      const getFlow = flows.get
      const cancelFlow = flows.cancel
      if (getFlow !== undefined) {
        app.get(
          '/api/flows/:id',
          yield* http.gen(async function* (context) {
            const authorization = yield* DashboardAuthorization
            const authorized = await requireRole(authorization, context.req.raw, 'viewer')
            if (Result.isError(authorized)) return authorized
            const flowId = parseJobId(context.req.param('id'))
            if (Result.isError(flowId)) return flowId
            const result = await runCapabilityOperation(getFlow({ flowId: flowId.value }))
            if (Result.isError(result)) return result
            if (result.value === undefined) {
              return Result.err(new DashboardHttpError(404, 'flow_not_found', 'Flow not found'))
            }
            return Result.ok({ flow: sanitizeFlow(result.value) })
          })
        )
      }

      if (cancelFlow !== undefined) {
        app.post(
          '/api/flows/:id/cancel',
          yield* http.gen(async function* (context) {
            const authorized = await authorizeMutation(context.req.raw, 'operator', 'flow.cancel')
            if (Result.isError(authorized)) return authorized
            const flowId = parseJobId(context.req.param('id'))
            if (Result.isError(flowId)) return flowId
            const now = (yield* Clock).now().getTime()
            const result = await runCapabilityOperation(cancelFlow({ flowId: flowId.value, now }))
            const audited = await auditMutationResult(
              auditSink,
              context.req.raw,
              authorized.value,
              'flow.cancel',
              result
            )
            if (Result.isError(audited)) return audited
            return Result.ok({
              cancelled: audited.value.cancelled,
              parentSettled: audited.value.parentSettled,
              flow: sanitizeFlow({
                parent: audited.value.parent,
                children: audited.value.children,
                outbox: []
              })
            })
          })
        )
      }
    }

    if (controls.available && controls.get !== undefined) {
      const getControl = controls.get
      app.get(
        '/api/controls/:queue',
        yield* http.gen(async function* (context) {
          const authorization = yield* DashboardAuthorization
          const authorized = await requireRole(authorization, context.req.raw, 'viewer')
          if (Result.isError(authorized)) return authorized
          const queue = parseQueueName(context.req.param('queue'))
          if (Result.isError(queue)) return queue
          const result = await runCapabilityOperation(getControl(queue.value))
          if (Result.isError(result)) return result
          if (result.value === undefined) {
            return Result.err(new DashboardHttpError(404, 'control_not_found', 'Control not found'))
          }
          return Result.ok({ control: sanitizeControl(result.value) })
        })
      )
    }

    app.get(
      '/api/events',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'viewer')
        if (Result.isError(authorized)) return authorized
        const after = new URL(context.req.raw.url).searchParams.get('after') ?? undefined
        const options = parseEventOptions(context.req.raw, after)
        if (Result.isError(options)) return options
        const feed = yield* DashboardEventFeed
        const page = await runEventPage(feed, options.value)
        if (Result.isError(page)) return page
        return Result.ok({
          events: page.value.events.map(sanitizeEvent),
          nextCursor: page.value.nextCursor
        })
      })
    )

    app.get(
      '/api/events/stream',
      yield* http.stream(
        Effect.fn(async function* () {
          const authorization = yield* DashboardAuthorization
          const currentRequest = yield* CurrentRequest
          const request = currentRequest.request as Request
          const authorized = await requireRole(authorization, request, 'viewer')
          if (Result.isError(authorized)) return authorized
          const feed = yield* DashboardEventFeed
          if (!feed.available) {
            return Result.err(
              new DashboardHttpError(503, 'events_unavailable', 'Durable events are not installed')
            )
          }
          const after =
            request.headers.get('Last-Event-ID') ??
            new URL(request.url).searchParams.get('after') ??
            undefined
          const options = parseEventOptions(request, after)
          if (Result.isError(options)) return options
          const health = feed.health ?? unavailableDashboardHealth
          const heartbeat = parsePositiveInteger(
            new URL(request.url).searchParams.get('heartbeatMs') ?? undefined,
            'heartbeatMs',
            300_000
          )
          if (Result.isError(heartbeat)) return heartbeat
          const scope = yield* Scope
          const stop = new AbortController()
          scope.addFinalizer(() => stop.abort())
          return Result.ok<WebEffectStream>({
            headers: {
              'cache-control': 'no-cache',
              connection: 'keep-alive',
              'content-type': 'text/event-stream',
              'x-accel-buffering': 'no'
            },
            producer: ({ signal }) =>
              makeEventSource(
                feed,
                health,
                options.value,
                heartbeat.value ?? 15_000,
                signal,
                stop.signal,
                request.headers.get('Last-Event-ID') !== null
              )
          })
        })
      )
    )

    app.post(
      '/api/jobs/:id/cancel',
      yield* http.gen(async function* (context) {
        const jobId = parseJobId(context.req.param('id'))
        if (Result.isError(jobId)) return jobId
        const store = yield* JobStore
        const authorized = await authorizeJobMutation(
          context.req.raw,
          'operator',
          'job.cancel',
          jobId.value,
          store
        )
        if (Result.isError(authorized)) return authorized
        const now = (yield* Clock).now().getTime()
        const result = await runOperation(store.cancel({ jobId: jobId.value, now }))
        const audited = await auditMutationResult(
          auditSink,
          context.req.raw,
          authorized.value.principal,
          'job.cancel',
          result
        )
        if (Result.isError(audited)) return audited
        return Result.ok({
          job: sanitizeJob(audited.value.record, authorized.value.decision)
        })
      })
    )
    app.post(
      '/api/jobs/:id/promote',
      yield* http.gen(async function* (context) {
        const jobId = parseJobId(context.req.param('id'))
        if (Result.isError(jobId)) return jobId
        const store = yield* JobStore
        const authorized = await authorizeJobMutation(
          context.req.raw,
          'operator',
          'job.promote',
          jobId.value,
          store
        )
        if (Result.isError(authorized)) return authorized
        const now = (yield* Clock).now().getTime()
        const result = await runOperation(store.promote({ jobId: jobId.value, now }))
        const audited = await auditMutationResult(
          auditSink,
          context.req.raw,
          authorized.value.principal,
          'job.promote',
          result
        )
        if (Result.isError(audited)) return audited
        return Result.ok({
          job: sanitizeJob(audited.value.record, authorized.value.decision)
        })
      })
    )
    app.post(
      '/api/jobs/:id/retry',
      yield* http.gen(async function* (context) {
        const jobId = parseJobId(context.req.param('id'))
        if (Result.isError(jobId)) return jobId
        const store = yield* JobStore
        const authorized = await authorizeJobMutation(
          context.req.raw,
          'operator',
          'job.retry',
          jobId.value,
          store
        )
        if (Result.isError(authorized)) return authorized
        const now = (yield* Clock).now().getTime()
        const body = await parseRetryBody(context.req.raw, now)
        if (Result.isError(body)) return body
        const result = await runOperation(
          store.retry({ jobId: jobId.value, now, runAt: body.value.runAt })
        )
        const audited = await auditMutationResult(
          auditSink,
          context.req.raw,
          authorized.value.principal,
          'job.retry',
          result
        )
        if (Result.isError(audited)) return audited
        return Result.ok({
          job: sanitizeJob(audited.value.record, authorized.value.decision)
        })
      })
    )
    app.post(
      '/api/jobs/:id/redrive',
      yield* http.gen(async function* (context) {
        const jobId = parseJobId(context.req.param('id'))
        if (Result.isError(jobId)) return jobId
        const store = yield* JobStore
        const authorized = await authorizeJobMutation(
          context.req.raw,
          'operator',
          'job.redrive',
          jobId.value,
          store
        )
        if (Result.isError(authorized)) return authorized
        const now = (yield* Clock).now().getTime()
        const body = await parseRetryBody(context.req.raw, now)
        if (Result.isError(body)) return body
        const result = await runOperation(
          store.retry({ jobId: jobId.value, now, runAt: body.value.runAt })
        )
        const audited = await auditMutationResult(
          auditSink,
          context.req.raw,
          authorized.value.principal,
          'job.redrive',
          result
        )
        if (Result.isError(audited)) return audited
        return Result.ok({
          job: sanitizeJob(audited.value.record, authorized.value.decision)
        })
      })
    )
    app.delete(
      '/api/jobs/:id',
      yield* http.gen(async function* (context) {
        const jobId = parseJobId(context.req.param('id'))
        if (Result.isError(jobId)) return jobId
        const store = yield* JobStore
        const authorized = await authorizeJobMutation(
          context.req.raw,
          'admin',
          'job.remove',
          jobId.value,
          store
        )
        if (Result.isError(authorized)) return authorized
        const result = yield* JobAdmin.for(JobStore).remove(jobId.value)
        await recordMutationAudit(
          auditSink,
          context.req.raw,
          authorized.value.principal,
          'job.remove',
          'success',
          undefined
        )
        return Result.ok({
          removed: true,
          job: sanitizeJob(result.job, authorized.value.decision)
        })
      })
    )
    app.post(
      '/api/queues/:queue/pause',
      yield* http.gen(async function* (context) {
        const authorized = await authorizeMutation(context.req.raw, 'operator', 'queue.pause')
        if (Result.isError(authorized)) return authorized
        const queue = parseQueue(context.req.param('queue'))
        if (Result.isError(queue)) return queue
        const result = yield* JobAdmin.for(JobStore).pause(queue.value)
        await recordMutationAudit(
          auditSink,
          context.req.raw,
          authorized.value,
          'queue.pause',
          'success',
          undefined
        )
        return Result.ok(result)
      })
    )
    app.post(
      '/api/queues/:queue/resume',
      yield* http.gen(async function* (context) {
        const authorized = await authorizeMutation(context.req.raw, 'operator', 'queue.resume')
        if (Result.isError(authorized)) return authorized
        const queue = parseQueue(context.req.param('queue'))
        if (Result.isError(queue)) return queue
        const result = yield* JobAdmin.for(JobStore).resume(queue.value)
        await recordMutationAudit(
          auditSink,
          context.req.raw,
          authorized.value,
          'queue.resume',
          'success',
          undefined
        )
        return Result.ok(result)
      })
    )

    return app
  }
)

export type DashboardApplication = InstanceType<typeof DashboardApp>

export type { AnyJobEventStoreToken, AnyJobStoreToken, JobEventCursor, JobListCursor }
