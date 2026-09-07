import { expectTypeOf } from 'bun:test'
import type { Layer } from 'better-effect'
import { JobEventStore, JobStore } from 'better-effect-mq'
import { SqliteJobEventStore, SqliteJobStore } from '../../src'

declare const database: import('../../src').SqliteDatabase

const config = { database, namespace: 'types' } as const
const named = JobStore.named('types-events')
const namedEvents = JobEventStore.for(named)

const defaultLayer = SqliteJobStore.layerWithEvents(config)
const namedLayer = SqliteJobStore.layerWithEventsFor(named, config, {
  retention: { count: 10 }
})
const eventLayer = SqliteJobEventStore.layerFor(namedEvents, config)

expectTypeOf(defaultLayer).toMatchTypeOf<Layer<JobStore.Instance | JobEventStore.Instance, never>>()
expectTypeOf(namedLayer).toMatchTypeOf<
  Layer<JobStore.Instance<'types-events'> | JobEventStore.Instance<typeof named>, never>
>()
expectTypeOf(eventLayer).toMatchTypeOf<Layer<JobEventStore.Instance<typeof named>, never>>()
