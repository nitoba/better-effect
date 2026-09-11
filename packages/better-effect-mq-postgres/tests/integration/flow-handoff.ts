import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Effect, Layer, Runtime, ServiceRuntime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'
import {
  Codec,
  Flow,
  FlowStore,
  JobContext,
  JobStore,
  LeaseLostError,
  Queue,
  Worker,
  makeFlowChildId,
  makePreparedEnqueue,
  makeQueueName,
  makeWorkerId
} from 'better-effect-mq'
import { Pool } from 'pg'
import type { WorkerErrorHandler } from 'better-effect-mq'
import { PostgresFlowStore, PostgresJobStore, PostgresMigrator } from '../../src/index'

const connectionString = process.env.MQ_TEST_DATABASE_URL
assert.ok(connectionString, 'MQ_TEST_DATABASE_URL must point to a dedicated test database')
const deadline = setTimeout(() => {
  console.error('FAIL: flow regression exceeded its bounded execution/shutdown deadline')
  process.exit(1)
}, 20_000)
deadline.unref()

function valueOf<Value, Failure>(result: Result<Value, Failure>): Value {
  if (Result.isError(result)) throw result.error
  return result.value
}

async function verifyLeases(pool: Pool, schema: string): Promise<void> {
  await using runtime = await Runtime.make(PostgresJobStore.layer({ pool, schema }))
  const jobs = await runtime.run(() => ServiceRuntime.resolve(JobStore))
  const flows = await PostgresFlowStore.make({ pool, schema })
  try {
    const now = Date.now()
    const queue = valueOf(makeQueueName('lease-regression'))
    const identity = { queue, name: 'parent', version: 1 }
    for (let index = 0; index < 2; index += 1) {
      valueOf(
        await jobs.enqueue({ job: identity, payload: { index }, runAt: now, now, attemptsMax: 2 })
      )
    }
    const claimed = valueOf(
      await jobs.claim({
        queue,
        accepted: [identity],
        workerId: valueOf(makeWorkerId('lease-regression')),
        limit: 2,
        leaseDurationMs: 60_000,
        now: now + 1
      })
    )
    const [parent, ordinary] = claimed.jobs
    assert.ok(parent && ordinary)
    const childId = valueOf(
      makeFlowChildId({ parentStoreKey: JobStore.serviceTag, flowId: parent.id, childKey: 'one' })
    )
    const request = valueOf(
      makePreparedEnqueue({
        protocolVersion: 1,
        identity: { queue: 'lease-regression', name: 'child', version: 1 },
        id: childId,
        payload: { ok: true },
        metadata: {},
        priority: 0,
        runAt: now + 2,
        now: now + 2,
        attemptsMax: 1
      })
    )
    valueOf(
      await flows.fanOut({
        flowId: parent.id,
        flowName: 'lease-regression',
        parentStoreKey: JobStore.serviceTag,
        leaseToken: parent.leaseToken,
        depth: 1,
        failFast: false,
        now: now + 2,
        children: [
          {
            childKey: 'one',
            name: 'child',
            version: 1,
            storeKey: JobStore.serviceTag,
            childJobId: childId,
            request
          }
        ]
      })
    )
    const heartbeat = valueOf(
      await jobs.heartbeat({
        leases: [parent, ordinary].map((job) => ({ jobId: job.id, leaseToken: job.leaseToken })),
        leaseDurationMs: 60_000,
        now: now + 3
      })
    )
    assert.equal(heartbeat.lost.length, 1)
    assert.equal(heartbeat.lost[0]?.jobId, parent.id)
    assert.equal(heartbeat.renewed.length, 1)
    const renewedOrdinary = valueOf(await jobs.getJob({ jobId: ordinary.id }))
    assert.equal(renewedOrdinary?.leaseToken, ordinary.leaseToken)
    assert.equal(renewedOrdinary?.leaseExpiresAt, now + 3 + 60_000)
    const released = await jobs.release({
      jobId: parent.id,
      leaseToken: parent.leaseToken,
      now: now + 4
    })
    assert.ok(Result.isError(released) && LeaseLostError.is(released.error))
    const settled = await jobs.settle({
      jobId: parent.id,
      leaseToken: parent.leaseToken,
      outcome: { type: 'complete' },
      now: now + 4
    })
    assert.ok(Result.isError(settled) && LeaseLostError.is(settled.error))
    const snapshot = valueOf(await flows.getFlow({ flowId: parent.id }))
    assert.equal(snapshot?.parent.state, 'waiting-children')
    assert.equal(snapshot.parent.flow.pending, 1)
    console.log(
      'PASS: mixed heartbeat preserves ordinary lease; stale release/settle cannot mutate suspended parent'
    )
  } finally {
    await flows.dispose()
  }
}

