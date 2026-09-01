// oxlint-disable anti-slop/no-unknown-parameters -- Effect programs intentionally exercise the typed worker boundary.

import { expectTypeOf } from 'bun:test'
import { Effect, Layer, Runtime, Service } from 'better-effect'
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

class OtherService extends Service<OtherService>()('WorkerTypesOther') {}

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

// SAFETY: This fixture only needs a structurally valid store contract to test Worker type inference.
const storeLayer = Layer.succeed(JobStore, JobStore.of({} as import('../../src').JobStore.Contract))
const namedLayer = Layer.succeed(
  namedStore,
  // SAFETY: This fixture only needs a structurally valid store contract to test named-store inference.
  namedStore.of({} as import('../../src').JobStore.Contract)
)
const rootLayer = Layer.succeed(RootService, RootService.of({ prefix: 'root' }))
const completeLayer = Layer.merge(storeLayer, rootLayer)
const namedCompleteLayer = Layer.merge(namedLayer, rootLayer)

declare const completeRuntime: Runtime.For<typeof completeLayer>
declare const namedCompleteRuntime: Runtime.For<typeof namedCompleteLayer>
declare const storeOnlyRuntime: Runtime.For<typeof storeLayer>
declare const otherRuntime: Runtime<OtherService>

const complete = Worker.start(completeRuntime, {
  handlers: [firstHandler, secondHandler],
  concurrency: 4
})
const namedComplete = Worker.start(namedCompleteRuntime, { handlers: [namedHandler] })

// @ts-expect-error A Worker handler's root Service must be present in the Runtime.
void Worker.start(storeOnlyRuntime, { handlers: [firstHandler] })
// @ts-expect-error A Job bound to a named store cannot run on another environment.
void Worker.start(completeRuntime, { handlers: [namedHandler] })
// @ts-expect-error A Runtime with an unrelated Service does not satisfy the handler.
void Worker.start(otherRuntime, { handlers: [firstHandler] })

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
// @ts-expect-error Worker handles expose readonly inspectable values.
void complete.then((handle) => (handle.id = 'mutable'))

void complete
void namedComplete
void wrongFailure
void wrongPayload
