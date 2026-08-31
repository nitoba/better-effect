import { expectTypeOf } from 'bun:test'
import { Effect, Layer, Runtime, type EffectRequirements } from 'better-effect'
import { Clock, ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'

import {
  Codec,
  Job,
  JobAdmin,
  JobStore,
  MemoryJobStore,
  Queue,
  type JobAwaitOptions,
  type JobEnqueueOptions,
  type JobRecordView
} from '../../src'

const Emails = Queue.define('application-types')
const Send = Emails.job('send', {
  version: 1,
  payload: Codec.json<{ readonly to: string }>(),
  result: Codec.string,
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
const poll = Send.poll('job')
const awaitResult = Send.awaitResult('job', awaitOptions)
const execute = Send.execute({ to: 'a' })
const adminList = JobAdmin.for(JobStore).list({ queue: 'application-types', states: ['waiting'] })
const adminCounts = JobAdmin.for(JobStore).counts('application-types')

expectTypeOf(enqueue).toMatchTypeOf<AsyncGenerator<unknown, string, unknown>>()
expectTypeOf(poll).toMatchTypeOf<
  AsyncGenerator<unknown, JobRecordView<string, never> | undefined, unknown>
>()
expectTypeOf(awaitResult).toMatchTypeOf<AsyncGenerator<unknown, string, unknown>>()
expectTypeOf(execute).toMatchTypeOf<AsyncGenerator<unknown, string, unknown>>()
expectTypeOf(adminList).toMatchTypeOf<AsyncGenerator<unknown, unknown, unknown>>()
expectTypeOf(adminCounts).toMatchTypeOf<AsyncGenerator<unknown, unknown, unknown>>()

const program = Effect.gen(async function* () {
  const id = yield* Send.enqueue({ to: 'a' })
  return Result.ok(id)
})
expectTypeOf<EffectRequirements<typeof program>>().toEqualTypeOf<
  JobStore.Instance | InstanceType<typeof Clock>
>()

const namedProgram = Effect.gen(async function* () {
  return Result.ok(yield* Named.enqueue('payload'))
})
expectTypeOf<EffectRequirements<typeof namedProgram>>().toEqualTypeOf<
  InstanceType<typeof NamedStore> | InstanceType<typeof Clock>
>()

const completeLayer = Layer.merge(MemoryJobStore.layer, ClockLive)
void Runtime.run(completeLayer, () => program)
const namedLayer = Layer.merge(MemoryJobStore.layerFor(NamedStore), ClockLive)
void Runtime.run(namedLayer, () => namedProgram)
// @ts-expect-error the named store requirement cannot be satisfied by the default layer.
void Runtime.run(completeLayer, () => namedProgram)

// @ts-expect-error delayMs and at cannot be supplied together.
Send.enqueue({ to: 'a' }, { delayMs: 1, at: 2 })

// @ts-expect-error a shared batch option cannot carry one Job ID for every item.
Send.enqueueMany([{ to: 'a' }], { jobId: 'one' })

void Job
