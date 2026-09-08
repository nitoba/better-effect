import { expect, test } from 'bun:test'

import { Effect, Layer, Runtime } from 'better-effect'
import { ClockTestLayer } from 'better-effect/standard-services'
import {
  DashboardApp,
  DashboardAuthorization,
  DashboardAuditSink,
  DashboardAuditSinkDisabled,
  DashboardControlCapabilityDisabled,
  DashboardEventFeedDisabled,
  DashboardFlowCapabilityDisabled,
  DashboardJobRedactionPolicy,
  DashboardJobRedactionPolicyDisabled,
  DashboardMutationPolicy,
  DashboardMutationPolicyDisabled,
  DashboardRateLimiter,
  DashboardRateLimiterDisabled,
  DashboardScheduleCapabilityDisabled,
  dashboardControlCapabilityLayer,
  dashboardEventFeedLayer,
  dashboardFlowCapabilityLayer,
  dashboardScheduleCapabilityLayer
} from '../src'
import {
  FlowStore,
  JobEventStore,
  JobId,
  JobName,
  JobScheduleStore,
  JobStore,
  makeLeaseToken,
  makeSerializedJobFailure,
  MemoryFlowStore,
  MemoryJobEventStore,
  MemoryJobScheduleStore,
  MemoryJobStore,
  QueueControls,
  QueueName
} from 'better-effect-mq'
import type { DashboardAuditEvent } from '../src'
import type {
  FlowSnapshot,
  JobEventStoreError,
  JobEventStoreOperation,
  JobStoreError,
  JobStoreOperation,
  ScheduleRecord,
  ScheduleStoreError,
  ScheduleStoreOperation
} from 'better-effect-mq'
import { Result } from 'better-result'

const allowAll = Layer.succeed(
  DashboardAuthorization,
  DashboardAuthorization.of({ authorize: () => ({ role: 'admin' as const }) })
)

const allowMutationPolicy = Layer.succeed(
  DashboardMutationPolicy,
  DashboardMutationPolicy.of({
    available: true,
    check: () => ({ allowed: true as const })
  })
)

const allowMutations = Layer.merge(
  DashboardJobRedactionPolicyDisabled,
  Layer.merge(
    allowMutationPolicy,
    Layer.merge(DashboardAuditSinkDisabled, DashboardRateLimiterDisabled)
  )
)

const denyAll = Layer.succeed(
  DashboardAuthorization,
  DashboardAuthorization.of({ authorize: () => null })
)

const disabledCapabilities = Layer.merge(
  DashboardScheduleCapabilityDisabled,
  Layer.merge(DashboardFlowCapabilityDisabled, DashboardControlCapabilityDisabled)
)

const disabledMutationCapabilities = Layer.merge(
  DashboardJobRedactionPolicyDisabled,
  Layer.merge(
    DashboardMutationPolicyDisabled,
    Layer.merge(DashboardAuditSinkDisabled, DashboardRateLimiterDisabled)
  )
)

