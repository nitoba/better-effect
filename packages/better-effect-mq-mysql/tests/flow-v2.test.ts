// oxlint-disable typescript/await-thenable -- mysql2's promise pool exposes tuple results.

import { createPool, type Pool as MySqlPool, type RowDataPacket } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Runtime, ServiceRuntime } from 'better-effect'
import { flowStoreContract } from 'better-effect-mq/testing'
import {
  JobStore,
  makeFlowChildId,
  makeJobId,
  makeLeaseToken,
  makePreparedEnqueue,
  makeQueueName,
  makeWorkerId,
  protocolVersion,
  type JsonValue,
  type FlowChildSpec
} from 'better-effect-mq'
import { MYSQL_FLOW_TABLES, MySqlClient, MySqlFlowStore, MySqlJobStore } from '../src'

const uri = process.env.MYSQL_URL
const namespace = `mysql_flow_${process.pid}_${Date.now()}`
const terminalNamespace = `${namespace}_terminal`
const integration = uri === undefined ? test.skip : test
let pool: MySqlPool | undefined

type StoredReport = {
  readonly flowId: string
  readonly childKey: string
  readonly outcome: string
  readonly result?: JsonValue
  readonly failure?: JsonValue
}

const configuredPool = (): MySqlPool => {
  if (pool === undefined) throw new Error('MYSQL_URL did not initialize a pool')
  return pool
}

