import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Codec, JobScheduleStore, JobStore, Queue, QueueName } from 'better-effect-mq'
import type { JsonValue, ScheduleRecord } from 'better-effect-mq'
import { SqliteJobScheduleStore, SqliteJobStore } from '../src'

const payloads: readonly JsonValue[] = [
  'null',
  'true',
  'false',
  '123',
  '0',
  '{}',
  '[]',
  '"quoted"',
  '{"value":null}',
  '',
  'ação 💾',
  null,
  true,
  false,
  123,
  ['null', { value: '123' }],
  { value: 'null', nested: ['true', null] }
]

for (const payload of payloads) {
  test(`SQLite schedules preserve decoded JSON ${JSON.stringify(payload)} through admin and ticks`, async () => {
    const database = new Database(':memory:')
    SqliteJobStore.migrate({ database })
    const runtime = await Runtime.make(
      Layer.merge(
        SqliteJobStore.layer({ database }),
        SqliteJobScheduleStore.layer({ database })
      )
    )
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobScheduleStore))
      const jobs = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const job = Queue.define('schedule-json').job('echo', {
        version: 1,
        payload: Codec.json<JsonValue>()
      })
      const record: ScheduleRecord = {
        key: 'payload',
        group: 'json',
        queue: QueueName.make(job.identity.queue).unwrap(),
        job: job.identity,
        cron: undefined,
        everyMs: 1000,
        timeZone: 'UTC',
        payload,
        metadata: {},
        priority: 0,
        attemptsMax: 1,
        backoff: undefined,
        timeoutMs: undefined,
        misfire: { strategy: 'run-once' },
        overlap: 'allow',
        paused: false,
        revision: 0,
        nextRunAtMs: 1000,
        lastScheduledAtMs: undefined,
        lastJobId: undefined,
        createdAtMs: 0,
        updatedAtMs: 0
      }
      const selector = { group: record.group, key: record.key }
      const stored = () => database.prepare('SELECT payload FROM better_effect_mq_schedules').get()
      const expected = { payload: JSON.stringify(payload) }
      const created = (await store.upsertSchedule(record)).unwrap()
      expect(created.record.payload).toEqual(payload)
      expect(stored()).toEqual(expected)
      const unchanged = (await store.upsertSchedule(record)).unwrap()
      expect(unchanged.changed).toBe(false)
      expect(unchanged.record.payload).toEqual(payload)
      expect((await store.getSchedule(selector)).unwrap()?.payload).toEqual(payload)
      expect(
        (await store.listSchedules({ group: 'json' })).unwrap().map((item) => item.payload)
      ).toEqual([payload])
      expect(
        (await store.dueSchedules({ nowMs: 1000 })).unwrap().map((item) => item.payload)
      ).toEqual([payload])

      ;(await store.pauseSchedule(selector)).unwrap()
      expect((await store.getSchedule(selector)).unwrap()?.paused).toBe(true)
      expect(stored()).toEqual(expected)
      ;(await store.resumeSchedule(selector)).unwrap()
      expect(stored()).toEqual(expected)
      const inspected = (await store.getSchedule(selector)).unwrap()
      assert.ok(inspected)
      const changed = (
        await store.upsertSchedule({ ...inspected, priority: 2, updatedAtMs: 50 })
      ).unwrap()
      expect(changed.changed).toBe(true)
      expect(changed.record.payload).toEqual(payload)
      expect(stored()).toEqual(expected)
      const command = {
        key: selector,
        expectedRevision: changed.record.revision,
        expectedRunAtMs: 1000,
        nowMs: 1000,
        decision: { occurrences: [1000], nextRunAtMs: 2000 }
      }
      const stale = (
        await store.tickSchedule({ ...command, expectedRevision: command.expectedRevision - 1 })
      ).unwrap()
      expect(stale.status).toBe('stale')
      expect(stale.schedule.payload).toEqual(payload)
      expect(stored()).toEqual(expected)
      expect((await jobs.counts()).unwrap().total).toBe(0)

      const fired = (await store.tickSchedule(command)).unwrap()
      expect(fired.status).toBe('fired')
      expect(fired.schedule.payload).toEqual(payload)
      expect(fired.jobs.map((item) => item.payload)).toEqual([payload])
      const emitted = fired.jobs[0]
      assert.ok(emitted)
      expect((await jobs.getJob({ jobId: emitted.id })).unwrap()?.payload).toEqual(payload)
      expect(database.prepare('SELECT payload FROM better_effect_mq_jobs').get()).toEqual(expected)
      expect(stored()).toEqual(expected)
      expect((await store.tickSchedule(command)).unwrap().status).toBe('stale')
      expect((await jobs.counts()).unwrap().total).toBe(1)
      expect(stored()).toEqual(expected)
    } finally {
      try {
        await runtime.dispose()
      } finally {
        database.close()
      }
    }
  })
}
