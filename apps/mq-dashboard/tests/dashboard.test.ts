import { expect, test } from 'bun:test'

import { Effect, Layer, Runtime } from 'better-effect'
import { ClockTestLayer } from 'better-effect/standard-services'
import {
  DashboardApp,
  DashboardAuthorization,
  DashboardEventFeedDisabled,
  dashboardEventFeedLayer
} from '../src'
import {
  JobEventStore,
  JobId,
  JobStore,
  MemoryJobEventStore,
  MemoryJobStore
} from 'better-effect-mq'
import type {
  JobEventStoreError,
  JobEventStoreOperation,
  JobStoreError,
  JobStoreOperation
} from 'better-effect-mq'
import { Result } from 'better-result'

const allowAll = Layer.succeed(
  DashboardAuthorization,
  DashboardAuthorization.of({ authorize: () => ({ role: 'admin' as const }) })
)

const denyAll = Layer.succeed(
  DashboardAuthorization,
  DashboardAuthorization.of({ authorize: () => null })
)

const resolve = async <Value>(
  operation: JobStoreOperation<Value, JobStoreError>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const resolveEvent = async <Value, Failure extends JobEventStoreError>(
  operation: JobEventStoreOperation<Value, Failure>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const resolveApp = async (runtime: Runtime<any>) => {
  const result = await runtime.run(
    Effect.fn(async function* () {
      return Result.ok(yield* DashboardApp)
    })
  )
  if (Result.isError(result)) throw result.error
  return result.value
}

const seed = async () => {
  const events = MemoryJobEventStore.make({ clock: () => 0 })
  const store = MemoryJobStore.make({ eventStore: events, clock: () => 0 })
  const created = await resolve(
    store.enqueue({
      id: JobId.make('dashboard-job').unwrap(),
      job: { queue: 'emails', name: 'send', version: 1 },
      payload: { secret: 'do-not-return' },
      metadata: { tenant: 'acme' },
      runAt: 100,
      attemptsMax: 3,
      now: 0
    })
  )
  return { events, store, jobId: created.job.id }
}

test('Memory dashboard exposes sanitized overview, list, detail, attempts, and actions', async () => {
  const { events, store, jobId } = await seed()
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(store)),
      Layer.merge(
        Layer.succeed(JobEventStore, JobEventStore.of(events)),
        Layer.merge(
          dashboardEventFeedLayer(),
          Layer.merge(ClockTestLayer(0), Layer.merge(allowAll, DashboardApp.layer))
        )
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const overview = await app.request('/api/overview')
    expect(overview.status).toBe(200)
    expect((await overview.json()).data.counts.total).toBe(1)

    const list = await app.request('/api/jobs?queue=emails&metadata=tenant:acme')
    const listed = (await list.json()).data
    expect(listed.jobs).toHaveLength(1)
    expect(listed.jobs[0].id).toBe('dashboard-job')
    expect(listed.jobs[0].payload).toBeUndefined()
    expect(listed.jobs[0].result).toBeUndefined()
    expect(listed.jobs[0].failure).toBeUndefined()

    const detail = await app.request(`/api/jobs/${jobId}`)
    expect((await detail.json()).data.job.payload).toBeUndefined()
    const attempts = await app.request(`/api/jobs/${jobId}/attempts`)
    expect((await attempts.json()).data.attempts).toEqual([])

    const eventPage = await app.request('/api/events?type=job-enqueued')
    expect(eventPage.status).toBe(200)
    const event = (await eventPage.json()).data.events[0]
    expect(event.payload).toBeUndefined()
    expect(event.failure).toBeUndefined()

    const promoted = await app.request(`/api/jobs/${jobId}/promote`, { method: 'POST' })
    expect(promoted.status).toBe(200)
    expect((await promoted.json()).data.job.state).toBe('waiting')

    const removed = await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect((await removed.json()).data.removed).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

test('dashboard returns a safe authorization failure and keeps EventStore optional', async () => {
  const store = MemoryJobStore.make()
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(store)),
      Layer.merge(
        ClockTestLayer(0),
        Layer.merge(allowAll, Layer.merge(DashboardEventFeedDisabled, DashboardApp.layer))
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const events = await app.request('/api/events')
    expect(events.status).toBe(503)
    expect((await events.json()).error).toBe('events_unavailable')
  } finally {
    await runtime.dispose()
  }
})

test('dashboard keeps authentication and role checks at the host boundary', async () => {
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(MemoryJobStore.make())),
      Layer.merge(
        ClockTestLayer(0),
        Layer.merge(denyAll, Layer.merge(DashboardEventFeedDisabled, DashboardApp.layer))
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const response = await app.request('/api/overview')
    expect(response.status).toBe(401)
    expect((await response.json()).error).toBe('unauthorized')
  } finally {
    await runtime.dispose()
  }
})

test('SSE resumes after Last-Event-ID and emits non-durable heartbeats', async () => {
  const { events, store } = await seed()
  const first = await resolveEvent(events.read({}))
  const initialCursor = first.events[0]!.cursor
  await resolve(
    store.enqueue({
      id: JobId.make('dashboard-job-2').unwrap(),
      job: { queue: 'emails', name: 'send', version: 1 },
      payload: { secret: 'do-not-return-2' },
      runAt: 0,
      attemptsMax: 3,
      now: 0
    })
  )
  const second = await resolveEvent(events.read({ after: initialCursor }))
  const secondCursor = second.events[0]!.cursor
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(store)),
      Layer.merge(
        Layer.succeed(JobEventStore, JobEventStore.of(events)),
        Layer.merge(
          dashboardEventFeedLayer(),
          Layer.merge(ClockTestLayer(0), Layer.merge(allowAll, DashboardApp.layer))
        )
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const controller = new AbortController()
    const response = await app.request('/api/events/stream?heartbeatMs=1', {
      headers: { 'last-event-id': initialCursor },
      signal: controller.signal
    })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const firstChunk = await reader.read()
    const eventChunk = new TextDecoder().decode(firstChunk.value)
    expect(eventChunk).toContain('event: job-event')
    expect(eventChunk).toContain(`id: ${secondCursor}`)
    expect(eventChunk).not.toContain('do-not-return-2')
    controller.abort()
    await reader.cancel()

    const heartbeatController = new AbortController()
    const heartbeatResponse = await app.request('/api/events/stream?heartbeatMs=1', {
      headers: { 'last-event-id': secondCursor },
      signal: heartbeatController.signal
    })
    expect(heartbeatResponse.status).toBe(200)
    const heartbeatReader = heartbeatResponse.body!.getReader()
    const heartbeatChunk = await heartbeatReader.read()
    expect(new TextDecoder().decode(heartbeatChunk.value)).toContain('event: heartbeat')
    heartbeatController.abort()
    await heartbeatReader.cancel()
  } finally {
    await runtime.dispose()
  }
})
