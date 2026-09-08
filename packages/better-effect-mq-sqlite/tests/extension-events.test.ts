// oxlint-disable anti-slop/no-chained-type-assertions -- the controlled extension is intentionally erased by JobStore's public contract.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the test setup narrows validated adapter contracts.
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  Codec,
  type ControlledJobStoreContract,
  Queue,
  QueueControls,
  QueueName,
  makeFlowChildId,
  makeJobId,
  makePreparedEnqueue,
  makeQueueName,
  makeWorkerId,
  protocolVersion,
  type FlowChildSpec,
  type JobStore as JobStoreContract,
  type ScheduleRecord
} from 'better-effect-mq'
import { Result } from 'better-result'
import {
  SqliteFlowStore,
  SqliteJobEventStore,
  SqliteJobScheduleStore,
  SqliteJobStore
} from '../src'

const databases: Database[] = []

const unwrap = async <Value>(
  operation: { readonly unwrap: () => Value } | PromiseLike<{ readonly unwrap: () => Value }>
): Promise<Value> => (await operation).unwrap()

const open = () => {
  const database = new Database(':memory:')
  databases.push(database)
  SqliteJobStore.migrate({ database })
  const config = { database, namespace: 'extension-events' } as const
  return {
    database,
    jobs: SqliteJobStore.make(config),
    events: SqliteJobEventStore.make(config),
    flow: SqliteFlowStore.make(config),
    schedules: SqliteJobScheduleStore.make(config)
  }
}

const childSpec = (flowId: string, childKey: string): FlowChildSpec => {
  const childJobId = makeFlowChildId({
    parentStoreKey: 'parent-store',
    flowId: makeJobId(flowId).unwrap(),
    childKey
  }).unwrap()
  return {
    childKey,
    name: 'child-job',
    version: 1,
    storeKey: 'child-store',
    childJobId,
    request: makePreparedEnqueue({
      protocolVersion,
      identity: { queue: 'flow', name: 'child-job', version: 1 },
      id: childJobId,
      payload: { childKey },
      metadata: {},
      priority: 0,
      runAt: 0,
      attemptsMax: 1,
      now: 0
    }).unwrap()
  }
}

