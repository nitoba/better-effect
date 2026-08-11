import { expectTypeOf } from 'bun:test'

import { Result, type UnhandledException } from 'better-result'

import {
  Effect,
  type EffectError,
  type EffectRequirements,
  type EffectSuccess
} from '../../src/effect'
import { Scope, type ScopeOutcome } from '../../src/scope'
import { Service, type ServiceRequirements, type ServiceToken } from '../../src/service'

class Database extends Service<Database>() {
  query(): string {
    return 'query'
  }
}

class Cache extends Service<Cache>() {
  get(): string {
    return 'value'
  }
}

class UserRepository extends Service<UserRepository>() {
  find(): ReturnType<typeof Result.ok> {
    return Result.ok('user')
  }

  load() {
    return Effect.gen(async function* () {
      const database = yield* Database

      const cache = yield* Cache

      return Result.ok({ database, cache })
    })
  }
}

class Connection {
  readonly id = 'connection'
}

const program = Effect.gen(async function* () {
  const database = yield* Database

  const cache = yield* Cache

  return Result.ok({ database, cache })
})

const failedProgram = Effect.gen(async function* () {
  yield* Result.err('failed')

  return Result.ok(true)
})

const nestedProgram = Effect.gen(async function* () {
  const cache = yield* Cache

  return Result.ok(cache)
})

const combinedProgram = Effect.gen(async function* () {
  const database = yield* Database

  void database

  return await nestedProgram
})

expectTypeOf<EffectRequirements<typeof program>>().toEqualTypeOf<
  ServiceToken<Database> | ServiceToken<Cache>
>()

expectTypeOf<EffectSuccess<typeof program>>().toEqualTypeOf<{ database: Database; cache: Cache }>()

expectTypeOf<EffectError<typeof program>>().toEqualTypeOf<never>()

expectTypeOf<EffectError<typeof failedProgram>>().toEqualTypeOf<string>()
expectTypeOf<EffectRequirements<typeof failedProgram>>().toEqualTypeOf<never>()

expectTypeOf<EffectRequirements<typeof combinedProgram>>().toEqualTypeOf<
  ServiceToken<Database> | ServiceToken<Cache>
>()

const plainResult = Result.ok('plain')

expectTypeOf<EffectRequirements<typeof plainResult>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<Promise<typeof nestedProgram>>>().toEqualTypeOf<
  ServiceToken<Cache>
>()
expectTypeOf<EffectRequirements<typeof nestedProgram | typeof plainResult>>().toEqualTypeOf<
  ServiceToken<Cache>
>()

const scopeProgram = Effect.gen(async function* () {
  const scope = yield* Scope
  const database = yield* Database

  return Result.ok({ scope, database })
})

const acquireReleaseProgram = Effect.gen(async function* () {
  const connection = yield* Effect.acquireRelease(
    async () => new Connection(),
    async (resource, outcome) => {
      void resource
      expectTypeOf(outcome).toEqualTypeOf<ScopeOutcome>()
    }
  )

  return Result.ok(connection)
})

const serviceAndAcquireReleaseProgram = Effect.gen(async function* () {
  const database = yield* Database

  const connection = yield* Effect.acquireRelease(
    () => new Connection(),
    (resource) => {
      void resource
    }
  )

  return Result.ok({ database, connection })
})

const legacyReleaseProgram = Effect.gen(async function* () {
  const connection = yield* Effect.acquireRelease(
    () => new Connection(),
    (resource) => {
      void resource
    }
  )

  return Result.ok(connection)
})

expectTypeOf<EffectRequirements<typeof scopeProgram>>().toEqualTypeOf<ServiceToken<Database>>()

expectTypeOf<EffectRequirements<ReturnType<UserRepository['load']>>>().toEqualTypeOf<
  ServiceToken<Database> | ServiceToken<Cache>
>()

expectTypeOf<EffectSuccess<typeof acquireReleaseProgram>>().toEqualTypeOf<Connection>()
expectTypeOf<EffectError<typeof acquireReleaseProgram>>().toEqualTypeOf<UnhandledException>()
expectTypeOf<EffectRequirements<typeof acquireReleaseProgram>>().toEqualTypeOf<never>()
expectTypeOf<EffectSuccess<typeof legacyReleaseProgram>>().toEqualTypeOf<Connection>()
expectTypeOf<EffectError<typeof legacyReleaseProgram>>().toEqualTypeOf<UnhandledException>()
expectTypeOf<EffectRequirements<typeof legacyReleaseProgram>>().toEqualTypeOf<never>()

expectTypeOf<EffectSuccess<typeof serviceAndAcquireReleaseProgram>>().toEqualTypeOf<{
  database: Database
  connection: Connection
}>()

expectTypeOf<
  EffectError<typeof serviceAndAcquireReleaseProgram>
>().toEqualTypeOf<UnhandledException>()

expectTypeOf<EffectRequirements<typeof serviceAndAcquireReleaseProgram>>().toEqualTypeOf<
  ServiceToken<Database>
>()

expectTypeOf<ServiceRequirements<typeof UserRepository>>().toEqualTypeOf<
  ServiceToken<Database> | ServiceToken<Cache>
>()
