import { expect, test } from 'bun:test'

import { Effect, Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'

import {
  Codec,
  Flow,
  FlowStore,
  JobId,
  JobStore,
  LeaseToken,
  makeFlowChildId,
  makePreparedEnqueue,
  MemoryFlowStore,
  MemoryJobStore,
  protocolVersion,
  Queue,
  QueueName,
  Worker,
  WorkerId,
  type FlowStoreV2,
  type FlowOutboxEntry,
  type JobStoreContract
} from '../src'

const ParentStore = JobStore.named('flow-worker-parent')
const ChildStore = JobStore.named('flow-worker-child')
const queue = Queue.define('flow-worker-lifecycle')
const Parent = queue.job('parent', {
  version: 1,
  payload: Codec.json<{ readonly value: string }>(),
  result: Codec.json<{ readonly done: boolean }>(),
  store: ParentStore
})
const Child = queue.job('child', {
  version: 1,
  payload: Codec.json<{ readonly value: string }>(),
  result: Codec.json<{ readonly done: boolean }>(),
  store: ChildStore
})
const Dummy = queue.job('dummy', {
  version: 1,
  payload: Codec.string,
  result: Codec.string,
  store: ParentStore
})
const FailParent = queue.job('fail-parent', {
  version: 1,
  payload: Codec.json<{ readonly value: string }>(),
  result: Codec.json<{ readonly done: boolean }>(),
  failure: Codec.json<{ readonly code: string }>(),
  store: ParentStore
})
const FailChild = queue.job('fail-child', {
  version: 1,
  payload: Codec.json<{ readonly value: string }>(),
  result: Codec.json<{ readonly done: boolean }>(),
  failure: Codec.json<{ readonly code: string }>(),
  store: ChildStore
})
const FlowDefinition = Flow.define('flow-worker-lifecycle', {
  parent: Parent,
  children: [Child] as const,
  onChildFailure: 'continue'
})

const unwrap = async <Value, Failure>(
  operation: Result<Value, Failure> | PromiseLike<Result<Value, Failure>>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const pureProgram = <Value>(value: Value) =>
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok(value)
  })

const waitFor = async (
  check: () => boolean | Promise<boolean>,
  timeoutMs = 1_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('Timed out waiting for Flow Worker state')
}

const makeSpec = (flowId: string, childKey: string) => {
  const id = makeFlowChildId({
    parentStoreKey: ParentStore.serviceTag,
    flowId: JobId.make(flowId).unwrap(),
    childKey
  }).unwrap()
  const request = makePreparedEnqueue({
    protocolVersion,
    identity: Child.identity,
    id,
    payload: { value: childKey },
    metadata: {},
    priority: 0,
    runAt: 0,
    attemptsMax: 1,
    now: 0
  }).unwrap()
  return {
    childKey,
    name: Child.name,
    version: Child.version,
    storeKey: ChildStore.serviceTag,
    childJobId: id,
    request
  } as const
}

const fanOut = async (store: FlowStoreV2, flowId: string, childKey = 'child:1') =>
  unwrap(
    store.fanOut({
      flowId: JobId.make(flowId).unwrap(),
      flowName: FlowDefinition.name,
      parentStoreKey: ParentStore.serviceTag,
      depth: 1,
      leaseToken: LeaseToken.make('flow-worker-lease').unwrap(),
      failFast: false,
      children: [makeSpec(flowId, childKey)],
      now: 0
    })
  )

const delegateFlowStore = (
  base: FlowStoreV2,
  overrides: Partial<Pick<FlowStoreV2, 'peekOutbox' | 'recordChildResults'>> = {}
): FlowStoreV2 => ({
  descriptor: base.descriptor,
  fanOut: base.fanOut.bind(base),
  recordChildResults: overrides.recordChildResults ?? base.recordChildResults.bind(base),
  cancel: base.cancel.bind(base),
  reconcile: base.reconcile.bind(base),
  markCascaded: base.markCascaded.bind(base),
  appendChildReport: base.appendChildReport.bind(base),
  peekOutbox: overrides.peekOutbox ?? base.peekOutbox.bind(base),
  ackOutbox: base.ackOutbox.bind(base),
  getFlow: base.getFlow.bind(base)
})

