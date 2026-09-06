import { RedisFlowStore } from '../../src/index'
import type { RedisClient } from '../../src/index'
import type { FlowStoreV2, FlowStoreV2Descriptor } from 'better-effect-mq'

declare const redis: RedisClient

const store = RedisFlowStore.make(redis)
const compatible: FlowStoreV2 = store
const descriptor: FlowStoreV2Descriptor = store.descriptor

void compatible
void descriptor
