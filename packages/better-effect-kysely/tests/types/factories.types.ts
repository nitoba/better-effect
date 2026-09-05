import { expectTypeOf } from 'bun:test'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import type { SelectQueryBuilder } from 'kysely'
import { Kysely } from 'kysely'
import { KyselyEffect } from '../../src/index.ts'

interface UserTable {
  id: number
  email: string
}

interface DatabaseSchema {
  users: UserTable
}

class DatabasePool extends Service<DatabasePool>()('@types/DatabasePool') {
  readonly raw = {}
}

const Database = KyselyEffect.service<DatabaseSchema>()('@types/Database')

declare const database: Kysely<DatabaseSchema>
declare const invalidDatabase: Kysely<{ other: { id: string } }>
declare const pool: DatabasePool

type DatabaseInstance = KyselyEffect.ServiceInstance<'@types/Database', DatabaseSchema>

const scopedSync = Database.scoped(function* () {
  const resolvedPool = yield* DatabasePool
  expectTypeOf(resolvedPool).toEqualTypeOf<DatabasePool>()
  return database
})

const scopedAsync = Database.scoped(async function* () {
  const resolvedPool = yield* DatabasePool
  expectTypeOf(resolvedPool).toEqualTypeOf<DatabasePool>()
  await Promise.resolve()
  return database
})

const borrowedSync = Database.borrowed(function* () {
  const resolvedPool = yield* DatabasePool
  expectTypeOf(resolvedPool).toEqualTypeOf<DatabasePool>()
  return database
})

const borrowedAsync = Database.borrowed(async function* () {
  const resolvedPool = yield* DatabasePool
  expectTypeOf(resolvedPool).toEqualTypeOf<DatabasePool>()
  return database
})

const requirementFreeScoped = Database.scoped(() => database)
const requirementFreeBorrowed = Database.borrowed(async () => database)

expectTypeOf<Layer.Provided<typeof scopedSync>>().toEqualTypeOf<DatabaseInstance>()
expectTypeOf<Layer.Required<typeof scopedSync>>().toEqualTypeOf<DatabasePool>()
expectTypeOf<Layer.Provided<typeof scopedAsync>>().toEqualTypeOf<DatabaseInstance>()
expectTypeOf<Layer.Required<typeof scopedAsync>>().toEqualTypeOf<DatabasePool>()
expectTypeOf<Layer.Provided<typeof borrowedSync>>().toEqualTypeOf<DatabaseInstance>()
expectTypeOf<Layer.Required<typeof borrowedSync>>().toEqualTypeOf<DatabasePool>()
expectTypeOf<Layer.Provided<typeof borrowedAsync>>().toEqualTypeOf<DatabaseInstance>()
expectTypeOf<Layer.Required<typeof borrowedAsync>>().toEqualTypeOf<DatabasePool>()

expectTypeOf<Layer.Required<typeof requirementFreeScoped>>().toBeNever()
expectTypeOf<Layer.Required<typeof requirementFreeBorrowed>>().toBeNever()
expectTypeOf<
  Layer.Provided<ReturnType<typeof Database.succeed>>
>().toEqualTypeOf<DatabaseInstance>()

const appLive = Layer.complete(Layer.merge(Layer.succeed(DatabasePool, pool), scopedSync))
expectTypeOf<Layer.Required<typeof appLive>>().toBeNever()
expectTypeOf<Layer.Provided<typeof appLive>>().toEqualTypeOf<DatabasePool | DatabaseInstance>()

const program = Effect.fn(async function* () {
  const resolved = yield* Database
  const query = resolved.selectFrom('users').selectAll()
  expectTypeOf(resolved).toEqualTypeOf<DatabaseInstance>()
  expectTypeOf(query).toMatchTypeOf<SelectQueryBuilder<DatabaseSchema, 'users', UserTable>>()
  return (await import('better-result')).Result.ok(query)
})
expectTypeOf<Effect.Requirements<typeof program>>().toEqualTypeOf<DatabaseInstance>()

declare const completeRuntime: Runtime<DatabaseInstance>
void completeRuntime.run(program)

// @ts-expect-error The declared schema must be preserved by scoped factories.
Database.scoped(() => invalidDatabase)

// @ts-expect-error The declared schema must be preserved by borrowed factories.
Database.borrowed(() => invalidDatabase)

// @ts-expect-error The declared schema must be preserved by succeed.
Database.succeed(invalidDatabase)

// @ts-expect-error Kysely Service tokens remain non-constructible.
new Database()
