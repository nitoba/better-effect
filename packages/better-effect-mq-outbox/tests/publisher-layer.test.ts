import { expect, test } from 'bun:test'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { JobStore, MemoryJobStore } from 'better-effect-mq'
import { Result } from 'better-result'

import { MemoryOutboxStore, OutboxRoutes, OutboxStore, OutboxPublisher } from '../src'

class PublisherConfig extends Service<PublisherConfig>()('PublisherConfig') {
  readonly concurrency!: number
}

test('OutboxPublisher layer is lazy and drains through Runtime disposal', async () => {
  const outbox = MemoryOutboxStore.make()
  const jobs = MemoryJobStore.make()
  const outboxToken = OutboxStore.named('publisher-layer')
  const jobsToken = JobStore.named('publisher-layer')
  const publisher = OutboxPublisher.service('LayerPublisher')
  let factoryCalls = 0

  const layer = publisher.layer(async function* () {
    const config = yield* PublisherConfig
    factoryCalls += 1
    return {
      outboxes: [outboxToken] as const,
      routes: OutboxRoutes.make({ jobs: jobsToken }),
      concurrency: config.concurrency,
      leaseDurationMs: 100,
      heartbeatIntervalMs: 10,
      pollIntervalMs: 1
    }
  })
  const runtime = await Runtime.make(
    Layer.complete(
      Layer.merge(
        Layer.succeed(PublisherConfig, PublisherConfig.of({ concurrency: 1 })),
        Layer.succeed(outboxToken, OutboxStore.of(outbox)),
        Layer.succeed(jobsToken, JobStore.of(jobs)),
        layer
      )
    )
  )

  try {
    expect(factoryCalls).toBe(0)
    await runtime.warmup()
    expect(factoryCalls).toBe(1)

    const result = await runtime.run(() =>
      Effect.gen(async function* () {
        return Result.ok(yield* publisher)
      })
    )
    if (Result.isError(result)) throw result.error
    expect(result.value.state).toBe('running')

    await runtime.dispose()
    expect(result.value.state).toBe('stopped')
  } finally {
    if (runtime.inspect().state !== 'disposed') await runtime.dispose()
  }
})
