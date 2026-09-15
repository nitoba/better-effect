import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteJobScheduleStore, SqliteMigrator } from 'better-effect-mq-sqlite'

const host = process.argv[2]
assert.ok(host === 'node' || host === 'bun')
const { openSqlite } = await import(`better-effect-mq-sqlite/${host}`)
const directory = await mkdtemp(join(tmpdir(), 'mq-schedule-json-'))
const path = join(directory, 'schedules.db')
const payloads = ['null', 'true', '123', '{}', '[]', '"quoted"', '', 'ação 💾', null, true, 123, ['null'], { value: '123' }]

try {
  const database = openSqlite(path)
  try {
    SqliteMigrator.migrate({ database })
    const store = SqliteJobScheduleStore.make({ database })
    for (const [index, payload] of payloads.entries()) {
      const record = {
        key: `payload-${index}`, group: 'json', queue: 'schedule-json',
        job: { queue: 'schedule-json', name: 'echo', version: 1 },
        everyMs: 1000, timeZone: 'UTC', payload, metadata: {},
        priority: 0, attemptsMax: 1, misfire: { strategy: 'run-once' },
        overlap: 'allow', paused: false, revision: 0,
        nextRunAtMs: 1000, createdAtMs: 0, updatedAtMs: 0
      }
      const selector = { group: record.group, key: record.key }
      const created = (await store.upsertSchedule(record)).unwrap()
      assert.deepEqual(created.record.payload, payload)
      ;(await store.pauseSchedule(selector)).unwrap()
      assert.equal(database.prepare('SELECT payload FROM better_effect_mq_schedules WHERE schedule_key=?').get(record.key).payload, JSON.stringify(payload))
      ;(await store.resumeSchedule(selector)).unwrap()
      const current = (await store.getSchedule(selector)).unwrap()
      assert.deepEqual(current.payload, payload)
      const fired = (await store.tickSchedule({
        key: selector, expectedRevision: current.revision, expectedRunAtMs: 1000,
        nowMs: 1000, decision: { occurrences: [1000], nextRunAtMs: 2000 }
      })).unwrap()
      assert.equal(fired.status, 'fired')
      assert.deepEqual(fired.jobs.map((job) => job.payload), [payload])
    }
  } finally {
    database.close()
  }
  const reopened = openSqlite(path)
  try {
    SqliteMigrator.validate(reopened)
    const store = SqliteJobScheduleStore.make({ database: reopened })
    for (const [index, payload] of payloads.entries()) {
      const record = (await store.getSchedule({ group: 'json', key: `payload-${index}` })).unwrap()
      assert.deepEqual(record.payload, payload)
      assert.equal(record.nextRunAtMs, 2000)
      const saved = reopened.prepare('SELECT payload FROM better_effect_mq_jobs WHERE id=?').get(record.lastJobId)
      assert.equal(saved.payload, JSON.stringify(payload))
    }
    console.log(`PASS packed ${host}: schedule JSON survives pause/resume, native ticks and file reopen (${payloads.length} values)`)
  } finally {
    reopened.close()
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