const makeRuntime = async (
  parentJobStore: JobStoreContract,
  childJobStore: JobStoreContract,
  parentFlowStore: FlowStoreV2,
  childFlowStore: FlowStoreV2,
  options: { readonly flowSweepFlowIds?: readonly import('../src').JobId[] } = {}
) => {
  const parentFlowToken = FlowStore.for(ParentStore)
  const childFlowToken = FlowStore.for(ChildStore)
  const workerService = Worker.service('FlowLifecycleWorker')
  const handler = Worker.handle(Dummy, () =>
    Effect.fn(async function* () {
      yield* []
      return Result.ok('dummy')
    })
  )
  const workerLayer = workerService.layer(() => ({
    handlers: [handler] as const,
    flows: [FlowDefinition] as const,
    pollIntervalMs: 1,
    flowSweepIntervalMs: 5,
    flowBatchSize: 2,
    ...options
  }))
  const application = Layer.complete(
    Layer.merge(
      Layer.merge(
        Layer.merge(
          Layer.succeed(ParentStore, ParentStore.of(parentJobStore)),
          Layer.succeed(ChildStore, ChildStore.of(childJobStore))
        ),
        Layer.merge(
          Layer.succeed(parentFlowToken, parentFlowToken.of(parentFlowStore)),
          Layer.succeed(childFlowToken, childFlowToken.of(childFlowStore))
        )
      ),
      workerLayer
    )
  )
  const runtime = await Runtime.make(application)
  await runtime.warmup()
  return runtime
}

const reportEntry = (flowId: string, childKey: string, id: string): FlowOutboxEntry => ({
  id,
  flowName: FlowDefinition.name,
  parentStoreKey: ParentStore.serviceTag,
  report: {
    flowId: JobId.make(flowId).unwrap(),
    childKey,
    outcome: 'completed',
    result: { done: true },
    failure: undefined
  }
})

test('Worker relays Flow reports at least once and acks only after parent confirmation', async () => {
  const parentFlowBase = MemoryFlowStore.make()
  const childFlowBase = MemoryFlowStore.make()
  await fanOut(parentFlowBase, 'flow-relay-loss')
  const entry = reportEntry('flow-relay-loss', 'child:1', 'relay-loss')
  await unwrap(childFlowBase.appendChildReport(entry))

  let recordCalls = 0
  const parentFlow = delegateFlowStore(parentFlowBase, {
    recordChildResults: (request) => {
      recordCalls += 1
      const result = parentFlowBase.recordChildResults(request)
      if (recordCalls === 1) {
        return Promise.resolve(result).then(() => {
          throw new Error('lost parent response')
        })
      }
      return result
    }
  })
  const runtime = await makeRuntime(
    MemoryJobStore.make(),
    MemoryJobStore.make(),
    parentFlow,
    childFlowBase
  )

  try {
    await waitFor(
      async () => (await unwrap(childFlowBase.peekOutbox({ limit: 10 }))).entries.length === 0
    )
    expect(recordCalls).toBeGreaterThanOrEqual(2)
    expect(
      (await unwrap(parentFlowBase.getFlow({ flowId: JobId.make('flow-relay-loss').unwrap() })))
        ?.children[0]?.status
    ).toBe('completed')
  } finally {
    await runtime.dispose()
  }
})

