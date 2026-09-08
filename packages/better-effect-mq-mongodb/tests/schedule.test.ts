// oxlint-disable anti-slop/no-runtime-typeof -- the exported API is checked at its public module boundary.

import { describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobScheduleStore, makeJobName, makeQueueName } from 'better-effect-mq'
import { Result } from 'better-result'
import {
  MONGODB_LAYOUT_VERSION,
  collectionNames,
  MongoJobScheduleStore,
  MongoJobStore
} from '../src/index'
import { makeDatabase } from './helpers/mongo-fake'

describe('MongoDB schedule layout', () => {
  test('declares the schedule collection without changing protocol v1', () => {
    expect(MONGODB_LAYOUT_VERSION).toBe(5)
    expect(collectionNames('better_effect_mq')).toContain('better_effect_mq_schedules')
  })

  test('exports the associated JobScheduleStore adapter', () => {
    expect(typeof MongoJobScheduleStore.layer).toBe('function')
    expect(typeof MongoJobScheduleStore.layerFor).toBe('function')
    expect(typeof MongoJobScheduleStore.layerFromConfig).toBe('function')
    expect(typeof MongoJobScheduleStore.layerFromConfigFor).toBe('function')
  })

  test('appends one schedule event for an effective upsert and none for an idempotent retry', async () => {
    const db = makeDatabase()
    const namespace = 'schedule-events'
    const writer = { id: 'mongodb-test', version: '1', canAppend: true } as const
    const runtime = await Runtime.make(
      Layer.merge(
        MongoJobStore.layer({
          db,
          namespace,
          validateLayout: false,
          notifications: 'poll',
          eventWriter: writer
        }),
        MongoJobScheduleStore.layer({
          db,
          namespace,
          validateLayout: false,
          notifications: 'poll',
          eventWriter: writer
        })
      )
    )
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobScheduleStore))
      const queue = makeQueueName('scheduled').unwrap()
      const name = makeJobName('work').unwrap()
      const record = {
        key: 'daily',
        group: 'tests',
        job: { queue, name, version: 1 },
        queue,
        cron: undefined,
        everyMs: 60_000,
        timeZone: undefined,
        payload: { kind: 'test' },
        metadata: {},
        priority: 0,
        attemptsMax: 1,
        backoff: undefined,
        timeoutMs: undefined,
        misfire: { strategy: 'skip' as const },
        overlap: 'allow' as const,
        paused: false,
        revision: 1,
        nextRunAtMs: 60_000,
        lastScheduledAtMs: undefined,
        lastJobId: undefined,
        createdAtMs: 0,
        updatedAtMs: 0
      }
      const first = await store.upsertSchedule(record)
      if (Result.isError(first)) throw first.error
      expect(first.value.changed).toBe(true)
      const second = await store.upsertSchedule(record)
      if (Result.isError(second)) throw second.error
      expect(second.value.changed).toBe(false)
      const events = await db.collection('better_effect_mq_events').find({ namespace }).toArray()
      expect(events.map((event) => event.eventType)).toEqual(['schedule-upserted'])
    } finally {
      await runtime.dispose()
    }
  })
})
