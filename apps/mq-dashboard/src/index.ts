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
  JobStore,
  QueueName,
  isDurableJobEventType
} from 'better-effect-mq'
import type {
  AnyJobEventStoreToken,
  AnyJobStoreToken,
  AttemptRecord,
  AwaitEventsOptions,
  DurableJobEvent,
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
  JobStoreOperation
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

    app.get(
      '/health',
      yield* http.gen(async function* () {
        yield* Result.await(Promise.resolve(Result.ok(undefined)))
        return Result.ok({ ok: true, service: 'better-effect-mq-dashboard' })
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
          events: { available: feed.available }
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
