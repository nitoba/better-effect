import {
  Codec,
  JobId,
  JobRegistry,
  JobStore,
  MemoryJobStore,
  Queue,
  Worker,
  protocolVersion
} from 'better-effect-mq'
import { Effect, Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'
import * as core from 'better-effect-mq'
import * as testing from 'better-effect-mq/testing'
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
const workerJob = queue.job('worker', { version: 1, payload: Codec.string, result: Codec.void })
const registry = JobRegistry.make([job])
if (registry.lookup(job.identity).status !== 'ok') {
  throw new Error('the better-effect-mq job registry did not resolve')
}

const workerRuntime = await Runtime.make(MemoryJobStore.layer)
const worker = await Worker.start(workerRuntime, {
  handlers: [
    Worker.handle(workerJob, () =>
      // oxlint-disable-next-line require-yield -- the generator shape is part of the Effect API contract.
      Effect.fn(async function* () {
        return Result.ok(undefined)
      })
    )
  ],
  pollIntervalMs: 1
})
await worker.awaitIdle()
await worker.stop()
await workerRuntime.dispose()

const smokeContract = {
  protocolVersion: 1,
  capabilities: {
    notifications: false,
    queueFilteredNotifications: false,
    batchClaim: false,
    transactionalEnqueue: false,
    changeFeed: false
  },
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
