import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect, Layer, Runtime, Service } from '../../src'
import {
  IdGenerator,
  IdGeneratorExhaustedError,
  IdGeneratorLive,
  IdGeneratorTest,
  IdGeneratorTestLayer,
  IdGeneratorUnavailableError
} from '../../src/standard-services'
import { TestRuntime } from '../../src/testing'

const queued = new IdGeneratorTest(['id-1'])
const generated = IdGeneratorTest.from((index) => `id-${index}`)
const queueLayer = IdGeneratorTest.layer(queued)
const defaultLayer = IdGeneratorTest.layer()
const shorthandLayer = IdGeneratorTestLayer(queued)

const program = Effect.fn(async function* () {
  const ids = yield* IdGenerator
  return Result.ok(ids.next())
})

expectTypeOf<IdGeneratorTest>().toMatchTypeOf<Service.Contract<IdGenerator>>()
expectTypeOf<Effect.Success<typeof program>>().toEqualTypeOf<string>()
expectTypeOf<Effect.Requirements<typeof program>>().toEqualTypeOf<IdGenerator>()
expectTypeOf<Layer.Provided<typeof IdGeneratorLive>>().toEqualTypeOf<IdGenerator>()
expectTypeOf<Layer.Required<typeof IdGeneratorLive>>().toBeNever()
expectTypeOf<Layer.Provided<typeof queueLayer>>().toEqualTypeOf<IdGenerator>()
expectTypeOf<Layer.Required<typeof defaultLayer>>().toBeNever()
expectTypeOf<Layer.Provided<typeof shorthandLayer>>().toEqualTypeOf<IdGenerator>()
expectTypeOf(queued.generated).toEqualTypeOf<number>()
expectTypeOf(queued.remaining).toEqualTypeOf<number>()
expectTypeOf(generated.next()).toEqualTypeOf<string>()
expectTypeOf<IdGeneratorExhaustedError>().toMatchTypeOf<Error>()
expectTypeOf<IdGeneratorUnavailableError>().toMatchTypeOf<Error>()

const testRuntime = TestRuntime.make(Layer.merge(), { idGenerator: queued })
expectTypeOf<Awaited<typeof testRuntime>['runtime']>().toEqualTypeOf<Runtime<IdGenerator>>()
expectTypeOf<Awaited<typeof testRuntime>['idGenerator']>().toEqualTypeOf<IdGeneratorTest>()

void generated
void program
void testRuntime
