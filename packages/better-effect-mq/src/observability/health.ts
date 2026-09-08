import type { LeaseLossReason } from '../protocol'

import type { JobMetricsSink } from './observer'

/** The low-cardinality operational signals collected by a health monitor. */
export type JobHealthSignal =
  | {
      readonly type: 'store-operation-failed'
      readonly operation: string
      readonly retryable: boolean
    }
  | { readonly type: 'lease-lost'; readonly reason: LeaseLossReason | 'store-timeout' }
  | {
      readonly type: 'stalled-recovered'
      readonly outcome: 'requeued' | 'failed' | 'cancelled'
    }
  | { readonly type: 'consumer-handler-failed' }
  | { readonly type: 'event-lag'; readonly lagMs: number }
  | {
      readonly type: 'retention'
      readonly retainedEventCount: number
      readonly oldestRetainedAgeMs: number | undefined
      readonly retentionCount: number | undefined
      readonly retentionAgeMs: number | undefined
    }
  | { readonly type: 'cursor-expired' }

/** Read-only health values suitable for a status endpoint or dashboard card. */
export interface JobHealthSnapshot {
  readonly storeOperationFailures: number
  readonly leaseLosses: number
  readonly stalledRecoveries: number
  readonly consumerHandlerFailures: number
  readonly latestEventLagMs: number | undefined
  readonly maxEventLagMs: number | undefined
  readonly retainedEventCount: number | undefined
  readonly oldestRetainedAgeMs: number | undefined
  readonly retentionCount: number | undefined
  readonly retentionAgeMs: number | undefined
  readonly cursorExpiries: number
}

/** A best-effort extension point for process-local health reporting. */
export interface JobHealthSink {
  readonly record: (signal: JobHealthSignal) => void | PromiseLike<void>
}

export interface JobHealthMonitor extends JobHealthSink {
  readonly snapshot: () => JobHealthSnapshot
  readonly reset: () => void
}

export interface JobHealthOptions {
  readonly metrics?: JobMetricsSink
}

const metricNames = Object.freeze({
  storeOperationFailures: 'better_effect_mq_store_failures_total',
  leaseLosses: 'better_effect_mq_leases_lost_total',
  stalledRecoveries: 'better_effect_mq_stalled_recovered_total',
  consumerHandlerFailures: 'better_effect_mq_consumer_handler_failures_total',
  eventLag: 'better_effect_mq_event_lag_ms',
  retainedEventCount: 'better_effect_mq_retained_event_count',
  oldestRetainedAge: 'better_effect_mq_oldest_retained_age_ms',
  cursorExpiries: 'better_effect_mq_cursor_expired_total'
} as const)

const initialSnapshot = (): JobHealthSnapshot => ({
  storeOperationFailures: 0,
  leaseLosses: 0,
  stalledRecoveries: 0,
  consumerHandlerFailures: 0,
  latestEventLagMs: undefined,
  maxEventLagMs: undefined,
  retainedEventCount: undefined,
  oldestRetainedAgeMs: undefined,
  retentionCount: undefined,
  retentionAgeMs: undefined,
  cursorExpiries: 0
})

const nonNegativeInteger = (value: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0

const metricCategory = (value: string, allowed: readonly string[]): string =>
  allowed.includes(value) ? value : 'other'

const observeThenable = (value: void | PromiseLike<void>): void => {
  if (value === undefined) return
  try {
    void Promise.resolve(value).catch(() => undefined)
  } catch {
    // A hostile thenable must not cross an observability boundary.
  }
}

export const makeJobHealth = (options: JobHealthOptions = {}): JobHealthMonitor => {
  let current = initialSnapshot()

  const emit = (
    method: keyof JobMetricsSink,
    name: string,
    value: number,
    attributes: Readonly<Record<string, string | number | boolean>> = {}
  ): void => {
    const sink = options.metrics
    if (sink === undefined) return
    try {
      observeThenable(sink[method](name, value, attributes))
    } catch {
      // Metrics are advisory and must not alter the source operation.
    }
  }

  const record = (signal: JobHealthSignal): void => {
    switch (signal.type) {
      case 'store-operation-failed':
        current = { ...current, storeOperationFailures: current.storeOperationFailures + 1 }
        emit('increment', metricNames.storeOperationFailures, 1, {
          operation: metricCategory(signal.operation, [
            'append',
            'read',
            'awaitEvents',
            'tailCursor',
            'cursor',
            'consumer'
          ]),
          retryable: signal.retryable
        })
        break
      case 'lease-lost':
        current = { ...current, leaseLosses: current.leaseLosses + 1 }
        emit('increment', metricNames.leaseLosses, 1, {
          reason: metricCategory(signal.reason, [
            'missing-token',
            'mismatched-token',
            'expired-lease',
            'missing-lease',
            'store-timeout'
          ])
        })
        break
      case 'stalled-recovered':
        current = { ...current, stalledRecoveries: current.stalledRecoveries + 1 }
        emit('increment', metricNames.stalledRecoveries, 1, { outcome: signal.outcome })
        break
      case 'consumer-handler-failed':
        current = { ...current, consumerHandlerFailures: current.consumerHandlerFailures + 1 }
        emit('increment', metricNames.consumerHandlerFailures, 1)
        break
      case 'event-lag': {
        const lagMs = nonNegativeInteger(signal.lagMs)
        current = {
          ...current,
          latestEventLagMs: lagMs,
          maxEventLagMs: Math.max(current.maxEventLagMs ?? 0, lagMs)
        }
        emit('observe', metricNames.eventLag, lagMs)
        break
      }
      case 'retention': {
        const retainedEventCount = nonNegativeInteger(signal.retainedEventCount)
        const oldestRetainedAgeMs =
          signal.oldestRetainedAgeMs === undefined
            ? undefined
            : nonNegativeInteger(signal.oldestRetainedAgeMs)
        const retentionCount =
          signal.retentionCount === undefined
            ? undefined
            : nonNegativeInteger(signal.retentionCount)
        const retentionAgeMs =
          signal.retentionAgeMs === undefined
            ? undefined
            : nonNegativeInteger(signal.retentionAgeMs)
        current = {
          ...current,
          retainedEventCount,
          oldestRetainedAgeMs,
          retentionCount,
          retentionAgeMs
        }
        emit('gauge', metricNames.retainedEventCount, retainedEventCount)
        if (oldestRetainedAgeMs !== undefined) {
          emit('gauge', metricNames.oldestRetainedAge, oldestRetainedAgeMs)
        }
        break
      }
      case 'cursor-expired':
        current = { ...current, cursorExpiries: current.cursorExpiries + 1 }
        emit('increment', metricNames.cursorExpiries, 1)
        break
    }
  }

  return Object.freeze({
    record,
    snapshot: () => Object.freeze({ ...current }),
    reset: () => {
      current = initialSnapshot()
    }
  })
}

/** Deliver a health signal without allowing an optional sink to affect MQ work. */
export const notifyJobHealth = (sink: JobHealthSink | undefined, signal: JobHealthSignal): void => {
  if (sink === undefined) return
  try {
    observeThenable(sink.record(signal))
  } catch {
    // Health sinks are advisory and isolated from queue behavior.
  }
}

export const JobHealth = Object.freeze({ make: makeJobHealth })
