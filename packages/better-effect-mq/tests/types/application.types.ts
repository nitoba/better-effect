import { expectTypeOf } from 'bun:test'
import { Effect, Layer, Runtime, type EffectError, type EffectRequirements } from 'better-effect'
import { Clock, ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import type { UnhandledException } from 'better-result'

import {
  Codec,
  Job,
  JobAdmin,
  JobStore,
  MemoryJobStore,
  Queue,
  type JobAdminCountError,
  type JobAdminListError,
  type JobAdminPauseError,
  type JobAdminRemoveError,
  type JobAdminResumeError,
  type JobAttemptView,
  type JobAttemptsError,
  type JobAwaitAbortedError,
  type JobAwaitOptions,
  type JobAwaitResultError,
  type JobCancelError,
  type JobDecodeFailure,
  type JobDefinitionError,
  type JobEnqueueError,
  type JobEncodeFailure,
  type JobEnqueueOptions,
  type JobExecutionCancelledError,
  type JobExecutionFailureError,
  type JobIdentityMismatchError,
  type JobNotFoundError,
  type JobOperation,
  type JobPollError,
  type JobPromoteError,
  type JobRecord,
  type JobRecordView,
  type JobRetryError,
  type JobStoreCountsError,
  type JobStoreEnqueueError,
  type JobStoreGetAttemptsError,
  type JobStoreGetJobError,
  type JobStoreListError,
  type JobStorePauseError,
  type JobStorePausedQueuesError,
  type JobStoreRemoveError,
  type JobStoreResumeError,
  type JobStoreRetryError,
  type QueueName
} from '../../src'

const Emails = Queue.define('application-types')
type HandlerFailure = { readonly code: string }

const Send = Emails.job('send', {
  version: 1,
  payload: Codec.json<{ readonly to: string }>(),
  result: Codec.string,
  failure: Codec.json<HandlerFailure>(),
  store: JobStore
})
const NamedStore = JobStore.named('application-named')
const Named = Emails.job('named', {
  version: 1,
  payload: Codec.string,
  store: NamedStore
})

const options: JobEnqueueOptions = { delayMs: 10 }
const awaitOptions: JobAwaitOptions = { pollIntervalMs: 10 }
const enqueue = Send.enqueue({ to: 'a' }, options)
const enqueueMany = Send.enqueueMany([{ to: 'a' }])
const poll = Send.poll('job')
const attempts = Send.attempts('job')
const awaitResult = Send.awaitResult('job', awaitOptions)
const execute = Send.execute({ to: 'a' })
const admin = JobAdmin.for(JobStore)
const adminList = admin.list({
  queue: 'application-types',
  version: 1,
  metadata: { source: 'type-test' },
  orderBy: 'finishedAt',
  order: 'desc',
  states: ['waiting']
})
const adminCounts = admin.counts('application-types')
const adminCount = admin.count('application-types')
const adminPause = admin.pause('application-types')
const adminResume = admin.resume('application-types')
const adminPausedQueues = admin.pausedQueues()
const adminRemove = admin.remove('job')
const cancel = Send.cancel('job')
const promote = Send.promote('job')
const retry = Send.retry('job', { delayMs: 10 })

type ExpectedEnqueueError =
  | JobDecodeFailure
  | JobEncodeFailure
  | JobDefinitionError
  | JobStoreEnqueueError
  | UnhandledException
type ExpectedPollError =
  | JobStoreGetJobError
  | JobIdentityMismatchError
  | JobDecodeFailure
  | UnhandledException
type ExpectedAttemptsError =
  | JobStoreGetJobError
  | JobStoreGetAttemptsError
  | JobNotFoundError
  | JobIdentityMismatchError
  | JobDecodeFailure
  | UnhandledException
type ExpectedAwaitError =
  | HandlerFailure
  | JobStoreGetJobError
  | JobIdentityMismatchError
  | JobNotFoundError
  | JobDecodeFailure
  | JobExecutionFailureError
  | JobExecutionCancelledError
  | JobAwaitAbortedError
  | UnhandledException
type ExpectedAdminListError = JobStoreListError | UnhandledException
type ExpectedAdminCountError = JobStoreCountsError | UnhandledException
type ExpectedAdminPauseError = JobStorePauseError | UnhandledException
type ExpectedAdminResumeError = JobStoreResumeError | UnhandledException
type ExpectedAdminRemoveError = JobStoreRemoveError | UnhandledException
type ExpectedRetryError =
  | JobStoreGetJobError
  | JobIdentityMismatchError
  | JobStoreRetryError
  | UnhandledException

expectTypeOf<JobEnqueueError>().toEqualTypeOf<ExpectedEnqueueError>()
expectTypeOf<JobPollError>().toEqualTypeOf<ExpectedPollError>()
expectTypeOf<JobAttemptsError>().toEqualTypeOf<ExpectedAttemptsError>()
expectTypeOf<JobAwaitResultError<HandlerFailure>>().toEqualTypeOf<ExpectedAwaitError>()
expectTypeOf<JobAdminListError>().toEqualTypeOf<ExpectedAdminListError>()
expectTypeOf<JobAdminCountError>().toEqualTypeOf<ExpectedAdminCountError>()
expectTypeOf<JobAdminPauseError>().toEqualTypeOf<ExpectedAdminPauseError>()
expectTypeOf<JobAdminResumeError>().toEqualTypeOf<ExpectedAdminResumeError>()
expectTypeOf<JobAdminRemoveError>().toEqualTypeOf<ExpectedAdminRemoveError>()
expectTypeOf<JobRetryError>().toEqualTypeOf<ExpectedRetryError>()
expectTypeOf<JobExecutionFailureError['kind']>().toEqualTypeOf<
  'defect' | 'timeout' | 'decode' | 'stalled'
>()
expectTypeOf<JobExecutionCancelledError['failure']>().toEqualTypeOf<
  import('../../src').SerializedJobFailure | undefined
>()

expectTypeOf(enqueue).toEqualTypeOf<
  JobOperation<import('../../src').JobId, ExpectedEnqueueError, typeof JobStore, true>
>()
expectTypeOf(enqueueMany).toEqualTypeOf<
  JobOperation<readonly import('../../src').JobId[], ExpectedEnqueueError, typeof JobStore, true>
>()
expectTypeOf(poll).toEqualTypeOf<
  JobOperation<
    JobRecordView<string, HandlerFailure> | undefined,
    ExpectedPollError,
    typeof JobStore
  >
>()
expectTypeOf(attempts).toEqualTypeOf<
  JobOperation<
    readonly JobAttemptView<string, HandlerFailure>[],
    ExpectedAttemptsError,
    typeof JobStore
  >
>()
expectTypeOf(awaitResult).toEqualTypeOf<
  JobOperation<string, ExpectedAwaitError, typeof JobStore, true>
>()
expectTypeOf(execute).toEqualTypeOf<
  JobOperation<string, ExpectedEnqueueError | ExpectedAwaitError, typeof JobStore, true>
>()
expectTypeOf(adminList).toEqualTypeOf<
  JobOperation<JobStore.ListJobsResult, ExpectedAdminListError, typeof JobStore>
>()
expectTypeOf(adminCounts).toEqualTypeOf<
  JobOperation<JobStore.JobCounts, ExpectedAdminCountError, typeof JobStore>
>()
expectTypeOf(adminCount).toEqualTypeOf<
  JobOperation<number, ExpectedAdminCountError, typeof JobStore>
>()
expectTypeOf(adminPause).toEqualTypeOf<
  JobOperation<JobStore.QueuePauseResult, ExpectedAdminPauseError, typeof JobStore, true>
>()
expectTypeOf(adminResume).toEqualTypeOf<
  JobOperation<JobStore.QueuePauseResult, ExpectedAdminResumeError, typeof JobStore, true>
>()
expectTypeOf(adminPausedQueues).toEqualTypeOf<
  JobOperation<
    readonly QueueName[],
    JobStorePausedQueuesError | UnhandledException,
    typeof JobStore
  >
>()
expectTypeOf(adminRemove).toEqualTypeOf<
  JobOperation<JobStore.RemoveResult, ExpectedAdminRemoveError, typeof JobStore, true>
>()
expectTypeOf(cancel).toEqualTypeOf<JobOperation<JobRecord, JobCancelError, typeof JobStore, true>>()
expectTypeOf(promote).toEqualTypeOf<
  JobOperation<JobRecord, JobPromoteError, typeof JobStore, true>
>()
expectTypeOf(retry).toEqualTypeOf<
  JobOperation<JobRecord, ExpectedRetryError, typeof JobStore, true>
>()

const program = Effect.gen(async function* () {
  const id = yield* Send.enqueue({ to: 'a' })
  expectTypeOf(id).toEqualTypeOf<import('../../src').JobId>()
  return Result.ok(id)
})
expectTypeOf<EffectError<typeof program>>().toEqualTypeOf<ExpectedEnqueueError>()
expectTypeOf<EffectRequirements<typeof program>>().toEqualTypeOf<
  JobStore.Instance | InstanceType<typeof Clock>
>()

const awaitProgram = Effect.gen(async function* () {
  const id = yield* Send.enqueue({ to: 'a' })
  const result = yield* Send.awaitResult(id)
  return Result.ok(result)
})
expectTypeOf<EffectError<typeof awaitProgram>>().toEqualTypeOf<
  ExpectedEnqueueError | ExpectedAwaitError
>()
expectTypeOf<EffectRequirements<typeof awaitProgram>>().toEqualTypeOf<
  JobStore.Instance | InstanceType<typeof Clock>
>()

const executeProgram = Effect.gen(async function* () {
  return Result.ok(yield* Send.execute({ to: 'a' }))
})
expectTypeOf<EffectError<typeof executeProgram>>().toEqualTypeOf<
  ExpectedEnqueueError | ExpectedAwaitError
>()
expectTypeOf<EffectRequirements<typeof executeProgram>>().toEqualTypeOf<
  JobStore.Instance | InstanceType<typeof Clock>
>()

const namedProgram = Effect.gen(async function* () {
  return Result.ok(yield* Named.enqueue('payload'))
})
expectTypeOf<EffectError<typeof namedProgram>>().toEqualTypeOf<ExpectedEnqueueError>()
expectTypeOf<EffectRequirements<typeof namedProgram>>().toEqualTypeOf<
  InstanceType<typeof NamedStore> | InstanceType<typeof Clock>
>()

const completeLayer = Layer.merge(MemoryJobStore.layer, ClockLive)
void Runtime.run(completeLayer, () => program)
void Runtime.run(completeLayer, () => awaitProgram)
void Runtime.run(completeLayer, () => executeProgram)
const namedLayer = Layer.merge(MemoryJobStore.layerFor(NamedStore), ClockLive)
void Runtime.run(namedLayer, () => namedProgram)
// @ts-expect-error the named store requirement cannot be satisfied by the default layer.
void Runtime.run(completeLayer, () => namedProgram)

// @ts-expect-error delayMs and at cannot be supplied together.
Send.enqueue({ to: 'a' }, { delayMs: 1, at: 2 })

// @ts-expect-error a shared batch option cannot carry one Job ID for every item.
Send.enqueueMany([{ to: 'a' }], { jobId: 'one' })

void Job
