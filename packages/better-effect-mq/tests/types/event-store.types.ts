import { expectTypeOf } from 'bun:test'
import { Effect, Layer } from 'better-effect'
import { Result } from 'better-result'

import {
  JobEventStore,
  JobStore,
  MemoryJobEventStore,
  MemoryJobStore,
  type DurableJobEvent,
  type JobEventCursor,
  type JobEventStoreContract,
  type JobEventStoreOperation
} from '../../src'

const defaultEvents = MemoryJobEventStore.make()
const defaultJobs = MemoryJobStore.make({ eventStore: defaultEvents })
const eventLayer = MemoryJobEventStore.layer
const jobLayer = MemoryJobStore.layerWith({ eventStore: defaultEvents })
const named = JobStore.named('events-types')
const namedEvents = JobEventStore.for(named)
const namedLayer = MemoryJobEventStore.layerFor(namedEvents)

expectTypeOf(defaultEvents).toMatchTypeOf<JobEventStoreContract>()
expectTypeOf(defaultJobs).toMatchTypeOf<JobStore.Contract>()
expectTypeOf(eventLayer).toMatchTypeOf<Layer<JobEventStore.Instance, never>>()
expectTypeOf(jobLayer).toMatchTypeOf<Layer<JobStore.Instance, never>>()
expectTypeOf(namedEvents).toMatchTypeOf<JobEventStore.Token<typeof named>>()
expectTypeOf(namedLayer).toMatchTypeOf<Layer<JobEventStore.Instance<typeof named>, never>>()
expectTypeOf<JobEventCursor>().toMatchTypeOf<string>()
expectTypeOf<DurableJobEvent>().toHaveProperty('cursor')

const read = defaultEvents.read({ limit: 10 })
expectTypeOf(read).toMatchTypeOf<JobEventStoreOperation<import('../../src').JobEventPage>>()

const program = Effect.gen(async function* () {
  const events = yield* JobEventStore
  const page = yield* Result.await(Promise.resolve(events.read({})))
  return Result.ok(page.events.length)
})

expectTypeOf<
  import('better-effect').EffectRequirements<typeof program>
>().toEqualTypeOf<JobEventStore.Instance>()
void program
void eventLayer
void defaultJobs
