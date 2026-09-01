// oxlint-disable anti-slop/no-unknown-parameters -- the structural contract fixture covers every operation boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- completed Result values are adapted to the phantom Effect contract.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- type fixtures use placeholder DTOs.

import { expectTypeOf } from 'bun:test'
import {
  Effect,
  Layer,
  Runtime,
  Service,
  type EffectError,
  type EffectRequirements
} from 'better-effect'
import { Result } from 'better-result'

import {
  Codec,
  Job,
  JobRegistry,
  JobStore,
  Queue,
  type ClaimRequestFor,
  type JobStoreCancelError,
  type JobStoreClaimError,
  type JobStoreContract,
  type JobStoreCountsError,
  type JobStoreEnqueueError,
  type JobStoreEnqueueManyError,
  type JobStoreGetAttemptsError,
  type JobStoreGetJobError,
  type JobStoreHeartbeatError,
  type JobStoreListError,
  type JobStoreOperation,
  type JobStorePauseError,
  type JobStorePausedQueuesError,
  type JobStorePromoteError,
  type JobStoreRecoverStalledError,
  type JobStoreRetryError,
  type JobStoreReleaseError,
  type JobStoreRemoveError,
  type JobStoreRequestCancellationError,
  type JobStoreResumeError,
  type JobStoreSettlementError,
  type JobStoreWakeError
} from '../../src'
import type { AttemptRecord, JobRecord, QueueName, WorkerId } from '../../src'

type StoreOperation<Name extends keyof JobStoreContract> = JobStoreContract[Name] extends (
  ...arguments_: never[]
) => infer Operation
  ? Operation
  : never

const ok = <Operation>(value: unknown): Operation => Result.ok(value) as unknown as Operation

const implementation = {
  protocolVersion: 1,
  capabilities: {
    notifications: false,
    queueFilteredNotifications: false,
    batchClaim: false,
    transactionalEnqueue: false,
    changeFeed: false
  },
  enqueue: () => ok<StoreOperation<'enqueue'>>({} as JobStore.EnqueueResult),
  enqueueMany: () => ok<StoreOperation<'enqueueMany'>>([]),
  claim: () => ok<StoreOperation<'claim'>>({} as JobStore.ClaimResult),
  settle: () => ok<StoreOperation<'settle'>>({} as JobStore.SettlementResult),
  release: () => ok<StoreOperation<'release'>>({} as JobStore.ReleaseResult),
  heartbeat: () => ok<StoreOperation<'heartbeat'>>({} as JobStore.HeartbeatResult),
  recoverStalled: () => ok<StoreOperation<'recoverStalled'>>({} as JobStore.RecoverStalledResult),
  awaitWake: () => ok<StoreOperation<'awaitWake'>>(undefined),
  getJob: () => ok<StoreOperation<'getJob'>>(undefined),
  getAttempts: () => ok<StoreOperation<'getAttempts'>>([]),
  list: () => ok<StoreOperation<'list'>>({ jobs: [], nextCursor: undefined }),
  counts: () =>
    ok<StoreOperation<'counts'>>({
      total: 0,
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    }),
  retry: () => ok<StoreOperation<'retry'>>({} as JobStore.RetryResult),
  cancel: () => ok<StoreOperation<'cancel'>>({} as JobStore.CancelResult),
  requestCancellation: () =>
    ok<StoreOperation<'requestCancellation'>>({} as JobStore.RequestCancellationResult),
  promote: () => ok<StoreOperation<'promote'>>({} as JobStore.PromoteResult),
  remove: () => ok<StoreOperation<'remove'>>({} as JobStore.RemoveResult),
  pause: () => ok<StoreOperation<'pause'>>({ queue: 'jobs' as never, paused: true }),
  resume: () => ok<StoreOperation<'resume'>>({ queue: 'jobs' as never, paused: false }),
  pausedQueues: () => ok<StoreOperation<'pausedQueues'>>([])
} satisfies JobStoreContract

expectTypeOf<StoreOperation<'enqueue'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.EnqueueResult, JobStoreEnqueueError>
>()
expectTypeOf<StoreOperation<'enqueueMany'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.EnqueueManyResult, JobStoreEnqueueManyError>
>()
expectTypeOf<StoreOperation<'claim'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.ClaimResult, JobStoreClaimError>
>()
expectTypeOf<StoreOperation<'settle'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.SettlementResult, JobStoreSettlementError>
>()
expectTypeOf<StoreOperation<'release'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.ReleaseResult, JobStoreReleaseError>
>()
expectTypeOf<StoreOperation<'heartbeat'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.HeartbeatResult, JobStoreHeartbeatError>
>()
expectTypeOf<StoreOperation<'recoverStalled'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.RecoverStalledResult, JobStoreRecoverStalledError>
>()
expectTypeOf<StoreOperation<'awaitWake'>>().toEqualTypeOf<
  JobStoreOperation<void, JobStoreWakeError>
