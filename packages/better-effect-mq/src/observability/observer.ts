// oxlint-disable anti-slop/no-runtime-typeof -- logger adapters intentionally validate explicit JavaScript callback shapes.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the levelled logger map is narrowed immediately before use.
// oxlint-disable anti-slop/no-known-value-widening -- logger data and metric attributes are assembled from event fields.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional scalar event fields are omitted from snapshots.

import { freezeJobEvent, type JobEvent } from './events'
import { makeJobDepthSampler } from './depth'

/** A process-local, best-effort observer for storage-neutral MQ events. */
export interface JobObserver {
  readonly onEvent: (event: JobEvent) => void | PromiseLike<void>
}

/** Structured data accepted by the optional logger adapter. */
export type JobLogData = Readonly<Record<string, string | number | boolean>>

export type JobLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface JobLogEvent {
  readonly level: JobLogLevel
  readonly message: string
  readonly data?: JobLogData
}

/** Logger shape accepted without requiring a Logger Service or LoggerLive. */
export type JobLogger =
  | ((event: JobLogEvent) => void | PromiseLike<void>)
  | {
      readonly log: (event: JobLogEvent) => void | PromiseLike<void>
    }
  | {
      readonly debug?: (message: string, data?: JobLogData) => void | PromiseLike<void>
      readonly info?: (message: string, data?: JobLogData) => void | PromiseLike<void>
      readonly warn?: (message: string, data?: JobLogData) => void | PromiseLike<void>
      readonly error?: (message: string, data?: JobLogData) => void | PromiseLike<void>
    }

export interface JobLoggerOptions {
  readonly logger?: JobLogger
  readonly includeStoreFailures?: boolean
  readonly includeSuccessfulRuns?: boolean
}

/** Low-cardinality attributes accepted by a metrics sink. */
export type JobMetricAttributes = Readonly<Record<string, string | number | boolean>>

export interface JobMetricsSink {
  readonly increment: (
    name: string,
    value: number,
    attributes: JobMetricAttributes
  ) => void | PromiseLike<void>
  readonly observe: (
    name: string,
    value: number,
    attributes: JobMetricAttributes
  ) => void | PromiseLike<void>
  readonly gauge: (
    name: string,
    value: number,
    attributes: JobMetricAttributes
  ) => void | PromiseLike<void>
}

export const JobMetricNames = Object.freeze({
  jobsEnqueued: 'better_effect_mq_jobs_enqueued_total',
  jobRuns: 'better_effect_mq_job_runs_total',
  jobRunDuration: 'better_effect_mq_job_run_duration_ms',
  jobWaitDuration: 'better_effect_mq_job_wait_duration_ms',
  claims: 'better_effect_mq_claims_total',
  jobsInFlight: 'better_effect_mq_jobs_in_flight',
  leasesLost: 'better_effect_mq_leases_lost_total',
  stalledRecovered: 'better_effect_mq_stalled_recovered_total',
  storeFailures: 'better_effect_mq_store_failures_total',
  queueDepth: 'better_effect_mq_queue_depth'
} as const)

const noOpObserver: JobObserver = Object.freeze({ onEvent: () => undefined })

/** Compose observers without awaiting or queueing their work. */
const compose = (...observers: readonly JobObserver[]): JobObserver => {
  if (observers.length === 0) return noOpObserver

  return Object.freeze({
    onEvent: (event: JobEvent): void => {
      for (const observer of observers) notifyJobObserver(observer, event)
    }
  })
}

/** Deliver one event without allowing observer code to affect the caller. */
export const notifyJobObserver = (observer: JobObserver, event: JobEvent): void => {
  let snapshot: JobEvent
  try {
    snapshot = freezeJobEvent(event)
  } catch {
    snapshot = event
  }

  let result: void | PromiseLike<void>
  try {
    result = observer.onEvent(snapshot)
  } catch {
    return
  }
  observeThenable(result)
}

const observeThenable = (value: void | PromiseLike<void>): void => {
  if (value === undefined) return
  try {
    void Promise.resolve(value).catch(() => undefined)
  } catch {
    // A hostile thenable must not escape an observability boundary.
  }
}

