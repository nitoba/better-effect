// oxlint-disable anti-slop/no-runtime-typeof -- package smoke verifies an exported callable boundary.

import {
  RedisClient,
  loadRedisScriptManifest,
  makeRedisKeyLayout,
  redisHashSlot
} from 'better-effect-mq-redis'

const manifest = await loadRedisScriptManifest()
if (
  manifest.length !== 13 ||
  manifest.some((script) => !script.source.includes('MQ_FOUNDATION_READY'))
) {
  throw new Error('Redis scripts are missing from the packed package')
}

const layout = makeRedisKeyLayout('better-effect-mq', 'consumer')
if (redisHashSlot(layout.job('node')) !== redisHashSlot(layout.queue('emails'))) {
  throw new Error('Redis layout is not cluster-safe')
}
if (typeof RedisClient.layerFromConfig !== 'function') throw new Error('owned layer missing')
console.log('redis consumer ok')
