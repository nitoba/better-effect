// oxlint-disable anti-slop/no-runtime-typeof -- token runtime tests inspect the Service protocol boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- generic Result fixture accepts placeholder values.
// oxlint-disable anti-slop/no-chained-type-assertions -- Result values are narrowed to the declaration-only Effect contract.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures intentionally erase placeholder DTO values.

import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { expect, test } from 'bun:test'
import { Effect, Layer, Runtime, ServiceNotFoundError, ServiceRuntime } from 'better-effect'
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

type StoreOperation<Name extends keyof JobStoreType.Contract> =
  JobStoreType.Contract[Name] extends (...arguments_: never[]) => infer Operation
    ? Operation
    : never

const success = <Operation>(value: unknown): Operation => Result.ok(value) as unknown as Operation

const contract: JobStoreType.Contract = {
  protocolVersion: 1,
  capabilities: {
    notifications: false,
    queueFilteredNotifications: false,
    batchClaim: false,
    transactionalEnqueue: false,
    changeFeed: false
  },
  enqueue: () => success<StoreOperation<'enqueue'>>({} as EnqueueResult),
  enqueueMany: () => success<StoreOperation<'enqueueMany'>>([]),
  claim: () => success<StoreOperation<'claim'>>({} as JobStoreType.ClaimResult),
  settle: () => success<StoreOperation<'settle'>>({} as JobStoreType.SettlementResult),
  release: () => success<StoreOperation<'release'>>({} as JobStoreType.ReleaseResult),
  heartbeat: () => success<StoreOperation<'heartbeat'>>({} as JobStoreType.HeartbeatResult),
  recoverStalled: () =>
    success<StoreOperation<'recoverStalled'>>({} as JobStoreType.RecoverStalledResult),
  awaitWake: () => success<StoreOperation<'awaitWake'>>(undefined),
  getJob: () => success<StoreOperation<'getJob'>>(undefined),
  getAttempts: () => success<StoreOperation<'getAttempts'>>([]),
  list: () => success<StoreOperation<'list'>>({ jobs: [], nextCursor: undefined }),
  counts: () =>
    success<StoreOperation<'counts'>>({
      total: 0,
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    }),
  redrive: () => success<StoreOperation<'redrive'>>({} as JobStoreType.RedriveResult),
  cancel: () => success<StoreOperation<'cancel'>>({} as JobStoreType.CancelResult),
  requestCancellation: () =>
    success<StoreOperation<'requestCancellation'>>({} as JobStoreType.RequestCancellationResult),
  promote: () => success<StoreOperation<'promote'>>({} as JobStoreType.PromoteResult),
  remove: () => success<StoreOperation<'remove'>>({} as JobStoreType.RemoveResult),
  pause: () => success<StoreOperation<'pause'>>({ queue: 'jobs' as never, paused: true }),
  resume: () => success<StoreOperation<'resume'>>({ queue: 'jobs' as never, paused: false }),
  pausedQueues: () => success<StoreOperation<'pausedQueues'>>([])
}

const implementation = JobStore.of(contract)

test('JobStore exposes stable default and named yieldable tokens', () => {
  const durable = JobStore.named('durable')
  const durableAgain = JobStore.named('durable')
  const ephemeral = JobStore.named('ephemeral')

  expect(JobStore.serviceTag).toBe('@better-effect/mq/JobStore')
  expect(durable.serviceTag).toBe('@better-effect/mq/JobStore/durable')
  expect(durable).not.toBe(durableAgain)
  expect(durableAgain.serviceTag).toBe(durable.serviceTag)
  expect(ephemeral).not.toBe(durable)
  expect(ephemeral.serviceTag).not.toBe(durable.serviceTag)
  expect(typeof JobStore[Symbol.asyncIterator]).toBe('function')
  expect(typeof durable[Symbol.asyncIterator]).toBe('function')
  expect(() => JobStore.named('' as unknown as never)).toThrow()
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

test('async adapter operations defer through Result.await and preserve the consumer boundary', async () => {
  let resolveWake!: (value: Awaited<StoreOperation<'awaitWake'>>) => void
  const wake = new Promise<Awaited<StoreOperation<'awaitWake'>>>((resolve) => {
    resolveWake = resolve
  })
  const asyncContract: JobStoreType.Contract = {
    ...contract,
    pausedQueues: async () => success<Awaited<StoreOperation<'pausedQueues'>>>([]),
    awaitWake: () => wake
  }
  const asyncStore = JobStore.of(asyncContract)
  const layer = Layer.succeed(JobStore, asyncStore)
  let settled = false
  const execution = Runtime.run(layer, () =>
    Effect.gen(async function* () {
      const store = yield* JobStore
      const queues = yield* Result.await(Promise.resolve(store.pausedQueues()))
      yield* Result.await(
        Promise.resolve(
          store.awaitWake({
            queues: [],
            wakeToken: 'wake' as never,
            signal: new AbortController().signal
          })
        )
      )

      return Result.ok(queues.length === 0)
    })
  ).then((result) => {
    settled = true
    return result
  })

  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(settled).toBe(false)

  resolveWake(success<Awaited<StoreOperation<'awaitWake'>>>(undefined))
  expect((await execution).unwrap()).toBe(true)
})

test('a wrong named token is rejected by the runtime resolver', async () => {
  const right = JobStore.named('runtime-right')
  const wrong = JobStore.named('runtime-wrong')
  const layer = Layer.succeed(right, right.of(contract))
  const execution = Runtime.run(layer, () => ServiceRuntime.resolve(wrong))

  const error = await execution.then(
    () => undefined,
    (cause) => cause
  )
  expect(error).toBeInstanceOf(ServiceNotFoundError)
})

test('named tokens from duplicate package copies resolve by their stable tag', async () => {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const temporaryRoot = await mkdtemp(join(packageRoot, '..', 'better-effect-mq-token-copy-'))

  try {
    await cp(join(packageRoot, 'src'), join(temporaryRoot, 'src'), { recursive: true })
    await symlink(join(packageRoot, 'node_modules'), join(temporaryRoot, 'node_modules'))
    const duplicate = await import(pathToFileURL(join(temporaryRoot, 'src/index.ts')).href)
    const local = JobStore.named('duplicate-runtime')
    const foreign = duplicate.JobStore.named('duplicate-runtime')
    const layer = Layer.succeed(local, local.of(contract))
    const value = await Runtime.run(layer, (() =>
      Effect.gen(async function* () {
        const store = yield* foreign
        return Result.ok(store === implementation)
      })) as never)

    expect(local).not.toBe(foreign)
    expect(local.serviceTag).toBe(foreign.serviceTag)
    expect((value as { unwrap: () => boolean }).unwrap()).toBe(true)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('wake abort is a focused tagged store error', () => {
  const error = new JobStoreWakeAbortedError()

  expect(error._tag).toBe('JobStoreWakeAbortedError')
  expect(JobStoreWakeAbortedError.is(error)).toBe(true)
  expect(error.message).toContain('aborted')
})
