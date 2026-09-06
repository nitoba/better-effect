// oxlint-disable anti-slop/no-chained-type-assertions -- incomplete adapter test doubles are confined to exercised methods.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test doubles preserve the protocol methods used by each scenario.

import { expect, test } from 'bun:test'
import { Layer, Runtime } from 'better-effect'
import { JobStore, JobStoreFailure, MemoryJobStore, type JobStoreContract } from 'better-effect-mq'
import { Result } from 'better-result'

import {
  MemoryOutboxStore,
  OutboxId,
  OutboxPublisher,
  OutboxRoutes,
  OutboxStore,
  OutboxWorkerId,
  makeOutboxRecord,
  validatePreparedEnqueue,
  type OutboxOperation,
  type OutboxPublisherEvent,
  type OutboxStore as OutboxStoreContract
} from '../src'

const resolveOutbox = async <Value>(operation: OutboxOperation<Value>): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await sleep(2)
  }
  throw new Error('condition did not become true')
}

const makeRecord = (id: string, attemptsMax = 3) => {
  const now = Date.now()
  const request = validatePreparedEnqueue({
    protocolVersion: 1,
    identity: { queue: 'publisher-shutdown-tests', name: 'publish', version: 1 },
    payload: { id },
    metadata: {},
    priority: 0,
    runAt: now,
    attemptsMax,
    now
  }).unwrap()
  return makeOutboxRecord({
    id: OutboxId.make(id).unwrap(),
    target: 'jobs',
    request,
    attemptsMax,
    nowMs: now
  }).unwrap()
}

const wrapOutbox = (
  base: ReturnType<typeof MemoryOutboxStore.make>,
  overrides: Partial<OutboxStoreContract>
): OutboxStoreContract =>
  ({
    descriptor: base.descriptor,
    claim: base.claim.bind(base),
    heartbeat: base.heartbeat.bind(base),
    markPublished: base.markPublished.bind(base),
    markRetry: base.markRetry.bind(base),
    markFailed: base.markFailed.bind(base),
    release: base.release.bind(base),
    recoverStalled: base.recoverStalled.bind(base),
    get: base.get.bind(base),
    list: base.list.bind(base),
    counts: base.counts.bind(base),
    ...overrides
  }) as OutboxStoreContract

test('retryable enqueue failures use bounded exponential markRetry backoff', async () => {
  const outbox = MemoryOutboxStore.make()
  await resolveOutbox(outbox.append(makeRecord('retry-1', 3)))
  let enqueueAttempts = 0
  const jobsToken = JobStore.named('publisher-retry')
  const jobDescriptor = MemoryJobStore.make().descriptor
  const jobs = JobStore.of({
    descriptor: jobDescriptor,
    enqueue: () => {
      enqueueAttempts += 1
      return Result.err(new JobStoreFailure({ operation: 'enqueue', retryable: true }))
    }
  } as unknown as JobStoreContract)
  const outboxToken = OutboxStore.named('publisher-retry')
  const publisher = OutboxPublisher.service('PublisherRetry')
  const events: OutboxPublisherEvent[] = []
  const runtime = await Runtime.make(
    Layer.complete(
      Layer.merge(
        Layer.succeed(outboxToken, OutboxStore.of(outbox)),
        Layer.succeed(jobsToken, jobs),
        publisher.layer(async function* () {
          yield* []
          return {
            outboxes: [outboxToken] as const,
            routes: OutboxRoutes.make({ jobs: jobsToken }),
            pollIntervalMs: 1,
            retryBaseDelayMs: 20,
            retryMaxDelayMs: 25,
            workerId: OutboxWorkerId.make('publisher-retry').unwrap(),
            observer: {
              onEvent: (event: OutboxPublisherEvent): void => {
                events.push(event)
              }
            }
          }
        })
      )
    )
  )

  try {
    await runtime.warmup()
    await waitFor(() => events.some((event) => event.type === 'retry-scheduled'))
    expect(enqueueAttempts).toBe(1)
    const pending = await resolveOutbox(outbox.get(OutboxId.make('retry-1').unwrap()))
    expect(pending?.state).toBe('pending')
    expect(pending?.failure?.kind).toBe('store-transient')
    expect(pending?.runAtMs).toBeGreaterThan(pending?.updatedAtMs ?? 0)
  } finally {
    await runtime.dispose()
  }
})

