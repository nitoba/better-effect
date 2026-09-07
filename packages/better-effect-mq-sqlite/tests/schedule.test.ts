import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Codec, JobScheduleStore, JobStore, Queue, QueueName, makeJobId } from 'better-effect-mq'
import { Result } from 'better-result'
import { SqliteJobScheduleStore, SqliteJobStore } from '../src'
import type { ScheduleRecord } from 'better-effect-mq'

const databases: Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

test('SQLite schedules migrate and atomically enqueue deterministic occurrences', async () => {
  const database = new Database(':memory:')
  databases.push(database)
  expect(SqliteJobStore.migrate({ database }).version).toBe(5)

  const runtime = await Runtime.make(
    Layer.merge(
      SqliteJobStore.layer({ database, configurePragmas: true }),
      SqliteJobScheduleStore.layer({ database, configurePragmas: true })
    )
  )

  try {
    const store = await runtime.run(() => ServiceRuntime.resolve(JobScheduleStore))
    const jobs = await runtime.run(() => ServiceRuntime.resolve(JobStore))
    const queue = Queue.define('billing')
    const queueName = QueueName.make(queue.queue).unwrap()
    const job = queue.job('invoice', {
      version: 1,
      payload: Codec.json<{ readonly month: string }>()
    })
    const record = {
      key: 'monthly',
      group: 'billing',
      job: job.identity,
      queue: queueName,
      cron: undefined,
      everyMs: 1_000,
      timeZone: 'UTC',
      payload: { month: 'current' },
      metadata: { source: 'sqlite-test' },
      priority: 4,
      attemptsMax: 3,
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
    } satisfies ScheduleRecord

    const created = await store.upsertSchedule(record)
    expect(Result.isOk(created)).toBe(true)
    if (Result.isError(created)) return
    const fired = await store.tickSchedule({
      key: { group: record.group, key: record.key },
      expectedRevision: created.value.record.revision,
      expectedRunAtMs: created.value.record.nextRunAtMs,
      nowMs: 1_001,
      decision: { occurrences: [1_000], nextRunAtMs: 2_000 }
    })
    expect(Result.isOk(fired)).toBe(true)
    if (Result.isError(fired)) return
    expect(fired.value.status).toBe('fired')
    expect(fired.value.jobs.map((job) => job.id)).toEqual([
      makeJobId('sched/monthly/1000').unwrap()
    ])
    expect((await jobs.counts()).unwrap().total).toBe(1)
    expect((await jobs.getJob({ jobId: fired.value.jobs[0]!.id })).unwrap()?.id).toBe(
      fired.value.jobs[0]!.id
    )
    const stale = await store.tickSchedule({
      key: { group: record.group, key: record.key },
      expectedRevision: created.value.record.revision,
      expectedRunAtMs: created.value.record.nextRunAtMs,
      nowMs: 1_001,
      decision: { occurrences: [1_000], nextRunAtMs: 2_000 }
    })
    expect(Result.isOk(stale) && stale.value.status).toBe('stale')

    const unicode = await store.upsertSchedule({ ...record, key: 'monthly-💾' })
    expect(Result.isOk(unicode)).toBe(true)
    expect(
      (await store.getSchedule({ group: record.group, key: 'monthly-💾' })).unwrap()?.key
    ).toBe('monthly-💾')
  } finally {
    await runtime.dispose()
  }
})
