import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'
import {
  JobStore,
  FlowStore,
  makeFlowChildId,
  makeJobId,
  makeLeaseToken,
  makePreparedEnqueue,
  makeQueueName,
  makeWorkerId,
  protocolVersion,
  type FlowChildSpec,
  type FlowStoreV2Operation
} from 'better-effect-mq'
import { flowStoreContract } from 'better-effect-mq/testing'
import {
  SqliteFlowProtocolMismatchError,
  SqliteFlowStore,
  SqliteJobStore,
  SqliteMigrator
} from '../src'

const databases: Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const open = (): Database => {
  const database = new Database(':memory:')
  databases.push(database)
  SqliteMigrator.migrate({ database })
  database.exec('PRAGMA foreign_keys = ON')
  return database
}

const unwrap = async <Value>(operation: FlowStoreV2Operation<Value>): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const childSpec = (flowId: string, childKey: string, storeKey = 'child-store'): FlowChildSpec => {
  const id = makeFlowChildId({
    parentStoreKey: 'parent-store',
    flowId: makeJobId(flowId).unwrap(),
    childKey
  }).unwrap()
  return {
    childKey,
    name: 'child-job',
    version: 1,
    storeKey,
    childJobId: id,
    request: makePreparedEnqueue({
      protocolVersion,
      identity: { queue: 'flow', name: 'child-job', version: 1 },
      id,
      payload: { childKey },
      metadata: {},
      priority: 0,
      runAt: 0,
      attemptsMax: 1,
      now: 0
    }).unwrap()
  }
}

const createParent = async (
  database: Database,
  name: string
): Promise<{ readonly flowId: string; readonly leaseToken: string }> => {
  const runtime = await Runtime.make(SqliteJobStore.layer({ database, validateSchema: false }))
  try {
    return await runtime.run(async () => {
      const store = await ServiceRuntime.resolve(JobStore)
      const queue = makeQueueName('flow').unwrap()
      const enqueued = await store.enqueue({
        job: { queue, name, version: 1 },
        payload: { parent: true },
        runAt: 0,
        attemptsMax: 2,
        now: 0
      })
      if (enqueued.isErr()) throw enqueued.error
      const claimed = await store.claim({
        queue,
        accepted: [{ queue, name, version: 1 }],
        limit: 1,
        workerId: makeWorkerId('flow-worker').unwrap(),
        leaseDurationMs: 10,
        now: 1
      })
      if (claimed.isErr()) throw claimed.error
      const active = claimed.value.jobs[0]
      if (active === undefined) throw new Error('parent was not claimed')
      return { flowId: active.id, leaseToken: active.leaseToken }
    })
  } finally {
    await runtime.dispose()
  }
}

const parentEnvelope = (flowId: string, childKey: string): string =>
  JSON.stringify({
    flowName: 'sqlite-flow',
    flowId,
    childKey,
    parentStoreKey: 'parent-store',
    depth: 1
  })

