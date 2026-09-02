import { Result } from 'better-result'

import { makeQueueName } from '../protocol'
import type { QueueName } from '../protocol'
import type { JobCounts, JobStoreContract } from '../store'
import { scheduleDeadline } from '../worker/timer'

import type { JobMetricsSink } from './observer'

/** Configuration for an opt-in, cancelable queue-depth sampler. */
export interface JobDepthSamplerOptions {
  /** Queues to sample in declaration order. */
  readonly queues: readonly QueueName[]
  /** Delay between completed samples. The first sample runs immediately. */
  readonly intervalMs: number
}

/** Handle for a process-local queue-depth sampler. */
export interface JobDepthSampler extends Disposable {
  readonly running: boolean
  start(): void
  stop(): void
}

/**
 * Sample waiting and delayed jobs through the storage-neutral `counts` API.
 *
 * Sampling is deliberately separate from `JobEvent`: depth is a point-in-time
 * gauge, not a durable transition. An in-flight store call is never cancelled;
 * its result is ignored after `stop()` so the sampler cannot retain a timer or
 * publish a post-cancellation value.
 */
export const makeJobDepthSampler = (
  store: JobStoreContract,
  sink: JobMetricsSink,
  options: JobDepthSamplerOptions
): JobDepthSampler => {
  const queues = normalizeQueues(options.queues)
  const intervalMs = normalizeInterval(options.intervalMs)
  let running = false
  let generation = 0
  let cancelTimer: (() => void) | undefined

  const isCurrent = (sampleGeneration: number): boolean =>
    running && sampleGeneration === generation

  const emitDepth = (queue: QueueName, counts: JobCounts, sampleGeneration: number): void => {
    if (!isCurrent(sampleGeneration)) return
    const depth = counts.waiting + counts.delayed
    if (!Number.isSafeInteger(depth) || depth < 0) return

    try {
      const result = sink.gauge('better_effect_mq_queue_depth', depth, { queue })
      if (result) void Promise.resolve(result).catch(() => undefined)
    } catch {
      // Metrics are advisory and must not affect queue operation.
    }
  }

  const sample = async (sampleGeneration: number): Promise<void> => {
    for (const queue of queues) {
      if (!isCurrent(sampleGeneration)) return
      try {
        const result = await store.counts({ queue })
        if (isCurrent(sampleGeneration) && Result.isOk(result)) {
          emitDepth(queue, result.value, sampleGeneration)
        }
      } catch {
        // A depth failure is intentionally invisible to the queue protocol.
      }
    }

    if (isCurrent(sampleGeneration)) {
      cancelTimer = scheduleDeadline(intervalMs, () => {
        cancelTimer = undefined
        void sample(sampleGeneration)
      })
    }
  }

  const start = (): void => {
    if (running) return
    running = true
    generation += 1
    void sample(generation)
  }

  const stop = (): void => {
    if (!running) return
    running = false
    generation += 1
    cancelTimer?.()
    cancelTimer = undefined
  }

  return Object.freeze({
    get running(): boolean {
      return running
    },
    start,
    stop,
    [Symbol.dispose]: stop
  })
}

const normalizeQueues = (value: readonly QueueName[]): readonly QueueName[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Queue-depth sampler requires at least one queue')
  }

  const queues: QueueName[] = []
  const seen = new Set<string>()
  for (const queue of value) {
    const checked = makeQueueName(queue)
    if (Result.isError(checked)) {
      throw new TypeError('Queue-depth sampler queues must be non-empty strings')
    }
    const normalized = checked.value
    if (!seen.has(normalized)) {
      seen.add(normalized)
      queues.push(normalized)
    }
  }
  return Object.freeze(queues)
}

const normalizeInterval = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Queue-depth sampler intervalMs must be a positive safe integer')
  }
  return value
}
