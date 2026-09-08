// oxlint-disable anti-slop/no-chained-type-assertions -- test helpers bridge intentionally erased service contracts.

import { createPool, type Pool as MySqlPool } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  JobEventStore,
  JobName,
  JobScheduleStore,
  JobStore,
  Queue,
  QueueControls,
  makeFlowChildId,
  makeJobId,
  makeJobName,
  makePreparedEnqueue,
  makeQueueName,
  makeWorkerId,
  protocolVersion,
  type FlowChildSpec,
  type ControlledJobStoreContract,
  type JobEventStoreContract,
  type JobRecord,
  type ScheduleRecord
} from 'better-effect-mq'
import {
  MySqlClient,
  MySqlFlowStore,
  MySqlJobEventStore,
  MySqlJobScheduleStore,
  MySqlJobStore
} from '../src'

const uri = process.env.MYSQL_URL
const integration = uri === undefined ? test.skip : test
const namespace = `mysql_extension_events_${process.pid}_${Date.now()}`
let pool: MySqlPool | undefined

const database = (): MySqlPool => {
  if (pool === undefined) throw new Error('MYSQL_URL did not initialize a pool')
  return pool
}

const resolve = async <Value>(
  operation: ResultType<Value, unknown> | PromiseLike<ResultType<Value, unknown>>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const readEvents = async (events: JobEventStoreContract) => {
  const result = await events.read({})
  if (result.isErr()) throw result.error
  return result.value.events
}

const flowChild = (flowId: string): FlowChildSpec => {
  const childJobId = makeFlowChildId({
    parentStoreKey: 'extension-parent',
    flowId: makeJobId(flowId).unwrap(),
    childKey: 'child'
  }).unwrap()
  return {
    childKey: 'child',
    name: 'flow-child',
    version: 1,
    storeKey: 'extension-child-store',
    childJobId,
    request: makePreparedEnqueue({
      protocolVersion,
      identity: { queue: 'extension-flow', name: 'flow-child', version: 1 },
      id: childJobId,
      payload: { secret: 'flow-payload' },
      metadata: { secret: 'flow-metadata' },
      priority: 0,
      runAt: 0,
      attemptsMax: 1,
      now: 0
    }).unwrap()
  }
}

const scheduleRecord = (): ScheduleRecord => {
  const queue = makeQueueName('extension-schedule').unwrap()
  return {
    key: 'extension-schedule',
    group: 'extension-events',
    job: { queue, name: makeJobName('scheduled').unwrap(), version: 1 },
    queue,
    cron: undefined,
    everyMs: 10,
    timeZone: 'UTC',
    payload: { secret: 'schedule-payload' },
    metadata: { secret: 'schedule-metadata' },
    priority: 0,
    attemptsMax: 1,
    backoff: undefined,
    timeoutMs: undefined,
    misfire: { strategy: 'run-once' },
    overlap: 'allow',
    paused: false,
    revision: 0,
    nextRunAtMs: 10,
    lastScheduledAtMs: undefined,
    lastJobId: undefined,
    createdAtMs: 0,
    updatedAtMs: 0
  }
}

describe('MySQL extension durable events', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    pool = createPool({ uri, connectionLimit: 12 })
    await MySqlClient.fromPool({ pool: database(), namespace }).migrate()
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  integration('appends effective Flow events and suppresses duplicate reports', async () => {
    const config = {
      pool: database(),
      namespace: `${namespace}_flow`,
      validateSchema: false
    } as const
    const runtime = await Runtime.make(
      Layer.merge(MySqlJobStore.layer(config), MySqlJobEventStore.layer(config))
    )
    const flow = await MySqlFlowStore.make(config)
    try {
      const value = await runtime.run(async () => {
        const jobs = await ServiceRuntime.resolve(JobStore)
        const events = await ServiceRuntime.resolve(JobEventStore)
        const queue = makeQueueName('extension-flow').unwrap()
        const name = JobName.make('flow-parent').unwrap()
        const enqueued = await resolve<{ readonly job: JobRecord }>(
          jobs.enqueue({
            job: { queue, name, version: 1 },
            payload: { secret: 'parent-payload' },
            metadata: { secret: 'parent-metadata' },
            runAt: 0,
            attemptsMax: 1,
            now: 0
          })
        )
        const claimed = await resolve<{ readonly jobs: readonly JobRecord[] }>(
          jobs.claim({
            queue,
            accepted: [{ queue, name, version: 1 }],
            limit: 1,
            workerId: makeWorkerId('extension-flow-worker').unwrap(),
            leaseDurationMs: 100,
            now: 1
          })
        )
        const active = claimed.jobs[0]!
        await resolve(
          flow.fanOut({
            flowId: enqueued.job.id,
            flowName: 'extension-flow',
            parentStoreKey: 'extension-parent',
            depth: 1,
            leaseToken: active.leaseToken!,
            failFast: false,
            children: [flowChild(enqueued.job.id)],
            now: 2
          })
        )
        const report = {
          flowId: enqueued.job.id,
          childKey: 'child',
          outcome: 'completed' as const,
          result: { secret: 'flow-result' },
          failure: undefined
        }
        const first = await resolve<{ readonly applied: number }>(
          flow.recordChildResults({ flowId: enqueued.job.id, reports: [report], now: 3 })
        )
        const second = await resolve<{ readonly applied: number }>(
          flow.recordChildResults({ flowId: enqueued.job.id, reports: [report], now: 4 })
        )
        return { first, second, events: await readEvents(events) }
      })
      expect(value.first.applied).toBe(1)
      expect(value.second.applied).toBe(0)
      expect(value.events.map((event) => event.type)).toEqual([
        'job-enqueued',
        'job-claimed',
        'flow-fan-out',
        'flow-child-results-recorded'
      ])
      expect(value.events[2]?.attributes).toEqual({ children: '1' })
      expect(value.events[3]?.attributes).toEqual({ applied: '1', parentSettled: 'true' })
      expect(JSON.stringify(value.events)).not.toContain('flow-payload')
      expect(JSON.stringify(value.events)).not.toContain('flow-result')
    } finally {
      await flow.dispose()
      await runtime.dispose()
    }
  })

  integration(
    'appends effective Schedule events and only one scheduled enqueue event',
    async () => {
      const config = {
        pool: database(),
        namespace: `${namespace}_schedule`,
        validateSchema: false
      } as const
      const runtime = await Runtime.make(
        Layer.merge(
          Layer.merge(MySqlJobStore.layer(config), MySqlJobEventStore.layer(config)),
          MySqlJobScheduleStore.layer(config)
        )
      )
      try {
        const value = await runtime.run(async () => {
          const schedules = await ServiceRuntime.resolve(JobScheduleStore)
          const events = await ServiceRuntime.resolve(JobEventStore)
          const record = scheduleRecord()
          await resolve(schedules.upsertSchedule(record))
          await resolve(schedules.upsertSchedule(record))
          await resolve(
            schedules.tickSchedule({
              key: { group: record.group, key: record.key },
              expectedRevision: 0,
              expectedRunAtMs: 10,
              nowMs: 11,
              decision: { occurrences: [10], nextRunAtMs: 20 }
            })
          )
          await resolve(
            schedules.tickSchedule({
              key: { group: record.group, key: record.key },
              expectedRevision: 0,
              expectedRunAtMs: 10,
              nowMs: 12,
              decision: { occurrences: [10], nextRunAtMs: 20 }
            })
          )
          await resolve(schedules.pauseSchedule({ group: record.group, key: record.key }))
          await resolve(schedules.pauseSchedule({ group: record.group, key: record.key }))
          await resolve(schedules.resumeSchedule({ group: record.group, key: record.key }))
          await resolve(schedules.removeSchedule({ group: record.group, key: record.key }))
          return readEvents(events)
        })
        expect(value.map((event) => event.type)).toEqual([
          'schedule-upserted',
          'job-enqueued',
          'schedule-ticked',
          'schedule-paused',
          'schedule-resumed',
          'schedule-removed'
        ])
        expect(value[2]?.attributes).toEqual({ jobs: '1', skipped: '0', status: 'fired' })
        expect(JSON.stringify(value)).not.toContain('schedule-payload')
        expect(JSON.stringify(value)).not.toContain('schedule-metadata')
      } finally {
        await runtime.dispose()
      }
    }
  )

  integration('keeps Controls events additive and idempotent', async () => {
    const config = {
      pool: database(),
      namespace: `${namespace}_controls`,
      validateSchema: false
    } as const
    const runtime = await Runtime.make(
      Layer.merge(MySqlJobStore.layer(config), MySqlJobEventStore.layer(config))
    )
    try {
      const value = await runtime.run(async () => {
        const jobs = await ServiceRuntime.resolve(JobStore)
        const events = await ServiceRuntime.resolve(JobEventStore)
        // SAFETY: MySqlJobStore exposes the controlled contract through the base JobStore token.
        const controlled = jobs as unknown as ControlledJobStoreContract
        const queue = Queue.define('extension-controls')
        const registry = QueueControls.registry({
          group: 'extension-controls',
          controls: [QueueControls.define(queue, { globalConcurrency: 1 })]
        })
        const first = await resolve<{ readonly records: readonly { readonly revision: number }[] }>(
          controlled.reconcile(registry)
        )
        await resolve(controlled.reconcile(registry))
        const enqueued = await resolve<{ readonly job: JobRecord }>(
          jobs.enqueue({
            id: makeJobId('extension-controls-job').unwrap(),
            job: {
              queue: makeQueueName('extension-controls').unwrap(),
              name: makeJobName('work').unwrap(),
              version: 1
            },
            payload: { secret: 'controls-payload' },
            runAt: 0,
            attemptsMax: 1,
            now: 0
          })
        )
        const claimed = await resolve<{ readonly jobs: readonly JobRecord[] }>(
          controlled.claimControlled({
            queue: makeQueueName('extension-controls').unwrap(),
            accepted: [
              {
                queue: makeQueueName('extension-controls').unwrap(),
                name: makeJobName('work').unwrap(),
                version: 1
              }
            ],
            limit: 1,
            workerId: makeWorkerId('extension-controls-worker').unwrap(),
            leaseDurationMs: 100,
            now: 1,
            controlsRevision: first.records[0]!.revision
          })
        )
        const settlement = {
          jobId: enqueued.job.id,
          leaseToken: claimed.jobs[0]!.leaseToken!,
          outcome: { type: 'complete' as const, result: { secret: 'controls-result' } },
          now: 2,
          controlsRevision: first.records[0]!.revision
        }
        await resolve(controlled.settleControlled(settlement))
        await resolve(controlled.settleControlled(settlement))
        return readEvents(events)
      })
      expect(value.map((event) => event.type)).toEqual([
        'controls-reconciled',
        'job-enqueued',
        'job-claimed',
        'controls-claimed',
        'job-completed',
        'controls-settled'
      ])
      expect(value[0]?.attributes).toEqual({ action: 'created' })
      expect(JSON.stringify(value)).not.toContain('controls-payload')
      expect(JSON.stringify(value)).not.toContain('controls-result')
    } finally {
      await runtime.dispose()
    }
  })
})
