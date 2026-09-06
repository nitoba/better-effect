// oxlint-disable anti-slop/no-unsafe-dictionary-type -- request overrides are test-only DTO fixtures.
// oxlint-disable anti-slop/no-chained-type-assertions -- incomplete adapter test doubles are confined to exercised methods.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test doubles preserve the protocol methods used by each scenario.

import { expect, test } from 'bun:test'
import { Layer, Runtime } from 'better-effect'
import {
  JobStore,
  MemoryJobStore,
  JobStoreFailure,
  type AnyJobStoreToken,
  type JobStoreContract,
  type JobStoreOperation
} from 'better-effect-mq'
import { Result } from 'better-result'

import {
  MemoryOutboxStore,
  OutboxId,
  OutboxPublisher,
  OutboxRouteMissingError,
  type OutboxPublisherEvent,
  type OutboxPublisherServiceToken,
  OutboxRoutes,
  OutboxStore,
  type OutboxRouteMap,
  type OutboxStoreTokenLike,
  makeOutboxRecord,
  validatePreparedEnqueue,
  type OutboxOperation,
  type OutboxRecord
} from '../src'

const resolveOutbox = async <Value>(operation: OutboxOperation<Value>): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const resolveJob = async <Value>(operation: JobStoreOperation<Value>): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const waitForState = async (
  store: ReturnType<typeof MemoryOutboxStore.make>,
  id: OutboxRecord['id'],
  state: OutboxRecord['state']
): Promise<OutboxRecord> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await resolveOutbox(store.get(id))
    if (current?.state === state) return current
    await sleep(2)
  }
  throw new Error(`outbox record ${id} did not reach ${state}`)
}

const request = (overrides: Record<string, unknown> = {}) =>
  validatePreparedEnqueue({
    protocolVersion: 1,
    identity: { queue: 'publisher-tests', name: 'publish', version: 1 },
    payload: { value: 1 },
    metadata: {},
    priority: 0,
    runAt: Date.now(),
    attemptsMax: 3,
    now: Date.now(),
    ...overrides
  }).unwrap()

const record = (id: string, target: string, prepared = request()): OutboxRecord =>
  makeOutboxRecord({
    id: OutboxId.make(id).unwrap(),
    target,
    request: prepared,
    attemptsMax: prepared.attemptsMax,
    nowMs: prepared.now
  }).unwrap()

const makeLayer = <
  const Tag extends string,
  const OutboxToken extends OutboxStoreTokenLike,
  const JobsToken extends AnyJobStoreToken,
  const Routes extends OutboxRouteMap
>(
  publisher: OutboxPublisherServiceToken<Tag>,
  outboxToken: OutboxToken,
  outbox: ReturnType<typeof MemoryOutboxStore.make>,
  jobsToken: JobsToken,
  jobs: JobStoreContract,
  routes: OutboxRoutes<Routes>,
  events: { readonly push: (event: OutboxPublisherEvent) => number },
  onError?: (cause: unknown) => void
) => {
  const reportError = onError ?? (() => undefined)
  return publisher.layer(() => ({
    outboxes: [outboxToken] as const,
    routes,
    concurrency: 1,
    leaseDurationMs: 100,
    heartbeatIntervalMs: 10,
    pollIntervalMs: 1,
    now: () => Date.now(),
    observer: {
      onEvent: (event: OutboxPublisherEvent): void => {
        events.push(event)
      }
    },
    onError: reportError
  }))
}

