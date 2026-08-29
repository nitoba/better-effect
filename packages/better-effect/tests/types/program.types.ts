import { expectTypeOf } from 'bun:test'

import { Result, type Result as ResultType } from 'better-result'

import {
  Effect,
  Program,
  type Effect as EffectType,
  type EffectRequirements
} from '../../src/effect'
import { pipe } from '../../src/function'
import { Layer } from '../../src/layer'
import { Runtime } from '../../src/runtime'
import { Service } from '../../src/service'
import { MemoryLayerBackend } from '../../src/testing'

class GreetingService extends Service<GreetingService>()('GreetingService') {
  greet(name: string): string {
    return `Hello, ${name}!`
  }
}

class UserRepository extends Service<UserRepository>()('UserRepository') {
  findById(id: string) {
    return Promise.resolve(Result.ok({ id }))
  }
}

class RequestContext extends Service<RequestContext>()('RequestContext') {
  readonly requestId = 'request'
}

const greet = Effect.fn(async function* () {
  const greeting = yield* GreetingService

  return Result.ok(greeting.greet('Ada'))
})

expectTypeOf(greet).toEqualTypeOf<Program<string, never, GreetingService>>()
expectTypeOf<Effect.Success<typeof greet>>().toEqualTypeOf<string>()
expectTypeOf<Effect.Error<typeof greet>>().toEqualTypeOf<never>()
expectTypeOf<Effect.Requirements<typeof greet>>().toEqualTypeOf<GreetingService>()
expectTypeOf<EffectRequirements<typeof greet>>().toEqualTypeOf<GreetingService>()

const namedGreet = Program.named('greeting.load', greet)
const pipedNamedGreet = pipe(greet, Program.named('greeting.load.piped'))
expectTypeOf(namedGreet).toEqualTypeOf<Program<string, never, GreetingService>>()
expectTypeOf(pipedNamedGreet).toEqualTypeOf<Program<string, never, GreetingService>>()

const findUser = (id: string) =>
  Effect.fn(async function* () {
    const repository = yield* UserRepository

    const user = yield* Result.await(repository.findById(id))

    return Result.ok(user)
  })

expectTypeOf(findUser('user-1')).toEqualTypeOf<Program<{ id: string }, never, UserRepository>>()

const GreetingLive = Layer.make(GreetingService)
const RequestLive = Layer.gen(RequestContext, async function* () {
  const greeting = yield* GreetingService

  void greeting
  return new RequestContext()
})
const requestProgram = Effect.fn(async function* () {
  const request = yield* RequestContext

  return Result.ok(request.requestId)
})

const collectedPrograms = Program.all([greet, requestProgram] as const, { concurrency: 2 })
expectTypeOf(collectedPrograms).toEqualTypeOf<
  Program<[string, string], never, GreetingService | RequestContext>
>()

const allResultsTuple = Program.allResults([greet, requestProgram] as const, { concurrency: 2 })
expectTypeOf(allResultsTuple).toEqualTypeOf<
  Program<
    readonly [ResultType<string, never>, ResultType<string, never>],
    never,
    GreetingService | RequestContext
  >
>()

const forEachProgram = Program.forEach(['first', 'second'] as const, (value, index) => {
  expectTypeOf(value).toEqualTypeOf<'first' | 'second'>()
  expectTypeOf(index).toEqualTypeOf<number>()

  return Effect.fn(async function* () {
    const greeting = yield* GreetingService

    return Result.ok(`${greeting.greet(value)}:${index}`)
  })
})
expectTypeOf(forEachProgram).toEqualTypeOf<Program<readonly string[], never, GreetingService>>()

const failedGreet = Effect.fn(async function* () {
  yield* []
  return Result.err<string, 'failed'>('failed')
})
const mixedForEach = Program.forEach([true, false] as const, (value) =>
  value ? greet : failedGreet
)
expectTypeOf(mixedForEach).toEqualTypeOf<Program<readonly string[], 'failed', GreetingService>>()

declare const firstCollectionProgram: Program<string, 'first', GreetingService>
declare const secondCollectionProgram: Program<number, 'second', RequestContext>
const collectionArray: Array<typeof firstCollectionProgram | typeof secondCollectionProgram> = [
  firstCollectionProgram,
  secondCollectionProgram
]
const allResultsArray = Program.allResults(collectionArray)
expectTypeOf(allResultsArray).toEqualTypeOf<
  Program<
    readonly ResultType<string | number, 'first' | 'second'>[],
    never,
    GreetingService | RequestContext
  >
>()

