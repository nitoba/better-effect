import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Effect, Layer, Runtime, Scope } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, Flow, FlowStore, JobContext, Queue, Worker } from 'better-effect-mq'
import { Result } from 'better-result'
import { Pool } from 'pg'
import { PostgresFlowStore, PostgresJobStore, PostgresMigrator } from '../../src/index'
import type { WorkerErrorHandler } from 'better-effect-mq'

function valueOf<Value, Failure>(result: Result<Value, Failure>): Value {
  if (Result.isError(result)) throw result.error
  return result.value
}

const connectionString = process.env.MQ_TEST_DATABASE_URL
assert.ok(connectionString, 'MQ_TEST_DATABASE_URL must point to a dedicated test database')
const deadline = setTimeout(() => {
  console.error('FAIL: handoff admission regression exceeded its execution/cleanup deadline')
  process.exit(1)
}, 15_000)
deadline.unref()
const schema = `mq_admission_${randomUUID().replaceAll('-', '')}`
const pool = new Pool({ connectionString, max: 8 })
try {
  await PostgresMigrator.run(pool, { schema })
  const nativeFlows = await PostgresFlowStore.make({ pool, schema })
  const closing = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const errors: unknown[] = []
  const captureError: WorkerErrorHandler = (error) => {
    errors.push(error)
  }
  const queue = Queue.define('handoff-admission')
  const parent = queue.job('parent', { version: 1, payload: Codec.string, result: Codec.string })
  const child = queue.job('child', { version: 1, payload: Codec.string, result: Codec.string })
  const probe = Queue.define('handoff-admission-probe').job('probe', {
    version: 1,
    payload: Codec.string,
    result: Codec.string
  })
  const definition = Flow.define('handoff-admission', {
    parent,
    children: [child] as const,
    onChildFailure: 'continue'
  })
  const route = Flow.handle(definition, {
    fanOut: () =>
      Effect.fn(async function* () {
        yield* JobContext
        return Result.ok([Flow.children(child, [])] as const)
      }),
    collect: (payload) =>
      Effect.fn(async function* () {
        yield* JobContext
        return Result.ok(payload)
      })
  })
  const token = Worker.service('HandoffAdmissionRegression')
  const live = Layer.complete(
    Layer.merge(
      PostgresJobStore.layer({ pool, schema }),
      Layer.succeed(
        FlowStore,
        FlowStore.of({
          descriptor: nativeFlows.descriptor,
          async fanOut(request) {
            // Keep the real transaction unchanged. Gate only the enclosing Scope's
            // finalizer so the released lease and live execution can be observed.
            const result = await nativeFlows.fanOut(request)
            if (Result.isOk(result)) {
              Scope.current().addFinalizer(async () => {
                closing.resolve()
                await resume.promise
              })
            }
            return result
          },
          getFlow: (request) => nativeFlows.getFlow(request),
          recordChildResults: (request) => nativeFlows.recordChildResults(request),
          reconcile: (request) => nativeFlows.reconcile(request),
          cancel: (request) => nativeFlows.cancel(request),
          markCascaded: (request) => nativeFlows.markCascaded(request),
          appendChildReport: (request) => nativeFlows.appendChildReport(request),
          peekOutbox: (request) => nativeFlows.peekOutbox(request),
          ackOutbox: (request) => nativeFlows.ackOutbox(request)
        })
      ),
      ClockLive,
      token.layer(() => ({
        handlers: [
          Worker.handle(child, (payload) =>
            Effect.fn(async function* () {
              yield* JobContext
              return Result.ok(payload)
            })
          ),
          Worker.handle(probe, (payload) =>
            Effect.fn(async function* () {
              yield* JobContext
              await closing.promise
              return Result.ok(payload)
            })
          )
        ] as const,
        flows: [route] as const,
        concurrency: 2,
        queueConcurrency: { 'handoff-admission': 1 },
        pollIntervalMs: 2,
        flowSweepIntervalMs: 20,
        leaseDurationMs: 2_000,
        heartbeatIntervalMs: 100,
        onError: captureError
      }))
    )
  )
  const runtime = await Runtime.make(live)
  try {
    await runtime.warmup()
    const id = valueOf(
      await runtime.run(() =>
        Effect.gen(async function* () {
          const id = yield* parent.enqueue('done')
          yield* probe.enqueue('wake another queue')
          return Result.ok(id)
        })
      )
    )
    await closing.promise
    // The independent probe completes and wakes slot waiters while the flow's
    // Scope remains held. Inspect actual persisted deliveries, not internal maps.
    const observeUntil = Date.now() + 150
    let heldDelivery = 0
    while (Date.now() < observeUntil) {
      const held = (
        await pool.query<{ delivery_count: string }>(
          `SELECT delivery_count FROM "${schema}".better_effect_mq_jobs WHERE id=$1`,
          [id]
        )
      ).rows[0]
      heldDelivery = Number(held?.delivery_count)
      if (heldDelivery > 1) break
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(
      heldDelivery,
      1,
      'A handed-off execution must retain capacity until its Scope has closed'
    )
    resume.resolve()
    const until = Date.now() + 5_000
    let completed = false
    while (Date.now() < until) {
      const row = (
        await pool.query<{ state: string; delivery_count: string }>(
          `SELECT state, delivery_count FROM "${schema}".better_effect_mq_jobs WHERE id=$1`,
          [id]
        )
      ).rows[0]
      if (row?.state === 'completed') {
        assert.equal(Number(row.delivery_count), 2)
        completed = true
        break
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(completed, 'Collect must complete once cleanup releases capacity')
  } finally {
    resume.resolve()
    closing.resolve()
    await runtime.dispose()
    await nativeFlows.dispose()
  }
  assert.deepEqual(errors, [])
  console.log(
    'PASS: handoff retains queue capacity through Scope cleanup; Collect uses the next delivery'
  )
} finally {
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await pool.end()
    clearTimeout(deadline)
  }
}