const defaultLogger: JobLogger = (event) => {
  switch (event.level) {
    case 'debug':
      console.debug(event.message, event.data)
      break
    case 'info':
      console.info(event.message, event.data)
      break
    case 'warn':
      console.warn(event.message, event.data)
      break
    case 'error':
      console.error(event.message, event.data)
      break
  }
}

const logger = (
  loggerOrOptions?: JobLogger | JobLoggerOptions,
  suppliedOptions: JobLoggerOptions = {}
): JobObserver => {
  const options = isLoggerOptions(loggerOrOptions) ? loggerOrOptions : suppliedOptions
  const target =
    (isLoggerOptions(loggerOrOptions) ? loggerOrOptions.logger : loggerOrOptions) ?? defaultLogger
  const includeStoreFailures = options.includeStoreFailures ?? true
  const includeSuccessfulRuns = options.includeSuccessfulRuns ?? false

  return Object.freeze({
    onEvent: (event: JobEvent): void => {
      if (event.type === 'store-operation-failed' && !includeStoreFailures) return
      if (event.type === 'completed' && !includeSuccessfulRuns) return
      const log = logForEvent(event)
      if (log === undefined || target === undefined) return
      try {
        if (typeof target === 'function') {
          observeThenable(target(log))
        } else if ('log' in target && typeof target.log === 'function') {
          observeThenable(target.log(log))
        } else {
          const callbacks = target as {
            readonly [Level in JobLogLevel]?: (
              message: string,
              data?: JobLogData
            ) => void | PromiseLike<void>
          }
          const callback = callbacks[log.level]
          if (typeof callback === 'function') observeThenable(callback(log.message, log.data))
        }
      } catch {
        // Logger failures are deliberately isolated from MQ behavior.
      }
    }
  })
}

const isLoggerOptions = (
  value: JobLogger | JobLoggerOptions | undefined
): value is JobLoggerOptions =>
  value !== undefined &&
  typeof value === 'object' &&
  value !== null &&
  ('logger' in value || 'includeStoreFailures' in value || 'includeSuccessfulRuns' in value)

const logForEvent = (event: JobEvent): JobLogEvent | undefined => {
  const data = logData(event)
  switch (event.type) {
    case 'worker-started':
    case 'worker-stopping':
    case 'worker-stopped':
      return { level: 'info', message: `MQ ${event.type}`, data }
    case 'retry-scheduled':
      return { level: 'warn', message: 'MQ job retry scheduled', data }
    case 'failed':
      return { level: 'error', message: 'MQ job failed', data }
    case 'lease-lost':
    case 'stalled-recovered':
      return { level: 'warn', message: `MQ ${event.type}`, data }
    case 'store-operation-failed':
      return {
        level: event.retryable ? 'warn' : 'error',
        message: 'MQ store operation failed',
        data
      }
    case 'completed':
      return { level: 'debug', message: 'MQ job completed', data }
    case 'enqueued':
    case 'claimed':
    case 'started':
    case 'cancelled':
    case 'released':
      return undefined
  }
}

const logData = (event: JobEvent): JobLogData => {
  const data: Record<string, string | number | boolean> = { type: event.type }
  if (event.queue !== undefined) data.queue = event.queue
  if (event.name !== undefined) data.name = event.name
  if (event.version !== undefined) data.version = event.version
  if (event.workerId !== undefined) data.workerId = event.workerId
  if (event.jobId !== undefined) data.jobId = event.jobId
  if ('attempt' in event && event.attempt !== undefined) data.attempt = event.attempt
  if ('durationMs' in event && event.durationMs !== undefined) data.durationMs = event.durationMs
  if ('failureKind' in event && event.failureKind !== undefined)
    data.failureKind = event.failureKind
  if ('failureCode' in event && event.failureCode !== undefined)
    data.failureCode = event.failureCode
  if ('retryAt' in event && event.retryAt !== undefined) data.retryAt = event.retryAt
  if ('retryDelayMs' in event && event.retryDelayMs !== undefined)
    data.retryDelayMs = event.retryDelayMs
  if ('reason' in event) data.reason = event.reason
  if ('outcome' in event) data.outcome = event.outcome
  if ('operation' in event) data.operation = event.operation
  if ('retryable' in event) data.retryable = event.retryable
  return Object.freeze(data)
}

