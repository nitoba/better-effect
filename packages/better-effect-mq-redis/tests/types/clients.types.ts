import { createClient } from 'redis'

import { RedisClient, RedisJobStore, type RedisJobStoreConfig } from '../../src/index'

const client = createClient()
const config: RedisJobStoreConfig = { client }
const layer = RedisClient.layer(config)
const storeLayer = RedisJobStore.layer(config)
void layer
void storeLayer
