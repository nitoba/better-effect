import { createClient } from 'redis'

import type { Layer } from 'better-effect'
import { JobScheduleStore, JobStore } from 'better-effect-mq'

import { RedisJobScheduleStore, type RedisJobStoreConfig } from '../../src/index'

const client = createClient()
const config: RedisJobStoreConfig = { client }
const Durable = JobStore.named('durable')
const DurableSchedules = JobScheduleStore.for(Durable)

const defaultLayer = RedisJobScheduleStore.layer(config)
const namedLayer = RedisJobScheduleStore.layerFor(DurableSchedules, config)

const defaultContract: Layer<
  InstanceType<typeof JobScheduleStore>,
  InstanceType<typeof JobStore>
> = defaultLayer
const namedContract: Layer<
  InstanceType<typeof DurableSchedules>,
  InstanceType<typeof Durable>
> = namedLayer

void defaultContract
void namedContract