const metrics = (sink: JobMetricsSink): JobObserver => {
  const inFlight = new Map<string, number>()
  const activeClaims = new Set<string>()
  const emit = (
    operation: keyof JobMetricsSink,
    name: string,
    value: number,
    attributes: JobMetricAttributes
  ): void => {
    try {
      observeThenable(sink[operation](name, value, attributes))
    } catch {
      // One sink method must not prevent later event processing.
    }
  }
  const adjustInFlight = (queue: string, delta: number): void => {
    const next = Math.max(0, (inFlight.get(queue) ?? 0) + delta)
    if (next === 0) inFlight.delete(queue)
    else inFlight.set(queue, next)
    emit('gauge', JobMetricNames.jobsInFlight, next, { queue })
  }
  const identityAttributes = (event: JobEvent) => ({
    ...(event.name === undefined ? {} : { name: event.name }),
    ...(event.queue === undefined ? {} : { queue: event.queue })
  })
  const finishClaim = (event: JobEvent): boolean => {
    const key = claimKey(event)
    if (key === undefined || !activeClaims.delete(key)) return false
    if (event.queue !== undefined) adjustInFlight(event.queue, -1)
    return true
  }

  return Object.freeze({
    onEvent: (event: JobEvent): void => {
      const identity = identityAttributes(event)
      switch (event.type) {
        case 'enqueued':
          emit('increment', JobMetricNames.jobsEnqueued, 1, {
            ...identity,
            duplicate: event.duplicate
          })
          break
        case 'claimed': {
          const key = claimKey(event)
          if (key !== undefined && activeClaims.add(key)) adjustInFlight(event.queue, 1)
          emit('increment', JobMetricNames.claims, 1, { queue: event.queue, result: 'claimed' })
          emit('observe', JobMetricNames.jobWaitDuration, event.waitDurationMs, identity)
          break
        }
        case 'completed':
          emitRunMetrics(event, identity, emit)
          finishClaim(event)
          break
        case 'retry-scheduled':
          if (event.source === 'attempt') emitRunMetrics(event, identity, emit)
          finishClaim(event)
          break
        case 'failed':
          emitRunMetrics(event, identity, emit)
          finishClaim(event)
          break
        case 'cancelled': {
          const wasClaimed = finishClaim(event)
          if (event.source === 'worker' || (event.source === undefined && wasClaimed)) {
            emitRunMetrics(event, identity, emit)
          }
          break
        }
        case 'released':
          finishClaim(event)
          break
        case 'lease-lost':
          emit('increment', JobMetricNames.leasesLost, 1, {})
          finishClaim(event)
          break
        case 'stalled-recovered':
          emit('increment', JobMetricNames.stalledRecovered, 1, { outcome: event.outcome })
          finishClaim(event)
          break
        case 'store-operation-failed':
          if (event.operation === 'settle' || event.operation === 'release') {
            finishClaim(event)
          }
          emit('increment', JobMetricNames.storeFailures, 1, {
            operation: event.operation,
            retryable: event.retryable
          })
          break
        case 'started':
        case 'worker-started':
        case 'worker-stopping':
        case 'worker-stopped':
          break
      }
    }
  })
}

const claimKey = (event: JobEvent): string | undefined =>
  event.workerId === undefined || event.jobId === undefined || event.delivery === undefined
    ? undefined
    : JSON.stringify([event.workerId, event.jobId, event.delivery])

const emitRunMetrics = (
  event: Extract<JobEvent, { type: 'completed' | 'retry-scheduled' | 'failed' | 'cancelled' }>,
  identity: JobMetricAttributes,
  emit: (
    operation: keyof JobMetricsSink,
    name: string,
    value: number,
    attributes: JobMetricAttributes
  ) => void
): void => {
  const outcome =
    event.type === 'completed'
      ? 'completed'
      : event.type === 'retry-scheduled'
        ? 'retried'
        : event.type
  emit('increment', JobMetricNames.jobRuns, 1, { ...identity, outcome })
  if ('durationMs' in event && event.durationMs !== undefined) {
    emit('observe', JobMetricNames.jobRunDuration, event.durationMs, { ...identity, outcome })
  }
}

export const JobObserver = Object.freeze({
  compose,
  logger,
  metrics,
  depthSampler: makeJobDepthSampler
})

export type { JobEvent, JobEventType } from './events'
