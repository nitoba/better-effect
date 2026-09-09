import { expect, test } from 'bun:test'

import { Effect, Layer, Runtime } from 'better-effect'
import { Clock, ClockTestLayer } from 'better-effect/standard-services'
import { Result } from 'better-result'
import {
  DashboardApp,
  DashboardAuditSinkDisabled,
  DashboardEventFeedDisabled,
  DashboardJobRedactionPolicyDisabled,
  DashboardMetricsSink,
  DashboardMutationPolicy,
  DashboardRateLimiter,
  DashboardRateLimiterDisabled,
  DashboardScheduleCapabilityDisabled,
  DashboardFlowCapabilityDisabled,
  DashboardControlCapabilityDisabled,
  dashboardScheduleCapabilityLayer,
  dashboardFlowCapabilityLayer,
  DashboardAuthorization,
  DashboardMetricNames
} from '../src'
import type { DashboardMutationMetricAttributes } from '../src'
import type { QueueName as QueueNameType } from 'better-effect-mq'
import {
  FlowStore,
  JobId,
  JobScheduleStore,
  JobStore,
  MemoryFlowStore,
  MemoryJobScheduleStore,
  MemoryJobStore
} from 'better-effect-mq'

test('dashboard emits low-cardinality mutation counters without changing HTTP outcomes', async () => {
  const store = MemoryJobStore.make()
  const created = await store.enqueue({
    id: JobId.make('metrics-job').unwrap(),
    job: { queue: 'emails', name: 'send', version: 1 },
    payload: { secret: 'redact-me' },
    runAt: 100,
    attemptsMax: 1,
    now: 0
  })
  if (Result.isError(created)) throw created.error

  const metrics: Array<{
    name: string
    value: number
    attributes: DashboardMutationMetricAttributes
  }> = []
  let rateLimitChecks = 0
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(store)),
      Layer.merge(
        ClockTestLayer(0),
        Layer.merge(
          Layer.succeed(
            DashboardAuthorization,
            DashboardAuthorization.of({ authorize: () => ({ role: 'admin' as const }) })
          ),
          Layer.merge(
            DashboardEventFeedDisabled,
            Layer.merge(
              DashboardScheduleCapabilityDisabled,
              Layer.merge(
                DashboardFlowCapabilityDisabled,
                Layer.merge(
                  DashboardControlCapabilityDisabled,
                  Layer.merge(
                    DashboardAuditSinkDisabled,
                    Layer.merge(
                      DashboardJobRedactionPolicyDisabled,
                      Layer.merge(
                        Layer.succeed(
                          DashboardMutationPolicy,
                          DashboardMutationPolicy.of({
                            available: true,
                            check: () => ({ allowed: true as const })
                          })
                        ),
                        Layer.merge(
                          Layer.succeed(
                            DashboardRateLimiter,
                            DashboardRateLimiter.of({
                              available: true,
                              check: () => {
                                rateLimitChecks += 1
                                return {
                                  allowed: rateLimitChecks !== 3,
                                  retryAfterSeconds: rateLimitChecks === 3 ? 10 : undefined
                                }
                              }
                            })
                          ),
                          Layer.merge(
                            Layer.succeed(
                              DashboardMetricsSink,
                              DashboardMetricsSink.of({
                                available: true,
                                increment: (name, value, attributes) => {
                                  metrics.push({ name, value, attributes })
                                }
                              })
                            ),
                            DashboardApp.layer
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
    )
  )

  try {
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* DashboardApp)
      })
    )
    if (Result.isError(appResult)) throw appResult.error

    const success = await appResult.value.request('/api/jobs/metrics-job/promote', {
      method: 'POST'
    })
    expect(success.status).toBe(200)

    const failure = await appResult.value.request('/api/jobs/metrics-job/promote', {
      method: 'POST'
    })
    expect(failure.status).toBe(500)

    const rateLimited = await appResult.value.request('/api/jobs/missing/promote', {
      method: 'POST'
    })
    expect(rateLimited.status).toBe(429)

    const observed = metrics.map(({ name, value, attributes }) => ({
      name,
      value,
      attributes
    }))
    expect(observed).toEqual([
      {
        name: DashboardMetricNames.adminActions,
        value: 1,
        attributes: { action: 'job.promote', outcome: 'success' }
      },
      {
        name: DashboardMetricNames.adminActions,
        value: 1,
        attributes: { action: 'job.promote', outcome: 'failure' }
      },
      {
        name: DashboardMetricNames.adminActions,
        value: 1,
        attributes: { action: 'job.promote', outcome: 'rate_limited' }
      }
    ])
    for (const metric of observed) {
      expect(Object.keys(metric.attributes).sort()).toEqual(['action', 'outcome'])
      expect(metric.attributes).not.toHaveProperty('jobId')
      expect(metric.attributes).not.toHaveProperty('subject')
      expect(metric.attributes).not.toHaveProperty('errorCode')
    }
  } finally {
    await runtime.dispose()
  }
})

test('dashboard metrics remain best-effort when the sink fails', async () => {
  const store = MemoryJobStore.make()
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(store)),
      Layer.merge(
        ClockTestLayer(0),
        Layer.merge(
          Layer.succeed(
            DashboardAuthorization,
            DashboardAuthorization.of({ authorize: () => ({ role: 'admin' as const }) })
          ),
          Layer.merge(
            DashboardEventFeedDisabled,
            Layer.merge(
              DashboardScheduleCapabilityDisabled,
              Layer.merge(
                DashboardFlowCapabilityDisabled,
                Layer.merge(
                  DashboardControlCapabilityDisabled,
                  Layer.merge(
                    DashboardAuditSinkDisabled,
                    Layer.merge(
                      DashboardJobRedactionPolicyDisabled,
                      Layer.merge(
                        Layer.succeed(
                          DashboardMutationPolicy,
                          DashboardMutationPolicy.of({
                            available: true,
                            check: () => ({ allowed: true as const })
                          })
                        ),
                        Layer.merge(
                          Layer.succeed(
                            DashboardMetricsSink,
                            DashboardMetricsSink.of({
                              available: true,
                              increment: () => Promise.reject(new Error('metrics sink unavailable'))
                            })
                          ),
                          Layer.merge(
                            Layer.succeed(
                              DashboardRateLimiter,
                              DashboardRateLimiter.of({
                                available: true,
                                check: () => ({ allowed: true, retryAfterSeconds: undefined })
                              })
                            ),
                            DashboardApp.layer
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
    )
  )

  try {
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* DashboardApp)
      })
    )
    if (Result.isError(appResult)) throw appResult.error
    const response = await appResult.value.request('/api/jobs/missing/promote', { method: 'POST' })
    expect(response.status).toBe(404)
  } finally {
    await runtime.dispose()
  }
})

test('dashboard emits one bounded action label for every mutation route', async () => {
  const metrics: Array<{ action: string; outcome: string }> = []
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(MemoryJobStore.make())),
      Layer.merge(
        Layer.succeed(JobScheduleStore, JobScheduleStore.of(MemoryJobScheduleStore.make())),
        Layer.merge(
          Layer.succeed(FlowStore, FlowStore.of(MemoryFlowStore.make())),
          Layer.merge(
            ClockTestLayer(0),
            Layer.merge(
              Layer.succeed(
                DashboardAuthorization,
                DashboardAuthorization.of({ authorize: () => ({ role: 'admin' as const }) })
              ),
              Layer.merge(
                dashboardScheduleCapabilityLayer(),
                Layer.merge(
                  dashboardFlowCapabilityLayer(),
                  Layer.merge(
                    DashboardEventFeedDisabled,
                    Layer.merge(
                      DashboardControlCapabilityDisabled,
                      Layer.merge(
                        DashboardAuditSinkDisabled,
                        Layer.merge(
                          DashboardJobRedactionPolicyDisabled,
                          Layer.merge(
                            Layer.succeed(
                              DashboardMutationPolicy,
                              DashboardMutationPolicy.of({
                                available: true,
                                check: () => ({ allowed: true as const })
                              })
                            ),
                            Layer.merge(
                              DashboardRateLimiterDisabled,
                              Layer.merge(
                                Layer.succeed(
                                  DashboardMetricsSink,
                                  DashboardMetricsSink.of({
                                    available: true,
                                    increment: (_name, _value, attributes) => {
                                      metrics.push(attributes)
                                    }
                                  })
                                ),
                                DashboardApp.layer
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
        )
      )
    )
  )

  try {
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* DashboardApp)
      })
    )
    if (Result.isError(appResult)) throw appResult.error

    const requests = [
      ['/api/jobs/missing/cancel', 'POST'],
      ['/api/jobs/missing/promote', 'POST'],
      ['/api/jobs/missing/retry', 'POST'],
      ['/api/jobs/missing/redrive', 'POST'],
      ['/api/jobs/missing', 'DELETE'],
      ['/api/queues/emails/pause', 'POST'],
      ['/api/queues/emails/resume', 'POST'],
      ['/api/schedules/billing/nightly/pause', 'POST'],
      ['/api/schedules/billing/nightly/resume', 'POST'],
      ['/api/schedules/billing/nightly', 'DELETE'],
      ['/api/flows/missing/cancel', 'POST']
    ] as const
    for (const [path, method] of requests) {
      const response = await appResult.value.request(path, { method })
      expect(response.status).toBeGreaterThanOrEqual(200)
      expect(response.status).toBeLessThan(500)
    }

    expect(metrics).toHaveLength(requests.length)
    expect(
      Object.fromEntries(
        [...new Set(metrics.map(({ action }) => action))].map((action) => [
          action,
          metrics.filter((metric) => metric.action === action).length
        ])
      )
    ).toEqual({
      'job.cancel': 1,
      'job.promote': 1,
      'job.retry': 1,
      'job.redrive': 1,
      'job.remove': 1,
      'queue.pause': 1,
      'queue.resume': 1,
      'schedule.pause': 1,
      'schedule.resume': 1,
      'schedule.remove': 1,
      'flow.cancel': 1
    })
  } finally {
    await runtime.dispose()
  }
})

test('dashboard queue mutations retain JobAdmin clock validation', async () => {
  const pauseRequests: Array<{ readonly now: number }> = []
  const resumeRequests: Array<{ readonly now: number }> = []
  const store = Object.assign(MemoryJobStore.make(), {
    pause: (request: { readonly now: number; readonly queue: QueueNameType }) => {
      pauseRequests.push({ now: request.now })
      return Result.ok({ queue: request.queue, paused: true })
    },
    resume: (request: { readonly now: number; readonly queue: QueueNameType }) => {
      resumeRequests.push({ now: request.now })
      return Result.ok({ queue: request.queue, paused: false })
    }
  })
  const metrics: Array<DashboardMutationMetricAttributes> = []
  const runtime = await Runtime.make(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(store)),
      Layer.merge(
        Layer.succeed(
          Clock,
          Clock.of({
            now: () => new Date(Number.NaN),
            sleep: () => Promise.resolve()
          })
        ),
        Layer.merge(
          Layer.succeed(
            DashboardAuthorization,
            DashboardAuthorization.of({ authorize: () => ({ role: 'admin' as const }) })
          ),
          Layer.merge(
            DashboardEventFeedDisabled,
            Layer.merge(
              DashboardScheduleCapabilityDisabled,
              Layer.merge(
                DashboardFlowCapabilityDisabled,
                Layer.merge(
                  DashboardControlCapabilityDisabled,
                  Layer.merge(
                    DashboardAuditSinkDisabled,
                    Layer.merge(
                      DashboardJobRedactionPolicyDisabled,
                      Layer.merge(
                        Layer.succeed(
                          DashboardMutationPolicy,
                          DashboardMutationPolicy.of({
                            available: true,
                            check: () => ({ allowed: true as const })
                          })
                        ),
                        Layer.merge(
                          DashboardRateLimiterDisabled,
                          Layer.merge(
                            Layer.succeed(
                              DashboardMetricsSink,
                              DashboardMetricsSink.of({
                                available: true,
                                increment: (_name, _value, attributes) => {
                                  metrics.push(attributes)
                                }
                              })
                            ),
                            DashboardApp.layer
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
    )
  )

  try {
    const appResult = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* DashboardApp)
      })
    )
    if (Result.isError(appResult)) throw appResult.error

    const response = await appResult.value.request('/api/queues/emails/pause', { method: 'POST' })
    const resumed = await appResult.value.request('/api/queues/emails/resume', { method: 'POST' })

    expect(response.status).toBe(500)
    expect(resumed.status).toBe(500)
    expect(pauseRequests).toEqual([])
    expect(resumeRequests).toEqual([])
    expect(metrics).toEqual([
      { action: 'queue.pause', outcome: 'failure' },
      { action: 'queue.resume', outcome: 'failure' }
    ])
  } finally {
    await runtime.dispose()
  }
})
