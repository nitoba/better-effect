import { expect, test } from 'bun:test'

import { DashboardHealthMetricNames, makeDashboardHealth } from '../src'
import { JobHealth } from 'better-effect-mq'

test('dashboard health tracks connection lifecycle, lag, backpressure, and stream failures', () => {
  const metrics: Array<{
    name: string
    value: number
    attributes: Readonly<Record<string, string | number | boolean>>
  }> = []
  const jobHealth = JobHealth.make()
  const health = makeDashboardHealth({
    jobHealth,
    metrics: {
      increment: (name, value, attributes) => {
        metrics.push({ name, value, attributes })
      },
      observe: (name, value, attributes) => {
        metrics.push({ name, value, attributes })
      },
      gauge: (name, value, attributes) => {
        metrics.push({ name, value, attributes })
      }
    }
  })

  health.record({ type: 'connection-opened', reconnect: false })
  health.record({ type: 'connection-opened', reconnect: true })
  health.record({ type: 'event-observed', lagMs: 25 })
  health.record({ type: 'backpressure', dropped: 2, coalesced: 3 })
  health.record({ type: 'stream-failed', kind: 'store' })
  health.record({ type: 'connection-closed', reason: 'failure' })
  health.record({ type: 'connection-opened', reconnect: true })
  health.record({ type: 'connection-closed', reason: 'cursor-expired' })

  expect(health.snapshot()).toMatchObject({
    state: 'degraded',
    activeConnections: 1,
    connectionsOpened: 3,
    connectionsClosed: 2,
    reconnects: 2,
    cursorExpiries: 1,
    latestObservedLagMs: 25,
    maxObservedLagMs: 25,
    backpressureDropped: 2,
    eventsCoalesced: 3,
    streamFailures: 1,
    job: jobHealth.snapshot()
  })
  expect(
    metrics.every(({ attributes }) => !('jobId' in attributes) && !('workerId' in attributes))
  ).toBe(true)
  expect(metrics.map(({ name }) => name)).toEqual(
    expect.arrayContaining([
      DashboardHealthMetricNames.activeConnections,
      DashboardHealthMetricNames.connectionsOpened,
      DashboardHealthMetricNames.reconnects,
      DashboardHealthMetricNames.eventLag,
      DashboardHealthMetricNames.dropped,
      DashboardHealthMetricNames.coalesced,
      DashboardHealthMetricNames.streamFailures
    ])
  )
})
