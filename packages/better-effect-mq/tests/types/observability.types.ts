// oxlint-disable anti-slop/no-chained-type-assertions -- type fixtures use erased placeholders at the public contract boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions are the subject of these type contracts.

import { expectTypeOf } from 'bun:test'

import {
  JobMetricNames,
  JobObserver,
  makeJobDepthSampler,
  type JobDepthSampler,
  type JobDepthSamplerOptions,
  type JobEvent,
  type JobMetricsSink,
  type JobObserverContract,
  type QueueName
} from '../../src'
import type { JobStoreContract } from '../../src'

const observer: JobObserverContract = { onEvent: () => undefined }
const composed = JobObserver.compose(observer)

expectTypeOf(composed).toEqualTypeOf<JobObserverContract>()
expectTypeOf<JobEvent['type']>().toEqualTypeOf<
  | 'enqueued'
  | 'claimed'
  | 'started'
  | 'completed'
  | 'retry-scheduled'
  | 'failed'
  | 'cancelled'
  | 'released'
  | 'lease-lost'
  | 'stalled-recovered'
  | 'worker-started'
  | 'worker-stopping'
  | 'worker-stopped'
  | 'store-operation-failed'
>()
expectTypeOf(JobMetricNames.queueDepth).toEqualTypeOf<'better_effect_mq_queue_depth'>()

const store = undefined as unknown as JobStoreContract
const sink = undefined as unknown as JobMetricsSink
const queue = undefined as unknown as QueueName
const options = { queues: [queue], intervalMs: 1 } satisfies JobDepthSamplerOptions
const sampler = makeJobDepthSampler(store, sink, options)

expectTypeOf(sampler).toEqualTypeOf<JobDepthSampler>()
expectTypeOf(sampler.running).toEqualTypeOf<boolean>()

void sampler