test('Worker skips unknown Flow routes without blocking later entries', async () => {
  const parentFlow = MemoryFlowStore.make()
  const childFlow = MemoryFlowStore.make()
  await fanOut(parentFlow, 'flow-route-skip')
  await unwrap(
    parentFlow.appendChildReport({
      ...reportEntry('flow-route-skip', 'child:1', 'unknown-parent-route'),
      flowName: 'unknown-flow'
    })
  )
  await unwrap(
    childFlow.appendChildReport({
      ...reportEntry('flow-route-skip', 'child:1', 'unknown-route'),
      flowName: 'unknown-flow'
    })
  )
  await unwrap(
    childFlow.appendChildReport(reportEntry('flow-route-skip', 'child:1', 'known-route'))
  )
  const runtime = await makeRuntime(
    MemoryJobStore.make(),
    MemoryJobStore.make(),
    parentFlow,
    childFlow
  )

  try {
    await waitFor(async () => {
      const page = await unwrap(childFlow.peekOutbox({ limit: 10 }))
      return page.entries.length === 1 && page.entries[0]?.id === 'unknown-route'
    })
    expect(
      (await unwrap(parentFlow.getFlow({ flowId: JobId.make('flow-route-skip').unwrap() })))
        ?.children[0]?.status
    ).toBe('completed')
  } finally {
    await runtime.dispose()
  }
})

test('Worker sweeper re-enqueues missing children and retries pending cascades', async () => {
  const parentFlow = MemoryFlowStore.make()
  const childFlow = MemoryFlowStore.make()
  const childJobStore = MemoryJobStore.make()
  const flowId = JobId.make('flow-sweep').unwrap()
  await fanOut(parentFlow, 'flow-sweep')
  const runtime = await makeRuntime(MemoryJobStore.make(), childJobStore, parentFlow, childFlow, {
    flowSweepFlowIds: [flowId]
  })

  try {
    const childId = makeSpec('flow-sweep', 'child:1').childJobId
    await waitFor(
      async () => (await unwrap(childJobStore.getJob({ jobId: childId }))) !== undefined
    )
    await unwrap(parentFlow.cancel({ flowId, now: 1 }))
    await waitFor(async () => {
      const flow = await unwrap(parentFlow.getFlow({ flowId }))
      const child = await unwrap(childJobStore.getJob({ jobId: childId }))
      return flow?.children[0]?.cascaded === true && child?.state === 'cancelled'
    })
  } finally {
    await runtime.dispose()
  }
})

test('Worker keeps active Flow children pending until their cancellation settles', async () => {
  const parentFlow = MemoryFlowStore.make()
  const childFlow = MemoryFlowStore.make()
  const childJobStore = MemoryJobStore.make()
  const flowId = JobId.make('flow-active-cascade').unwrap()
  await fanOut(parentFlow, 'flow-active-cascade')

  const spec = makeSpec('flow-active-cascade', 'child:1')
  const { protocolVersion: _protocolVersion, ...enqueueRequest } = spec.request
  await unwrap(childJobStore.enqueue(enqueueRequest))
  const claimed = await unwrap(
    childJobStore.claim({
      queue: QueueName.make(queue.name).unwrap(),
      accepted: [Child.identity],
      limit: 1,
      workerId: WorkerId.make('flow-active-cascade-test').unwrap(),
      leaseDurationMs: 60_000,
      now: Date.now()
    })
  )
  const active = claimed.jobs[0]
  if (active === undefined) throw new Error('active cascade fixture was not claimed')
  await unwrap(parentFlow.cancel({ flowId, now: 2 }))

  const runtime = await makeRuntime(MemoryJobStore.make(), childJobStore, parentFlow, childFlow, {
    flowSweepFlowIds: [flowId]
  })

  try {
    await waitFor(async () => {
      const job = await unwrap(childJobStore.getJob({ jobId: active.id }))
      return job?.cancellationRequestedAt !== undefined
    })
    const requested = await unwrap(childJobStore.getJob({ jobId: active.id }))
    if (requested === undefined) throw new Error('active cascade request disappeared')
    expect((await unwrap(parentFlow.getFlow({ flowId })))?.children[0]?.cascaded).toBe(false)

    await unwrap(
      childJobStore.settle({
        jobId: active.id,
        leaseToken: active.leaseToken,
        outcome: { type: 'complete', result: { done: true } },
        now: requested.updatedAt + 1
      })
    )
    await waitFor(async () => {
      const flow = await unwrap(parentFlow.getFlow({ flowId }))
      return flow?.children[0]?.cascaded === true
    })
  } finally {
    await runtime.dispose()
  }
})

