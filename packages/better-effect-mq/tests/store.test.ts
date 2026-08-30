// oxlint-disable anti-slop/no-runtime-typeof -- token runtime tests inspect the Service protocol boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- Result values are narrowed to the declaration-only Effect contract.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures intentionally erase placeholder DTO values.

import { expect, test } from 'bun:test'
import { Effect, Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'

import {
  Codec,
  Job,
  JobStore,
  JobStoreWakeAbortedError,
  Queue,
  bindJob,
  type EnqueueResult,
  type JobStore as JobStoreType
} from '../src'

const success = <Value>(value: Value): JobStoreType.Effect<Value> =>
  Result.ok(value) as unknown as JobStoreType.Effect<Value>

const contract: JobStoreType.Contract = {
  protocolVersion: 1,
  capabilities: {
    notifications: false,
    batchClaim: false,
    transactionalEnqueue: false,
    changeFeed: false
  },
  enqueue: () => success({} as EnqueueResult),
  enqueueMany: () => success([]),
  claim: () => success({} as JobStoreType.ClaimResult),
  settle: () => success({} as JobStoreType.SettlementResult),
  release: () => success({} as JobStoreType.ReleaseResult),
  heartbeat: () => success({} as JobStoreType.HeartbeatResult),
  recoverStalled: () => success({} as JobStoreType.RecoverStalledResult),
  awaitWake: () => success(undefined),
  getJob: () => success(undefined),
  getAttempts: () => success([]),
  list: () => success({ jobs: [], nextCursor: undefined }),
  counts: () =>
    success({
      total: 0,
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    }),
  redrive: () => success({} as JobStoreType.RedriveResult),
  cancel: () => success({} as JobStoreType.CancelResult),
  requestCancellation: () => success({} as JobStoreType.RequestCancellationResult),
  promote: () => success({} as JobStoreType.PromoteResult),
  remove: () => success({} as JobStoreType.RemoveResult),
  pause: () => success({ queue: 'jobs' as never, paused: true }),
  resume: () => success({ queue: 'jobs' as never, paused: false }),
  pausedQueues: () => success([])
}

const implementation = JobStore.of(contract)

test('JobStore exposes cached default and named yieldable tokens', () => {
  const durable = JobStore.named('durable')
  const durableAgain = JobStore.named('durable')
  const ephemeral = JobStore.named('ephemeral')

  expect(JobStore.serviceTag).toBe('@better-effect/mq/JobStore')
  expect(durable.serviceTag).toBe('@better-effect/mq/JobStore/durable')
  expect(durable).toBe(durableAgain)
  expect(ephemeral).not.toBe(durable)
  expect(typeof JobStore[Symbol.asyncIterator]).toBe('function')
  expect(typeof durable[Symbol.asyncIterator]).toBe('function')
  expect(() => JobStore.named('' as string)).toThrow()
})

test('Job bindings are immutable descriptors and preserve the selected token', () => {
  const queue = Queue.define('jobs')
  const job = queue.job('send', { version: 1, payload: Codec.string })
  const durable = JobStore.named('durable')
  const bound = bindJob(job, durable)

  expect(bound).not.toBe(job)
  expect(bound.identity).toBe(job.identity)
  expect(bound.store).toBe(durable)
  expect(Job.is(bound)).toBe(true)
  expect(Object.isFrozen(bound)).toBe(true)
  expect(Reflect.set(bound, 'store', JobStore)).toBe(false)
  expect(Job.bind(job, durable).store).toBe(durable)
})

test('JobStore implementations can be provided and yielded without a backend', async () => {
  const layer = Layer.succeed(JobStore, implementation)
  const value = await Runtime.run(layer, async () =>
    Effect.gen(async function* () {
      const store = yield* JobStore
      return Result.ok(store === implementation && store.capabilities.batchClaim === false)
    })
  )

  expect(value.unwrap()).toBe(true)
})

test('named stores remain isolated when provided together', async () => {
  const durableToken = JobStore.named('test-durable')
  const ephemeralToken = JobStore.named('test-ephemeral')
  const durable = durableToken.of({
    ...contract,
    capabilities: { ...contract.capabilities, transactionalEnqueue: true }
  })
  const ephemeral = ephemeralToken.of(contract)
  const layer = Layer.merge(
    Layer.succeed(durableToken, durable),
    Layer.succeed(ephemeralToken, ephemeral)
  )
  const value = await Runtime.run(layer, async () =>
    Effect.gen(async function* () {
      const durableStore = yield* durableToken
      const ephemeralStore = yield* ephemeralToken
      return Result.ok([
        durableStore.capabilities.transactionalEnqueue,
        ephemeralStore.capabilities.transactionalEnqueue
      ] as const)
    })
  )

  expect(value.unwrap()).toEqual([true, false])
})

test('wake abort is a focused tagged store error', () => {
  const error = new JobStoreWakeAbortedError()

  expect(error._tag).toBe('JobStoreWakeAbortedError')
  expect(JobStoreWakeAbortedError.is(error)).toBe(true)
  expect(error.message).toContain('aborted')
})
