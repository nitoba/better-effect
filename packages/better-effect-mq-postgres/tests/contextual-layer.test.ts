import { expect, test } from 'bun:test'
import { Layer, Runtime, Service, ServiceRuntime } from 'better-effect'
import type { ServiceRequirement } from 'better-effect'
import { FlowStore, JobScheduleStore, JobStore } from 'better-effect-mq'
import {
  PostgresFlowStore,
  PostgresJobEventStore,
  PostgresJobScheduleStore,
  PostgresJobStore,
  PostgresOutbox,
  type Pool,
  type PostgresLayerRequirements
} from '../src'

class SharedPool extends Service<SharedPool>()('@test/PostgresSharedPool') {
  declare readonly raw: Pool
}

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false
type Assert<Value extends true> = Value

const NamedJobStore = JobStore.named('contextual')
const NamedScheduleStore = JobScheduleStore.for(NamedJobStore)
const NamedFlowStore = FlowStore.for(NamedJobStore)

const contextualConfig = function* () {
  const shared = yield* SharedPool
  return { pool: shared.raw, validateSchema: false }
}

const contextualConnectionConfig = function* () {
  yield* SharedPool
  return { connectionString: 'postgres://localhost/contextual' }
}

const contextualStoreLayer = PostgresJobStore.layerWith(contextualConfig)
const contextualNamedStoreLayer = PostgresJobStore.layerWithFor(NamedJobStore, contextualConfig)
const contextualScheduleLayer = PostgresJobScheduleStore.layerWith(contextualConfig)
const contextualNamedScheduleLayer = PostgresJobScheduleStore.layerWithFor(
  NamedScheduleStore,
  contextualConfig
)
const contextualEventLayer = PostgresJobEventStore.layerWith(contextualConfig)
const contextualOutboxLayer = PostgresOutbox.layerWith(contextualConfig)
const contextualFlowLayer = PostgresFlowStore.layerWith(contextualConfig)
const contextualNamedFlowLayer = PostgresFlowStore.layerWithFor(NamedFlowStore, contextualConfig)
const contextualOwnedStoreLayer = PostgresJobStore.layerFromConfigWith(contextualConnectionConfig)

type _StoreRequirements = Assert<Equal<Layer.Required<typeof contextualStoreLayer>, SharedPool>>
type _NamedStoreRequirements = Assert<
  Equal<Layer.Required<typeof contextualNamedStoreLayer>, SharedPool>
>
type _ScheduleRequirements = Assert<
  Equal<Layer.Required<typeof contextualScheduleLayer>, InstanceType<typeof JobStore> | SharedPool>
>
type _NamedScheduleRequirements = Assert<
  Equal<
    Layer.Required<typeof contextualNamedScheduleLayer>,
    InstanceType<typeof NamedJobStore> | SharedPool
  >
>
type _EventRequirements = Assert<Equal<Layer.Required<typeof contextualEventLayer>, SharedPool>>
type _OutboxRequirements = Assert<Equal<Layer.Required<typeof contextualOutboxLayer>, SharedPool>>
type _FlowRequirements = Assert<
  Equal<Layer.Required<typeof contextualFlowLayer>, InstanceType<typeof JobStore> | SharedPool>
>
type _NamedFlowRequirements = Assert<
  Equal<
    Layer.Required<typeof contextualNamedFlowLayer>,
    InstanceType<typeof NamedJobStore> | SharedPool
  >
>
type _OwnedStoreRequirements = Assert<
  Equal<Layer.Required<typeof contextualOwnedStoreLayer>, SharedPool>
>

test('contextual borrowed Layers resolve their pool during Runtime acquisition', async () => {
  let factoryCalls = 0
  let endCalls = 0
  const pool: Pool = {
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => undefined
    }),
    end: async () => {
      endCalls += 1
    }
  }
  const layer = PostgresJobStore.layerWith(async function* () {
    factoryCalls += 1
    const shared = yield* SharedPool
    return { pool: shared.raw, validateSchema: false }
  })
  type _AsyncContextualRequirements = Assert<Equal<Layer.Required<typeof layer>, SharedPool>>
  type _MarkerRequirements = Assert<
    Equal<PostgresLayerRequirements<ServiceRequirement<SharedPool>>, SharedPool>
  >
  expect(factoryCalls).toBe(0)
  const runtime = await Runtime.make(
    Layer.complete(Layer.merge(Layer.succeed(SharedPool, SharedPool.of({ raw: pool })), layer))
  )

  try {
    const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
    expect(store.descriptor.adapter).toBe('postgres')
    expect(factoryCalls).toBe(1)
  } finally {
    await runtime.dispose()
  }

  expect(endCalls).toBe(0)
})
