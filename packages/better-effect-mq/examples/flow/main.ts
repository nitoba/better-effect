import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import {
  Codec,
  Flow,
  FlowStore,
  JobStore,
  MemoryFlowStore,
  MemoryJobStore,
  Queue,
  Worker
} from 'better-effect-mq'

const Reports = Queue.define('examples.reports')

const RunReport = Reports.job('run-report', {
  version: 1,
  payload: Codec.json<{ readonly reportId: string }>(),
  result: Codec.json<{ readonly completed: number; readonly failed: number }>(),
  failure: Codec.json<{ readonly code: string }>()
})

const BuildReport = Reports.job('build-report', {
  version: 1,
  payload: Codec.json<{ readonly reportId: string }>(),
  result: Codec.json<{ readonly reportId: string; readonly rows: number }>(),
  failure: Codec.json<{ readonly code: string }>()
})

const NotifyReport = Reports.job('notify-report', {
  version: 1,
  payload: Codec.json<{ readonly reportId: string }>(),
  result: Codec.string,
  failure: Codec.json<{ readonly code: string }>()
})

const ReportFlow = Flow.define('report-flow', {
  parent: RunReport,
  children: [BuildReport, NotifyReport] as const,
  onChildFailure: 'continue'
})

const ReportFlowHandler = Flow.handle(ReportFlow, {
  fanOut: (payload) =>
    // oxlint-disable-next-line require-yield -- this phase has no contextual requirements.
    Effect.fn(async function* () {
      return Result.ok([
        Flow.children(BuildReport, [{ key: 'build', payload: { reportId: payload.reportId } }]),
        Flow.children(NotifyReport, [{ key: 'notify', payload: { reportId: payload.reportId } }])
      ] as const)
    }),
  collect: (_payload, results) =>
    // oxlint-disable-next-line require-yield -- this phase has no contextual requirements.
    Effect.fn(async function* () {
      return Result.ok({
        completed: results.counts.completed,
        failed: results.counts.failed
      })
    })
})

const handlers = [
  Worker.handle(BuildReport, (payload) =>
    // oxlint-disable-next-line require-yield -- this handler has no contextual requirements.
    Effect.fn(async function* () {
      return Result.ok({ reportId: payload.reportId, rows: 42 })
    })
  ),
  Worker.handle(NotifyReport, (payload) =>
    // oxlint-disable-next-line require-yield -- this handler has no contextual requirements.
    Effect.fn(async function* () {
      return Result.ok(`notified:${payload.reportId}`)
    })
  )
] as const

const ReportsWorker = Worker.service('@examples/ReportsWorker')
const ReportsWorkerLive = ReportsWorker.layer(() => ({
  handlers,
  flows: [ReportFlowHandler] as const,
  concurrency: 2,
  pollIntervalMs: 1,
  flowSweepIntervalMs: 2,
  flowBatchSize: 16
}))

// A durable adapter provides these same two Service tokens with its own Layer.
// Memory stores keep this example self-contained and process-local.
const jobs = MemoryJobStore.make()
const flows = MemoryFlowStore.make()
const AppLive = Layer.complete(
  Layer.merge(
    Layer.succeed(JobStore, JobStore.of(jobs)),
    Layer.merge(
      Layer.succeed(FlowStore, FlowStore.of(flows)),
      Layer.merge(ClockLive, ReportsWorkerLive)
    )
  )
)

const runtime = await Runtime.make(AppLive)

try {
  const worker = await runtime.run(() =>
    Effect.gen(async function* () {
      return Result.ok(yield* ReportsWorker)
    })
  )
  if (Result.isError(worker)) throw worker.error

  const execution = await runtime.run(() =>
    Effect.gen(async function* () {
      const jobId = yield* RunReport.enqueue({ reportId: 'daily-2026-01-01' })
      const result = yield* RunReport.awaitResult(jobId)
      return Result.ok({ jobId, result })
    })
  )
  if (Result.isError(execution)) throw execution.error

  console.log(execution.value)
  await worker.value.awaitIdle({ timeoutMs: 2_000 })
} finally {
  await runtime.dispose()
}
