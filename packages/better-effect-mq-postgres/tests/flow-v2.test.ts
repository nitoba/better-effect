// oxlint-disable typescript/await-thenable -- PGlite's declarations expose synchronous-looking APIs.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- database rows are test-only protocol fixtures.

import { PGlite } from '@electric-sql/pglite'
import { describe, expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import { flowStoreContract } from 'better-effect-mq/testing'
import {
  JobStore,
  makeFlowChildId,
  makeJobId,
  makeLeaseToken,
  makeSerializedJobFailure,
  makeQueueName,
  makeWorkerId,
  makePreparedEnqueue,
  type FlowChildSpec
} from 'better-effect-mq'
import {
  PostgresClient,
  PostgresFlowProtocolMismatchError,
  PostgresFlowStore,
  PostgresJobStore,
  loadPostgresMigrations,
  migrationSql,
  type Pool,
  type PoolClient,
  type QueryResult
} from '../src/index'

type Database = Awaited<ReturnType<typeof PGlite.create>>

const makePool = async (): Promise<{ readonly database: Database; readonly pool: Pool }> => {
  const database = await PGlite.create('memory://')
  const pool: Pool = {
    connect: async (): Promise<PoolClient> => ({
      query: async <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
        if (values === undefined && !/^\s*(SELECT|WITH)/iu.test(text)) {
          await database.exec(text)
          return { rows: [], rowCount: 0 }
        }
        const result =
          values === undefined
            ? await database.query(text)
            : await database.query(text, [...values])
        return {
          // SAFETY: PGlite has returned the rows for this typed query result.
          rows: result.rows as readonly Row[],
          rowCount: result.affectedRows ?? result.rows.length
        }
      },
      release: () => undefined
    })
  }
  return { database, pool }
}

const childSpec = (flowId: string, childKey: string, storeKey = 'emails'): FlowChildSpec => {
  const id = makeFlowChildId({
    parentStoreKey: storeKey,
    flowId: makeJobId(flowId).unwrap(),
    childKey
  }).unwrap()
  return {
    childKey,
    name: 'send-email',
    version: 1,
    storeKey,
    childJobId: id,
    request: makePreparedEnqueue({
      protocolVersion: 1,
      identity: { queue: 'default', name: 'send-email', version: 1 },
      id,
      payload: { childKey },
      metadata: {},
      priority: 0,
      runAt: 0,
      attemptsMax: 2,
      now: 0
    }).unwrap()
  }
}

const createParent = async (
  pool: Pool,
  schema: string,
  failFast: boolean
): Promise<{ readonly flowId: string; readonly leaseToken: string }> => {
  const runtime = await Runtime.make(
    PostgresJobStore.layer({ pool, schema, validateSchema: false })
  )
  try {
    return await runtime.run(async () => {
      const store = await ServiceRuntime.resolve(JobStore)
      const queue = makeQueueName('default').unwrap()
      const workerId = makeWorkerId('flow-worker').unwrap()
      const enqueued = await store.enqueue({
        job: { queue, name: failFast ? 'flow-fail-fast' : 'flow-continue', version: 1 },
        payload: { flow: true },
        runAt: 0,
        attemptsMax: 2,
        now: 0
      })
      if (enqueued.isErr()) throw enqueued.error
      const claimed = await store.claim({
        queue,
        accepted: [{ queue, name: failFast ? 'flow-fail-fast' : 'flow-continue', version: 1 }],
        limit: 1,
        workerId,
        leaseDurationMs: 10_000,
        now: 1
      })
      if (claimed.isErr()) throw claimed.error
      return {
        flowId: enqueued.value.job.id,
        leaseToken: claimed.value.jobs[0]!.leaseToken
      }
    })
  } finally {
    await runtime.dispose()
  }
}

