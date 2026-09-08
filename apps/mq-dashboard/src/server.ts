import { Effect, Layer, Runtime } from 'better-effect'
import { BunEffect } from 'better-effect/bun'
import {
  DashboardApp,
  DashboardAuthorization,
  DashboardAuditSinkDisabled,
  DashboardControlCapabilityDisabled,
  DashboardFlowCapabilityDisabled,
  DashboardJobRedactionPolicyDisabled,
  DashboardMetricsSinkDisabled,
  DashboardMutationPolicy,
  DashboardRateLimiter,
  DashboardScheduleCapabilityDisabled,
  dashboardEventFeedLayer,
  makeDashboardHealth
} from './index'
import {
  JobEventStore,
  JobHealth,
  JobStore,
  MemoryJobEventStore,
  MemoryJobStore
} from 'better-effect-mq'
import { ClockLive } from 'better-effect/standard-services'
import { Result } from 'better-result'

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  let difference = leftBytes.length ^ rightBytes.length
  const length = Math.max(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return difference === 0
}

const token = process.env.MQ_DASHBOARD_TOKEN
const hostname = process.env.MQ_DASHBOARD_HOST ?? '127.0.0.1'
const port = Number(process.env.MQ_DASHBOARD_PORT ?? 3000)
const mutationWindowMs = 60_000
const mutationLimit = 30

if (
  hostname !== '127.0.0.1' &&
  hostname !== 'localhost' &&
  (token === undefined || token.length === 0)
) {
  throw new Error('MQ_DASHBOARD_TOKEN is required when the dashboard is not loopback-bound')
}

export const DashboardServer = BunEffect.server(
  '@better-effect/mq-dashboard/Server',
  async function* () {
    const app = yield* DashboardApp
    return { hostname, port, fetch: app.fetch }
  }
)

export const DashboardLive = (() => {
  const jobHealth = JobHealth.make()
  const events = MemoryJobEventStore.make({ health: jobHealth })
  const dashboardHealth = makeDashboardHealth({ jobHealth, awaitEventsAvailable: true })
  const store = MemoryJobStore.make({ eventStore: events })
  const authorization = Layer.succeed(
    DashboardAuthorization,
    DashboardAuthorization.of({
      authorize: ({ request }) => {
        if (token === undefined || token.length === 0) return null
        return request.headers.get('authorization') === undefined
          ? null
          : constantTimeEqual(request.headers.get('authorization')!, `Bearer ${token}`)
            ? { role: 'admin' as const }
            : null
      }
    })
  )
  const mutationPolicy = Layer.succeed(
    DashboardMutationPolicy,
    DashboardMutationPolicy.of({
      available: token !== undefined && token.length > 0,
      check: ({ request }) => {
        if (token === undefined || token.length === 0) {
          return { allowed: false, reason: 'policy_unavailable' as const }
        }
        const confirmation = request.headers.get('x-dashboard-csrf')
        if (confirmation === null) {
          return { allowed: false, reason: 'confirmation_required' as const }
        }
        return constantTimeEqual(confirmation, token)
          ? { allowed: true as const }
          : { allowed: false, reason: 'csrf_invalid' as const }
      }
    })
  )
  const rateLimiter = (() => {
    let windowStartedAt = Date.now()
    let mutations = 0
    return Layer.succeed(
      DashboardRateLimiter,
      DashboardRateLimiter.of({
        available: true,
        check: () => {
          const now = Date.now()
          if (now - windowStartedAt >= mutationWindowMs) {
            windowStartedAt = now
            mutations = 0
          }
          if (mutations >= mutationLimit) {
            return {
              allowed: false,
              retryAfterSeconds: Math.max(
                1,
                Math.ceil((mutationWindowMs - (now - windowStartedAt)) / 1000)
              )
            }
          }
          mutations += 1
          return { allowed: true, retryAfterSeconds: undefined }
        }
      })
    )
  })()

  return Layer.merge(
    Layer.succeed(JobStore, JobStore.of(store)),
    Layer.merge(
      Layer.succeed(JobEventStore, JobEventStore.of(events)),
      Layer.merge(
        dashboardEventFeedLayer({
          health: { available: true, ...dashboardHealth }
        }),
        Layer.merge(
          ClockLive,
          Layer.merge(
            Layer.merge(
              DashboardScheduleCapabilityDisabled,
              Layer.merge(
                DashboardFlowCapabilityDisabled,
                Layer.merge(
                  DashboardControlCapabilityDisabled,
                  Layer.merge(
                    DashboardJobRedactionPolicyDisabled,
                    Layer.merge(DashboardAuditSinkDisabled, DashboardMetricsSinkDisabled)
                  )
                )
              )
            ),
            Layer.merge(
              DashboardApp.layer,
              Layer.merge(
                authorization,
                Layer.merge(mutationPolicy, Layer.merge(rateLimiter, DashboardServer.layer))
              )
            )
          )
        )
      )
    )
  )
})()

export const startDashboard = async (): Promise<void> => {
  const runtime = await Runtime.make(DashboardLive)
  const resolved = await runtime.run(
    Effect.fn(async function* () {
      return Result.ok(yield* DashboardServer)
    })
  )
  if (Result.isError(resolved)) throw resolved.error
  console.log(`better-effect-mq dashboard listening on ${resolved.value.url}`)

  const shutdown = async (): Promise<void> => {
    await runtime.dispose()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (import.meta.main) void startDashboard()
