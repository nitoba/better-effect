// oxlint-disable typescript/await-thenable -- PGlite's declarations expose synchronous-looking APIs.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- test-only SQL row fixtures.

import { PGlite } from '@electric-sql/pglite'
import { describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import {
  JobScheduleStore,
  JobStore,
  Queue,
  QueueControls,
  makeFlowChildId,
  makeJobId,
  makeLeaseToken,
  makePreparedEnqueue,
  makeQueueName,
  makeWorkerId,
  type ControlledJobStoreContract,
  type FlowChildSpec
} from 'better-effect-mq'
import {
  PostgresClient,
  PostgresFlowStore,
  PostgresJobScheduleStore,
  PostgresJobStore,
  type Pool,
  type PoolClient,
  type QueryResult
} from '../src'

type Database = Awaited<ReturnType<typeof PGlite.create>>

const makePool = async (): Promise<{ readonly database: Database; readonly pool: Pool }> => {
  const database = await PGlite.create('memory://')
  const pool: Pool = {
    connect: async (): Promise<PoolClient> => ({
      query: async <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
        const result =
          values === undefined && !/^\s*(SELECT|WITH)/iu.test(text)
            ? await database.exec(text).then(() => ({ rows: [], affectedRows: 0 }))
            : values === undefined
              ? await database.query(text)
              : await database.query(text, [...values])
        return {
          // SAFETY: the PGlite result rows are the generic row shape requested by this test pool.
          rows: result.rows as readonly Row[],
          rowCount: result.affectedRows ?? result.rows.length
        }
      },
      release: () => undefined
    })
  }
  return { database, pool }
}

const eventTypes = async (database: Database, schema: string): Promise<readonly string[]> => {
  // SAFETY: this fixed query selects the event_type column from the migrated event table.
  const result = (await database.query(
    `SELECT event_type FROM "${schema}".better_effect_mq_job_events ORDER BY cursor`
  )) as { readonly rows: readonly { readonly event_type: string }[] }
  return result.rows.map((row) => row.event_type)
}

const flowChild = (flowId: string): FlowChildSpec => {
  const id = makeFlowChildId({
    parentStoreKey: 'flow-events',
    flowId: makeJobId(flowId).unwrap(),
    childKey: 'child:1'
  }).unwrap()
  return {
    childKey: 'child:1',
    name: 'child',
    version: 1,
    storeKey: 'flow-events',
    childJobId: id,
    request: makePreparedEnqueue({
      protocolVersion: 1,
      identity: { queue: 'flow-child', name: 'child', version: 1 },
      id,
      payload: { child: true },
      metadata: {},
      priority: 0,
      runAt: 0,
      attemptsMax: 1,
      now: 0
    }).unwrap()
  }
}

