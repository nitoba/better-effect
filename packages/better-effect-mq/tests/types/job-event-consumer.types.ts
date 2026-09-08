// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions are the subject of these type contracts.
// oxlint-disable anti-slop/no-chained-type-assertions -- the exactness helper intentionally casts a phantom value.

import { expectTypeOf } from 'bun:test'
import { Clock, ClockLive } from 'better-effect/standard-services'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { Result } from 'better-result'

import {
  JobEventConsumer,
  JobEventStore,
  JobStore,
  type DurableJobEvent,
  type JobEventCursor
} from '../../src'

class ConsumerConfig extends Service<ConsumerConfig>()('JobEventConsumerConfig') {
  readonly initialCursor!: JobEventCursor
}

class HandlerDependency extends Service<HandlerDependency>()('JobEventConsumerHandlerDependency') {
  readonly suffix = 'handled'
}

const handler = (_event: DurableJobEvent) =>
  Effect.fn(function* () {
    const dependency = yield* HandlerDependency
    return Result.ok(dependency.suffix)
  })

const AuditConsumer = JobEventConsumer.service('@audit/EventConsumer')
const auditLayer = AuditConsumer.layer(async function* () {
  const config = yield* ConsumerConfig

  return {
    eventStore: JobEventStore,
    after: config.initialCursor,
    concurrency: 1,
    handler
  }
})

expectTypeOf(AuditConsumer.serviceTag).toEqualTypeOf<'@audit/EventConsumer'>()
expectTypeOf(auditLayer).toMatchTypeOf<
  Layer<JobEventConsumer.Instance<'@audit/EventConsumer'>, any>
>()
expectTypeOf<Layer.Provided<typeof auditLayer>>().toEqualTypeOf<
  JobEventConsumer.Instance<'@audit/EventConsumer'>
>()
type AuditRequirements =
  | ConsumerConfig
  | InstanceType<typeof JobEventStore>
  | InstanceType<typeof Clock>
  | HandlerDependency

type Exact<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false

expectTypeOf<Layer.Required<typeof auditLayer>>().toMatchTypeOf<AuditRequirements>()
expectTypeOf<AuditRequirements>().toMatchTypeOf<Layer.Required<typeof auditLayer>>()
const auditRequirementsExact: true = undefined as unknown as Exact<
  Layer.Required<typeof auditLayer>,
  AuditRequirements
>
void auditRequirementsExact

const testDouble: JobEventConsumer.Handle = {
  state: 'running',
  stop: async () => {},
  awaitStopped: async () => {}
}
const testDoubleLayer = AuditConsumer.succeed(testDouble)
expectTypeOf<Layer.Required<typeof testDoubleLayer>>().toEqualTypeOf<never>()

const incomplete = Layer.merge(
  Layer.merge(
    auditLayer,
    Layer.succeed(ConsumerConfig, ConsumerConfig.of({ initialCursor: '' as JobEventCursor })),
    Layer.succeed(HandlerDependency, HandlerDependency.of({ suffix: 'handled' }))
  )
)

// @ts-expect-error The event store requirement must remain explicit at composition time.
void Runtime.make(incomplete)

const completeWithStore = Layer.complete(
  Layer.merge(
    incomplete,
    Layer.succeed(JobEventStore, JobEventStore.of({} as JobEventStore.Contract)),
    ClockLive
  )
)
void Runtime.make(completeWithStore)

void AuditConsumer.layer(() => ({ eventStore: JobEventStore, concurrency: 2, handler }))

const NamedStore = JobStore.named('consumer-types')
const NamedEvents = JobEventStore.for(NamedStore)
const NamedConsumer = JobEventConsumer.service('@audit/NamedConsumer')
const namedLayer = NamedConsumer.layer(() => ({
  eventStore: NamedEvents,
  handler
}))

type NamedRequirements =
  | InstanceType<typeof NamedEvents>
  | InstanceType<typeof Clock>
  | HandlerDependency

expectTypeOf<Layer.Required<typeof namedLayer>>().toMatchTypeOf<NamedRequirements>()
expectTypeOf<NamedRequirements>().toMatchTypeOf<Layer.Required<typeof namedLayer>>()
const namedRequirementsExact: true = undefined as unknown as Exact<
  Layer.Required<typeof namedLayer>,
  NamedRequirements
>
void namedRequirementsExact

void Runtime.make
void completeWithStore
void namedLayer
