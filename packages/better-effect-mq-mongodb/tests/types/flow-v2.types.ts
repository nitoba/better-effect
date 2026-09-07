// SAFETY: all assertions below are compile-time-only checks against an erased placeholder database.
import type { Layer } from 'better-effect'
import { FlowStore, JobStore } from 'better-effect-mq'

import {
  MongoFlowMigrator,
  MongoFlowStore,
  type MongoDb,
  type MongoJobStoreConfig,
  type MongoFlowStoreInstance
} from '../../src/index'

// SAFETY: these values are used only for compile-time API assertions.
const db = {} as MongoDb
const config: MongoJobStoreConfig = { db, validateLayout: false }
const Durable = JobStore.named('durable')
const DurableFlow = FlowStore.for(Durable)

const defaultLayer = MongoFlowStore.layer(config)
const namedLayer = MongoFlowStore.layerFor(Durable, config)
const namedFromConfigLayer = MongoFlowStore.layerFromConfigFor(Durable, {
  uri: 'mongodb://localhost:27017',
  database: 'application'
})

const defaultContract: Layer<InstanceType<typeof FlowStore>, never> = defaultLayer
const namedContract: Layer<InstanceType<typeof DurableFlow>, never> = namedLayer
const namedFromConfigContract: Layer<InstanceType<typeof DurableFlow>, never> = namedFromConfigLayer

type Store = Awaited<ReturnType<typeof MongoFlowStore.make>>
// SAFETY: the store value is never evaluated; the assertion checks the public return type.
const storeContract: MongoFlowStoreInstance = {} as Store
const flowContract: FlowStore.Contract = storeContract
const migration = MongoFlowMigrator.migrate({ db })

void defaultContract
void namedContract
void namedFromConfigContract
void flowContract
void migration
