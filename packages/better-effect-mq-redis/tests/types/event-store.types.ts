import { expectTypeOf } from 'bun:test'
import { Layer } from 'better-effect'
import {
  JobEventStore,
  JobStore,
  type JobEventStoreContract,
  type JobEventStoreOperation
} from 'better-effect-mq'
import {
  RedisJobEventStore,
  RedisJobStore,
  type RedisJobEventStoreOptions,
  type RedisJobStoreConnectionConfig
} from '../../src'

const config: RedisJobStoreConnectionConfig = { namespace: 'type-events' }
const defaultLayer = RedisJobStore.layerWithEventsFromConfig(config)
const defaultEvents = RedisJobEventStore.layerFromConfig(config)
const named = JobStore.named('type-events-named')
const namedEvents = JobEventStore.for(named)
const namedLayer = RedisJobStore.layerWithEventsFromConfigFor(named, config)
const namedReader = RedisJobEventStore.layerFromConfigFor(namedEvents, config)

expectTypeOf(defaultLayer).toMatchTypeOf<Layer<JobStore.Instance | JobEventStore.Instance, never>>()
expectTypeOf(defaultEvents).toMatchTypeOf<Layer<JobEventStore.Instance, never>>()
expectTypeOf(namedLayer).toMatchTypeOf<
  Layer<JobStore.Instance<'type-events-named'> | JobEventStore.Instance<typeof named>, never>
>()
expectTypeOf(namedReader).toMatchTypeOf<Layer<JobEventStore.Instance<typeof named>, never>>()

const options: RedisJobEventStoreOptions = { retention: { ageMs: 60_000, count: 100 } }
// SAFETY: this assertion supplies a structural contract fixture for the type-only test.
const operation = ({} as JobEventStoreContract).read({ limit: 1 })
expectTypeOf(operation).toMatchTypeOf<JobEventStoreOperation<JobEventStore.Page>>()
void options
void defaultLayer
void defaultEvents
void namedLayer
void namedReader
