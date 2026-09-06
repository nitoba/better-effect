import { expect, test } from 'bun:test'

import { Effect, Layer, Runtime, Service } from 'better-effect'
import { Result } from 'better-result'

import {
  Codec,
  JobStore,
  MemoryJobStore,
  Queue,
  Worker,
  makeWorkerId,
  type JobStoreError,
  type JobStoreOperation,
  type WorkerHandle
} from '../src'

const resolveStoreOperation = async <Value>(
  operation: JobStoreOperation<Value, JobStoreError>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) {
    throw result.error
  }
  return result.value
}

class WorkerLayerRoot extends Service<WorkerLayerRoot>()('WorkerLayerRoot') {
  readonly prefix!: string
}

const queue = Queue.define('worker-layer-tests')
const job = queue.job('run', {
  version: 1,
  payload: Codec.json<{ readonly value: number }>(),
  result: Codec.string
})

test('Worker.service layer is lazy, starts once, and releases after Runtime drain', async () => {
  const store = MemoryJobStore.make()
  const now = Date.now()
  const enqueued = await resolveStoreOperation(
    store.enqueue({
      job: job.identity,
      payload: { value: 2 },
      runAt: now,
      attemptsMax: 1,
      metadata: {},
      now
    })
  )

  const workerService = Worker.service('WorkerLayerControl')
  let factoryCalls = 0
  let observedPrefix: string | undefined

  const handler = Worker.handle(job, (input) =>
    Effect.fn(async function* () {
      const root = yield* WorkerLayerRoot
      observedPrefix = root.prefix
      return Result.ok(`${root.prefix}:${input.value}`)
    })
  )

  const workerLayer = workerService.layer(async function* () {
    const root = yield* WorkerLayerRoot
    factoryCalls += 1

    if (root.prefix !== 'root') {
      throw new Error('Worker Layer factory did not resolve the root Service')
    }

    return {
      handlers: [handler] as const,
      concurrency: 1,
      pollIntervalMs: 1,
      now: () => now,
      shutdown: {
        gracePeriodMs: 100,
        abortAfterGracePeriod: false
      },
      onError: (cause: unknown) => {
        throw cause
      },
      workerId: makeWorkerId('worker-layer-test').unwrap()
    }
  })

  const application = Layer.complete(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(store)),
      Layer.succeed(WorkerLayerRoot, WorkerLayerRoot.of({ prefix: 'root' })),
      workerLayer
    )
  )
  const runtime = await Runtime.make(application)

  try {
    expect(factoryCalls).toBe(0)

    await runtime.warmup()
    expect(factoryCalls).toBe(1)

    const resolved = await runtime.run(() =>
      Effect.gen(async function* () {
        const worker = yield* workerService
        return Result.ok(worker)
      })
    )

    if (Result.isError(resolved)) {
      throw resolved.error
    }

    await resolved.value.awaitIdle({ timeoutMs: 2_000 })
    expect(observedPrefix).toBe('root')

    const completed = await resolveStoreOperation(store.getJob({ jobId: enqueued.job.id }))
    expect(completed?.state).toBe('completed')
    expect(completed?.result).toBe('root:2')

    const disposal = runtime.dispose()
    expect(runtime.inspect().state).toBe('quiescing')
    await disposal
    expect(resolved.value.state).toBe('stopped')
  } finally {
    if (runtime.inspect().state !== 'disposed') {
      await runtime.dispose()
    }
  }
})

test('Worker.succeed provides caller-owned test doubles without registering lifecycle', async () => {
  const workerService = Worker.service('WorkerLayerTestDouble')
  let stopCalls = 0
  const fake: WorkerHandle = {
    id: makeWorkerId('worker-test-double').unwrap(),
    state: 'running',
    activeCount: 0,
    stop: async () => {
      stopCalls += 1
    },
    awaitIdle: async () => {},
    [Symbol.asyncDispose]: async () => {}
  }

  const runtime = await Runtime.make(workerService.succeed(fake))
  const resolved = await runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* workerService)
    })
  )

  if (Result.isError(resolved)) {
    throw resolved.error
  }

  // SAFETY: the resolved value is the exact fake supplied to Worker.succeed; the cast only removes its Service identity marker for this identity assertion.
  expect(resolved.value as WorkerHandle).toBe(fake)
  await runtime.dispose()
  expect(stopCalls).toBe(0)
})
