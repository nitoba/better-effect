import { createClient } from 'redis'

import { RedisClient, type RedisJobStoreConfig } from '../../src/index'

const client = createClient()
const config: RedisJobStoreConfig = { client }
const layer = RedisClient.layer(config)
void layer