declare const greetingRuntime: Runtime<GreetingService>
// @ts-expect-error Program.all retains the complete union of child requirements.
void greetingRuntime.run(collectedPrograms)
// @ts-expect-error Program.allResults retains the complete union of child requirements.
void greetingRuntime.run(allResultsTuple)

declare const emptyRuntime: Runtime<never>
const backend = new MemoryLayerBackend()
const runtimePromise = Runtime.make(GreetingLive, backend)
const oneShotResult = Runtime.run(GreetingLive, backend, greet)
const namedRunOptions = {
  attributes: { requestId: 'request-1' }
} satisfies import('../../src/runtime').RuntimeRunOptions
const namedOneShotResult = Runtime.run(GreetingLive, backend, namedGreet, namedRunOptions)

expectTypeOf(oneShotResult).toEqualTypeOf<Promise<ProgramResult>>()
expectTypeOf(namedOneShotResult).toEqualTypeOf<Promise<ProgramResult>>()

const EmptyLive = Layer.merge()

// @ts-expect-error GreetingService is not supplied by this one-shot Runtime.
void Runtime.run(EmptyLive, backend, greet)

// @ts-expect-error RequestLive requires GreetingService from the root Runtime.
void emptyRuntime.runWith(RequestLive, requestProgram)

// @ts-expect-error GreetingService is not supplied by this Runtime.
void emptyRuntime.run(greet)

async function checkRuntime() {
  const runtime = await runtimePromise
  const result = runtime.run(greet)
  const requestResult = runtime.runWith(RequestLive, requestProgram)

  expectTypeOf(result).toEqualTypeOf<Promise<ProgramResult>>()
  expectTypeOf(requestResult).toEqualTypeOf<Promise<RequestProgramResult>>()
  await runtime.dispose()
}

type ProgramResult = Awaited<ReturnType<typeof greet>>
type RequestProgramResult = Awaited<ReturnType<typeof requestProgram>>

void checkRuntime

declare const sourceProgram: Program<string, 'source', GreetingService>
declare const nextEffect: EffectType<number, 'next', UserRepository>
declare const nextProgram: Program<boolean, 'program', RequestContext>
declare const recoveryEffect: EffectType<Date, 'recovered', UserRepository>
declare const recoveryProgram: Program<URL, 'program-recovered', RequestContext>

const mappedProgram = Program.map(sourceProgram, (value) => value.length)
expectTypeOf(mappedProgram).toEqualTypeOf<Program<number, 'source', GreetingService>>()

const errorMappedProgram = Program.mapError(sourceProgram, (error) => ({ error }))
expectTypeOf(errorMappedProgram).toEqualTypeOf<
  Program<string, { error: 'source' }, GreetingService>
>()

const pipedProgram = pipe(
  sourceProgram,
  Program.map((value: string) => value.length),
  Program.map((value: number) => value > 0)
)
expectTypeOf(pipedProgram).toEqualTypeOf<Program<boolean, 'source', GreetingService>>()

const chainedEffect = Program.andThen(sourceProgram, () => nextEffect)
expectTypeOf(chainedEffect).toEqualTypeOf<
  Program<number, 'source' | 'next', GreetingService | UserRepository>
>()

const chainedProgram = pipe(
  sourceProgram,
  Program.andThen((value: string) => {
    void value
    return nextProgram
  })
)
expectTypeOf(chainedProgram).toEqualTypeOf<
  Program<boolean, 'source' | 'program', GreetingService | RequestContext>
>()

const tappedProgram = Program.tap(sourceProgram, () => undefined)
const errorTappedProgram = Program.tapError(sourceProgram, () => undefined)
expectTypeOf(tappedProgram).toEqualTypeOf<Program<string, 'source', GreetingService>>()
expectTypeOf(errorTappedProgram).toEqualTypeOf<Program<string, 'source', GreetingService>>()

const recoveredEffect = Program.recover(sourceProgram, () => recoveryEffect)
expectTypeOf(recoveredEffect).toEqualTypeOf<
  Program<string | Date, 'recovered', GreetingService | UserRepository>
>()

const recoveredProgram = pipe(
  sourceProgram,
  Program.recover((error: 'source') => {
    void error
    return recoveryProgram
  })
)
expectTypeOf(recoveredProgram).toEqualTypeOf<
  Program<string | URL, 'program-recovered', GreetingService | RequestContext>
>()

// @ts-expect-error Program continuations must return an Effect, PromiseLike<Effect>, or Program.
Program.andThen(sourceProgram, () => 'not an Effect')

// @ts-expect-error Program recoveries must return an Effect, PromiseLike<Effect>, or Program.
Program.recover(sourceProgram, () => 'not an Effect')