const disabledDashboard = Layer.merge(
  DashboardEventFeedDisabled,
  Layer.merge(disabledCapabilities, disabledMutationCapabilities)
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

const resolveSchedule = async <Value>(
  operation: ScheduleStoreOperation<Value, ScheduleStoreError>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const readStreamChunk = async (response: Response): Promise<string> => {
  if (response.body === null) throw new Error('stream response has no body')
  const reader = response.body.getReader()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out waiting for SSE chunk')), 1_000)
      })
    ])
    if (result.done || result.value === undefined) return ''
    return new TextDecoder().decode(result.value)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    await reader.cancel()
  }
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
          Layer.merge(
            ClockTestLayer(0),
            Layer.merge(
              allowAll,
              Layer.merge(allowMutations, Layer.merge(disabledCapabilities, DashboardApp.layer))
            )
          )
        )
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const health = await app.request('/health')
    expect((await health.json()).data).toEqual({
      ok: true,
      service: 'better-effect-mq-dashboard',
      capabilities: {
        jobRedactionPolicy: false,
        mutationPolicy: true,
        audit: false,
        rateLimit: false
      }
    })
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
    expect(listed.jobs[0].metadata).toBeUndefined()

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

    const cancelled = await app.request(`/api/jobs/${jobId}/cancel`, { method: 'POST' })
    expect(cancelled.status).toBe(200)
    expect((await cancelled.json()).data.job.state).toBe('cancelled')

    const retried = await app.request(`/api/jobs/${jobId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ delayMs: 0 }),
      headers: { 'content-type': 'application/json' }
    })
    expect(retried.status).toBe(200)
    expect((await retried.json()).data.job.state).toBe('waiting')

    const removed = await app.request(`/api/jobs/${jobId}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect((await removed.json()).data.removed).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

test('dashboard applies job redaction policy by identity and principal context', async () => {
  const events = MemoryJobEventStore.make({ clock: () => 0 })
  const store = MemoryJobStore.make({ eventStore: events, clock: () => 0 })
  const publicJob = await resolve(
    store.enqueue({
      id: JobId.make('public-job').unwrap(),
      job: { queue: 'emails', name: 'public-send', version: 1 },
      payload: { safe: 'visible-payload' },
      metadata: { visible: 'yes', secret: 'do-not-return' },
      runAt: 0,
      attemptsMax: 3,
      now: 0
    })
  )
  await resolve(
    store.enqueue({
      id: JobId.make('private-job').unwrap(),
      job: { queue: 'emails', name: 'private-send', version: 1 },
      payload: { secret: 'do-not-return' },
      metadata: { visible: 'do-not-return' },
      runAt: 0,
      attemptsMax: 3,
      now: 0
    })
  )
  const policy = Layer.succeed(
    DashboardJobRedactionPolicy,
    DashboardJobRedactionPolicy.of({
      available: true,
      decide: ({ request, principal, job, target }) => {
        expect(request).toBeInstanceOf(Request)
        expect(principal.role).toBe('admin')
        if (job.name !== 'public-send') {
          return {
            allowed: false as const,
            payload: false,
            result: false,
            failure: false,
            metadataKeys: []
          }
        }
        expect(['list', 'detail', 'attempts']).toContain(target)
        return {
          allowed: true as const,
          payload: true,
          result: true,
          failure: true,
          metadataKeys: ['visible']
        }
      }
    })
  )
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(store)),
      Layer.merge(
        ClockTestLayer(0),
        Layer.merge(
          allowAll,
          Layer.merge(
            policy,
            Layer.merge(
              DashboardEventFeedDisabled,
              Layer.merge(
                disabledCapabilities,
                Layer.merge(
                  DashboardMutationPolicyDisabled,
                  Layer.merge(
                    DashboardAuditSinkDisabled,
                    Layer.merge(DashboardRateLimiterDisabled, DashboardApp.layer)
                  )
                )
              )
            )
          )
        )
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const health = await app.request('/health')
    expect((await health.json()).data.capabilities.jobRedactionPolicy).toBe(true)

    const list = await app.request('/api/jobs')
    expect(list.status).toBe(200)
    const listed = (await list.json()).data.jobs
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: publicJob.job.id,
      payload: { safe: 'visible-payload' },
      metadata: { visible: 'yes' }
    })
    expect(listed[0].metadata.secret).toBeUndefined()

    const detail = await app.request('/api/jobs/public-job')
    expect(detail.status).toBe(200)
    expect((await detail.json()).data.job.payload).toEqual({ safe: 'visible-payload' })

    const deniedDetail = await app.request('/api/jobs/private-job')
    expect(deniedDetail.status).toBe(403)
    expect((await deniedDetail.json()).error).toBe('job_forbidden')

    const deniedAttempts = await app.request('/api/jobs/private-job/attempts')
    expect(deniedAttempts.status).toBe(403)
    expect((await deniedAttempts.json()).error).toBe('job_forbidden')
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
        Layer.merge(allowAll, Layer.merge(disabledDashboard, DashboardApp.layer))
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const events = await app.request('/api/events')
    expect(events.status).toBe(503)
    expect((await events.json()).error).toBe('events_unavailable')

    const stream = await app.request('/api/events/stream')
    expect(stream.status).toBe(503)
    expect((await stream.json()).error).toBe('events_unavailable')
  } finally {
    await runtime.dispose()
  }
})

