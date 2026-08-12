import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect, type EffectRequirements } from '../../src/effect'
import { Service, ServiceRuntime, type ServiceToken } from '../../src/service'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'database'
  }
}

const program = Effect.gen(async function* () {
  const database = yield* Database

  expectTypeOf(database).toEqualTypeOf<Database>()

  return Result.ok(database)
})

expectTypeOf<EffectRequirements<typeof program>>().toEqualTypeOf<
  ServiceToken<'Database', Database>
>()

const database = await ServiceRuntime.resolve(Database)

expectTypeOf(database).toEqualTypeOf<Database>()

const DATABASE_TAG = 'Database' as const

class DatabaseWithConstTag extends Service<DatabaseWithConstTag>()(DATABASE_TAG) {}

expectTypeOf(DatabaseWithConstTag.serviceTag).toEqualTypeOf<'Database'>()

declare const dynamicTag: string

// @ts-expect-error Service tags must remain string literals.
Service<unknown>()(dynamicTag)

// @ts-expect-error Empty Service tags are not valid identities.
Service<unknown>()('')

void program
void database