const childSpec = (flowId: string, childKey: string, storeKey = 'parent-store'): FlowChildSpec => {
  const id = makeFlowChildId({
    parentStoreKey: storeKey,
    flowId: makeJobId(flowId).unwrap(),
    childKey
  }).unwrap()
  return {
    childKey,
    name: 'flow-child',
    version: 1,
    storeKey,
    childJobId: id,
    request: makePreparedEnqueue({
      protocolVersion,
      identity: { queue: 'flow', name: 'flow-child', version: 1 },
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
  flowNamespace: string,
  failFast: boolean
): Promise<{ readonly flowId: string; readonly leaseToken: string }> => {
  const runtime = await Runtime.make(
    MySqlJobStore.layer({ pool: configuredPool(), namespace: flowNamespace, validateSchema: false })
  )
  try {
    return await runtime.run(async () => {
      const store = await ServiceRuntime.resolve(JobStore)
      const queue = makeQueueName('flow').unwrap()
      const name = failFast ? 'flow-fail-fast' : 'flow-continue'
      const enqueued = await store.enqueue({
        job: { queue, name, version: 1 },
        payload: { flow: true },
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

const attachParent = async (
  childJobId: string,
  flowNamespace: string,
  flowId: string,
  flowName: string,
  childKey: string,
  parentStoreKey: string,
  depth: number
): Promise<void> => {
  await configuredPool().query(
    `UPDATE better_effect_mq_jobs SET parent=? WHERE namespace=? AND id=?`,
    [
      JSON.stringify({ flowName, flowId, childKey, parentStoreKey, depth }),
      flowNamespace,
      childJobId
    ]
  )
}

describe('MySQL flow protocol v2', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    pool = createPool({ uri, connectionLimit: 12 })
    await MySqlClient.fromPool({ pool: configuredPool(), namespace }).migrate()
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  integration('passes the shared FlowStore v2 conformance suite', async () => {
    const suite = flowStoreContract({
      makeStore: () =>
        MySqlFlowStore.make({ pool: configuredPool(), namespace, validateSchema: false }),
      createFlow: (_store, _scenario, input) => createParent(namespace, input.failFast),
      prefix: `mysql-${process.pid}`
    })
    for (const scenario of suite) await scenario.run()
    expect(suite.report().failed).toEqual([])
  })

  integration('writes terminal child reports in the same MySQL transaction', async () => {
    const parent = await createParent(terminalNamespace, false)
    const flow = await MySqlFlowStore.make({
      pool: configuredPool(),
      namespace: terminalNamespace,
      validateSchema: false
    })
    const spec = childSpec(parent.flowId, 'complete')
    const flowId = makeJobId(parent.flowId).unwrap()
    try {
      const fannedOut = await flow.fanOut({
        flowId,
        flowName: 'mysql-flow',
        parentStoreKey: 'parent-store',
        depth: 1,
        leaseToken: makeLeaseToken(parent.leaseToken).unwrap(),
        failFast: false,
        children: [spec],
        now: 2
      })
      expect(fannedOut.isOk()).toBe(true)

      const runtime = await Runtime.make(
        MySqlJobStore.layer({
          pool: configuredPool(),
          namespace: terminalNamespace,
          validateSchema: false
        })
      )
      try {
        const settled = await runtime.run(async () => {
          const store = await ServiceRuntime.resolve(JobStore)
          const enqueued = await store.enqueue({
            id: makeJobId(spec.childJobId).unwrap(),
            job: { queue: makeQueueName('flow').unwrap(), name: spec.name, version: spec.version },
            payload: spec.request.payload,
            runAt: 0,
            attemptsMax: 1,
            now: 3
          })
          if (enqueued.isErr()) throw enqueued.error
          await attachParent(
            spec.childJobId,
            terminalNamespace,
            parent.flowId,
            'mysql-flow',
            spec.childKey,
            'parent-store',
            1
          )
          const claimed = await store.claim({
            queue: makeQueueName('flow').unwrap(),
            accepted: [{ queue: makeQueueName('flow').unwrap(), name: spec.name, version: 1 }],
            limit: 1,
            workerId: makeWorkerId('child-worker').unwrap(),
            leaseDurationMs: 10_000,
            now: 4
          })
          if (claimed.isErr()) throw claimed.error
          const active = claimed.value.jobs[0]!
          return store.settle({
            jobId: active.id,
            leaseToken: active.leaseToken,
            outcome: { type: 'complete', result: { sent: true } },
            now: 5
          })
        })
        expect(settled.isOk()).toBe(true)
      } finally {
        await runtime.dispose()
      }

      const [rows] = await configuredPool().query<
        (RowDataPacket & { report: string; created_at_ms: number })[]
      >(
        `SELECT CAST(report AS CHAR) AS report,created_at_ms FROM ${MYSQL_FLOW_TABLES.outbox} WHERE namespace=? AND id=?`,
        [terminalNamespace, `flow-report/${spec.childJobId}/1`]
      )
      expect(rows[0]).toBeDefined()
      expect(JSON.parse(rows[0]!.report)).toMatchObject({
        flowId: parent.flowId,
        childKey: spec.childKey,
        outcome: 'completed',
        result: { sent: true }
      })
      expect(rows[0]?.created_at_ms).toBe(5)
    } finally {
      await flow.dispose()
    }
  })

  integration('reports waiting-job cancellation and exhausted stalled recovery', async () => {
    const stateNamespace = `${namespace}_terminal_states`
    const flow = await MySqlFlowStore.make({
      pool: configuredPool(),
      namespace: stateNamespace,
      validateSchema: false
    })
    const prepareChild = async (
      childKey: string
    ): Promise<{
      readonly parent: { readonly flowId: string; readonly leaseToken: string }
      readonly spec: FlowChildSpec
    }> => {
      const parent = await createParent(stateNamespace, false)
      const spec = childSpec(parent.flowId, childKey)
      const fannedOut = await flow.fanOut({
        flowId: makeJobId(parent.flowId).unwrap(),
        flowName: 'mysql-terminal-states',
        parentStoreKey: 'parent-store',
        depth: 1,
        leaseToken: makeLeaseToken(parent.leaseToken).unwrap(),
        failFast: false,
        children: [spec],
        now: 2
      })
      if (fannedOut.isErr()) throw fannedOut.error
      return { parent, spec }
    }
    const readReport = async (spec: FlowChildSpec): Promise<StoredReport> => {
      const [rows] = await configuredPool().query<
        (RowDataPacket & { report: string; created_at_ms: number })[]
      >(
        `SELECT CAST(report AS CHAR) AS report,created_at_ms FROM ${MYSQL_FLOW_TABLES.outbox} WHERE namespace=? AND id=?`,
        [stateNamespace, `flow-report/${spec.childJobId}/1`]
      )
      if (rows[0] === undefined) throw new Error('terminal flow report is missing')
      return JSON.parse(rows[0].report)
    }
    try {
      const cancelled = await prepareChild('waiting-cancel')
      const cancelRuntime = await Runtime.make(
        MySqlJobStore.layer({
          pool: configuredPool(),
          namespace: stateNamespace,
          validateSchema: false
        })
      )
      try {
        const result = await cancelRuntime.run(async () => {
          const store = await ServiceRuntime.resolve(JobStore)
          const enqueued = await store.enqueue({
            id: makeJobId(cancelled.spec.childJobId).unwrap(),
            job: {
              queue: makeQueueName('flow').unwrap(),
              name: cancelled.spec.name,
              version: cancelled.spec.version
            },
            payload: cancelled.spec.request.payload,
            runAt: 10,
            attemptsMax: 1,
            now: 3
          })
          if (enqueued.isErr()) throw enqueued.error
          await attachParent(
            cancelled.spec.childJobId,
            stateNamespace,
            cancelled.parent.flowId,
            'mysql-terminal-states',
            cancelled.spec.childKey,
            'parent-store',
            1
          )
          return store.cancel({ jobId: cancelled.spec.childJobId, now: 4 })
        })
        expect(result.isOk()).toBe(true)
      } finally {
        await cancelRuntime.dispose()
      }
      expect(await readReport(cancelled.spec)).toMatchObject({
        flowId: cancelled.parent.flowId,
        childKey: cancelled.spec.childKey,
        outcome: 'cancelled'
      })

      const stalled = await prepareChild('stalled-exhausted')
      const stalledRuntime = await Runtime.make(
        MySqlJobStore.layer({
          pool: configuredPool(),
          namespace: stateNamespace,
          validateSchema: false
        })
      )
      try {
        const result = await stalledRuntime.run(async () => {
          const store = await ServiceRuntime.resolve(JobStore)
          const enqueued = await store.enqueue({
            id: makeJobId(stalled.spec.childJobId).unwrap(),
            job: {
              queue: makeQueueName('flow').unwrap(),
              name: stalled.spec.name,
              version: stalled.spec.version
            },
            payload: stalled.spec.request.payload,
            runAt: 0,
            attemptsMax: 1,
            now: 3
          })
          if (enqueued.isErr()) throw enqueued.error
          await attachParent(
            stalled.spec.childJobId,
            stateNamespace,
            stalled.parent.flowId,
            'mysql-terminal-states',
            stalled.spec.childKey,
            'parent-store',
            1
          )
          const claimed = await store.claim({
            queue: makeQueueName('flow').unwrap(),
            accepted: [
              { queue: makeQueueName('flow').unwrap(), name: stalled.spec.name, version: 1 }
            ],
            limit: 1,
            workerId: makeWorkerId('stalled-worker').unwrap(),
            leaseDurationMs: 1,
            now: 4
          })
          if (claimed.isErr()) throw claimed.error
          return store.recoverStalled({ maxStalledCount: 0, now: 6 })
        })
        expect(result.isOk()).toBe(true)
      } finally {
        await stalledRuntime.dispose()
      }
      expect(await readReport(stalled.spec)).toMatchObject({
        flowId: stalled.parent.flowId,
        childKey: stalled.spec.childKey,
        outcome: 'failed'
      })
    } finally {
      await flow.dispose()
    }
  })
})
