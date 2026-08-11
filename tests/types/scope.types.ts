import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect, type EffectRequirements, Scope, Service, type ServiceToken } from '../../src'

class Database extends Service<Database>() {}

const program = Effect.gen(async function* () {
  const scope = yield* Scope
  const database = yield* Database

  expectTypeOf(scope).toEqualTypeOf<Scope>()

  return Result.ok({ scope, database })
})

expectTypeOf<EffectRequirements<typeof program>>().toEqualTypeOf<ServiceToken<Database>>()

const onlyScope = Effect.gen(async function* () {
  const scope = yield* Scope

  return Result.ok(scope)
})

expectTypeOf<EffectRequirements<typeof onlyScope>>().toEqualTypeOf<never>()