test('dashboard stream resumes from a cursor, honors Last-Event-ID, and emits non-durable heartbeats', async () => {
  const events = MemoryJobEventStore.make({ clock: () => 0 })
  const store = MemoryJobStore.make({ eventStore: events, clock: () => 0 })
  await resolve(
    store.enqueue({
      id: JobId.make('stream-job-1').unwrap(),
      job: { queue: 'events', name: 'first', version: 1 },
      payload: { secret: 'do-not-return' },
      metadata: {},
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  await resolve(
    store.enqueue({
      id: JobId.make('stream-job-2').unwrap(),
      job: { queue: 'events', name: 'second', version: 1 },
      payload: { secret: 'do-not-return' },
      metadata: {},
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(store)),
      Layer.merge(
        Layer.succeed(JobEventStore, JobEventStore.of(events)),
        Layer.merge(
          dashboardEventFeedLayer(),
          Layer.merge(
            ClockTestLayer(0),
            Layer.merge(
              allowAll,
              Layer.merge(
                disabledCapabilities,
                Layer.merge(disabledMutationCapabilities, DashboardApp.layer)
              )
            )
          )
        )
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const page = await app.request('/api/events?limit=50')
    const pageEvents = (await page.json()).data.events
    const firstCursor = pageEvents[0].cursor
    const secondCursor = pageEvents[1].cursor

    const resumed = await app.request(
      `/api/events/stream?after=${encodeURIComponent(firstCursor)}&heartbeatMs=1`
    )
    expect(resumed.status).toBe(200)
    const resumedChunk = await readStreamChunk(resumed)
    expect(resumedChunk).toContain('event: job-event')
    expect(resumedChunk).toContain(`id: ${secondCursor}`)
    expect(resumedChunk).toContain('stream-job-2')

    const fromLastEventId = await app.request(
      `/api/events/stream?after=${encodeURIComponent(firstCursor)}&heartbeatMs=1`,
      { headers: { 'last-event-id': secondCursor } }
    )
    const heartbeatChunk = await readStreamChunk(fromLastEventId)
    expect(heartbeatChunk).toContain('event: heartbeat')
    expect(heartbeatChunk).not.toContain('id:')
    expect(heartbeatChunk).not.toContain('stream-job-2')
  } finally {
    await runtime.dispose()
  }
})

test('dashboard stream reports cursor expiration and the oldest available cursor', async () => {
  const events = MemoryJobEventStore.make({ clock: () => 0, retention: { count: 1 } })
  const store = MemoryJobStore.make({ eventStore: events, clock: () => 0 })
  const beforeEvents = await events.tailCursor()
  if (Result.isError(beforeEvents)) throw beforeEvents.error
  await resolve(
    store.enqueue({
      id: JobId.make('expired-job-1').unwrap(),
      job: { queue: 'events', name: 'first', version: 1 },
      payload: {},
      metadata: {},
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  await resolve(
    store.enqueue({
      id: JobId.make('expired-job-2').unwrap(),
      job: { queue: 'events', name: 'second', version: 1 },
      payload: {},
      metadata: {},
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(store)),
      Layer.merge(
        Layer.succeed(JobEventStore, JobEventStore.of(events)),
        Layer.merge(
          dashboardEventFeedLayer(),
          Layer.merge(
            ClockTestLayer(0),
            Layer.merge(
              allowAll,
              Layer.merge(
                disabledCapabilities,
                Layer.merge(disabledMutationCapabilities, DashboardApp.layer)
              )
            )
          )
        )
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const stream = await app.request(
      `/api/events/stream?after=${encodeURIComponent(beforeEvents.value)}&heartbeatMs=1`
    )
    expect(stream.status).toBe(200)
    const chunk = await readStreamChunk(stream)
    expect(chunk).toContain('event: cursor-expired')
    expect(chunk).toContain('refreshRequired')
    expect(chunk).toContain('oldestAvailableCursor')
  } finally {
    await runtime.dispose()
  }
})

test('dashboard keeps optional capability routes absent when their Layers are not installed', async () => {
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(MemoryJobStore.make())),
      Layer.merge(
        ClockTestLayer(0),
        Layer.merge(allowAll, Layer.merge(disabledDashboard, DashboardApp.layer))
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const overview = await app.request('/api/overview')
    expect(overview.status).toBe(200)
    expect((await overview.json()).data.capabilities).toEqual({
      events: false,
      schedules: false,
      flows: false,
      controls: false,
      security: {
        jobRedactionPolicy: false,
        mutationPolicy: false,
        audit: false,
        rateLimit: false
      }
    })
    const capabilities = await app.request('/api/capabilities')
    expect(capabilities.status).toBe(200)
    expect((await capabilities.json()).data).toEqual({
      events: false,
      schedules: false,
      flows: false,
      controls: false,
      security: {
        jobRedactionPolicy: false,
        mutationPolicy: false,
        audit: false,
        rateLimit: false
      }
    })
    expect((await app.request('/api/schedules')).status).toBe(404)
    expect((await app.request('/api/flows/flow-1')).status).toBe(404)
    expect((await app.request('/api/controls/emails')).status).toBe(404)
  } finally {
    await runtime.dispose()
  }
})

test('dashboard exposes public schedule, flow, and controls Layers with sanitized optional APIs', async () => {
  const emailQueue = QueueName.make('emails').unwrap()
  const sendName = JobName.make('send').unwrap()
  const schedule: ScheduleRecord = {
    key: 'nightly',
    group: 'billing',
    job: { queue: emailQueue, name: sendName, version: 1 },
    queue: emailQueue,
    cron: '0 0 * * *',
    everyMs: undefined,
    timeZone: 'UTC',
    payload: { secret: 'do-not-return' },
    metadata: { tenant: 'do-not-return' },
    priority: 1,
    attemptsMax: 3,
    backoff: undefined,
    timeoutMs: undefined,
    misfire: { strategy: 'run-once' },
    overlap: 'skip',
    paused: false,
    revision: 2,
    nextRunAtMs: 10_000,
    lastScheduledAtMs: undefined,
    lastJobId: undefined,
    createdAtMs: 0,
    updatedAtMs: 0
  }
  const scheduleStore = MemoryJobScheduleStore.make()
  await resolveSchedule(scheduleStore.upsertSchedule(schedule))

  const flowId = JobId.make('flow-1').unwrap()
  const flowSnapshot: FlowSnapshot = {
    parent: {
      flowId,
      flowName: 'billing-flow',
      parentStoreKey: 'sensitive-parent-key',
      depth: 1,
      state: 'waiting-children',
      leaseToken: makeLeaseToken('sensitive-lease-token').unwrap(),
      flow: {
        flowName: 'billing-flow',
        failFast: true,
        pending: 1,
        completed: 0,
        failed: 0,
        cancelled: 0
      },
      failure: makeSerializedJobFailure({
        kind: 'defect',
        message: 'do-not-return',
        retryable: false,
        recordedAt: 0
      }).unwrap()
    },
    children: [
      {
        flowId,
        childKey: 'send-email',
        name: 'send',
        version: 1,
        storeKey: 'sensitive-child-store-key',
        childJobId: JobId.make('child-1').unwrap(),
        status: 'failed',
        result: { secret: 'do-not-return' },
        failure: makeSerializedJobFailure({
          kind: 'defect',
          message: 'do-not-return',
          retryable: false,
          recordedAt: 0
        }).unwrap(),
        cascaded: false,
        pendingSinceMs: 0
      }
    ],
    outbox: []
  }
  const flowStore = Object.assign(MemoryFlowStore.make(), {
    getFlow: () => Result.ok(flowSnapshot),
    cancel: () =>
      Result.ok({
        cancelled: 1,
        parentSettled: true,
        parent: flowSnapshot.parent,
        children: flowSnapshot.children
      })
  })
  const controlsStore = MemoryJobStore.make()
  const controlsQueue = (
    await resolve(
      controlsStore.reconcile({
        group: 'billing',
        controls: [{ queue: 'emails', options: { globalConcurrency: 2 } }]
      })
    )
  ).records[0]!

  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(MemoryJobStore.make())),
      Layer.merge(
        ClockTestLayer(0),
        Layer.merge(
          allowAll,
          Layer.merge(
            DashboardEventFeedDisabled,
            Layer.merge(
              Layer.succeed(JobScheduleStore, JobScheduleStore.of(scheduleStore)),
              Layer.merge(
                dashboardScheduleCapabilityLayer(),
                Layer.merge(
                  Layer.succeed(FlowStore, FlowStore.of(flowStore)),
                  Layer.merge(
                    dashboardFlowCapabilityLayer(),
                    Layer.merge(
                      QueueControls.layer(() => controlsStore),
                      Layer.merge(
                        dashboardControlCapabilityLayer(),
                        Layer.merge(allowMutations, DashboardApp.layer)
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const capabilities = (await (await app.request('/api/capabilities')).json()).data
    expect(capabilities.schedules).toBe(true)
    expect(capabilities.flows).toBe(true)
    expect(capabilities.controls).toBe(true)

    const schedules = await app.request('/api/schedules?group=billing')
    const scheduleData = (await schedules.json()).data.schedules[0]
    expect(scheduleData.key).toBe('nightly')
    expect(scheduleData.payload).toBeUndefined()
    expect(scheduleData.metadata).toBeUndefined()

    const flow = await app.request('/api/flows/flow-1')
    const flowData = (await flow.json()).data.flow
    expect(flowData.parent.leaseToken).toBeUndefined()
    expect(flowData.parent.parentStoreKey).toBeUndefined()
    expect(flowData.children[0].result).toBeUndefined()
    expect(flowData.children[0].failure).toBeUndefined()

    const controls = await app.request('/api/controls/emails')
    expect((await controls.json()).data.control).toEqual({
      queue: controlsQueue.queue,
      group: 'billing',
      enabled: true,
      revision: controlsQueue.revision,
      globalConcurrency: 2,
      perKeyConcurrency: undefined,
      rateLimit: undefined,
      createdAtMs: controlsQueue.createdAtMs,
      updatedAtMs: controlsQueue.updatedAtMs
    })

    const cancelled = await app.request('/api/flows/flow-1/cancel', { method: 'POST' })
    expect(cancelled.status).toBe(200)
    expect((await cancelled.json()).data.cancelled).toBe(1)
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
        Layer.merge(denyAll, Layer.merge(disabledDashboard, DashboardApp.layer))
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

test('dashboard keeps viewer reads available while mutation policy fails closed', async () => {
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(MemoryJobStore.make())),
      Layer.merge(
        ClockTestLayer(0),
        Layer.merge(allowAll, Layer.merge(disabledDashboard, DashboardApp.layer))
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    expect((await app.request('/api/overview')).status).toBe(200)
    const mutation = await app.request('/api/jobs/unknown/promote', { method: 'POST' })
    expect(mutation.status).toBe(503)
    expect((await mutation.json()).error).toBe('mutation_policy_unavailable')
  } finally {
    await runtime.dispose()
  }
})

test('dashboard returns stable confirmation and CSRF failures for mutations', async () => {
  let rejection: 'confirmation_required' | 'csrf_invalid' = 'confirmation_required'
  const policy = Layer.succeed(
    DashboardMutationPolicy,
    DashboardMutationPolicy.of({
      available: true,
      check: () => ({ allowed: false as const, reason: rejection })
    })
  )
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(MemoryJobStore.make())),
      Layer.merge(
        ClockTestLayer(0),
        Layer.merge(
          allowAll,
          Layer.merge(
            DashboardEventFeedDisabled,
            Layer.merge(
              disabledCapabilities,
              Layer.merge(
                policy,
                Layer.merge(
                  DashboardJobRedactionPolicyDisabled,
                  Layer.merge(
                    DashboardAuditSinkDisabled,
                    Layer.merge(DashboardRateLimiterDisabled, DashboardApp.layer)
                  )
                )
              )
            )
          )
        )
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const confirmation = await app.request('/api/jobs/unknown/promote', { method: 'POST' })
    expect(confirmation.status).toBe(428)
    expect((await confirmation.json()).error).toBe('confirmation_required')

    rejection = 'csrf_invalid'
    const csrf = await app.request('/api/jobs/unknown/promote', { method: 'POST' })
    expect(csrf.status).toBe(403)
    expect((await csrf.json()).error).toBe('csrf_invalid')
  } finally {
    await runtime.dispose()
  }
})

test('dashboard rate-limits mutations and records safe audit outcomes', async () => {
  const { store, jobId } = await seed()
  const auditEvents: DashboardAuditEvent[] = []
  let checks = 0
  const audit = Layer.succeed(
    DashboardAuditSink,
    DashboardAuditSink.of({
      available: true,
      record: (event) => {
        auditEvents.push(event)
        if (event.outcome === 'success') throw new Error('audit sink unavailable')
      }
    })
  )
  const rateLimiter = Layer.succeed(
    DashboardRateLimiter,
    DashboardRateLimiter.of({
      available: true,
      check: () => {
        checks += 1
        return { allowed: checks === 1, retryAfterSeconds: checks === 1 ? undefined : 10 }
      }
    })
  )
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(store)),
      Layer.merge(
        ClockTestLayer(0),
        Layer.merge(
          allowAll,
          Layer.merge(
            DashboardEventFeedDisabled,
            Layer.merge(
              disabledCapabilities,
              Layer.merge(
                allowMutationPolicy,
                Layer.merge(
                  DashboardJobRedactionPolicyDisabled,
                  Layer.merge(audit, Layer.merge(rateLimiter, DashboardApp.layer))
                )
              )
            )
          )
        )
      )
    )
  )

  try {
    const app = await resolveApp(runtime)
    const first = await app.request(`/api/jobs/${jobId}/promote`, { method: 'POST' })
    expect(first.status).toBe(200)
    const second = await app.request(`/api/jobs/${jobId}/promote`, { method: 'POST' })
    expect(second.status).toBe(429)
    expect((await second.json()).retryAfterSeconds).toBe(10)
    expect(
      auditEvents.map(({ action, outcome, errorCode }) => ({ action, outcome, errorCode }))
    ).toEqual([
      { action: 'job.promote', outcome: 'success', errorCode: undefined },
      { action: 'job.promote', outcome: 'denied', errorCode: 'rate_limited' }
    ])
    expect(auditEvents[0]?.path).toBe(`/api/jobs/${jobId}/promote`)
    expect(auditEvents[0]?.subject).toBeUndefined()
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
          Layer.merge(
            ClockTestLayer(0),
            Layer.merge(
              allowAll,
              Layer.merge(
                disabledCapabilities,
                Layer.merge(disabledMutationCapabilities, DashboardApp.layer)
              )
            )
          )
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
