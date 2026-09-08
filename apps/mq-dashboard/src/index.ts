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

export type DashboardEventFeedPage = (
  options: JobEventReadOptions
) => PromiseLike<ResultType<JobEventPage, JobEventStoreError>>

export interface DashboardEventFeedContract {
  readonly available: boolean
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
    page: undefined,
    tailCursor: undefined,
    awaitEvents: undefined
  })
)

/** Compose the public JobEvents reader into the dashboard's optional feed boundary. */
export const dashboardEventFeedLayer = () =>
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

  constructor(status: number, code: string, message: string, oldestAvailableCursor?: string) {
    super(message)
    this.name = 'DashboardHttpError'
    this.status = status
    this.code = code
    this.oldestAvailableCursor = oldestAvailableCursor
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
          })
    }

    return context.json(body, dashboardError.status)
  }

  return context.json({ error: 'internal_error', message: 'Internal Server Error' }, 500)
}

const sanitizeJob = (job: JobRecord) => ({
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
  cancellationRequestedAt: job.cancellationRequestedAt
})

const sanitizeAttempt = (attempt: AttemptRecord) => ({
  attempt: attempt.attempt,
  attemptSequence: attempt.attemptSequence,
  delivery: attempt.delivery,
  startedAt: attempt.startedAt,
  finishedAt: attempt.finishedAt,
  outcome: attempt.outcome,
  retryAt: attempt.retryAt,
  retryDelayMs: attempt.retryDelayMs
})

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
  cursor: JobEventCursor,
  queues: readonly import('better-effect-mq').QueueName[] | undefined,
  heartbeatMs: number,
  signal: AbortSignal
): Promise<'event' | 'heartbeat' | 'aborted'> => {
  if (feed.awaitEvents === undefined || signal.aborted) return 'aborted'
  let timer: ReturnType<typeof setTimeout> | undefined
  const event = Promise.resolve(
    queues === undefined
      ? feed.awaitEvents({ after: cursor, signal })
      : feed.awaitEvents({ after: cursor, queues, signal })
  )
  const heartbeat = new Promise<'heartbeat'>((resolve) => {
    timer = setTimeout(() => resolve('heartbeat'), heartbeatMs)
  })

  try {
    const result = await Promise.race([event, heartbeat])
    if (result === 'heartbeat') return signal.aborted ? 'aborted' : 'heartbeat'
    if (Result.isError(result)) return signal.aborted ? 'aborted' : 'event'
    return signal.aborted ? 'aborted' : 'event'
  } catch {
    return signal.aborted ? 'aborted' : 'event'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const makeEventSource = (
  feed: InstanceType<typeof DashboardEventFeed>,
  options: JobEventReadOptions,
  heartbeatMs: number,
  requestSignal: AbortSignal,
  stopSignal: AbortSignal
): AsyncIterable<Uint8Array> =>
  (async function* () {
    const linked = linkAbortSignals([requestSignal, stopSignal])
    try {
      const initialCursor = options.after
      let cursor: JobEventCursor
      if (initialCursor === undefined) {
        if (feed.tailCursor === undefined) return
        const tail = await feed.tailCursor()
        if (Result.isError(tail)) {
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
            yield writeSse('cursor-expired', {
              error: 'cursor_expired',
              ...(page.error.oldestAvailableCursor === undefined
                ? {}
                : { oldestAvailableCursor: page.error.oldestAvailableCursor }),
              refreshRequired: true
            })
          } else {
            yield writeSse('error', { error: 'internal_error', message: 'Event feed failed' })
          }
          return
        }

        for (const event of page.value.events) {
          if (linked.signal.aborted) return
          yield writeSse('job-event', sanitizeEvent(event), event.cursor)
          cursor = event.cursor
        }
        if (page.value.nextCursor !== undefined) cursor = page.value.nextCursor
        if (page.value.events.length > 0 || page.value.nextCursor !== undefined) continue

        const wait = await waitForEventOrHeartbeat(
          feed,
          cursor,
          options.queues,
          heartbeatMs,
          linked.signal
        )
        if (wait === 'aborted') return
        if (wait === 'heartbeat') yield writeSse('heartbeat', {})
      }
    } finally {
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
    const schedules = yield* DashboardScheduleCapability
    const flows = yield* DashboardFlowCapability
    const controls = yield* DashboardControlCapability

    app.get(
      '/health',
      yield* http.gen(async function* () {
        yield* Result.await(Promise.resolve(Result.ok(undefined)))
        return Result.ok({ ok: true, service: 'better-effect-mq-dashboard' })
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
          controls: controls.available
        })
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
            controls: controls.available
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
        return Result.ok({
          jobs: result.jobs.map(sanitizeJob),
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
        return Result.ok({ job: sanitizeJob(result.value) })
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
        const result = await runOperation(store.getAttempts({ jobId: jobId.value }))
        if (Result.isError(result)) return result
        return Result.ok({ attempts: result.value.map(sanitizeAttempt) })
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
            const authorization = yield* DashboardAuthorization
            const authorized = await requireRole(authorization, context.req.raw, 'operator')
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
            if (Result.isError(result)) return result
            return Result.ok({ paused: true })
          })
        )
      }

      if (resumeSchedule !== undefined) {
        app.post(
          '/api/schedules/:group/:key/resume',
          yield* http.gen(async function* (context) {
            const authorization = yield* DashboardAuthorization
            const authorized = await requireRole(authorization, context.req.raw, 'operator')
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
            if (Result.isError(result)) return result
            return Result.ok({ paused: false })
          })
        )
      }

      if (removeSchedule !== undefined) {
        app.delete(
          '/api/schedules/:group/:key',
          yield* http.gen(async function* (context) {
            const authorization = yield* DashboardAuthorization
            const authorized = await requireRole(authorization, context.req.raw, 'admin')
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
            if (Result.isError(result)) return result
            if (!result.value) {
              return Result.err(
                new DashboardHttpError(404, 'schedule_not_found', 'Schedule not found')
              )
            }
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
            const authorization = yield* DashboardAuthorization
            const authorized = await requireRole(authorization, context.req.raw, 'operator')
            if (Result.isError(authorized)) return authorized
            const flowId = parseJobId(context.req.param('id'))
            if (Result.isError(flowId)) return flowId
            const now = (yield* Clock).now().getTime()
            const result = await runCapabilityOperation(cancelFlow({ flowId: flowId.value, now }))
            if (Result.isError(result)) return result
            return Result.ok({
              cancelled: result.value.cancelled,
              parentSettled: result.value.parentSettled,
              flow: sanitizeFlow({
                parent: result.value.parent,
                children: result.value.children,
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
              makeEventSource(feed, options.value, heartbeat.value ?? 15_000, signal, stop.signal)
          })
        })
      )
    )

    app.post(
      '/api/jobs/:id/cancel',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'operator')
        if (Result.isError(authorized)) return authorized
        const jobId = parseJobId(context.req.param('id'))
        if (Result.isError(jobId)) return jobId
        const store = yield* JobStore
        const now = (yield* Clock).now().getTime()
        const result = await runOperation(store.cancel({ jobId: jobId.value, now }))
        if (Result.isError(result)) return result
        return Result.ok({ job: sanitizeJob(result.value.record) })
      })
    )
    app.post(
      '/api/jobs/:id/promote',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'operator')
        if (Result.isError(authorized)) return authorized
        const jobId = parseJobId(context.req.param('id'))
        if (Result.isError(jobId)) return jobId
        const store = yield* JobStore
        const now = (yield* Clock).now().getTime()
        const result = await runOperation(store.promote({ jobId: jobId.value, now }))
        if (Result.isError(result)) return result
        return Result.ok({ job: sanitizeJob(result.value.record) })
      })
    )
    app.post(
      '/api/jobs/:id/retry',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'operator')
        if (Result.isError(authorized)) return authorized
        const jobId = parseJobId(context.req.param('id'))
        if (Result.isError(jobId)) return jobId
        const now = (yield* Clock).now().getTime()
        const body = await parseRetryBody(context.req.raw, now)
        if (Result.isError(body)) return body
        const store = yield* JobStore
        const result = await runOperation(
          store.retry({ jobId: jobId.value, now, runAt: body.value.runAt })
        )
        if (Result.isError(result)) return result
        return Result.ok({ job: sanitizeJob(result.value.record) })
      })
    )
    app.post(
      '/api/jobs/:id/redrive',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'operator')
        if (Result.isError(authorized)) return authorized
        const jobId = parseJobId(context.req.param('id'))
        if (Result.isError(jobId)) return jobId
        const now = (yield* Clock).now().getTime()
        const body = await parseRetryBody(context.req.raw, now)
        if (Result.isError(body)) return body
        const store = yield* JobStore
        const result = await runOperation(
          store.retry({ jobId: jobId.value, now, runAt: body.value.runAt })
        )
        if (Result.isError(result)) return result
        return Result.ok({ job: sanitizeJob(result.value.record) })
      })
    )
    app.delete(
      '/api/jobs/:id',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'admin')
        if (Result.isError(authorized)) return authorized
        const jobId = parseJobId(context.req.param('id'))
        if (Result.isError(jobId)) return jobId
        const result = yield* JobAdmin.for(JobStore).remove(jobId.value)
        return Result.ok({ removed: true, job: sanitizeJob(result.job) })
      })
    )
    app.post(
      '/api/queues/:queue/pause',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'operator')
        if (Result.isError(authorized)) return authorized
        const queue = parseQueue(context.req.param('queue'))
        if (Result.isError(queue)) return queue
        const result = yield* JobAdmin.for(JobStore).pause(queue.value)
        return Result.ok(result)
      })
    )
    app.post(
      '/api/queues/:queue/resume',
      yield* http.gen(async function* (context) {
        const authorization = yield* DashboardAuthorization
        const authorized = await requireRole(authorization, context.req.raw, 'operator')
        if (Result.isError(authorized)) return authorized
        const queue = parseQueue(context.req.param('queue'))
        if (Result.isError(queue)) return queue
        const result = yield* JobAdmin.for(JobStore).resume(queue.value)
        return Result.ok(result)
      })
    )

    return app
  }
)

export type DashboardApplication = InstanceType<typeof DashboardApp>

export type { AnyJobEventStoreToken, AnyJobStoreToken, JobEventCursor, JobListCursor }
