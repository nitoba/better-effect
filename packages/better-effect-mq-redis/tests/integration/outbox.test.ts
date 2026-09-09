// Redis integration tests are intentionally safe to run without a local server.

import { describe, expect, test } from 'bun:test'
import { Result, type Result as ResultType } from 'better-result'
import {
  OutboxId,
  OutboxStore,
  OutboxWorkerId,
  makeOutboxRecord,
  validatePreparedEnqueue,
  type OutboxOperation,
  type OutboxStoreError
} from 'better-effect-mq-outbox'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { RedisClient, RedisOutbox, RedisOutboxStore } from '../../src'

const url = process.env.REDIS_URL
const integration = url === undefined ? test.skip : test
let sequence = 0

const prepared = validatePreparedEnqueue({
  protocolVersion: 1,
  identity: { queue: 'orders', name: 'send-confirmation', version: 1 },
  payload: { orderId: 'order-1' },
  metadata: {},
  priority: 0,
  runAt: 0,
  attemptsMax: 3,
  now: 0
}).unwrap()

const record = (id: string) =>
  makeOutboxRecord({
    id: OutboxId.make(id).unwrap(),
    target: 'orders',
    request: prepared,
    nowMs: 0
  }).unwrap()

const unwrap = async <Value, Failure extends OutboxStoreError>(
  operation: OutboxOperation<Value, Failure>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const unwrapResult = async <Value, Failure>(
  operation: PromiseLike<ResultType<Value, Failure>>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

describe('RedisOutboxStore integration', () => {
  integration('appends, recovers expired leases, and settles records', async () => {
    if (url === undefined) return
    const namespace = `outbox-${process.pid}-${Date.now()}-${sequence++}`
    const config = { url, namespace, prefix: 'better-effect-mq-test' }
    const runtime = await Runtime.make(
      Layer.merge(RedisOutboxStore.layerFromConfig(config), RedisClient.layerFromConfig(config))
    )

    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(OutboxStore))
      const redis = await runtime.run(() => ServiceRuntime.resolve(RedisClient))
      const input = record('order-1')
      const first = await unwrapResult(RedisOutbox.append(redis, input))
      const duplicate = await unwrapResult(RedisOutbox.append(redis, input))
      expect(first.duplicate).toBe(false)
      expect(duplicate.duplicate).toBe(true)

      const initial = (
        await unwrap(
          store.claim({
            owner: OutboxWorkerId.make('worker-1').unwrap(),
            limit: 1,
            leaseDurationMs: 10,
            nowMs: 0
          })
        )
      )[0]
      if (initial === undefined) throw new Error('initial claim missing')

      const redelivered = (
        await unwrap(
          store.claim({
            owner: OutboxWorkerId.make('worker-2').unwrap(),
            limit: 1,
            leaseDurationMs: 10,
            nowMs: 10
          })
        )
      )[0]
      if (redelivered === undefined) throw new Error('recovered claim missing')
      expect(redelivered.id).toBe(initial.id)
      expect(redelivered.attemptsMade).toBe(2)
      expect(redelivered.leaseToken).not.toBe(initial.leaseToken)

      const published = await unwrap(
        store.markPublished({
          id: redelivered.id,
          leaseToken: redelivered.leaseToken,
          nowMs: 11
        })
      )
      expect(published.status).toBe('applied')
      expect((await unwrap(store.counts())).published).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })
})
