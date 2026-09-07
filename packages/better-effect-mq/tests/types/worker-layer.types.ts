import { expectTypeOf } from 'bun:test'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { Result } from 'better-result'

import { Codec, Flow, FlowStore, JobStore, Queue, Worker, makeWorkerId } from '../../src'
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

const flowParent = queue.job('flow-parent', {
  version: 1,
  payload: Codec.json<{ readonly id: string }>(),
  result: Codec.json<{ readonly complete: boolean }>()
})
const flowChild = queue.job('flow-child', {
  version: 1,
  payload: Codec.json<{ readonly id: string }>(),
  result: Codec.boolean
})
const flow = Flow.define('typed-worker-flow', {
  parent: flowParent,
  children: [flowChild] as const,
  onChildFailure: 'continue'
})
const flowHandler = Flow.handle(flow, {
  fanOut: () =>
    Effect.fn(async function* () {
      yield* []
      return Result.ok([Flow.children(flowChild, [{ key: 'child:1', payload: { id: '1' } }])])
    }),
  collect: (_payload, results) =>
    Effect.fn(async function* () {
      yield* []
      return Result.ok({ complete: results.counts.failed === 0 })
    })
})
const flowWorker = Worker.service('TypedFlowWorker')
const flowWorkerLayer = flowWorker.layer(() => ({
  handlers: [handler] as const,
  flows: [flowHandler] as const
}))
expectTypeOf<Layer.Required<typeof flowWorkerLayer>>().toEqualTypeOf<
  WorkerLayerConfig | JobStore.Instance | FlowStore.Instance
>()

const namedParentStore = JobStore.named('typed-flow-parent')
const namedChildStore = JobStore.named('typed-flow-child')
const namedParent = queue.job('named-flow-parent', {
  version: 1,
  payload: Codec.string,
  result: Codec.string,
  store: namedParentStore
})
const namedChild = queue.job('named-flow-child', {
  version: 1,
  payload: Codec.number,
  store: namedChildStore
})
const namedFlow = Flow.define('typed-named-flow', {
  parent: namedParent,
  children: [namedChild] as const,
  onChildFailure: 'continue'
})
const namedFlowWorker = Worker.service('TypedNamedFlowWorker')
const namedFlowLayer = namedFlowWorker.layer(() => ({
  handlers: [
    Worker.handle(namedParent, () =>
      Effect.fn(async function* () {
        yield* []
        return Result.ok('done')
      })
    )
  ] as const,
  flows: [namedFlow] as const,
  flowSweepFlowIds: [] as const
}))
expectTypeOf<Layer.Required<typeof namedFlowLayer>>().toEqualTypeOf<
  | JobStore.Instance<'typed-flow-parent'>
  | JobStore.Instance<'typed-flow-child'>
  | FlowStore.Instance<typeof namedParentStore>
  | FlowStore.Instance<typeof namedChildStore>
>()
void FlowStore

// @ts-expect-error Worker layers cannot be made into a Runtime before their Services are provided.
void Runtime.make(workerLayer)

// @ts-expect-error Worker Service tokens reject manual construction.
void new workerService()
