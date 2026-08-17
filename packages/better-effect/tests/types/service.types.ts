import { expectTypeOf } from 'bun:test'

import { type ServiceRequirement } from '../../src/effect'
import { Service, ServiceRuntime, type ServiceContract, type ServiceToken } from '../../src/service'

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

declare const inspect: unique symbol

class SymbolService extends Service<SymbolService>()('SymbolService') {
  [inspect](): string {
    return 'symbol'
  }
}

expectTypeOf<ServiceContract<SymbolService>>().toEqualTypeOf<{
  [inspect](): string
}>()

SymbolService.of({
  [inspect]: () => 'structural symbol'
})

// @ts-expect-error ServiceContract removes only identity; behavioral symbol members remain required.
SymbolService.of({})

async function* serviceYieldTypes() {
  const database = yield* Database

  const users = yield* UserRepository

  expectTypeOf(database).toEqualTypeOf<Database>()

  expectTypeOf(users).toEqualTypeOf<UserRepository>()
}

type DatabaseIterator = ReturnType<(typeof Database)[typeof Symbol.asyncIterator]>

expectTypeOf<DatabaseIterator>().toEqualTypeOf<
  AsyncGenerator<ServiceRequirement<Database>, Database, unknown>
>()

async function runtimeTypes() {
  const database = await ServiceRuntime.resolve(Database)

  expectTypeOf(database).toEqualTypeOf<Database>()
}

function tokenTypes() {
  expectTypeOf(Database).toMatchTypeOf<ServiceToken<'Database', Database>>()

  expectTypeOf(UserRepository).toMatchTypeOf<ServiceToken<'UserRepository', UserRepository>>()

  expectTypeOf(Database.of).parameter(0).toEqualTypeOf<ServiceContract<Database>>()
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
