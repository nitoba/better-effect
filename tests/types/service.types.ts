import { expectTypeOf } from 'bun:test'

import { Service, ServiceRuntime, type ServiceToken } from '../../src/service'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'result'
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
}

void serviceYieldTypes
void runtimeTypes
void tokenTypes
