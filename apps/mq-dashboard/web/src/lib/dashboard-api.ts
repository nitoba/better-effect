// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- this module parses untrusted JSON at the HTTP boundary before exposing typed dashboard data.
export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'cancelled'

export type DashboardTab = 'overview' | 'jobs' | 'events' | 'extensions' | 'health'

export interface Job {
  id: string
  name: string
  version: number
  queue: string
  state: JobState
  priority: number
  runAt: number
  orderingSequence: number
  attemptsMax: number
  attemptsMade: number
  attemptSequence: number
  deliveryCount: number
  stalledCount: number
  timeoutMs: number | undefined
  createdAt: number
  updatedAt: number
  processedAt: number | undefined
  finishedAt: number | undefined
  cancellationRequestedAt: number | undefined
}

export interface Attempt {
  attempt: number
  attemptSequence: number
  delivery: number
  startedAt: number
  finishedAt: number | undefined
  outcome: string | undefined
  retryAt: number | undefined
  retryDelayMs: number | undefined
}

export interface DurableEvent {
  cursor: string
  type: string
  recordedAtMs: number
  jobId: string | undefined
  queue: string | undefined
  name: string | undefined
  version: number | undefined
  state: string | undefined
  attempt: number | undefined
  delivery: number | undefined
  workerId: string | undefined
  outcome: string | undefined
  failureKind: string | undefined
  duplicate: boolean | undefined
  attributes: Readonly<Record<string, string>>
}

export interface Schedule {
  key: string
  group: string
  queue: string
  cron: string | undefined
  everyMs: number | undefined
  timeZone: string
  paused: boolean
  revision: number
  nextRunAtMs: number | undefined
  lastScheduledAtMs: number | undefined
  lastJobId: string | undefined
}

export interface QueueControl {
  queue: string
  group: string
  enabled: boolean
  revision: number
  globalConcurrency: number | undefined
  perKeyConcurrency: number | undefined
  rateLimit: { limit: number; intervalMs: number } | undefined
  createdAtMs: number
  updatedAtMs: number
}

export interface Overview {
  store: {
    protocolVersion: number
    adapter: string
    adapterVersion: string
    layoutVersion: number
    capabilities: Readonly<Record<string, boolean>>
  }
  counts: Readonly<Record<string, number>>
  pausedQueues: readonly string[]
  events: { available: boolean }
  capabilities: {
    events: boolean
    schedules: boolean
    flows: boolean
    controls: boolean
    security: {
      mutationPolicy: boolean
      audit: boolean
      rateLimit: boolean
    }
  }
}

export interface JobHealthSnapshot {
  storeOperationFailures: number
  leaseLosses: number
  stalledRecoveries: number
  consumerHandlerFailures: number
  latestEventLagMs: number | undefined
  maxEventLagMs: number | undefined
  retainedEventCount: number | undefined
  oldestRetainedAgeMs: number | undefined
  retentionCount: number | undefined
  retentionAgeMs: number | undefined
  cursorExpiries: number
}

export interface DashboardNotificationSnapshot {
  awaitEventsAvailable: boolean
  status: 'available' | 'unavailable' | 'degraded'
  failures: number
  fallbackPolls: number
}

export interface DashboardHealthSnapshot {
  state: 'idle' | 'active' | 'degraded'
  activeConnections: number
  connectionsOpened: number
  connectionsClosed: number
  reconnects: number
  cursorExpiries: number
  latestObservedLagMs: number | undefined
  maxObservedLagMs: number | undefined
  backpressureDropped: number
  eventsCoalesced: number
  streamFailures: number
  notifications?: DashboardNotificationSnapshot
  job: JobHealthSnapshot | undefined
}

export interface FlowSnapshot {
  parent: { flowId: string; flowName: string; depth: number; state: string }
  children: readonly {
    flowId: string
    childKey: string
    name: string
    version: number
    childJobId: string
    status: string
    cascaded: boolean
    pendingSinceMs: number | undefined
  }[]
  outbox: readonly {
    id: string
    flowName: string
    report: { flowId: string; childKey: string; outcome: string }
  }[]
}

export interface ApiErrorPayload {
  error: string
  message: string
  oldestAvailableCursor?: string
  refreshRequired?: boolean
  retryAfterSeconds?: number
}

export class DashboardApiError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfterSeconds: number | undefined

  constructor(payload: ApiErrorPayload, status: number) {
    super(payload.message)
    this.name = 'DashboardApiError'
    this.code = payload.error
    this.status = status
    this.retryAfterSeconds = payload.retryAfterSeconds
  }
}

const apiBase = import.meta.env.VITE_DASHBOARD_API_BASE ?? ''

function isDataEnvelope<T>(value: unknown): value is { data: T } {
  return typeof value === 'object' && value !== null && 'data' in value
}

function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  )
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers
  })
  const payload: unknown = await response.json()

  if (!response.ok || !isDataEnvelope<T>(payload)) {
    const errorPayload: ApiErrorPayload = isApiErrorPayload(payload)
      ? payload
      : { error: 'invalid_response', message: 'Resposta inválida do dashboard.' }
    throw new DashboardApiError(errorPayload, response.status)
  }

  return payload.data
}

export function apiUrl(path: string): string {
  return `${apiBase}${path}`
}

export function formatTimestamp(value: number | undefined): string {
  if (value === undefined) return '—'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(value)
}

export function formatDuration(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value < 1_000) return `${value} ms`
  if (value < 60_000) return `${Math.round(value / 1_000)} s`
  return `${Math.round(value / 60_000)} min`
}