describe('SQLite FlowStore protocol v2', () => {
  test('rejects a v1-v3 schema without silently applying the flow layout', () => {
    const database = new Database(':memory:')
    databases.push(database)
    database.exec('PRAGMA foreign_keys = ON')
    database.exec(`
      CREATE TABLE better_effect_mq_schema_versions (
        component TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, applied_at_ms INTEGER NOT NULL, checksum TEXT NOT NULL
      )
    `)
    expect(() => SqliteFlowStore.make({ database })).toThrow(SqliteFlowProtocolMismatchError)
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'better_effect_mq_flow_children'"
        )
        .get()
    ).toBeNull()
  })

  test('persists fanOut atomically and replays the exact manifest', async () => {
    const database = open()
    const parent = await createParent(database, 'fanout-parent')
    const store = SqliteFlowStore.make({ database })
    const flowId = makeJobId(parent.flowId).unwrap()
    const leaseToken = makeLeaseToken(parent.leaseToken).unwrap()
    const children = [childSpec(parent.flowId, 'one'), childSpec(parent.flowId, 'two')]
    const request = {
      flowId,
      flowName: 'sqlite-flow',
      parentStoreKey: 'parent-store',
      depth: 1,
      leaseToken,
      failFast: false,
      children,
      now: 2
    }
    const first = await unwrap(store.fanOut(request))
    expect(first.status).toBe('applied')
    expect(first.parent.state).toBe('waiting-children')
    expect(first.parent.flow.pending).toBe(2)
    expect((await unwrap(store.fanOut(request))).status).toBe('already-applied')
    expect(
      database.prepare('SELECT state FROM better_effect_mq_jobs WHERE id = ?').get(parent.flowId)
    ).toMatchObject({ state: 'waiting-children' })
  })

  test('records terminal child reports in the same SQLite transaction as settlement', async () => {
    const database = open()
    const parent = await createParent(database, 'terminal-parent')
    const childId = makeJobId('terminal-child').unwrap()
    const jobRuntime = await Runtime.make(SqliteJobStore.layer({ database, validateSchema: false }))
    try {
      const settlement = await jobRuntime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const queue = makeQueueName('flow').unwrap()
        const enqueued = await store.enqueue({
          id: childId,
          job: { queue, name: 'terminal-child', version: 1 },
          payload: { child: true },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        if (enqueued.isErr()) throw enqueued.error
        database
          .prepare('UPDATE better_effect_mq_jobs SET parent = ? WHERE namespace = ? AND id = ?')
          .run(
            JSON.stringify({
              flowName: 'sqlite-flow',
              flowId: parent.flowId,
              childKey: 'terminal',
              parentStoreKey: 'parent-store',
              depth: 1
            }),
            'default',
            childId
          )
        const claimed = await store.claim({
          queue,
          accepted: [{ queue, name: 'terminal-child', version: 1 }],
          limit: 1,
          workerId: makeWorkerId('terminal-worker').unwrap(),
          leaseDurationMs: 100,
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
      expect(settlement.isOk()).toBe(true)
      // SAFETY: the selected row is narrowed by the optional report_json property before parsing.
      const report = database
        .prepare('SELECT report_json FROM better_effect_mq_flow_outbox WHERE namespace = ?')
        .get('default') as { readonly report_json?: string } | undefined
      expect(JSON.parse(report?.report_json ?? '{}')).toMatchObject({
        flowId: parent.flowId,
        childKey: 'terminal',
        outcome: 'completed',
        result: { ok: true }
      })
    } finally {
      await jobRuntime.dispose()
    }
  })

  test('reports waiting and delayed cancellation and exhausted stalled recovery', async () => {
    const database = open()
    const runtime = await Runtime.make(SqliteJobStore.layer({ database, validateSchema: false }))
    try {
      await runtime.run(async () => {
        const store = await ServiceRuntime.resolve(JobStore)
        const queue = makeQueueName('flow-cancel').unwrap()
        for (const [id, runAt, childKey] of [
          ['cancel-waiting', 0, 'waiting'],
          ['cancel-delayed', 10, 'delayed']
        ] as const) {
          const enqueued = await store.enqueue({
            id: makeJobId(id).unwrap(),
            job: { queue, name: id, version: 1 },
            payload: { id },
            runAt,
            attemptsMax: 1,
            now: 0
          })
          if (enqueued.isErr()) throw enqueued.error
          database
            .prepare('UPDATE better_effect_mq_jobs SET parent = ? WHERE namespace = ? AND id = ?')
            .run(parentEnvelope(`flow-${id}`, childKey), 'default', id)
          const cancelled = await store.cancel({ jobId: makeJobId(id).unwrap(), now: 1 })
          if (cancelled.isErr()) throw cancelled.error
        }

        const stalledId = makeJobId('stalled-child').unwrap()
        const enqueued = await store.enqueue({
          id: stalledId,
          job: { queue, name: 'stalled-child', version: 1 },
          payload: { stalled: true },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        if (enqueued.isErr()) throw enqueued.error
        database
          .prepare('UPDATE better_effect_mq_jobs SET parent = ? WHERE namespace = ? AND id = ?')
          .run(parentEnvelope('flow-stalled', 'stalled'), 'default', stalledId)
        const claimed = await store.claim({
          queue,
          accepted: [{ queue, name: 'stalled-child', version: 1 }],
          limit: 1,
          workerId: makeWorkerId('stalled-worker').unwrap(),
          leaseDurationMs: 1,
          now: 1
        })
        if (claimed.isErr()) throw claimed.error
        const recovered = await store.recoverStalled({ maxStalledCount: 0, limit: 1, now: 2 })
        if (recovered.isErr()) throw recovered.error
        expect(recovered.value.transitions[0]?.attempt?.outcome).toBe('stalled')
      })

      // SAFETY: every row selected by this query contains the declared report_json column.
      const reports = database
        .prepare('SELECT report_json FROM better_effect_mq_flow_outbox ORDER BY row_sequence')
        .all() as readonly { readonly report_json: string }[]
      expect(reports).toHaveLength(3)
      expect(reports.map((row) => JSON.parse(row.report_json).outcome)).toEqual([
        'cancelled',
        'cancelled',
        'failed'
      ])
      expect(JSON.parse(reports[2]!.report_json).failure.kind).toBe('stalled')
    } finally {
      await runtime.dispose()
    }
  })

  test('persists flow state across a FlowStore restart and resolves through its Layer', async () => {
    const database = open()
    const parent = await createParent(database, 'restart-parent')
    const first = SqliteFlowStore.make({ database })
    const request = {
      flowId: makeJobId(parent.flowId).unwrap(),
      flowName: 'sqlite-flow',
      parentStoreKey: 'parent-store',
      depth: 1,
      leaseToken: makeLeaseToken(parent.leaseToken).unwrap(),
      failFast: false,
      children: [childSpec(parent.flowId, 'restart')],
      now: 2
    }
    await unwrap(first.fanOut(request))
    await first.dispose()

    const second = SqliteFlowStore.make({ database })
    try {
      const snapshot = await unwrap(second.getFlow({ flowId: request.flowId }))
      expect(snapshot?.children[0]?.childKey).toBe('restart')
    } finally {
      await second.dispose()
    }

    const runtime = await Runtime.make(
      Layer.merge(
        SqliteJobStore.layer({ database, validateSchema: false }),
        SqliteFlowStore.layer({ database })
      )
    )
    try {
      const flow = await runtime.run(() => ServiceRuntime.resolve(FlowStore))
      expect(flow.descriptor.protocolVersion).toBe(2)
      expect(flow.descriptor.layoutVersion).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('passes the shared flow conformance suite', async () => {
    const suite = flowStoreContract({
      makeStore: async (scenario) => {
        const database = open()
        await createParent(database, `contract-${scenario.id}`)
        return SqliteFlowStore.make({ database, namespace: 'default' })
      },
      createFlow: async (_store, scenario) => {
        const flow = await createParent(databases.at(-1)!, `contract-${scenario.id}-parent`)
        return flow
      },
      prefix: `sqlite-${process.pid}`
    })
    for (const scenario of suite) await scenario.run()
    expect(suite.report().failed).toEqual([])
  })
})
