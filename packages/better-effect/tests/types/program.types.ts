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
declare const emptyRuntime: Runtime<never>
const backend = new MemoryLayerBackend()
const runtimePromise = Runtime.make(GreetingLive, backend)
const oneShotResult = Runtime.run(GreetingLive, backend, greet)

expectTypeOf(oneShotResult).toEqualTypeOf<Promise<ProgramResult>>()

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
