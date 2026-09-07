// oxlint-disable typescript/await-thenable -- PGlite's runtime Promise shape is narrower than its declarations.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- PGlite's query bridge is narrowed at this test boundary.

import { PGlite } from '@electric-sql/pglite'
import { describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import {
  JobEventCursorExpiredError,
  JobEventStore,
  JobStore,
  JobName,
  QueueName,
  WorkerId
} from 'better-effect-mq'
import {
  PostgresClient,
  PostgresJobEventStore,
  PostgresJobStore,
  type Pool,
  type PoolClient,
  type QueryResult
} from '../src/index'

type PGliteDatabase = Awaited<ReturnType<typeof PGlite.create>>

const runQuery = async <Row>(
  database: PGliteDatabase,
  text: string,
  values: readonly unknown[] | undefined
): Promise<{ readonly rows: readonly Row[]; readonly affectedRows?: number }> => {
  if (values !== undefined)
    return database.query(text, [...values]) as Promise<{
      readonly rows: readonly Row[]
      readonly affectedRows?: number
    }>
  if (/^\s*(SELECT|WITH)/iu.test(text))
    return database.query(text) as Promise<{
      readonly rows: readonly Row[]
      readonly affectedRows?: number
    }>
  await database.exec(text)
  return { rows: [] }
}

const makePool = async (): Promise<{
  readonly database: PGliteDatabase
  readonly pool: Pool
}> => {
  const database = await PGlite.create('memory://')
  const pool: Pool = {
    connect: async (): Promise<PoolClient> => ({
      query: async <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
        const result = await runQuery<Row>(database, text, values)
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
      },
      release: () => undefined
    })
  }
  return { database, pool }
}

const identity = {
  queue: QueueName.make('events').unwrap(),
  name: JobName.make('send').unwrap(),
  version: 1
} as const

const makeRuntime = async (
  pool: Pool,
  schema: string,
  namespace: string,
  retention?: { readonly ageMs?: number; readonly count?: number }
) => {
  const eventConfig = { pool, schema, namespace, validateSchema: false } as const
  const eventLayer =
    retention === undefined
      ? PostgresJobEventStore.layer(eventConfig)
      : PostgresJobEventStore.layer({ ...eventConfig, retention })
  return Runtime.make(Layer.merge(PostgresJobStore.layer(eventConfig), eventLayer))
}

describe('PostgreSQL durable JobEventStore', () => {
  test('appends JobStore transitions in cursor order and keeps the event safe', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_events_atomic'
    await PostgresClient.fromPool({ pool, schema }).migrate({ appliedAtMs: 1 })
    const runtime = await makeRuntime(pool, schema, 'events')
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
        expect(duplicate.value.duplicate).toBe(true)
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
      expect(new Set(result.value.events.map((event) => event.cursor)).size).toBe(3)
      expect(JSON.stringify(result.value.events)).not.toContain('private@example.com')
      expect(JSON.stringify(result.value.events)).not.toContain('private')
      expect(result.value.events.every((event) => event.attributes !== undefined)).toBe(true)
    } finally {
      await runtime.dispose()
      await database.close()
    }
  })

  test('retention expires an old cursor and read pagination advances over filters', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_events_retention'
    await PostgresClient.fromPool({ pool, schema }).migrate({ appliedAtMs: 1 })
    const runtime = await makeRuntime(pool, schema, 'events', { count: 2 })
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
        const second = await events.read({ after: nextCursor, types: ['job-enqueued'] })
        const expired = await events.read({ after: initial.value })
        return { first, second, expired }
      })
      expect(result.second.isOk()).toBe(true)
      expect(result.second.isOk() && result.second.value.events).toHaveLength(2)
      expect(result.expired.isErr()).toBe(true)
      expect(result.expired.isErr() && result.expired.error).toBeInstanceOf(
        JobEventCursorExpiredError
      )
    } finally {
      await runtime.dispose()
      await database.close()
    }
  })

  test('awaitEvents uses polling as the authoritative wake path', async () => {
    const { database, pool } = await makePool()
    const schema = 'mq_events_wait'
    await PostgresClient.fromPool({ pool, schema }).migrate({ appliedAtMs: 1 })
    const runtime = await makeRuntime(pool, schema, 'events')
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
      await database.close()
    }
  })
})
