import { expect, test } from 'bun:test'
import { Result } from 'better-result'

import {
  MemoryOutboxStore,
  OutboxConflictError,
  OutboxId,
  OutboxLeaseToken,
  OutboxWorkerId,
  makeOutboxRecord,
  validatePreparedEnqueue,
  validateOutboxRecord,
  type OutboxRecord
} from '../src'
import type { OutboxOperation, OutboxStoreError } from '../src'

const resolve = async <Value, Failure extends OutboxStoreError>(
  operation: OutboxOperation<Value, Failure>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const request = validatePreparedEnqueue({
  protocolVersion: 1,
  identity: { queue: 'jobs', name: 'send', version: 1 },
  payload: { message: 'hello' },
  metadata: { tenant: 'acme' },
  priority: 0,
  runAt: 0,
  attemptsMax: 3,
  now: 0
}).unwrap()

const record = (id: string, overrides: Partial<OutboxRecord> = {}) =>
  makeOutboxRecord({
    id: OutboxId.make(id).unwrap(),
    target: 'jobs-memory',
    request,
    nowMs: 0,
    ...overrides
  }).unwrap()

test('MemoryOutboxStore is idempotent for the same OutboxId and rejects conflicting requests', async () => {
  const store = MemoryOutboxStore.make()
  const first = await resolve(store.append(record('order-1')))
  const duplicate = await resolve(store.append(record('order-1')))

  expect(first.duplicate).toBe(false)
  expect(Result.isOk(validateOutboxRecord(first.record))).toBe(true)
  expect(duplicate.duplicate).toBe(true)
  expect(duplicate.record.requestDigest).toBe(first.record.requestDigest)

  const conflicting = await store.append(
    makeOutboxRecord({
      id: OutboxId.make('order-1').unwrap(),
      target: 'jobs-memory',
      request: validatePreparedEnqueue({
        ...request,
        payload: { message: 'different' }
      }).unwrap(),
      nowMs: 0
    }).unwrap()
  )

  expect(Result.isError(conflicting)).toBe(true)
  if (Result.isOk(conflicting)) return
  expect(OutboxConflictError.is(conflicting.error)).toBe(true)
})

test('MemoryOutboxStore redelivers after lease expiry and settles the duplicate publish once', async () => {
  const store = MemoryOutboxStore.make()
  await resolve(store.append(record('order-2')))

  const firstClaim = await resolve(
    store.claim({
      owner: OutboxWorkerId.make('publisher-1').unwrap(),
      limit: 1,
      leaseDurationMs: 10,
      nowMs: 0
    })
  )
  const first = firstClaim[0]
  if (first === undefined || first.leaseToken === undefined) throw new Error('missing first lease')

  const redelivery = await resolve(
    store.claim({
      owner: OutboxWorkerId.make('publisher-2').unwrap(),
      limit: 1,
      leaseDurationMs: 10,
      nowMs: 11
    })
  )
  const second = redelivery[0]
  if (second === undefined || second.leaseToken === undefined) throw new Error('missing redelivery')

  expect(second.id).toBe(first.id)
  expect(second.attemptsMade).toBe(2)
  expect(second.leaseToken).not.toBe(first.leaseToken)

  const published = await resolve(
    store.markPublished({ id: second.id, leaseToken: second.leaseToken, nowMs: 11 })
  )
  const acknowledged = await resolve(
    store.markPublished({
      id: second.id,
      leaseToken: OutboxLeaseToken.make('lost-response-retry').unwrap(),
      nowMs: 12
    })
  )

  expect(published.status).toBe('applied')
  expect(acknowledged.status).toBe('already-applied')
  expect((await resolve(store.get(second.id)))?.state).toBe('published')
})

test('the outbox is at-least-once, not exactly-once, across a publish crash window', async () => {
  const store = MemoryOutboxStore.make()
  await resolve(store.append(record('order-3')))

  const first = (
    await resolve(
      store.claim({
        owner: OutboxWorkerId.make('publisher-1').unwrap(),
        limit: 1,
        leaseDurationMs: 5,
        nowMs: 0
      })
    )
  )[0]
  if (first === undefined) throw new Error('missing first delivery')

  let deliveries = 0
  deliveries += 1
  // A crash here leaves the lease unsettled; the side effect may already have run.
  void first

  const second = (
    await resolve(
      store.claim({
        owner: OutboxWorkerId.make('publisher-2').unwrap(),
        limit: 1,
        leaseDurationMs: 5,
        nowMs: 6
      })
    )
  )[0]
  if (second === undefined) throw new Error('missing redelivery')
  deliveries += 1

  expect(deliveries).toBe(2)
  expect(second.id).toBe(first.id)
})
