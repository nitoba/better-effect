// oxlint-disable anti-slop/no-unknown-parameters -- Effect programs intentionally exercise the typed worker boundary.

import { expectTypeOf } from 'bun:test'
import { Effect, Service } from 'better-effect'
import { Result } from 'better-result'

import {
  Codec,
  JobContext,
  JobStore,
  Queue,
  Worker,
  type WorkerHandle,
  type WorkerRequirements
} from '../../src'

class RootService extends Service<RootService>()('WorkerTypesRoot') {
  readonly prefix!: string
}

const queue = Queue.define('worker-types')
const payload = Codec.json<{ readonly value: number }>()
const result = Codec.number
const failure = Codec.json<{ readonly code: string }>()

const firstJob = queue.job('first', { version: 1, payload, result, failure })
const secondJob = queue.job('second', { version: 2, payload: Codec.string, result })
const namedStore = JobStore.named('worker-types')
const namedJob = queue.job('named', {
  version: 1,
  payload,
  result: Codec.string,
  store: namedStore
})

const firstHandler = Worker.handle(firstJob, (input) =>
  Effect.fn(async function* () {
    const root = yield* RootService
    const context = yield* JobContext
    return Result.ok(root.prefix.length + input.value + context.attempt)
  })
)

const secondHandler = Worker.handle(secondJob, (input) =>
  // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
  Effect.fn(async function* () {
    return Result.ok(input.length)
  })
)

const namedHandler = Worker.handle(namedJob, () =>
  Effect.fn(async function* () {
    const root = yield* RootService
    return Result.ok(root.prefix)
  })
)

expectTypeOf<WorkerRequirements<[typeof firstHandler]>>().toEqualTypeOf<
  RootService | import('../../src').JobStore.Instance
>()
expectTypeOf<WorkerRequirements<[typeof namedHandler]>>().toEqualTypeOf<
  RootService | import('../../src').JobStore.Instance<'worker-types'>
>()
expectTypeOf(firstHandler.job).toEqualTypeOf<typeof firstJob>()
expectTypeOf(firstHandler.handler).toMatchTypeOf<
  (input: {
    readonly value: number
  }) => Effect.Program<number, { readonly code: string }, RootService | JobContext>
>()

const wrongFailure = Worker.handle(firstJob, () =>
  // @ts-expect-error A handler must return the Job's declared failure channel.
  // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
  Effect.fn(async function* () {
    return Result.err({ wrong: true })
  })
)

const wrongPayload = Worker.handle(
  firstJob,
  // @ts-expect-error Handler payload is the Job's decoded payload type.
  (input: string) =>
    // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
    Effect.fn(async function* () {
      return Result.ok(input)
    })
)

const versions = [firstHandler, secondHandler] as const
expectTypeOf(versions[0]!.job).toEqualTypeOf<typeof firstJob>()
expectTypeOf(versions[1]!.job).toEqualTypeOf<typeof secondJob>()
expectTypeOf<WorkerHandle['state']>().toEqualTypeOf<'running' | 'stopping' | 'stopped'>()
expectTypeOf<WorkerHandle['activeCount']>().toEqualTypeOf<number>()

// @ts-expect-error Handler descriptors are immutable after construction.
firstHandler.concurrency = 2
void wrongFailure
void wrongPayload