test('OutboxPublisher claims, enqueues, and fences markPublished', async () => {
  const outbox = MemoryOutboxStore.make()
  await resolveOutbox(outbox.append(record('publish-1', 'jobs')))
  const jobs = MemoryJobStore.make()
  const outboxToken = OutboxStore.named('publisher-delivery')
  const jobsToken = JobStore.named('publisher-delivery')
  const publisher = OutboxPublisher.service('PublisherDelivery')
  const events: import('../src').OutboxPublisherEvent[] = []
  const layer = makeLayer(
    publisher,
    outboxToken,
    outbox,
    jobsToken,
    jobs,
    OutboxRoutes.make({ jobs: jobsToken }),
    events
  )
  const runtime = await Runtime.make(
    Layer.complete(
      Layer.merge(
        Layer.succeed(outboxToken, OutboxStore.of(outbox)),
        Layer.succeed(jobsToken, JobStore.of(jobs)),
        layer
      )
    )
  )

  try {
    await runtime.warmup()
    const published = await waitForState(outbox, OutboxId.make('publish-1').unwrap(), 'published')
    expect(published.publishedAtMs).not.toBeUndefined()
    expect(events.some((event) => event.type === 'enqueued' && !event.duplicate)).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

test('duplicate JobStore enqueue is a successful publish', async () => {
  const now = Date.now()
  const prepared = request({
    id: 'duplicate-job',
    idempotencyKey: 'publisher-dedupe',
    now,
    runAt: now
  })
  const jobs = MemoryJobStore.make()
  const jobRequest = (({ protocolVersion: _protocolVersion, ...value }) => value)(prepared)
  await resolveJob(jobs.enqueue(jobRequest))

  const outbox = MemoryOutboxStore.make()
  await resolveOutbox(outbox.append(record('publish-duplicate', 'jobs', prepared)))
  const outboxToken = OutboxStore.named('publisher-duplicate')
  const jobsToken = JobStore.named('publisher-duplicate')
  const publisher = OutboxPublisher.service('PublisherDuplicate')
  const events: import('../src').OutboxPublisherEvent[] = []
  const runtime = await Runtime.make(
    Layer.complete(
      Layer.merge(
        Layer.succeed(outboxToken, OutboxStore.of(outbox)),
        Layer.succeed(jobsToken, JobStore.of(jobs)),
        makeLayer(
          publisher,
          outboxToken,
          outbox,
          jobsToken,
          jobs,
          OutboxRoutes.make({ jobs: jobsToken }),
          events
        )
      )
    )
  )

  try {
    await runtime.warmup()
    await waitForState(outbox, OutboxId.make('publish-duplicate').unwrap(), 'published')
    expect(events.some((event) => event.type === 'enqueued' && event.duplicate)).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

test('missing routes and permanent enqueue failures remain inspectable', async () => {
  const missingOutbox = MemoryOutboxStore.make()
  await resolveOutbox(
    missingOutbox.append(record('publish-missing', 'missing', request({ attemptsMax: 1 })))
  )
  const missingToken = OutboxStore.named('publisher-missing')
  const missingJobsToken = JobStore.named('publisher-missing')
  const missingPublisher = OutboxPublisher.service('PublisherMissing')
  const missingEvents: OutboxPublisherEvent[] = []
  const missingErrors: unknown[] = []
  const missingRuntime = await Runtime.make(
    Layer.complete(
      Layer.merge(
        Layer.succeed(missingToken, OutboxStore.of(missingOutbox)),
        makeLayer(
          missingPublisher,
          missingToken,
          missingOutbox,
          missingJobsToken,
          {} as import('better-effect-mq').JobStore.Contract,
          OutboxRoutes.make({}),
          missingEvents,
          (cause) => missingErrors.push(cause)
        )
      )
    )
  )

  try {
    await missingRuntime.warmup()
    const failed = await waitForState(
      missingOutbox,
      OutboxId.make('publish-missing').unwrap(),
      'failed'
    )
    expect(failed.failure?.kind).toBe('target-missing')
    expect(missingEvents.some((event) => event.type === 'route-missing')).toBe(true)
    expect(missingErrors.some((cause) => OutboxRouteMissingError.is(cause))).toBe(true)
  } finally {
    await missingRuntime.dispose()
  }

  const permanentOutbox = MemoryOutboxStore.make()
  await resolveOutbox(permanentOutbox.append(record('publish-permanent', 'jobs')))
  const permanentToken = OutboxStore.named('publisher-permanent')
  const permanentJobsToken = JobStore.named('publisher-permanent')
  const permanentJobDescriptor = MemoryJobStore.make().descriptor
  const permanentJobs = JobStore.of({
    descriptor: permanentJobDescriptor,
    enqueue: () => Result.err(new JobStoreFailure({ operation: 'enqueue', retryable: false }))
  } as unknown as import('better-effect-mq').JobStore.Contract)
  const permanentPublisher = OutboxPublisher.service('PublisherPermanent')
  const permanentEvents: OutboxPublisherEvent[] = []
  const permanentRuntime = await Runtime.make(
    Layer.complete(
      Layer.merge(
        Layer.succeed(permanentToken, OutboxStore.of(permanentOutbox)),
        Layer.succeed(permanentJobsToken, permanentJobs),
        makeLayer(
          permanentPublisher,
          permanentToken,
          permanentOutbox,
          permanentJobsToken,
          permanentJobs,
          OutboxRoutes.make({ jobs: permanentJobsToken }),
          permanentEvents
        )
      )
    )
  )

  try {
    await permanentRuntime.warmup()
    const failed = await waitForState(
      permanentOutbox,
      OutboxId.make('publish-permanent').unwrap(),
      'failed'
    )
    expect(failed.failure?.kind).toBe('store-permanent')
  } finally {
    await permanentRuntime.dispose()
  }
})
