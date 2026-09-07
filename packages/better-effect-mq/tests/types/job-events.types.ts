import { expectTypeOf } from 'bun:test'
import { Clock } from 'better-effect/standard-services'
import { Effect, Service } from 'better-effect'
import { Result, UnhandledException } from 'better-result'

import {
  JobDefinitionError,
  JobEventConsumerAbortedError,
  JobEventStore,
  JobEvents,
  JobStore,
  type DurableJobEvent
} from '../../src'
import type { JobEventStoreError, JobEventsPageOperation } from '../../src'

class HandlerService extends Service<HandlerService>()('JobEventsHandlerService') {
  readonly suffix = 'handled'
}

type HandlerFailure = { readonly _tag: 'HandlerFailure' }

const page = JobEvents.page(JobEventStore, { limit: 10 })
expectTypeOf(page).toMatchTypeOf<JobEventsPageOperation<typeof JobEventStore>>()

const pageProgram = Effect.gen(async function* () {
  return Result.ok(yield* page)
})
expectTypeOf<Effect.Requirements<typeof pageProgram>>().toEqualTypeOf<JobEventStore.Instance>()
expectTypeOf<Effect.Error<typeof pageProgram>>().toEqualTypeOf<JobEventStoreError>()

const handler = (event: DurableJobEvent) =>
  Effect.fn(function* () {
    const service = yield* HandlerService
    void event
    void service.suffix
    return Result.err<never, HandlerFailure>({ _tag: 'HandlerFailure' })
  })

const consume = JobEvents.forEach(
  {
    store: JobEventStore,
    pageSize: 10,
    pollIntervalMs: 100
  },
  handler
)
const consumeProgram = Effect.gen(async function* () {
  return Result.ok(yield* consume)
})

expectTypeOf<Effect.Requirements<typeof consumeProgram>>().toEqualTypeOf<
  JobEventStore.Instance | InstanceType<typeof Clock> | HandlerService
>()
expectTypeOf<Effect.Error<typeof consumeProgram>>().toEqualTypeOf<
  | JobEventStoreError
  | JobEventConsumerAbortedError
  | JobDefinitionError
  | UnhandledException
  | HandlerFailure
>()

const namedStore = JobStore.named('job-events-types')
const namedEvents = JobEventStore.for(namedStore)
const namedPage = JobEvents.page(namedEvents)
expectTypeOf(namedPage).toMatchTypeOf<JobEventsPageOperation<typeof namedEvents>>()

void pageProgram
void consumeProgram
void namedPage
