import {
  Codec,
  JobId,
  JobContext,
  JobRegistry,
  JobStore,
  MemoryJobStore,
  Queue,
  Worker,
  protocolVersion
} from 'better-effect-mq'
import { Effect, Layer, Runtime } from 'better-effect'
import { TestRuntime } from 'better-effect/testing'
import { ClockLive, ClockTest, IdGeneratorTest } from 'better-effect/standard-services'
import { Result } from 'better-result'
import * as core from 'better-effect-mq'
import * as testing from 'better-effect-mq/testing'
import { TestJobStore } from 'better-effect-mq/testing'
import packageJson from 'better-effect-mq/package.json' with { type: 'json' }

if (Object.keys(core).length === 0 || protocolVersion !== 1) {
  throw new Error('the better-effect-mq protocol entrypoint did not resolve')
}

if (JobId.make === undefined) {
  throw new Error('the better-effect-mq protocol brand constructor did not resolve')
}

const decoded = Codec.string.decode('external')
if (decoded.status !== 'ok' || decoded.value !== 'external') {
  throw new Error('the better-effect-mq codec did not resolve')
}

const queue = Queue.define('external')
const job = queue.job('smoke', { version: 1, payload: Codec.string })
const workerPayload = Codec.json()
const workerJob = queue.job('worker', {
  version: 1,
  payload: workerPayload,
  result: Codec.void
})
const vectorQueue = Queue.define('application-tests')
const vectorJob = vectorQueue.job('send', {
  version: 1,
  payload: Codec.json(),
  idempotencyKey: (payload) => payload.id
})
const registry = JobRegistry.make([job])
if (registry.lookup(job.identity).status !== 'ok') {
  throw new Error('the better-effect-mq job registry did not resolve')
}

const store = MemoryJobStore.make()
const testStore = TestJobStore.make({
  clock: new ClockTest(1_700_000_000_000),
  ids: IdGeneratorTest.from((index) => `test-${index}`)
})
const testRuntime = await TestRuntime.make(testStore.layer, {
  clock: testStore.clock,
  idGenerator: testStore.idGenerator
})
const testEnqueued = testStore.store.enqueue({
  id: JobId.make('testing-job').unwrap(),
  job: workerJob.identity,
  payload: { value: 'testing' },
  runAt: 1_700_000_000_000,
  attemptsMax: 1,
  now: 1_700_000_000_000
})
if (testEnqueued.status !== 'ok' || (await testStore.enqueued(workerJob)).length !== 1) {
  throw new Error('the packed TestJobStore did not expose the public store harness')
}
const workerRuntime = await Runtime.make(
  Layer.merge(Layer.succeed(JobStore, JobStore.of(store)), ClockLive)
)
const now = 1_700_000_000_000
const jobs = []
for (let index = 0; index < 8; index += 1) {
  const enqueued = store.enqueue({
    job: workerJob.identity,
    payload: { value: index },
    runAt: now,
    attemptsMax: 1,
    metadata: { jobIndex: String(index) },
    now
  })
  if (enqueued.status !== 'ok') {
    throw enqueued.error
  }
  jobs.push(enqueued.value.job)
}

let active = 0
let maximum = 0
let entered = 0
const contexts = []
let releaseGate
const gate = new Promise((resolve) => {
  releaseGate = resolve
})
let resolveOverlap
const overlap = new Promise((resolve) => {
  resolveOverlap = resolve
})
const workerHandler = Worker.handle(workerJob, (input) =>
  Effect.fn(async function* () {
    const context = yield* JobContext
    active += 1
    maximum = Math.max(maximum, active)
    contexts.push({ context, input })
    entered += 1
    if (entered === 2) {
      resolveOverlap()
    }
    if (entered <= 2) {
      await gate
    }
    active -= 1
    return Result.ok(undefined)
  })
)
const worker = await Worker.start(workerRuntime, {
  handlers: [workerHandler],
  concurrency: 2,
  pollIntervalMs: 1
})
let stopWasIdempotent = false