test('Worker sweeper reconciles terminal child jobs into the parent Flow', async () => {
  const parentFlow = MemoryFlowStore.make()
  const childFlow = MemoryFlowStore.make()
  const childJobStore = MemoryJobStore.make()
  const flowId = JobId.make('flow-terminal').unwrap()
  await fanOut(parentFlow, 'flow-terminal')

  const spec = makeSpec('flow-terminal', 'child:1')
  const { protocolVersion: _protocolVersion, ...enqueueRequest } = spec.request
  await unwrap(childJobStore.enqueue(enqueueRequest))
  const claimed = await unwrap(
    childJobStore.claim({
      queue: QueueName.make(queue.name).unwrap(),
      accepted: [Child.identity],
      limit: 1,
      workerId: WorkerId.make('flow-terminal-test').unwrap(),
      leaseDurationMs: 100,
      now: 1
    })
  )
  const active = claimed.jobs[0]
  if (active === undefined) throw new Error('terminal child fixture was not claimed')
  await unwrap(
    childJobStore.settle({
      jobId: active.id,
      leaseToken: active.leaseToken,
      outcome: { type: 'complete', result: { done: true } },
      now: 2
    })
  )

  const runtime = await makeRuntime(MemoryJobStore.make(), childJobStore, parentFlow, childFlow, {
    flowSweepFlowIds: [flowId]
  })

  try {
    await waitFor(async () => {
      const flow = await unwrap(parentFlow.getFlow({ flowId }))
      return flow?.children[0]?.status === 'completed'
    })
    expect((await unwrap(parentFlow.getFlow({ flowId })))?.parent.state).toBe('waiting')
  } finally {
    await runtime.dispose()
  }
})

