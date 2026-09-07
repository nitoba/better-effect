import { expectTypeOf } from 'bun:test'
import { Layer } from 'better-effect'
import { FlowStore, JobStore, type FlowStoreV2 } from 'better-effect-mq'
import { SqliteFlowStore, type SqliteDatabase } from '../../src'

declare const database: SqliteDatabase

const store = SqliteFlowStore.make({ database, validateSchema: false })
expectTypeOf(store).toMatchTypeOf<FlowStoreV2>()

const defaultLayer = SqliteFlowStore.layer({ database, validateSchema: false })
expectTypeOf(defaultLayer).toMatchTypeOf<Layer<FlowStore.Instance, never>>()

const namedJobStore = JobStore.named('billing')
const namedFlowStore = FlowStore.for(namedJobStore)
const namedLayer = SqliteFlowStore.layerFor(namedFlowStore, { database, validateSchema: false })
expectTypeOf(namedLayer).toMatchTypeOf<Layer<FlowStore.Instance<typeof namedJobStore>, never>>()
