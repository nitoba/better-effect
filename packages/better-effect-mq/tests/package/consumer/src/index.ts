import { Effect, Runtime, Service } from 'better-effect'
import type { AnyService } from 'better-effect'
import { Result } from 'better-result'

import {
  Codec,
  Job,
  JobContext,
  JobId,
  JobRegistry,
  JobStore,
  Queue,
  Worker,
  bindJob,
  protocolVersion
} from 'better-effect-mq'
import * as core from 'better-effect-mq'
import * as testing from 'better-effect-mq/testing'
import packageJson from 'better-effect-mq/package.json' with { type: 'json' }
import type { JobRecord, JsonValue } from 'better-effect-mq'
import type { JobStoreContractRuntime } from 'better-effect-mq/testing'

const packageName: string = packageJson.name
const version: 1 = protocolVersion
const id = JobId.make('external-job')
const payload: JsonValue = { source: 'external' }
const recordState: JobRecord['state'] = 'waiting'
const codec = Codec.json<{ readonly source: string }>()
const encoded = codec.encode({ source: 'external' })
const queue = Queue.define('external')
const job = queue.job('smoke', { version: 1, payload: codec })
class WorkerRoot extends Service<WorkerRoot>()('ExternalWorkerRoot') {}
const workerJob = queue.job('worker', {
  version: 1,
  payload: codec,
  result: Codec.void
})
const workerHandler = Worker.handle(workerJob, (input) =>
  Effect.fn(async function* () {
    const root = yield* WorkerRoot
    const context = yield* JobContext
    void input
    void root
    void context
    return Result.ok(undefined)
  })
)
declare const workerRuntime: Runtime<WorkerRoot | AnyService>
const workerStarted = Worker.start(workerRuntime, { handlers: [workerHandler] as const })
const registry = JobRegistry.make([job] as const)
const found = registry.lookup(job.identity)
const namedStore = JobStore.named('external')
const bound = bindJob(job, namedStore)
const boundAgain = Job.bind(job, namedStore)
const runtime: JobStoreContractRuntime<InstanceType<typeof JobStore>> = {
  run: async <Value>(program: () => Value | PromiseLike<Value>): Promise<Awaited<Value>> =>
    await program(),
  dispose: async () => {}
}
const suite = testing.jobStoreContract({ makeRuntime: async () => runtime })
const scenario = suite[0]
const report = suite.report()

void core
void testing
void packageName
void version
void id
void payload
void recordState
void encoded
void found
void workerStarted
void namedStore
void bound
void boundAgain
void scenario
void report