test('Worker shutdown waits for an admitted Flow relay I/O operation', async () => {
  const parentFlow = MemoryFlowStore.make()
  const childFlowBase = MemoryFlowStore.make()
  await fanOut(parentFlow, 'flow-shutdown')
  await unwrap(childFlowBase.appendChildReport(reportEntry('flow-shutdown', 'child:1', 'shutdown')))

  let releasePeek!: () => void
  let peekStarted = false
  const childFlow = delegateFlowStore(childFlowBase, {
    peekOutbox: () => {
      if (!peekStarted) {
        peekStarted = true
        return new Promise((resolve) => {
          releasePeek = () => resolve(childFlowBase.peekOutbox({ limit: 2 }))
        })
      }
      return childFlowBase.peekOutbox({ limit: 2 })
    }
  })
  const runtime = await makeRuntime(
    MemoryJobStore.make(),
    MemoryJobStore.make(),
    parentFlow,
    childFlow
  )

  try {
    await waitFor(() => peekStarted)
    let disposed = false
    const disposal = runtime.dispose().then(() => {
      disposed = true
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(disposed).toBe(false)
    releasePeek()
    await disposal
    expect(disposed).toBe(true)
  } finally {
    releasePeek?.()
    if (runtime.inspect().state !== 'disposed') await runtime.dispose()
  }
})

test('Worker executes Flow.handle fanOut, child jobs, relay, and typed collect end to end', async () => {
  const parentJobStore = MemoryJobStore.make()
  const childJobStore = MemoryJobStore.make()
  const parentFlowStore = MemoryFlowStore.make()
  const childFlowStore = MemoryFlowStore.make()
  const flowId = JobId.make('flow-execution').unwrap()
  const parentPrepared = makePreparedEnqueue({
    protocolVersion,
    identity: Parent.identity,
    id: flowId,
    payload: { value: 'root' },
    metadata: {},
    priority: 0,
    runAt: 0,
    attemptsMax: 1,
    now: 0
  }).unwrap()
  const { protocolVersion: _protocolVersion, ...parentRequest } = parentPrepared
  await unwrap(parentJobStore.enqueue(parentRequest))

  const collected: string[] = []
  const route = Flow.handle(FlowDefinition, {
    fanOut: (payload) =>
      pureProgram([
        Flow.children(Child, [{ key: `child:${payload.value}`, payload: { value: payload.value } }])
      ] as const),
    collect: (_payload, results) =>
      Effect.fn(async function* () {
        const page = yield* Result.await(
          // SAFETY: FlowResults.page is invoked in the Runtime that provides its FlowStore.
          Promise.resolve(results.page({ limit: 1 })()) as Promise<
            Result<import('../src').FlowChildPage<typeof FlowDefinition>, never>
          >
        )
        const all = yield* Result.await(
          // SAFETY: FlowResults.all is invoked in the Runtime that provides its FlowStore.
          Promise.resolve(results.all()()) as Promise<
            Result<readonly import('../src').FlowSettledChild<typeof FlowDefinition>[], never>
          >
        )
        yield* Result.await(
          // SAFETY: FlowResults.forEach is invoked in the Runtime that provides its FlowStore.
          Promise.resolve(
            results.forEach((child) => {
              collected.push(child.childKey)
              return pureProgram(undefined)
            })()
          ) as Promise<Result<void, never>>
        )
        return Result.ok({ done: page.items.length === 1 && all.length === 1 } as const)
      })
  })
  const childHandler = Worker.handle(Child, () => pureProgram({ done: true }))
  const workerService = Worker.service('FlowExecutionWorker')
  const workerLayer = workerService.layer(() => ({
    handlers: [childHandler] as const,
    flows: [route] as const,
    concurrency: 1,
    pollIntervalMs: 1,
    flowSweepIntervalMs: 2,
    flowBatchSize: 4
  }))
  const parentFlowToken = FlowStore.for(ParentStore)
  const childFlowToken = FlowStore.for(ChildStore)
  const application = Layer.complete(
    Layer.merge(
      Layer.merge(
        Layer.merge(
          Layer.succeed(ParentStore, ParentStore.of(parentJobStore)),
          Layer.succeed(ChildStore, ChildStore.of(childJobStore))
        ),
        Layer.merge(
          Layer.succeed(parentFlowToken, parentFlowToken.of(parentFlowStore)),
          Layer.succeed(childFlowToken, childFlowToken.of(childFlowStore))
        )
      ),
      workerLayer
    )
  )
  const runtime = await Runtime.make(application)
  await runtime.warmup()

  try {
    await waitFor(
      async () => (await unwrap(parentJobStore.getJob({ jobId: flowId })))?.state === 'completed'
    )
    expect(collected).toEqual(['child:root'])
    const childId = makeFlowChildId({
      parentStoreKey: ParentStore.serviceTag,
      flowId,
      childKey: 'child:root'
    }).unwrap()
    expect((await unwrap(childJobStore.getJob({ jobId: childId })))?.state).toBe('completed')
    expect((await unwrap(parentFlowStore.getFlow({ flowId })))?.children[0]?.status).toBe(
      'completed'
    )
  } finally {
    await runtime.dispose()
  }
})

test('Worker fail-fast Flow settles the parent from the first failed child', async () => {
  const parentJobStore = MemoryJobStore.make()
  const childJobStore = MemoryJobStore.make()
  const parentFlowStore = MemoryFlowStore.make()
  const childFlowStore = MemoryFlowStore.make()
  const flow = Flow.define('flow-worker-fail-fast', {
    parent: FailParent,
    children: [FailChild] as const,
    onChildFailure: 'fail'
  })
  let collected = false
  const route = Flow.handle(flow, {
    fanOut: () =>
      pureProgram([Flow.children(FailChild, [{ key: 'failed-child', payload: { value: 'x' } }])]),
    collect: () => {
      collected = true
      return pureProgram({ done: true })
    }
  })
  const flowId = JobId.make('flow-fail-fast').unwrap()
  const prepared = makePreparedEnqueue({
    protocolVersion,
    identity: FailParent.identity,
    id: flowId,
    payload: { value: 'root' },
    metadata: {},
    priority: 0,
    runAt: 0,
    attemptsMax: 1,
    now: 0
  }).unwrap()
  const { protocolVersion: _protocolVersion, ...request } = prepared
  await unwrap(parentJobStore.enqueue(request))

  const childHandler = Worker.handle(FailChild, () =>
    Effect.fn(async function* () {
      yield* Result.await(Promise.resolve(Result.ok(undefined)))
      return Result.err({ code: 'child-failed' })
    })
  )
  const workerService = Worker.service('FlowFailFastWorker')
  const parentFlowToken = FlowStore.for(ParentStore)
  const childFlowToken = FlowStore.for(ChildStore)
  const workerLayer = workerService.layer(() => ({
    handlers: [childHandler] as const,
    flows: [route] as const,
    concurrency: 1,
    pollIntervalMs: 1,
    flowSweepIntervalMs: 2,
    flowBatchSize: 4
  }))
  const application = Layer.complete(
    Layer.merge(
      Layer.merge(
        Layer.merge(
          Layer.succeed(ParentStore, ParentStore.of(parentJobStore)),
          Layer.succeed(ChildStore, ChildStore.of(childJobStore))
        ),
        Layer.merge(
          Layer.succeed(parentFlowToken, parentFlowToken.of(parentFlowStore)),
          Layer.succeed(childFlowToken, childFlowToken.of(childFlowStore))
        )
      ),
      workerLayer
    )
  )
  const runtime = await Runtime.make(application)
  await runtime.warmup()

  try {
    await waitFor(
      async () => (await unwrap(parentJobStore.getJob({ jobId: flowId })))?.state === 'failed'
    )
    expect(collected).toBe(false)
    expect((await unwrap(parentFlowStore.getFlow({ flowId })))?.parent.state).toBe('failed')
  } finally {
    await runtime.dispose()
  }
})

test('Worker rejects nested Flow cycles before creating another generation of children', async () => {
  const jobStore = MemoryJobStore.make()
  const flowStore = MemoryFlowStore.make()
  const cycle = Flow.define('flow-worker-cycle', {
    parent: Dummy,
    children: [Dummy] as const,
    onChildFailure: 'fail'
  })
  const flowId = JobId.make('flow-cycle-root').unwrap()
  const prepared = makePreparedEnqueue({
    protocolVersion,
    identity: Dummy.identity,
    id: flowId,
    payload: 'root',
    metadata: {},
    priority: 0,
    runAt: 0,
    attemptsMax: 1,
    now: 0
  }).unwrap()
  const { protocolVersion: _protocolVersion, ...request } = prepared
  await unwrap(jobStore.enqueue(request))

  const route = Flow.handle(cycle, {
    fanOut: () => pureProgram([Flow.children(Dummy, [{ key: 'cycle-child', payload: 'nested' }])]),
    collect: () => pureProgram('unreachable')
  })
  const ordinaryHandler = Worker.handle(Child, () => pureProgram({ done: true }))
  const workerService = Worker.service('FlowCycleWorker')
  const workerLayer = workerService.layer(() => ({
    handlers: [ordinaryHandler] as const,
    flows: [route] as const,
    concurrency: 2,
    pollIntervalMs: 1,
    flowSweepIntervalMs: 2,
    flowBatchSize: 4
  }))
  const flowToken = FlowStore.for(ParentStore)
  const application = Layer.complete(
    Layer.merge(
      Layer.merge(
        Layer.succeed(ParentStore, ParentStore.of(jobStore)),
        Layer.merge(
          Layer.succeed(ChildStore, ChildStore.of(MemoryJobStore.make())),
          Layer.succeed(flowToken, flowToken.of(flowStore))
        )
      ),
      workerLayer
    )
  )
  const runtime = await Runtime.make(application)
  await runtime.warmup()

  try {
    await waitFor(
      async () => (await unwrap(jobStore.getJob({ jobId: flowId })))?.state === 'failed'
    )
    expect((await unwrap(flowStore.getFlow({ flowId })))?.parent.state).toBe('failed')
    expect((await unwrap(flowStore.getFlow({ flowId })))?.children).toHaveLength(1)
  } finally {
    await runtime.dispose()
  }
})