>()
expectTypeOf<StoreOperation<'getJob'>>().toEqualTypeOf<
  JobStoreOperation<JobRecord | undefined, JobStoreGetJobError>
>()
expectTypeOf<StoreOperation<'getAttempts'>>().toEqualTypeOf<
  JobStoreOperation<readonly AttemptRecord[], JobStoreGetAttemptsError>
>()
expectTypeOf<StoreOperation<'list'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.ListJobsResult, JobStoreListError>
>()
expectTypeOf<StoreOperation<'counts'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.JobCounts, JobStoreCountsError>
>()
expectTypeOf<StoreOperation<'retry'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.RetryResult, JobStoreRetryError>
>()
expectTypeOf<StoreOperation<'cancel'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.CancelResult, JobStoreCancelError>
>()
expectTypeOf<StoreOperation<'requestCancellation'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.RequestCancellationResult, JobStoreRequestCancellationError>
>()
expectTypeOf<StoreOperation<'promote'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.PromoteResult, JobStorePromoteError>
>()
expectTypeOf<StoreOperation<'remove'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.RemoveResult, JobStoreRemoveError>
>()
expectTypeOf<StoreOperation<'pause'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.QueuePauseResult, JobStorePauseError>
>()
expectTypeOf<StoreOperation<'resume'>>().toEqualTypeOf<
  JobStoreOperation<JobStore.QueuePauseResult, JobStoreResumeError>
>()
expectTypeOf<StoreOperation<'pausedQueues'>>().toEqualTypeOf<
  JobStoreOperation<readonly import('../../src').QueueName[], JobStorePausedQueuesError>
>()
expectTypeOf<EffectError<StoreOperation<'enqueue'>>>().toEqualTypeOf<JobStoreEnqueueError>()
expectTypeOf<EffectError<StoreOperation<'awaitWake'>>>().toEqualTypeOf<JobStoreWakeError>()
expectTypeOf<EffectError<StoreOperation<'list'>>>().toEqualTypeOf<JobStoreListError>()

class AdapterConfig extends Service<AdapterConfig>()('JobStoreAdapterConfig') {}
type RequiredOperation = JobStoreOperation<string, JobStoreClaimError, AdapterConfig>
expectTypeOf<EffectRequirements<RequiredOperation>>().toEqualTypeOf<AdapterConfig>()

const Default = JobStore
const Durable = JobStore.named('durable')
const DurableAgain = JobStore.named('durable')
const Ephemeral = JobStore.named('ephemeral')
const widenedName: string = 'widened'
// @ts-expect-error Named stores require a non-empty string literal, not a widened string.
const widenedToken = JobStore.named(widenedName)
// @ts-expect-error Empty names are rejected at the TypeScript call site.
const emptyToken = JobStore.named('')
// @ts-expect-error Different named store tags are distinct Service tokens.
const incompatibleNamedToken: typeof Durable = Ephemeral

const asyncImplementation = {
  ...implementation,
  pausedQueues: async (): Promise<Awaited<StoreOperation<'pausedQueues'>>> =>
    ok<Awaited<StoreOperation<'pausedQueues'>>>([]),
  awaitWake: async (): Promise<Awaited<StoreOperation<'awaitWake'>>> =>
    ok<Awaited<StoreOperation<'awaitWake'>>>(undefined)
} satisfies JobStoreContract
const asyncInstance = Durable.of(asyncImplementation)
const asyncLayer = Layer.succeed(Durable, asyncInstance)
const asyncProgram = Effect.fn(async function* () {
  const store = yield* Durable
  const queues = yield* Result.await(Promise.resolve(store.pausedQueues()))

  return Result.ok(queues)
})
expectTypeOf<EffectRequirements<typeof asyncProgram>>().toEqualTypeOf<
  JobStore.Instance<'durable'>
>()
expectTypeOf<EffectError<typeof asyncProgram>>().toEqualTypeOf<JobStorePausedQueuesError>()
const asyncComplete = Runtime.run(asyncLayer, asyncProgram)

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
const repeatedLayer = Layer.succeed(
  JobStore.named('durable'),
  JobStore.named('durable').of(implementation)
)
const repeatedProgram = Effect.fn(async function* () {
  const store = yield* JobStore.named('durable')
  return Result.ok(store.protocolVersion)
})
const repeatedComplete = Runtime.run(repeatedLayer, repeatedProgram)
const wrong = JobStore.named('wrong')
const wrongLayer = Layer.succeed(wrong, wrong.of(implementation))
// @ts-expect-error A Layer for another named token does not complete this program.
const wrongName = Runtime.run(wrongLayer, program)
// @ts-expect-error Runtime completeness rejects a missing named JobStore.
const incomplete = Runtime.run(Layer.empty, program)

void claim
void invalidClaim
void asyncComplete
void complete
void incomplete
void defaultLayer
void repeatedComplete
void widenedToken
void emptyToken
void incompatibleNamedToken
void wrongName
