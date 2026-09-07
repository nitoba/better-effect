// oxlint-disable typescript/await-thenable -- mysql2 and better-effect use PromiseLike boundaries.

import { createPool, type Pool as MySqlPool } from 'mysql2/promise'
import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import {
  JobEventCursorExpiredError,
  JobEventStore,
  JobName,
  JobStore,
  QueueName,
  WorkerId
} from 'better-effect-mq'
import { MYSQL_TABLES, MySqlClient, MySqlJobEventStore, MySqlJobStore } from '../src/index'

const uri = process.env.MYSQL_URL
const integration = uri === undefined ? test.skip : test
const namespace = `mysql_events_${process.pid}`
let pool: MySqlPool | undefined

const database = (): MySqlPool => {
  if (pool === undefined) throw new Error('MYSQL_URL did not initialize a pool')
  return pool
}

const identity = {
  queue: QueueName.make('events').unwrap(),
  name: JobName.make('send').unwrap(),
  version: 1
} as const

const reset = async (): Promise<void> => {
  await database().query(`DELETE FROM ${MYSQL_TABLES.events} WHERE namespace=?`, [namespace])
  await database().query(`DELETE FROM ${MYSQL_TABLES.eventCursors} WHERE namespace=?`, [namespace])
  await database().query(
    `DELETE attempts FROM ${MYSQL_TABLES.attempts} attempts JOIN ${MYSQL_TABLES.jobs} jobs ON jobs.namespace=attempts.namespace AND jobs.id=attempts.job_id WHERE jobs.namespace=?`,
    [namespace]
  )
  await database().query(`DELETE FROM ${MYSQL_TABLES.jobs} WHERE namespace=?`, [namespace])
  await database().query(`DELETE FROM ${MYSQL_TABLES.queues} WHERE namespace=?`, [namespace])
}

const makeRuntime = async (retention?: { readonly count?: number; readonly ageMs?: number }) => {
  const config = { pool: database(), namespace, validateSchema: false } as const
  const events =
    retention === undefined
      ? MySqlJobEventStore.layer(config)
      : MySqlJobEventStore.layer({ ...config, retention })
  return Runtime.make(Layer.merge(MySqlJobStore.layer(config), events))
}

describe('MySQL durable JobEventStore', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    pool = createPool({ uri, connectionLimit: 12 })
    await MySqlClient.fromPool({ pool: database(), namespace }).migrate()
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    if (uri !== undefined) await reset()
  })

  integration(
    'appends transitions atomically and keeps sensitive values out of events',
    async () => {
      const runtime = await makeRuntime()
      try {
        const result = await runtime.run(async () => {
          const jobs = await ServiceRuntime.resolve(JobStore)
          const events = await ServiceRuntime.resolve(JobEventStore)
          const enqueued = await jobs.enqueue({
            job: identity,
            payload: { email: 'private@example.com' },
            metadata: { secret: 'private' },
            runAt: 0,
            attemptsMax: 1,
            now: 0
          })
          if (enqueued.isErr()) throw enqueued.error
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
      } finally {
        await runtime.dispose()
      }
    }
  )

  integration('uses exclusive keyset pagination, filters, and count retention', async () => {
    const runtime = await makeRuntime({ count: 2 })
    try {
      const result = await runtime.run(async () => {
        const jobs = await ServiceRuntime.resolve(JobStore)
        const events = await ServiceRuntime.resolve(JobEventStore)
        const initial = await events.tailCursor()
        if (initial.isErr()) throw initial.error
        for (const name of ['one', 'two']) {
          const enqueued = await jobs.enqueue({
            job: { ...identity, name: JobName.make(name).unwrap() },
            payload: { name },
            runAt: 0,
            attemptsMax: 1,
            now: 0
          })
          if (enqueued.isErr()) throw enqueued.error
        }
        const first = await events.read({ limit: 1, types: ['job-enqueued'] })
        if (first.isErr() || first.value.nextCursor === undefined) throw new Error('missing cursor')
        const enqueued = await jobs.enqueue({
          job: { ...identity, name: JobName.make('three').unwrap() },
          payload: { name: 'three' },
          runAt: 0,
          attemptsMax: 1,
          now: 0
        })
        if (enqueued.isErr()) throw enqueued.error
        const second = await events.read({
          after: first.value.nextCursor,
          limit: 10,
          types: ['job-enqueued']
        })
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
    }
  })

  integration('wakes awaitEvents locally and remains abortable', async () => {
    const runtime = await makeRuntime()
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
})
