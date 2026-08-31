import { expectTypeOf } from 'bun:test'
import { Effect, Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'

import {
  JobStore,
  MemoryJobStore,
  type MemoryJobStoreClock,
  type MemoryJobStoreIdGenerator,
  type MemoryJobStoreOptions
} from '../../src'

const clock: MemoryJobStoreClock = {
  now: () => new Date(0)
}
const idGenerator: MemoryJobStoreIdGenerator = {
  next: () => 'deterministic-id'
}
const options: MemoryJobStoreOptions = { clock, idGenerator }
const defaultStore = MemoryJobStore.make(options)
const defaultLayer = MemoryJobStore.layerWith(options)
const named = JobStore.named('memory-types')
const namedLayer = MemoryJobStore.layerFor(named, options)

expectTypeOf(defaultStore).toEqualTypeOf<JobStore.Contract>()
expectTypeOf(defaultLayer).toMatchTypeOf<Layer<JobStore.Instance, never>>()
expectTypeOf(namedLayer).toMatchTypeOf<Layer<JobStore.Instance<'memory-types'>, never>>()

const program = () =>
  Effect.gen(async function* () {
    const store = yield* JobStore
    const counts = yield* Result.await(Promise.resolve(store.counts()))
    return Result.ok(counts.total)
  })

void Runtime.run(defaultLayer, program)
void defaultStore
void namedLayer