try {
  const vectorResult = await workerRuntime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* vectorJob.enqueue({ id: 'one' }))
    })
  )
  if (
    !Result.isOk(vectorResult) ||
    vectorResult.value !==
      'idem-v1-9ce225892cc3f574919f45ec4322f13e58c529385f8d78cece9ec7068d78b3dd'
  ) {
    throw new Error('the packed idempotency vector changed across runtimes')
  }

  if (worker.state !== 'running') {
    throw new Error('the packed Worker did not start')
  }

  await overlap
  if (contexts.length !== 2 || contexts[0].context === contexts[1].context) {
    throw new Error('the packed Worker did not overlap isolated JobContexts')
  }
  if (new Set(contexts.map(({ context }) => context.jobId)).size !== 2) {
    throw new Error('the packed Worker reused a JobContext job id')
  }

  const normalAbort = new AbortController()
  const normalWait = worker.awaitIdle({ signal: normalAbort.signal, timeoutMs: 1_000 })
  normalAbort.abort(new Error('normal signal abort'))
  try {
    await normalWait
    throw new Error('the packed Worker did not reject an aborted native signal')
  } catch (cause) {
    if (cause?.name !== 'WorkerAwaitIdleError' || cause.reason !== 'aborted') {
      throw cause
    }
  }

  const unhandledRejections = []
  const onUnhandledRejection = (reason) => {
    unhandledRejections.push(reason)
  }
  process.on('unhandledRejection', onUnhandledRejection)
  let addCalls = 0
  let removeCalls = 0
  const rejectingSignal = {
    aborted: false,
    addEventListener() {
      addCalls += 1
      return Promise.reject(new Error('add listener rejected'))
    },
    removeEventListener() {
      removeCalls += 1
      return Promise.reject(new Error('remove listener rejected'))
    }
  }

  try {
    let failure
    try {
      await worker.awaitIdle({ signal: rejectingSignal, timeoutMs: 1_000 })
    } catch (cause) {
      failure = cause
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
    if (failure?.name !== 'WorkerAwaitIdleError' || failure.reason !== 'invalid-signal') {
      throw new Error('the packed Worker did not reject a non-void signal listener result')
    }
    if (addCalls !== 1 || removeCalls !== 1) {
      throw new Error('the packed Worker did not synchronously clean its malformed signal waiter')
    }
    if (unhandledRejections.length !== 0) {
      throw new Error(
        `the packed Worker leaked ${unhandledRejections.length} unhandled signal rejection(s)`
      )
    }
  } finally {
    process.off('unhandledRejection', onUnhandledRejection)
  }

  releaseGate()
  await worker.awaitIdle()
  if (worker.activeCount !== 0) {
    throw new Error('the packed Worker remained active after awaitIdle')
  }
  if (maximum > 2) {
    throw new Error(`the packed Worker exceeded concurrency: ${maximum}`)
  }
  if (contexts.length !== jobs.length) {
    throw new Error(`the packed Worker processed ${contexts.length} of ${jobs.length} jobs`)
  }
  if (new Set(contexts.map(({ context }) => context.jobId)).size !== jobs.length) {
    throw new Error('the packed Worker did not isolate every JobContext')
  }
  for (const { context, input } of contexts) {
    if (context.metadata.jobIndex !== String(input.value)) {
      throw new Error('the packed Worker mixed JobContext metadata between attempts')
    }
  }
  const counts = store.counts()
  if (counts.status !== 'ok' || counts.value.completed !== jobs.length) {
    throw new Error('the packed Worker did not complete every enqueued job')
  }
} finally {
  releaseGate()
  const firstStop = worker.stop()
  const secondStop = worker.stop()
  stopWasIdempotent = firstStop === secondStop
  await firstStop
  await worker[Symbol.asyncDispose]()
  await workerRuntime.dispose()
  await testRuntime.dispose()
}

if (!stopWasIdempotent) {
  throw new Error('the packed Worker stop handle was not idempotent')
}
if (worker.state !== 'stopped' || worker.activeCount !== 0) {
  throw new Error('the packed Worker did not clean up its handle')
}

const smokeContract = {
  descriptor: Object.freeze({
    protocolVersion: 1,
    adapter: 'external-smoke',
    adapterVersion: '0.1.0',
    layoutVersion: 1,
    capabilities: Object.freeze({
      queueFilteredNotifications: false,
      nativeBatchEnqueue: false,
      nativeBatchClaim: false,
      metadataIndex: 'none',
      transactionalEnqueue: false,
      durableChangeFeed: false,
      globalConcurrency: false,
      rateLimiting: false
    })
  }),
  list: () => Result.ok({ jobs: [], nextCursor: undefined })
}
const suite = testing.jobStoreContract({
  makeRuntime: async () => {
    const runtime = await Runtime.make(Layer.succeed(JobStore, JobStore.of(smokeContract)))
    return {
      run: (program) => runtime.run(program),
      dispose: () => runtime.dispose()
    }
  }
})
const emptyList = suite.find((scenario) => scenario.id === 'list-empty')
if (emptyList === undefined) {
  throw new Error('the better-effect-mq testing entrypoint did not expose stable scenarios')
}
await emptyList.run()
if (!suite.report().passed.includes('list-empty')) {
  throw new Error('the better-effect-mq testing scenario did not execute')
}

if (packageJson.name !== 'better-effect-mq') {
  throw new Error('the package.json export did not resolve from the tarball')
}

console.log('better-effect-mq external consumer smoke test passed')