test('heartbeat keeps an admitted lease alive and Runtime disposal drains it', async () => {
  const outbox = MemoryOutboxStore.make()
  await resolveOutbox(outbox.append(makeRecord('shutdown-1', 1)))
  let heartbeats = 0
  let releaseEnqueue: (() => void) | undefined
  const baseOutbox = outbox
  const controlledOutbox = wrapOutbox(baseOutbox, {
    heartbeat: (request) => {
      heartbeats += 1
      return baseOutbox.heartbeat(request)
    }
  })
  const jobsToken = JobStore.named('publisher-shutdown')
  const jobDescriptor = MemoryJobStore.make().descriptor
  const blockedJobs = JobStore.of({
    descriptor: jobDescriptor,
    enqueue: () =>
      new Promise<void>((resolve) => {
        releaseEnqueue = resolve
      }).then(() => Result.ok({ job: {} as never, duplicate: false }))
  } as unknown as JobStoreContract)
  const outboxToken = OutboxStore.named('publisher-shutdown')
  const publisher = OutboxPublisher.service('PublisherShutdown')
  const runtime = await Runtime.make(
    Layer.complete(
      Layer.merge(
        Layer.succeed(outboxToken, OutboxStore.of(controlledOutbox)),
        Layer.succeed(jobsToken, JobStore.of(blockedJobs)),
        publisher.layer(async function* () {
          yield* []
          return {
            outboxes: [outboxToken] as const,
            routes: OutboxRoutes.make({ jobs: jobsToken }),
            concurrency: 1,
            leaseDurationMs: 40,
            heartbeatIntervalMs: 5,
            pollIntervalMs: 1,
            workerId: OutboxWorkerId.make('publisher-shutdown').unwrap()
          }
        })
      )
    )
  )

  try {
    await runtime.warmup()
    await waitFor(() => releaseEnqueue !== undefined)
    await sleep(18)
    expect(heartbeats).toBeGreaterThan(0)

    let disposed = false
    const disposal = runtime.dispose().then(() => {
      disposed = true
    })
    await sleep(10)
    expect(disposed).toBe(false)

    releaseEnqueue?.()
    await disposal
    const published = await resolveOutbox(outbox.get(OutboxId.make('shutdown-1').unwrap()))
    expect(published?.state).toBe('published')
  } finally {
    if (runtime.inspect().state !== 'disposed') {
      releaseEnqueue?.()
      await runtime.dispose()
    }
  }
})

test('publisher admission applies the configured concurrency cap', async () => {
  const outbox = MemoryOutboxStore.make()
  await resolveOutbox(outbox.append(makeRecord('capacity-1', 1)))
  await resolveOutbox(outbox.append(makeRecord('capacity-2', 1)))
  const resolvers: Array<() => void> = []
  const success = Result.ok({ job: {} as never, duplicate: false })
  const jobsToken = JobStore.named('publisher-capacity')
  const jobDescriptor = MemoryJobStore.make().descriptor
  const jobs = JobStore.of({
    descriptor: jobDescriptor,
    enqueue: () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve)
      }).then(() => success)
  } as unknown as JobStoreContract)
  const outboxToken = OutboxStore.named('publisher-capacity')
  const publisher = OutboxPublisher.service('PublisherCapacity')
  const events: OutboxPublisherEvent[] = []
  const runtime = await Runtime.make(
    Layer.complete(
      Layer.merge(
        Layer.succeed(outboxToken, OutboxStore.of(outbox)),
        Layer.succeed(jobsToken, jobs),
        publisher.layer(async function* () {
          yield* []
          return {
            outboxes: [outboxToken] as const,
            routes: OutboxRoutes.make({ jobs: jobsToken }),
            concurrency: 1,
            leaseDurationMs: 100,
            heartbeatIntervalMs: 10,
            pollIntervalMs: 1,
            workerId: OutboxWorkerId.make('publisher-capacity').unwrap(),
            observer: {
              onEvent: (event: OutboxPublisherEvent): void => {
                events.push(event)
              }
            }
          }
        })
      )
    )
  )

  try {
    await runtime.warmup()
    await waitFor(() => resolvers.length === 1)
    await sleep(12)
    expect(events.filter((event) => event.type === 'claimed')).toHaveLength(1)

    resolvers.shift()?.()
    await waitFor(() => resolvers.length === 1)
    expect(events.filter((event) => event.type === 'claimed')).toHaveLength(2)
    resolvers.shift()?.()
    await sleep(12)

    expect((await resolveOutbox(outbox.get(OutboxId.make('capacity-1').unwrap())))?.state).toBe(
      'published'
    )
    expect((await resolveOutbox(outbox.get(OutboxId.make('capacity-2').unwrap())))?.state).toBe(
      'published'
    )
  } finally {
    resolvers.forEach((resolve) => resolve())
    await runtime.dispose()
  }
})