const createFlowParent = async (jobs: JobStoreContract.Contract) => {
  const queue = makeQueueName('flow').unwrap()
  const job = await unwrap(
    jobs.enqueue({
      id: makeJobId('flow-parent').unwrap(),
      job: { queue, name: 'parent', version: 1 },
      payload: {},
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  const claimed = await unwrap(
    jobs.claim({
      queue,
      accepted: [{ queue, name: 'parent', version: 1 }],
      limit: 1,
      workerId: makeWorkerId('flow-worker').unwrap(),
      leaseDurationMs: 100,
      now: 1
    })
  )
  return { flowId: job.job.id, leaseToken: claimed.jobs[0]!.leaseToken }
}

const schedule = (): ScheduleRecord => {
  const queue = Queue.define('scheduled')
  return {
    key: 'hourly',
    group: 'billing',
    job: queue.job('invoice', {
      version: 1,
      payload: Codec.json<{ readonly invoice: string }>()
    }).identity,
    queue: QueueName.make(queue.queue).unwrap(),
    cron: undefined,
    everyMs: 1_000,
    timeZone: 'UTC',
    payload: { invoice: 'safe-test-data' },
    metadata: { source: 'test' },
    priority: 0,
    attemptsMax: 1,
    backoff: undefined,
    timeoutMs: undefined,
    misfire: { strategy: 'run-once' },
    overlap: 'allow',
    paused: false,
    revision: 0,
    nextRunAtMs: 1_000,
    lastScheduledAtMs: undefined,
    lastJobId: undefined,
    createdAtMs: 0,
    updatedAtMs: 0
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('SQLite extension transition events', () => {
  test('appends effective FlowStore transitions and suppresses idempotent retries', async () => {
    const { database, jobs, events, flow } = open()
    const parent = await createFlowParent(jobs)
    const child = childSpec(parent.flowId, 'one')
    const request = {
      flowId: parent.flowId,
      flowName: 'sqlite-flow',
      parentStoreKey: 'parent-store',
      depth: 1,
      leaseToken: parent.leaseToken,
      failFast: false,
      children: [child],
      now: 2
    }

    expect((await unwrap(flow.fanOut(request))).status).toBe('applied')
    expect((await unwrap(flow.fanOut(request))).status).toBe('already-applied')
    await unwrap(
      jobs.enqueue({
        id: child.childJobId,
        job: { queue: 'flow', name: 'child-job', version: 1 },
        payload: {},
        runAt: 0,
        attemptsMax: 1,
        now: 2
      })
    )
    database
      .prepare('UPDATE better_effect_mq_jobs SET parent = ? WHERE namespace = ? AND id = ?')
      .run(
        JSON.stringify({
          flowName: request.flowName,
          flowId: parent.flowId,
          childKey: 'one',
          parentStoreKey: request.parentStoreKey,
          depth: 1
        }),
        'extension-events',
        child.childJobId
      )
    const claimed = await unwrap(
      jobs.claim({
        queue: makeQueueName('flow').unwrap(),
        accepted: [{ queue: 'flow', name: 'child-job', version: 1 }],
        limit: 1,
        workerId: makeWorkerId('flow-child-worker').unwrap(),
        leaseDurationMs: 100,
        now: 3
      })
    )
    await unwrap(
      jobs.settle({
        jobId: claimed.jobs[0]!.id,
        leaseToken: claimed.jobs[0]!.leaseToken,
        outcome: { type: 'complete' },
        now: 4
      })
    )
    const page = await unwrap(events.read({ types: ['flow-fan-out', 'flow-outbox-appended'] }))
    expect(page.events.map((event) => event.type)).toEqual(['flow-fan-out', 'flow-outbox-appended'])
  })

  test('appends effective ScheduleStore transitions and suppresses no-ops', async () => {
    const { events, schedules } = open()
    const record = schedule()
    const created = await unwrap(schedules.upsertSchedule(record))
    await unwrap(schedules.upsertSchedule(record))
    const ticked = await unwrap(
      schedules.tickSchedule({
        key: { group: record.group, key: record.key },
        expectedRevision: created.record.revision,
        expectedRunAtMs: created.record.nextRunAtMs,
        nowMs: 1_001,
        decision: { occurrences: [1_000], nextRunAtMs: 2_000 }
      })
    )
    expect(ticked.status).toBe('fired')
    await unwrap(schedules.pauseSchedule({ group: record.group, key: record.key }))
    await unwrap(schedules.pauseSchedule({ group: record.group, key: record.key }))
    await unwrap(schedules.resumeSchedule({ group: record.group, key: record.key }))
    expect(await unwrap(schedules.removeSchedule({ group: record.group, key: record.key }))).toBe(
      true
    )
    expect(await unwrap(schedules.removeSchedule({ group: record.group, key: record.key }))).toBe(
      false
    )

    const page = await unwrap(
      events.read({
        types: [
          'schedule-upserted',
          'schedule-ticked',
          'schedule-paused',
          'schedule-resumed',
          'schedule-removed'
        ]
      })
    )
    expect(page.events.map((event) => event.type)).toEqual([
      'schedule-upserted',
      'schedule-ticked',
      'schedule-paused',
      'schedule-resumed',
      'schedule-removed'
    ])
  })

  test('preserves base job events while appending effective controls events', async () => {
    const { jobs, events } = open()
    const controlled = jobs as unknown as ControlledJobStoreContract
    const queue = Queue.define('controlled-events')
    const identity = { queue: queue.queue, name: 'work', version: 1 } as const
    const controls = await unwrap(
      controlled.reconcile(
        QueueControls.registry({
          group: 'controlled-events',
          controls: [QueueControls.define(queue, { globalConcurrency: 1 })]
        })
      )
    )
    const revision = controls.records[0]!.revision
    await unwrap(
      jobs.enqueue({
        id: makeJobId('controlled-event-job').unwrap(),
        job: identity,
        payload: {},
        runAt: 0,
        attemptsMax: 1,
        now: 0
      })
    )
    const claim = await unwrap(
      controlled.claimControlled({
        queue: makeQueueName(queue.queue).unwrap(),
        accepted: [identity],
        limit: 1,
        workerId: makeWorkerId('controlled-events-worker').unwrap(),
        leaseDurationMs: 100,
        now: 1,
        controlsRevision: revision
      })
    )
    await unwrap(
      controlled.settleControlled({
        jobId: claim.jobs[0]!.id,
        leaseToken: claim.jobs[0]!.leaseToken,
        outcome: { type: 'complete' },
        now: 2,
        controlsRevision: revision
      })
    )

    const page = await unwrap(
      events.read({
        types: [
          'job-enqueued',
          'job-claimed',
          'job-completed',
          'controls-reconciled',
          'controls-claimed',
          'controls-settled'
        ]
      })
    )
    expect(page.events.map((event) => event.type)).toEqual([
      'controls-reconciled',
      'job-enqueued',
      'job-claimed',
      'controls-claimed',
      'job-completed',
      'controls-settled'
    ])
  })

  test('rolls back extension state and events when append fails', async () => {
    const { database, schedules } = open()
    database.exec(`
      CREATE TRIGGER block_extension_events
      BEFORE INSERT ON better_effect_mq_job_events
      BEGIN
        SELECT RAISE(ABORT, 'blocked extension event append');
      END;
    `)
    const result = await schedules.upsertSchedule(schedule())
    expect(Result.isError(result)).toBe(true)
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM better_effect_mq_schedules').get()
    ).toEqual({ count: 0 })
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM better_effect_mq_job_events').get()
    ).toEqual({ count: 0 })
  })
})
