// oxlint-disable anti-slop/no-runtime-typeof -- package smoke verifies an exported callable boundary.

import {
  RedisClient,
  decodeDelayedMember,
  encodeDelayedMember,
  makeRedisKeyLayout,
  redisHashSlot
} from 'better-effect-mq-redis'

const layout = makeRedisKeyLayout('better-effect-mq', 'consumer')
const job = layout.job('consumer-job')
const waiting = layout.waiting('emails', 'send-email', 1)
if (redisHashSlot(job) !== redisHashSlot(waiting)) throw new Error('hash tag mismatch')
if (decodeDelayedMember(encodeDelayedMember(1, 'consumer-job')).jobId !== 'consumer-job') {
  throw new Error('codec mismatch')
}
if (typeof RedisClient.layer !== 'function') throw new Error('client layer missing')
console.log('redis consumer ok')
