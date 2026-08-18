import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { Effect, type EffectRequirements } from '../../src/effect'
import type { InferYieldRequirements } from '../../src/effect/types'
import { Service, type ServiceRequirements } from '../../src/service'

class Database extends Service<Database>()('SoundnessDatabase') {
  query(): string {
    return 'database'
  }
}

class Cache extends Service<Cache>()('SoundnessCache') {
  get(): string {
    return 'cache'
  }
}

class UserService extends Service<UserService>()('SoundnessUserService') {
  load<T extends string>(id: T) {
    return Effect.gen(async function* () {
      const database = yield* Database

      return Result.ok(`${id}:${database.query()}`)
    })
  }

  overloaded(): ReturnType<this['load']>
  overloaded(id: string): ReturnType<this['load']>
  overloaded(id = 'default') {
    return this.load(id)
  }
}

const nested = Effect.gen(async function* () {
  const cache = yield* Cache

  return Result.ok(cache.get())
})

const nestedThroughYield = Effect.gen(async function* () {
  const database = yield* Database
  const nestedEffect = await nested
  const value = yield* nestedEffect

  return Result.ok(`${database.query()}:${value}`)
})

expectTypeOf<EffectRequirements<typeof nestedThroughYield>>().toEqualTypeOf<Database | Cache>()

declare const effect: Effect<number, string, Database>

// @ts-expect-error A plain Result cannot claim a required Service channel.
const fake: Effect<number, never, Database> = Result.ok(42)

// SAFETY: This assertion intentionally erases the declaration-only Service metadata at a Result boundary.
const erasedResult = effect as Result<number, string>

// @ts-expect-error Passing through Result must not recreate an Effect requirement marker.
const erasedEffect: Effect<number, string, never> = erasedResult

const mapped = effect.map((value) => value.toString())
const mappedError = effect.mapError((error) => error.length)
const nestedEffect: Effect<string, never, Cache> = await nested
declare const unionEffect: typeof effect | typeof nestedEffect
const chained = effect.andThen(() => nestedEffect)
const chainedAsync = effect.andThenAsync(async () => nested)
const directResultMap = Result.map(effect, (value) => value + 1)
const recovered = effect.tryRecover(() => nestedEffect)
const tapped = effect.tap(() => {})
if (effect.isOk()) {
  expectTypeOf<EffectRequirements<typeof effect>>().toEqualTypeOf<Database>()
  const narrowedMapped = effect.map((value) => value + 1)
  expectTypeOf<EffectRequirements<typeof narrowedMapped>>().toEqualTypeOf<Database>()
}

type NestedIterator = ReturnType<(typeof nestedEffect)[typeof Symbol.iterator]>
type NestedYield = NestedIterator extends Generator<infer Yield, any, any> ? Yield : never
type NestedRequirements = InferYieldRequirements<NestedYield>

expectTypeOf<NestedRequirements>().toEqualTypeOf<Cache>()

expectTypeOf<EffectRequirements<typeof mapped>>().toEqualTypeOf<Database>()
expectTypeOf(mapped).toEqualTypeOf<Effect<string, string, Database>>()
expectTypeOf<EffectRequirements<typeof mappedError>>().toEqualTypeOf<Database>()
expectTypeOf<EffectRequirements<typeof chained>>().toEqualTypeOf<Database | Cache>()
expectTypeOf<EffectRequirements<typeof chainedAsync>>().toEqualTypeOf<Database | Cache>()
expectTypeOf<EffectRequirements<typeof recovered>>().toEqualTypeOf<Database | Cache>()
expectTypeOf<EffectRequirements<typeof tapped>>().toEqualTypeOf<Database>()
expectTypeOf<EffectRequirements<typeof directResultMap>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<Promise<typeof effect>>>().toEqualTypeOf<Database>()
expectTypeOf<EffectRequirements<typeof effect | typeof nested>>().toEqualTypeOf<Database | Cache>()

const unionThroughYield = Effect.gen(async function* () {
  const value = yield* unionEffect

  return Result.ok(value)
})

expectTypeOf<EffectRequirements<typeof unionThroughYield>>().toEqualTypeOf<Database | Cache>()

expectTypeOf<ServiceRequirements<UserService>>().toEqualTypeOf<Database>()
expectTypeOf<ReturnType<UserService['overloaded']>>().toEqualTypeOf<
  ReturnType<UserService['load']>
>()

void fake
void erasedEffect
void mapped
void mappedError
void chained
void chainedAsync
void recovered
void tapped
void unionThroughYield
