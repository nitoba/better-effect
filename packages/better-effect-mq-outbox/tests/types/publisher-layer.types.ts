// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- type tests intentionally use erased contracts as compile-time fixtures.

import { expectTypeOf } from 'bun:test'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { JobStore } from 'better-effect-mq'
import { Result } from 'better-result'

import { OutboxRoutes, OutboxStore, OutboxPublisher } from '../../src'

class PublisherConfig extends Service<PublisherConfig>()('PublisherConfig') {
  readonly concurrency!: number
}

const outbox = OutboxStore.named('publisher-types')
const jobs = JobStore.named('publisher-types')
const publisher = OutboxPublisher.service('TypedPublisher')
const layer = publisher.layer(async function* () {
  const config = yield* PublisherConfig
  return {
    outboxes: [outbox] as const,
    routes: OutboxRoutes.make({ jobs }),
    concurrency: config.concurrency
  }
})

expectTypeOf(publisher.serviceTag).toEqualTypeOf<'TypedPublisher'>()
expectTypeOf<Layer.Required<typeof layer>>().toEqualTypeOf<
  PublisherConfig | OutboxStore.Instance<'publisher-types'> | JobStore.Instance<'publisher-types'>
>()
expectTypeOf<Layer.Provided<typeof layer>>().toEqualTypeOf<
  OutboxPublisher.ServiceInstance<'TypedPublisher'>
>()

const complete = Layer.complete(
  Layer.merge(
    Layer.succeed(PublisherConfig, PublisherConfig.of({ concurrency: 1 })),
    Layer.succeed(outbox, OutboxStore.of({} as OutboxStore.Contract)),
    Layer.succeed(jobs, JobStore.of({} as JobStore.Contract)),
    layer
  )
)
declare const runtime: Runtime.For<typeof complete>
const program = () =>
  Effect.gen(async function* () {
    const service = yield* publisher
    return Result.ok(service.state)
  })
expectTypeOf(runtime.run(program)).toEqualTypeOf<Promise<Awaited<ReturnType<typeof program>>>>()

// @ts-expect-error Publisher Service tokens reject manual construction.
void new publisher()

// @ts-expect-error A publisher Layer cannot form a Runtime before its stores are provided.
void Runtime.make(layer)