async function verifyWorker(pool: Pool, schema: string): Promise<void> {
  const queue = Queue.define('handoff-regression')
  const parent = queue.job('parent', {
    version: 1,
    payload: Codec.json<{ readonly empty: boolean }>(),
    result: Codec.json<{ readonly completed: number; readonly failed: number }>()
  })
  const child = queue.job('child', {
    version: 1,
    payload: Codec.json<{ readonly fail: boolean }>(),
    result: Codec.json<{ readonly ok: boolean }>(),
    failure: Codec.json<{ readonly code: string }>()
  })
  const definition = Flow.define('handoff-regression', {
    parent,
    children: [child] as const,
    onChildFailure: 'continue'
  })
  const phases: Array<{
    readonly id: string
    readonly phase: string
    readonly delivery: number
    readonly lease: string
  }> = []
  const workerErrors: unknown[] = []
  const captureError: WorkerErrorHandler = (error) => {
    workerErrors.push(error)
  }
  const handler = Flow.handle(definition, {
    fanOut: (payload) =>
      Effect.fn(async function* () {
        const context = yield* JobContext
        const state = await pool.query<{
          state: string
          lease_token: string
          delivery_count: string
        }>(
          `SELECT state, lease_token, delivery_count FROM "${schema}".better_effect_mq_jobs WHERE id=$1`,
          [context.jobId]
        )
        const record = state.rows[0]
        assert.ok(record && record.state === 'active' && record.lease_token)
        phases.push({
          id: context.jobId,
          phase: 'fanOut',
          delivery: Number(record.delivery_count),
          lease: record.lease_token
        })
        return Result.ok([
          Flow.children(
            child,
            payload.empty
              ? []
              : [
                  { key: 'bad', payload: { fail: true } },
                  { key: 'good', payload: { fail: false } }
                ]
          )
        ] as const)
      }),
    collect: (_payload, results) =>
      Effect.fn(async function* () {
        const context = yield* JobContext
        const state = await pool.query<{
          state: string
          lease_token: string
          delivery_count: string
        }>(
          `SELECT state, lease_token, delivery_count FROM "${schema}".better_effect_mq_jobs WHERE id=$1`,
          [context.jobId]
        )
        const record = state.rows[0]
        assert.ok(record && record.state === 'active' && record.lease_token)
        phases.push({
          id: context.jobId,
          phase: 'collect',
          delivery: Number(record.delivery_count),
          lease: record.lease_token
        })
        return Result.ok({ completed: results.counts.completed, failed: results.counts.failed })
      })
  })
  const token = Worker.service('FlowHandoffRegression')
  const flows = await PostgresFlowStore.make({ pool, schema })
  const live = Layer.complete(
    Layer.merge(
      PostgresJobStore.layer({ pool, schema }),
      Layer.succeed(FlowStore, FlowStore.of(flows)),
      ClockLive,
      token.layer(() => ({
        handlers: [
          Worker.handle(child, (payload) =>
            Effect.fn(async function* () {
              yield* JobContext
              return payload.fail ? Result.err({ code: 'child-failed' }) : Result.ok({ ok: true })
            })
          )
        ] as const,
        flows: [handler] as const,
        concurrency: 1,
        pollIntervalMs: 5,
        flowSweepIntervalMs: 20,
        leaseDurationMs: 2_000,
        heartbeatIntervalMs: 100,
        onError: captureError
      }))
    )
  )
  const runtime = await Runtime.make(live)
  try {
    valueOf(
      await runtime.run(() =>
        Effect.gen(async function* () {
          return Result.ok(yield* token)
        })
      )
    )
    for (const empty of [false, true]) {
      const id = valueOf(
        await runtime.run(() =>
          Effect.gen(async function* () {
            return Result.ok(yield* parent.enqueue({ empty }))
          })
        )
      )
      const end = Date.now() + 5_000
      let completed = false
      while (Date.now() < end) {
        const rows = await pool.query<{
          state: string
          result: { completed: number; failed: number }
        }>(`SELECT state, result FROM "${schema}".better_effect_mq_jobs WHERE id=$1`, [id])
        if (rows.rows[0]?.state === 'completed') {
          assert.deepEqual(rows.rows[0].result, { completed: empty ? 0 : 1, failed: empty ? 0 : 1 })
          completed = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.ok(
        completed,
        `Parent must finish under concurrency 1; errors=${workerErrors.slice(0, 5).map(String).join('; ')}`
      )
      const executed = phases.filter((phase) => phase.id === id)
      assert.equal(executed.length, 2)
      assert.equal(executed[0]?.phase, 'fanOut')
      assert.equal(executed[1]?.phase, 'collect')
      assert.equal(executed[1]?.delivery, 2)
      assert.notEqual(executed[0]?.lease, executed[1]?.lease)
    }
    assert.deepEqual(workerErrors, [])
    console.log(
      'PASS: concurrency-one mixed-failure and empty flows collect exactly once under a new active lease'
    )
  } catch (error) {
    console.error('WORKER HANDOFF REGRESSION', error)
    console.error(
      'DURABLE HANDOFF STATE',
      (
        await pool.query(
          `SELECT name,state,delivery_count,flow FROM "${schema}".better_effect_mq_jobs`
        )
      ).rows
    )
    throw error
  } finally {
    await runtime.dispose()
    await flows.dispose()
  }
}

const schema = `mq_handoff_${randomUUID().replaceAll('-', '')}`
const pool = new Pool({ connectionString, max: 8 })
try {
  await PostgresMigrator.run(pool, { schema })
  if (process.argv.includes('--worker')) await verifyWorker(pool, schema)
  else await verifyLeases(pool, schema)
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await pool.end()
  clearTimeout(deadline)
}
