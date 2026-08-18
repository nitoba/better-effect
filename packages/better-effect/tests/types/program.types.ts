import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect, type EffectRequirements, type Program } from '../../src/effect'
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

const greet = Effect.fn(async function* () {
  const greeting = yield* GreetingService

  return Result.ok(greeting.greet('Ada'))
})

expectTypeOf(greet).toEqualTypeOf<Program<string, never, GreetingService>>()
expectTypeOf<Effect.Success<typeof greet>>().toEqualTypeOf<string>()
expectTypeOf<Effect.Error<typeof greet>>().toEqualTypeOf<never>()
expectTypeOf<Effect.Requirements<typeof greet>>().toEqualTypeOf<GreetingService>()
expectTypeOf<EffectRequirements<typeof greet>>().toEqualTypeOf<GreetingService>()

const findUser = (id: string) =>
  Effect.fn(async function* () {
    const repository = yield* UserRepository

    const user = yield* Result.await(repository.findById(id))

    return Result.ok(user)
  })

expectTypeOf(findUser('user-1')).toEqualTypeOf<Program<{ id: string }, never, UserRepository>>()

const GreetingLive = Layer.make(GreetingService)
const backend = new MemoryLayerBackend()
const runtimePromise = Runtime.make(GreetingLive, backend)
const oneShotResult = Runtime.run(GreetingLive, backend, greet)

expectTypeOf(oneShotResult).toEqualTypeOf<Promise<ProgramResult>>()

const EmptyLive = Layer.merge()

// @ts-expect-error GreetingService is not supplied by this one-shot Runtime.
void Runtime.run(EmptyLive, backend, greet)

declare const emptyRuntime: Runtime<never>

// @ts-expect-error GreetingService is not supplied by this Runtime.
void emptyRuntime.run(greet)

async function checkRuntime() {
  const runtime = await runtimePromise
  const result = runtime.run(greet)

  expectTypeOf(result).toEqualTypeOf<Promise<ProgramResult>>()
  await runtime.dispose()
}

type ProgramResult = Awaited<ReturnType<typeof greet>>

void checkRuntime
