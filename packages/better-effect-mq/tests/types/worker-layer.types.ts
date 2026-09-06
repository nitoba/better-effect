import { expectTypeOf } from 'bun:test'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { Result } from 'better-result'

import { Codec, JobStore, Queue, Worker, makeWorkerId } from '../../src'
import type { WorkerHandle } from '../../src'

class WorkerLayerConfig extends Service<WorkerLayerConfig>()('WorkerLayerConfig') {
  readonly concurrency!: number
}

const queue = Queue.define('worker-layer-types')
const job = queue.job('run', {
  version: 1,
  payload: Codec.number,
  result: Codec.string
})
const handler = Worker.handle(job, (input) =>
  Effect.fn(async function* () {
    const config = yield* WorkerLayerConfig
    return Result.ok(`${config.concurrency}:${input}`)
  })
)

const workerService = Worker.service('TypedWorker')
expectTypeOf(workerService.serviceTag).toEqualTypeOf<'TypedWorker'>()
expectTypeOf(workerService).toMatchTypeOf<Worker.ServiceToken<'TypedWorker'>>()

const workerLayer = workerService.layer(async function* () {
  const config = yield* WorkerLayerConfig
  return {
    handlers: [handler] as const,
    concurrency: config.concurrency
  }
})

expectTypeOf<Layer.Provided<typeof workerLayer>>().toEqualTypeOf<
  Worker.ServiceInstance<'TypedWorker'>
>()
expectTypeOf<Layer.Required<typeof workerLayer>>().toEqualTypeOf<
  WorkerLayerConfig | JobStore.Instance
>()

const completeLayer = Layer.complete(
  Layer.merge(
    Layer.succeed(WorkerLayerConfig, WorkerLayerConfig.of({ concurrency: 2 })),
    // SAFETY: this fixture only exercises Layer requirements; the store contract is not executed.
    Layer.succeed(JobStore, JobStore.of({} as JobStore.Contract)),
    workerLayer
  )
)
declare const runtime: Runtime.For<typeof completeLayer>

const workerProgram = () =>
  Effect.gen(async function* () {
    const worker = yield* workerService
    return Result.ok(worker.id)
  })
const execution = runtime.run(workerProgram)
expectTypeOf(execution).toEqualTypeOf<Promise<Awaited<ReturnType<typeof workerProgram>>>>()

const fake: WorkerHandle = {
  id: makeWorkerId('test-worker').unwrap(),
  state: 'running',
  activeCount: 0,
  stop: async () => {},
  awaitIdle: async () => {},
  [Symbol.asyncDispose]: async () => {}
}
const testDouble = workerService.succeed(fake)
expectTypeOf<Layer.Required<typeof testDouble>>().toEqualTypeOf<never>()
expectTypeOf(workerService.of(fake)).toEqualTypeOf<Worker.ServiceInstance<'TypedWorker'>>()

// @ts-expect-error Worker layers cannot be made into a Runtime before their Services are provided.
void Runtime.make(workerLayer)

// @ts-expect-error Worker Service tokens reject manual construction.
void new workerService()
