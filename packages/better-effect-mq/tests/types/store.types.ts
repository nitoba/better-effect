// oxlint-disable anti-slop/no-unknown-parameters -- the structural contract fixture covers every operation boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- completed Result values are adapted to the phantom Effect contract.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- type fixtures use placeholder DTOs.

import { expectTypeOf } from 'bun:test'
import { Effect, Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'

import {
  Codec,
  Job,
  JobRegistry,
  JobStore,
  Queue,
  type ClaimRequestFor,
  type JobStoreContract,
  type JobStoreEffect
} from '../../src'
import type { QueueName, WorkerId } from '../../src'

const ok = <Value>(value: Value): JobStoreEffect<Value> =>
  Result.ok(value) as unknown as JobStoreEffect<Value>

const implementation = {
  protocolVersion: 1,
  capabilities: {
    notifications: false,
    batchClaim: false,
    transactionalEnqueue: false,
    changeFeed: false
  },
  enqueue: () => ok({} as JobStore.EnqueueResult),
  enqueueMany: () => ok([]),
  claim: () => ok({} as JobStore.ClaimResult),
  settle: () => ok({} as JobStore.SettlementResult),
  release: () => ok({} as JobStore.ReleaseResult),
  heartbeat: () => ok({} as JobStore.HeartbeatResult),
  recoverStalled: () => ok({} as JobStore.RecoverStalledResult),
  awaitWake: () => ok(undefined),
  getJob: () => ok(undefined),
  getAttempts: () => ok([]),
  list: () => ok({ jobs: [], nextCursor: undefined }),
  counts: () =>
    ok({
      total: 0,
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    }),
  redrive: () => ok({} as JobStore.RedriveResult),
  cancel: () => ok({} as JobStore.CancelResult),
  requestCancellation: () => ok({} as JobStore.RequestCancellationResult),
  promote: () => ok({} as JobStore.PromoteResult),
  remove: () => ok({} as JobStore.RemoveResult),
  pause: () => ok({ queue: 'jobs' as never, paused: true }),
  resume: () => ok({ queue: 'jobs' as never, paused: false }),
  pausedQueues: () => ok([])
} satisfies JobStoreContract

const Default = JobStore
const Durable = JobStore.named('durable')
const DurableAgain = JobStore.named('durable')
const queue = Queue.define('jobs')
const defaultJob = queue.job('default', { version: 1, payload: Codec.string })
const durableJob = queue.job('durable', {
  version: 1,
  payload: Codec.string,
  store: Durable
})
const boundJob = Job.bind(defaultJob, Durable)
const registry = JobRegistry.make([durableJob] as const)

expectTypeOf(Default.serviceTag).toEqualTypeOf<'@better-effect/mq/JobStore'>()
expectTypeOf(Durable.serviceTag).toEqualTypeOf<'@better-effect/mq/JobStore/durable'>()
expectTypeOf<typeof Durable>().toEqualTypeOf<typeof DurableAgain>()
expectTypeOf<Job.StoreToken<typeof defaultJob>>().toEqualTypeOf<JobStore.Token>()
expectTypeOf<Job.StoreToken<typeof durableJob>>().toEqualTypeOf<JobStore.Token<'durable'>>()
expectTypeOf<Job.StoreToken<typeof boundJob>>().toEqualTypeOf<JobStore.Token<'durable'>>()
expectTypeOf<Job.Requirements<typeof defaultJob>>().toEqualTypeOf<JobStore.Instance>()
expectTypeOf<Job.Requirements<typeof durableJob>>().toEqualTypeOf<JobStore.Instance<'durable'>>()
expectTypeOf<typeof implementation>().toMatchTypeOf<JobStore.Contract>()

const claim: ClaimRequestFor<typeof registry> = {
  queue: 'jobs' as QueueName,
  accepted: registry.accepted,
  limit: 1,
  workerId: 'worker' as WorkerId,
  leaseDurationMs: 1,
  now: 0
}
const invalidClaim: ClaimRequestFor<typeof registry> = {
  queue: 'jobs' as QueueName,
  accepted: [
    // @ts-expect-error A claim cannot name an unregistered job version.
    { queue: 'jobs', name: 'durable', version: 2 }
  ],
  limit: 1,
  workerId: 'worker' as WorkerId,
  leaseDurationMs: 1,
  now: 0
}

const defaultInstance = JobStore.of(implementation)
const durableInstance = Durable.of(implementation)
const defaultLayer = Layer.succeed(Default, defaultInstance)
const durableLayer = Layer.succeed(Durable, durableInstance)
const program = () =>
  Effect.gen(async function* () {
    const store = yield* Durable
    return Result.ok(store.protocolVersion)
  })
const complete = Runtime.run(durableLayer, program)
// @ts-expect-error Runtime completeness rejects a missing named JobStore.
const incomplete = Runtime.run(Layer.empty, program)

void claim
void invalidClaim
void complete
void incomplete
void defaultLayer
