import { expectTypeOf } from 'bun:test'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockTest, IdGeneratorTest } from 'better-effect/standard-services'
import { Result } from 'better-result'

import { Codec, JobStore, Queue } from '../../src'
import { TestJobStore } from '../../src/testing'

const clock = new ClockTest(1_700_000_000_000)
const ids = IdGeneratorTest.from((index) => `test-job-${index}`)
const harness = TestJobStore.make({ clock, ids })
const definition = Queue.define('testing-types').job('payload', {
  version: 1,
  payload: Codec.json<{ readonly value: number }>()
})

expectTypeOf(harness.layer).toMatchTypeOf<Layer<InstanceType<typeof JobStore>, never>>()
expectTypeOf(harness.clock).toEqualTypeOf<ClockTest>()
expectTypeOf(harness.idGenerator).toEqualTypeOf<IdGeneratorTest>()
expectTypeOf(harness.enqueued(definition)).toEqualTypeOf<
  Promise<readonly import('../../src').JobRecord[]>
>()
expectTypeOf(harness.enqueuedPayloads(definition)).toEqualTypeOf<
  Promise<readonly { readonly value: number }[]>
>()

const NamedStore = JobStore.named('testing-named')
const namedHarness = TestJobStore.makeFor(NamedStore, { clock, ids })
const namedHarnessFromOptions = TestJobStore.make({ token: NamedStore, clock, ids })
expectTypeOf(namedHarnessFromOptions.token).toEqualTypeOf<typeof NamedStore>()
const namedDefinition = Queue.define('testing-types').job('named', {
  version: 1,
  payload: Codec.string,
  store: NamedStore
})

expectTypeOf(namedHarness.token).toEqualTypeOf<typeof NamedStore>()
expectTypeOf(namedHarness.layer).toMatchTypeOf<Layer<InstanceType<typeof NamedStore>, never>>()
expectTypeOf(namedHarness.enqueuedPayloads(namedDefinition)).toEqualTypeOf<
  Promise<readonly string[]>
>()

const runtimeLayer = Layer.merge(harness.layer, harness.clockLayer, harness.idGeneratorLayer)
const program = Effect.gen(async function* () {
  const id = yield* definition.enqueue({ value: 1 })
  return Result.ok(id)
})
void Runtime.run(runtimeLayer, () => program)
void namedHarness