describe('PostgreSQL extension transition events', () => {
  test('appends Flow and Schedule events only for effective transitions', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_extension_events'
    await PostgresClient.fromPool({ pool, schema }).migrate({ appliedAtMs: 1 })
    const runtime = await Runtime.make(
      Layer.merge(
        PostgresJobStore.layer({ pool, schema, validateSchema: false }),
        PostgresJobScheduleStore.layer({ pool, schema, validateSchema: false })
      )
    )
    try {
      await runtime.run(async () => {
        const schedules = await ServiceRuntime.resolve(JobScheduleStore)
        const record = {
          key: 'daily',
          group: 'events',
          job: { queue: 'scheduled', name: 'daily', version: 1 },
          queue: makeQueueName('scheduled').unwrap(),
          cron: undefined,
          everyMs: 1_000,
          timeZone: 'UTC',
          payload: { value: 1 },
          metadata: {},
          priority: 0,
          attemptsMax: 1,
          backoff: undefined,
          timeoutMs: undefined,
          misfire: { strategy: 'run-once' as const },
          overlap: 'allow' as const,
          paused: false,
          revision: 0,
          nextRunAtMs: 1_000,
          lastScheduledAtMs: undefined,
          lastJobId: undefined,
          createdAtMs: 0,
          updatedAtMs: 0
        }
        await schedules.upsertSchedule(record)
        await schedules.upsertSchedule(record)
        await schedules.pauseSchedule('daily')
        await schedules.pauseSchedule('daily')
        await schedules.resumeSchedule('daily')
        await schedules.tickSchedule({
          key: 'daily',
          expectedRevision: 2,
          expectedRunAtMs: 1_000,
          nowMs: 1_001,
          decision: { occurrences: [1_000], nextRunAtMs: 2_000 }
        })
      })

      expect(await eventTypes(database, schema)).toEqual([
        'schedule-upserted',
        'schedule-paused',
        'schedule-resumed',
        'job-enqueued',
        'schedule-ticked'
      ])
    } finally {
      await runtime.dispose()
      await database.close()
    }
  })

  test('appends Flow fan-out once when the idempotent request is replayed', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_flow_extension_events'
    await PostgresClient.fromPool({ pool, schema }).migrate({ appliedAtMs: 1 })
    const runtime = await Runtime.make(
      PostgresJobStore.layer({ pool, schema, validateSchema: false })
    )
    let flowId: string
    let leaseToken: string
    try {
      await runtime.run(async () => {
        const jobs = await ServiceRuntime.resolve(JobStore)
        const queue = makeQueueName('flow-parent').unwrap()
        const enqueued = await jobs.enqueue({
          job: { queue, name: 'parent', version: 1 },
          payload: { parent: true },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        if (enqueued.isErr()) throw enqueued.error
        flowId = enqueued.value.job.id
        const claimed = await jobs.claim({
          queue,
          accepted: [{ queue, name: 'parent', version: 1 }],
          limit: 1,
          workerId: makeWorkerId('flow-events-worker').unwrap(),
          leaseDurationMs: 100,
          now: 1
        })
        if (claimed.isErr()) throw claimed.error
        leaseToken = claimed.value.jobs[0]!.leaseToken
      })
    } finally {
      await runtime.dispose()
    }

    const flow = await PostgresFlowStore.make({ pool, schema, validateSchema: false })
    try {
      const request = {
        flowId: makeJobId(flowId!).unwrap(),
        flowName: 'parent-flow',
        parentStoreKey: 'flow-events',
        depth: 1,
        leaseToken: makeLeaseToken(leaseToken!).unwrap(),
        failFast: false,
        children: [flowChild(flowId!)],
        now: 2
      }
      const first = await flow.fanOut(request)
      const replay = await flow.fanOut(request)
      expect(first.isOk()).toBe(true)
      expect(replay.isOk() && replay.value.status).toBe('already-applied')
      expect(await eventTypes(database, schema)).toEqual([
        'job-enqueued',
        'job-claimed',
        'flow-fan-out'
      ])
    } finally {
      await flow.dispose()
      await database.close()
    }
  })

  test('keeps base job events and adds effective Controls events', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_controls_extension_events'
    await PostgresClient.fromPool({ pool, schema }).migrate({ appliedAtMs: 1 })
    const runtime = await Runtime.make(
      PostgresJobStore.layer({ pool, schema, validateSchema: false })
    )
    try {
      await runtime.run(async () => {
        const jobs = await ServiceRuntime.resolve(JobStore)
        const queue = Queue.define('controlled-events')
        const registry = QueueControls.registry({
          group: 'events',
          controls: [QueueControls.define(queue, { globalConcurrency: 1 })]
        })
        // SAFETY: PostgresJobStore exposes the controlled extension implemented by this adapter.
        const controlled = jobs as typeof jobs & ControlledJobStoreContract
        const reconciled = await controlled.reconcile(registry)
        if (reconciled.isErr()) throw reconciled.error
        const unchanged = await controlled.reconcile(registry)
        if (unchanged.isErr()) throw unchanged.error
        const enqueued = await jobs.enqueue({
          job: { queue: queue.queue, name: 'work', version: 1 },
          payload: {},
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        if (enqueued.isErr()) throw enqueued.error
        const claimed = await controlled.claimControlled({
          queue: makeQueueName(queue.queue).unwrap(),
          accepted: [{ queue: queue.queue, name: 'work', version: 1 }],
          limit: 1,
          workerId: makeWorkerId('controls-events-worker').unwrap(),
          leaseDurationMs: 100,
          now: 1,
          controlsRevision: reconciled.value.records[0]!.revision
        })
        if (claimed.isErr()) throw claimed.error
        const active = claimed.value.jobs[0]!
        const released = await controlled.releaseControlled({
          jobId: active.id,
          leaseToken: active.leaseToken,
          now: 2,
          controlsRevision: reconciled.value.records[0]!.revision
        })
        if (released.isErr()) throw released.error
      })

      expect(await eventTypes(database, schema)).toEqual([
        'controls-reconciled',
        'job-enqueued',
        'job-claimed',
        'controls-claimed',
        'job-released',
        'controls-released'
      ])
    } finally {
      await runtime.dispose()
      await database.close()
    }
  })

  test('rolls back a schedule transition when its event append fails', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_extension_atomicity'
    await PostgresClient.fromPool({ pool, schema }).migrate({ appliedAtMs: 1 })
    let failEventAppend = true
    const failingPool: Pool = {
      connect: async () => {
        const connection = await pool.connect()
        return {
          query: async <Row>(text: string, values?: readonly unknown[]) => {
            if (failEventAppend && /INSERT INTO .*better_effect_mq_job_events/iu.test(text)) {
              throw new Error('injected event append failure')
            }
            return connection.query<Row>(text, values)
          },
          release: (error?: Error) => connection.release(error)
        }
      }
    }
    const runtime = await Runtime.make(
      Layer.merge(
        PostgresJobStore.layer({ pool: failingPool, schema, validateSchema: false }),
        PostgresJobScheduleStore.layer({ pool: failingPool, schema, validateSchema: false })
      )
    )
    try {
      const result = await runtime.run(async () => {
        const schedules = await ServiceRuntime.resolve(JobScheduleStore)
        return schedules.upsertSchedule({
          key: 'atomic',
          group: 'events',
          job: { queue: 'scheduled', name: 'atomic', version: 1 },
          queue: makeQueueName('scheduled').unwrap(),
          cron: undefined,
          everyMs: 1_000,
          timeZone: 'UTC',
          payload: {},
          metadata: {},
          priority: 0,
          attemptsMax: 1,
          backoff: undefined,
          timeoutMs: undefined,
          misfire: { strategy: 'run-once' as const },
          overlap: 'allow' as const,
          paused: false,
          revision: 0,
          nextRunAtMs: 1_000,
          lastScheduledAtMs: undefined,
          lastJobId: undefined,
          createdAtMs: 0,
          updatedAtMs: 0
        })
      })
      expect(result.isErr()).toBe(true)
      failEventAppend = false
      // SAFETY: this fixed query selects one aggregate count from the migrated schedule table.
      const row = (await database.query(
        `SELECT count(*)::text AS count FROM "${schema}".better_effect_mq_schedules`
      )) as { readonly rows: readonly { readonly count: string }[] }
      expect(row.rows[0]?.count).toBe('0')
    } finally {
      await runtime.dispose()
      await database.close()
    }
  })
})
