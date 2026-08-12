import { expectTypeOf } from 'bun:test'

import { Service, ServiceRuntime, type ServiceToken } from '../../src/service'

class Database extends Service<Database>()('Database') {
  query(sql: string): string {
    return sql
  }
}

class UserRepository extends Service<UserRepository>()('UserRepository') {
  find(): string {
    return 'user'
  }
}

async function* serviceYieldTypes() {
  const database = yield* Database

  const users = yield* UserRepository

  expectTypeOf(database).toEqualTypeOf<Database>()

  expectTypeOf(users).toEqualTypeOf<UserRepository>()
}

async function runtimeTypes() {
  const database = await ServiceRuntime.resolve(Database)

  expectTypeOf(database).toEqualTypeOf<Database>()
}

function tokenTypes() {
  expectTypeOf(Database).toMatchTypeOf<ServiceToken<'Database', Database>>()

  expectTypeOf(UserRepository).toMatchTypeOf<ServiceToken<'UserRepository', UserRepository>>()

  expectTypeOf(Database.of).parameter(0).toEqualTypeOf<Database>()
  expectTypeOf(Database.of).returns.toEqualTypeOf<Database>()

  const structuralDatabase = Database.of({
    query: (sql) => {
      expectTypeOf(sql).toEqualTypeOf<string>()
      return `structural result: ${sql}`
    }
  })

  expectTypeOf(structuralDatabase).toEqualTypeOf<Database>()

  const token: ServiceToken<'Database', Database> = Database
  const structuralFromToken = token.of({
    query: () => 'structural result'
  })

  expectTypeOf(structuralFromToken).toEqualTypeOf<Database>()

  // @ts-expect-error query is required
  Database.of({})

  Database.of({
    // @ts-expect-error query must return string
    query: () => 123
  })
}

void serviceYieldTypes
void runtimeTypes
void tokenTypes
