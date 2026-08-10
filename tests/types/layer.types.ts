import { expectTypeOf } from 'bun:test'

import { Layer } from '../../src/layer'

import { Service } from '../../src/service'

class Database extends Service<Database>() {
  query(): string {
    return 'query'
  }
}

class UserRepository extends Service<UserRepository>() {
  find(): string {
    return 'user'
  }
}

Layer.make(Database, () => new Database())

Layer.succeed(Database, new Database())

Layer.scoped(
  Database,

  () => new Database(),

  (database) => {
    expectTypeOf(database).toEqualTypeOf<Database>()

    database.query()
  }
)

// @ts-expect-error UserRepository is not a Database
Layer.make(Database, () => new UserRepository())

// @ts-expect-error UserRepository is not a Database
Layer.succeed(Database, new UserRepository())

Layer.scoped(
  Database,
  () => new Database(),
  // @ts-expect-error UserRepository is not a Database
  (_repository: UserRepository) => {}
)
