import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import {
  JobEventCursorExpiredError,
  JobEventStore,
  JobEventWriterRejectedError,
  JobName,
  JobStore,
  QueueName,
  WorkerId
} from 'better-effect-mq'
import { SqliteJobEventStore, SqliteJobStore } from '../src'

const databases: Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const identity = {
  queue: QueueName.make('events').unwrap(),
  name: JobName.make('send').unwrap(),
  version: 1
} as const

const makeRuntime = async (
  database: Database,
  retention?: { readonly ageMs?: number; readonly count?: number }
) => {
  SqliteJobStore.migrate({ database })
  return Runtime.make(
    SqliteJobStore.layerWithEvents(
      { database, namespace: 'events', pollIntervalMs: 10 },
      retention === undefined ? undefined : { retention }
    )
  )
}

describe('SQLite durable JobEventStore', () => {
  test('appends transitions atomically and keeps event fields safe', async () => {
    const database = new Database(':memory:')
    databases.push(database)
    const runtime = await makeRuntime(database)
    try {
      const result = await runtime.run(async () => {
        const jobs = await ServiceRuntime.resolve(JobStore)
        const events = await ServiceRuntime.resolve(JobEventStore)
        const enqueued = await jobs.enqueue({
          job: identity,
          payload: { email: 'private@example.com' },
          metadata: { secret: 'private' },
          runAt: 0,
          attemptsMax: 2,
          now: 0
        })
        if (enqueued.isErr()) throw enqueued.error
        const duplicate = await jobs.enqueue({
          id: enqueued.value.job.id,
          job: identity,
          payload: { email: 'private@example.com' },
          metadata: { secret: 'private' },
          runAt: 0,
          attemptsMax: 2,
          now: 0
        })
        if (duplicate.isErr()) throw duplicate.error
        const claimed = await jobs.claim({
          queue: identity.queue,
          accepted: [identity],
          limit: 1,
          workerId: WorkerId.make('events-worker').unwrap(),
          leaseDurationMs: 100,
          now: 1
        })
        if (claimed.isErr()) throw claimed.error
        const settled = await jobs.settle({
          jobId: enqueued.value.job.id,
          leaseToken: claimed.value.jobs[0]!.leaseToken,
          outcome: { type: 'complete', result: { private: true } },
          now: 2
        })
        if (settled.isErr()) throw settled.error
        return events.read({})
      })
      expect(result.isOk()).toBe(true)
      if (result.isErr()) return
      expect(result.value.events.map((event) => event.type)).toEqual([
        'job-enqueued',
        'job-claimed',
        'job-completed'
      ])
      expect(JSON.stringify(result.value.events)).not.toContain('private@example.com')
      expect(JSON.stringify(result.value.events)).not.toContain('private')
    } finally {
      await runtime.dispose()
    }
  })

  test('retention expires cursors and filtered pagination advances', async () => {
    const database = new Database(':memory:')
    databases.push(database)
    const runtime = await makeRuntime(database, { count: 2 })
    try {
      const result = await runtime.run(async () => {
        const jobs = await ServiceRuntime.resolve(JobStore)
        const events = await ServiceRuntime.resolve(JobEventStore)
        const initial = await events.tailCursor()
        if (initial.isErr()) throw initial.error
        for (const suffix of ['one', 'two']) {
          const enqueued = await jobs.enqueue({
            job: { ...identity, name: JobName.make(`send-${suffix}`).unwrap() },
            payload: { suffix },
            runAt: 0,
            attemptsMax: 1,
            now: 0
          })
          if (enqueued.isErr()) throw enqueued.error
        }
        const first = await events.read({ limit: 1, types: ['job-enqueued'] })
        const enqueued = await jobs.enqueue({
          job: { ...identity, name: JobName.make('send-three').unwrap() },
          payload: { suffix: 'three' },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        if (enqueued.isErr()) throw enqueued.error
        if (first.isErr()) throw first.error
        const nextCursor = first.value.nextCursor
        if (nextCursor === undefined) throw new Error('first page did not return a cursor')
        return {
          second: await events.read({ after: nextCursor, types: ['job-enqueued'] }),
          expired: await events.read({ after: initial.value })
        }
      })
      expect(result.second.isOk()).toBe(true)
      expect(result.second.isOk() && result.second.value.events).toHaveLength(2)
      expect(result.expired.isErr()).toBe(true)
      expect(result.expired.isErr() && result.expired.error).toBeInstanceOf(
        JobEventCursorExpiredError
      )
    } finally {
      await runtime.dispose()
    }
  })

  test('awaitEvents wakes locally and has polling fallback', async () => {
    const database = new Database(':memory:')
    databases.push(database)
    const runtime = await makeRuntime(database)
    try {
      const result = await runtime.run(async () => {
        const jobs = await ServiceRuntime.resolve(JobStore)
        const events = await ServiceRuntime.resolve(JobEventStore)
        const tail = await events.tailCursor()
        if (tail.isErr()) throw tail.error
        const controller = new AbortController()
        const waiting = events.awaitEvents({
          after: tail.value,
          queues: [identity.queue],
          signal: controller.signal
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
        const enqueued = await jobs.enqueue({
          job: identity,
          payload: { value: 1 },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        if (enqueued.isErr()) throw enqueued.error
        const woken = await waiting
        controller.abort()
        return woken
      })
      expect(result.isOk()).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('rolls back the job transition when durable event append fails', async () => {
    const database = new Database(':memory:')
    databases.push(database)
    const runtime = await makeRuntime(database)
    database.exec(`
      CREATE TRIGGER block_sqlite_job_events
      BEFORE INSERT ON better_effect_mq_job_events
      BEGIN
        SELECT RAISE(ABORT, 'blocked event append');
      END;
    `)
    try {
      const result = await runtime.run(async () => {
        const jobs = await ServiceRuntime.resolve(JobStore)
        return jobs.enqueue({
          job: identity,
          payload: { value: 1 },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
      })
      expect(result.isErr()).toBe(true)
      expect(database.prepare(`SELECT COUNT(*) AS count FROM better_effect_mq_jobs`).get()).toEqual(
        {
          count: 0
        }
      )
      expect(
        database.prepare(`SELECT COUNT(*) AS count FROM better_effect_mq_job_events`).get()
      ).toEqual({ count: 0 })
    } finally {
      await runtime.dispose()
    }
  })

  test('supports separate JobStore and JobEventStore layers', async () => {
    const database = new Database(':memory:')
    databases.push(database)
    SqliteJobStore.migrate({ database })
    const runtime = await Runtime.make(
      Layer.merge(
        SqliteJobStore.layer({ database, namespace: 'separate' }),
        SqliteJobEventStore.layer({ database, namespace: 'separate' })
      )
    )
    try {
      const result = await runtime.run(async () => {
        const jobs = await ServiceRuntime.resolve(JobStore)
        const events = await ServiceRuntime.resolve(JobEventStore)
        const enqueued = await jobs.enqueue({
          job: identity,
          payload: { value: 1 },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        if (enqueued.isErr()) throw enqueued.error
        return events.read({})
      })
      expect(result.isOk()).toBe(true)
      expect(result.isOk() && result.value.events).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('coordinates required activation and rejects an old writer before mutation', async () => {
    const database = new Database(':memory:')
    databases.push(database)
    SqliteJobStore.migrate({ database })
    const firstRuntime = await Runtime.make(
      SqliteJobStore.layerWithEvents({ database, namespace: 'rollout' })
    )
    try {
      await firstRuntime.run(async () => {
        const jobs = await ServiceRuntime.resolve(JobStore)
        const events = await ServiceRuntime.resolve(JobEventStore)
        const created = await jobs.enqueue({
          job: identity,
          payload: { value: 1 },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        if (created.isErr()) throw created.error
        const activation = await events.activate({ mode: 'required', now: 1 })
        if (activation.isErr()) throw activation.error
        expect(activation.value.state).toBe('required')
      })
    } finally {
      await firstRuntime.dispose()
    }

    const oldRuntime = await Runtime.make(
      SqliteJobStore.layerWithEvents(
        { database, namespace: 'rollout' },
        { writer: { id: 'old-writer', version: '0', canAppend: false } }
      )
    )
    try {
      const result = await oldRuntime.run(async () => {
        const jobs = await ServiceRuntime.resolve(JobStore)
        return jobs.enqueue({
          job: { ...identity, name: JobName.make('old-writer-job').unwrap() },
          payload: { value: 2 },
          runAt: 0,
          attemptsMax: 1,
          now: 2
        })
      })
      expect(result.isErr()).toBe(true)
      expect(result.isErr() && result.error).toBeInstanceOf(JobEventWriterRejectedError)
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM better_effect_mq_jobs WHERE namespace = ?')
          .get('rollout')
      ).toEqual({ count: 1 })
    } finally {
      await oldRuntime.dispose()
    }
  })
})