describe('PostgreSQL flow protocol v2', () => {
  test('ships an additive flow migration and leaves historical migrations unchanged', async () => {
    const migrations = await loadPostgresMigrations()
    expect(migrations).toHaveLength(5)
    expect(migrations.slice(0, 3).map(({ checksum }) => checksum)).toEqual([
      '318f515315265f43f75703530465b7700572c3191867fe43b95a37ca6afca8a7',
      '98812cdcab7c4b87525f64a941936a37d08334bb337f287fcd82fa7a2fe9610d',
      'd86fabd5504c883c777392b30128038e6acbbfa9836f3fa0dfed4fdee9805714'
    ])
    expect(migrations[3]?.sql).toContain('better_effect_mq_flow_children')
    expect(migrations[3]?.sql).toContain('better_effect_mq_flow_outbox')
    expect(migrationSql(migrations[3]!, 'flow_test')).toContain('"flow_test"')
    expect(migrations[4]?.sql).toContain('better_effect_mq_queue_controls')
  })

  test('rejects a v1-only schema during the v2 handshake', async () => {
    const { database, pool } = await makePool()
    try {
      const migrations = await loadPostgresMigrations()
      await database.exec('CREATE SCHEMA "v1_only"')
      for (const migration of migrations.slice(0, 3)) {
        await database.exec(migrationSql(migration, 'v1_only'))
      }
      await expect(
        PostgresFlowStore.make({ pool, schema: 'v1_only', validateSchema: false })
      ).rejects.toBeInstanceOf(PostgresFlowProtocolMismatchError)

      const runtime = await Runtime.make(
        PostgresJobStore.layer({ pool, schema: 'v1_only', validateSchema: false })
      )
      try {
        const settled = await runtime.run(async () => {
          const store = await ServiceRuntime.resolve(JobStore)
          const queue = makeQueueName('default').unwrap()
          const enqueued = await store.enqueue({
            job: { queue, name: 'v1-job', version: 1 },
            payload: { v1: true },
            runAt: 0,
            attemptsMax: 1,
            now: 0
          })
          if (enqueued.isErr()) throw enqueued.error
          const claimed = await store.claim({
            queue,
            accepted: [{ queue, name: 'v1-job', version: 1 }],
            limit: 1,
            workerId: makeWorkerId('v1-worker').unwrap(),
            leaseDurationMs: 10_000,
            now: 1
          })
          if (claimed.isErr()) throw claimed.error
          const active = claimed.value.jobs[0]!
          return store.settle({
            jobId: active.id,
            leaseToken: active.leaseToken,
            outcome: { type: 'complete', result: { ok: true } },
            now: 2
          })
        })
        expect(settled.isOk()).toBe(true)
      } finally {
        await runtime.dispose()
      }
    } finally {
      await database.close()
    }
  })

  test('persists FanOut atomically, acknowledges replay, and rejects conflicting replay', async () => {
    const { database, pool } = await makePool()
    const schema = 'flow_fanout'
    const client = PostgresClient.fromPool({ pool, schema })
    await client.migrate({ appliedAtMs: 1 })
    const parent = await createParent(pool, schema, false)
    const store = await PostgresFlowStore.make({ pool, schema, validateSchema: false })
    try {
      const children = [childSpec(parent.flowId, 'email:1'), childSpec(parent.flowId, 'email:2')]
      const request = {
        flowId: makeJobId(parent.flowId).unwrap(),
        flowName: 'daily-digest',
        parentStoreKey: 'emails',
        depth: 1,
        leaseToken: makeLeaseToken(parent.leaseToken).unwrap(),
        failFast: false,
        children,
        now: 2
      }
      const first = await store.fanOut(request)
      expect(first.isOk()).toBe(true)
      expect(first.isOk() && first.value.status).toBe('applied')
      expect(first.isOk() && first.value.parent.state).toBe('waiting-children')
      expect(first.isOk() && first.value.parent.flow.pending).toBe(2)

      const replay = await store.fanOut(request)
      expect(replay.isOk()).toBe(true)
      expect(replay.isOk() && replay.value.status).toBe('already-applied')

      const conflict = await store.fanOut({ ...request, children: [children[0]!] })
      expect(conflict.isErr()).toBe(true)

      const snapshot = await store.getFlow({ flowId: request.flowId })
      expect(snapshot.isOk() && snapshot.value?.children).toHaveLength(2)
      const rows = await database.query(
        'SELECT state, flow FROM "flow_fanout".better_effect_mq_jobs WHERE id = $1',
        [parent.flowId]
      )
      expect(rows.rows[0]).toMatchObject({ state: 'waiting-children' })

      const child = children[0]!
      const defaultQueue = makeQueueName('default').unwrap()
      const runtime = await Runtime.make(
        PostgresJobStore.layer({ pool, schema, validateSchema: false })
      )
      try {
        const settlement = await runtime.run(async () => {
          const jobStore = await ServiceRuntime.resolve(JobStore)
          const enqueued = await jobStore.enqueue({
            id: makeJobId(child.childJobId).unwrap(),
            job: { queue: defaultQueue, name: child.name, version: child.version },
            payload: child.request.payload,
            runAt: 0,
            attemptsMax: 1,
            now: 3
          })
          if (enqueued.isErr()) throw enqueued.error
          await database.query(
            'UPDATE "flow_fanout".better_effect_mq_jobs SET parent = $2::jsonb WHERE id = $1',
            [
              child.childJobId,
              JSON.stringify({
                flowName: request.flowName,
                flowId: request.flowId,
                childKey: child.childKey,
                parentStoreKey: request.parentStoreKey,
                depth: request.depth
              })
            ]
          )
          const claimed = await jobStore.claim({
            queue: defaultQueue,
            accepted: [{ queue: defaultQueue, name: child.name, version: child.version }],
            limit: 1,
            workerId: makeWorkerId('child-worker').unwrap(),
            leaseDurationMs: 10_000,
            now: 4
          })
          if (claimed.isErr()) throw claimed.error
          const active = claimed.value.jobs[0]!
          return jobStore.settle({
            jobId: active.id,
            leaseToken: active.leaseToken,
            outcome: { type: 'complete', result: { sent: true } },
            now: 5
          })
        })
        expect(settlement.isOk()).toBe(true)
      } finally {
        await runtime.dispose()
      }
      const reports = await database.query(
        'SELECT report, created_at_ms FROM "flow_fanout".better_effect_mq_flow_outbox WHERE id = $1',
        [`flow-report/${child.childJobId}/1`]
      )
      expect(reports.rows[0]).toMatchObject({
        report: {
          flowId: request.flowId,
          childKey: child.childKey,
          outcome: 'completed',
          result: { sent: true }
        },
        created_at_ms: 5
      })
    } finally {
      await store.dispose()
      await database.close()
    }
  })

  test('records reports idempotently and supports continue, fail-fast, cancel, and cascade', async () => {
    const { database, pool } = await makePool()
    const schema = 'flow_reports'
    const client = PostgresClient.fromPool({ pool, schema })
    await client.migrate({ appliedAtMs: 1 })
    const parent = await createParent(pool, schema, false)
    const store = await PostgresFlowStore.make({ pool, schema, validateSchema: false })
    try {
      const children = [childSpec(parent.flowId, 'email:1'), childSpec(parent.flowId, 'email:2')]
      const request = {
        flowId: makeJobId(parent.flowId).unwrap(),
        flowName: 'daily-digest',
        parentStoreKey: 'emails',
        depth: 1,
        leaseToken: makeLeaseToken(parent.leaseToken).unwrap(),
        failFast: false,
        children,
        now: 2
      }
      await store.fanOut(request)
      const completed = await store.recordChildResults({
        flowId: request.flowId,
        reports: [
          {
            flowId: request.flowId,
            childKey: 'email:1',
            outcome: 'completed',
            result: { ok: true },
            failure: undefined
          }
        ],
        now: 3
      })
      expect(completed.isOk() && completed.value.applied).toBe(1)
      expect(completed.isOk() && completed.value.parentSettled).toBe(false)
      const duplicate = await store.recordChildResults({
        flowId: request.flowId,
        reports: [
          {
            flowId: request.flowId,
            childKey: 'email:1',
            outcome: 'completed',
            result: { ok: true },
            failure: undefined
          }
        ],
        now: 4
      })
      expect(duplicate.isOk() && duplicate.value.applied).toBe(0)
      const final = await store.recordChildResults({
        flowId: request.flowId,
        reports: [
          {
            flowId: request.flowId,
            childKey: 'email:2',
            outcome: 'completed',
            result: { ok: true },
            failure: undefined
          }
        ],
        now: 5
      })
      expect(final.isOk() && final.value.parent.state).toBe('waiting')
      const cancelled = await store.cancel({ flowId: request.flowId, now: 6 })
      expect(cancelled.isOk() && cancelled.value.parentSettled).toBe(false)
    } finally {
      await store.dispose()
      await database.close()
    }
  })

  test('settles fail-fast before the pending-zero branch and exposes cascade work', async () => {
    const { database, pool } = await makePool()
    const schema = 'flow_fail_fast'
    const client = PostgresClient.fromPool({ pool, schema })
    await client.migrate({ appliedAtMs: 1 })
    const parent = await createParent(pool, schema, true)
    const store = await PostgresFlowStore.make({ pool, schema, validateSchema: false })
    try {
      const flowId = makeJobId(parent.flowId).unwrap()
      const children = [childSpec(parent.flowId, 'email:1'), childSpec(parent.flowId, 'email:2')]
      await store.fanOut({
        flowId,
        flowName: 'daily-digest',
        parentStoreKey: 'emails',
        depth: 1,
        leaseToken: makeLeaseToken(parent.leaseToken).unwrap(),
        failFast: true,
        children,
        now: 2
      })
      const failed = await store.recordChildResults({
        flowId,
        reports: [
          {
            flowId,
            childKey: 'email:1',
            outcome: 'failed',
            result: undefined,
            failure: makeSerializedJobFailure({
              kind: 'typed',
              message: 'provider unavailable',
              retryable: false,
              recordedAt: 3
            }).unwrap()
          }
        ],
        now: 3
      })
      expect(failed.isOk() && failed.value.parent.state).toBe('failed')
      expect(failed.isOk() && failed.value.parentSettled).toBe(true)
      expect(failed.isOk() && failed.value.parent.flow.pending).toBe(0)
      expect(failed.isOk() && failed.value.parent.flow.cancelled).toBe(1)

      const reconciled = await store.reconcile({
        flowId,
        observations: [],
        now: 4
      })
      expect(reconciled.isOk() && reconciled.value.cascade.map((child) => child.childKey)).toEqual([
        'email:2'
      ])
      const cascaded = await store.markCascaded({ flowId, childKeys: ['email:2'] })
      expect(cascaded.isOk() && cascaded.value.marked).toBe(1)
      expect(
        cascaded.isOk() &&
          cascaded.value.children.find((child) => child.childKey === 'email:2')?.cascaded
      ).toBe(true)
    } finally {
      await store.dispose()
      await database.close()
    }
  })

  test('passes the shared FlowStore v2 conformance suite', async () => {
    const { database, pool } = await makePool()
    const schema = 'flow_contract'
    const client = PostgresClient.fromPool({ pool, schema })
    await client.migrate({ appliedAtMs: 1 })
    try {
      const suite = flowStoreContract({
        makeStore: () => PostgresFlowStore.make({ pool, schema, validateSchema: false }),
        createFlow: (_store, _scenario, input) => createParent(pool, schema, input.failFast),
        prefix: `postgres-${process.pid}`
      })
      for (const scenario of suite) await scenario.run()
      expect(suite.report().failed).toEqual([])
    } finally {
      await database.close()
    }
  })
})
