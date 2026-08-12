import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../../src/effect'
import { Layer } from '../../src/layer'
import { createRuntimeHandle } from '../../src/layer/runtime'
import type { CompleteLayer, LayerMissing, LayerRawRequired } from '../../src/layer'
import { Runtime } from '../../src/runtime'

import { Service, type ServiceToken } from '../../src/service'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

class UserRepository extends Service<UserRepository>()('UserRepository') {
  find(): string {
    return 'user'
  }

  load() {
    return Effect.gen(async function* () {
      const database = yield* Database

      return Result.ok(database)
    })
  }
}

class PasswordHasher extends Service<PasswordHasher>()('PasswordHasher') {
  hash() {
    return Result.ok('hash')
  }
}

class FactoryDependency extends Service<FactoryDependency>()('FactoryDependency') {
  factoryOnly(): void {}
}

class ReplacementDependency extends Service<ReplacementDependency>()('ReplacementDependency') {
  replacementOnly(): void {}
}

class AuthService extends Service<AuthService>()('AuthService') {
  login() {
    return Effect.gen(async function* () {
      const users = yield* UserRepository

      const passwords = yield* PasswordHasher

      return Result.ok({ users, passwords })
    })
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

const DatabaseLive = Layer.make(Database, () => new Database())
const UsersLive = Layer.make(UserRepository, () => new UserRepository())
const UsersGeneratedLive = Layer.gen(UserRepository, async function* () {
  const database = yield* Database

  void database

  return new UserRepository()
})
const PasswordsLive = Layer.make(PasswordHasher, () => new PasswordHasher())
const AuthLive = Layer.make(AuthService, () => new AuthService())

const PasswordsGeneratedLive = Layer.gen(PasswordHasher, async function* () {
  const dependency = yield* FactoryDependency

  void dependency

  return new PasswordHasher()
})

const PasswordsOverridden = Layer.override(PasswordsGeneratedLive, PasswordsLive)

expectTypeOf<LayerMissing<typeof PasswordsGeneratedLive>>().toEqualTypeOf<
  ServiceToken<'FactoryDependency', FactoryDependency>
>()

expectTypeOf<LayerMissing<typeof PasswordsOverridden>>().toEqualTypeOf<never>()

const PasswordsReplacementWithRequirement = Layer.gen(PasswordHasher, async function* () {
  const dependency = yield* ReplacementDependency

  void dependency

  return new PasswordHasher()
})

const PasswordsNeedsReplacementDependency = Layer.override(
  PasswordsGeneratedLive,
  PasswordsReplacementWithRequirement
)

expectTypeOf<LayerMissing<typeof PasswordsNeedsReplacementDependency>>().toEqualTypeOf<
  ServiceToken<'ReplacementDependency', ReplacementDependency>
>()

const PasswordsMultipleOverride = Layer.override(
  PasswordsGeneratedLive,
  PasswordsLive,
  PasswordsReplacementWithRequirement
)

expectTypeOf<LayerMissing<typeof PasswordsMultipleOverride>>().toEqualTypeOf<
  ServiceToken<'ReplacementDependency', ReplacementDependency>
>()

const WithUnrelatedProvider = Layer.merge(DatabaseLive, PasswordsGeneratedLive)
const OverriddenWithUnrelatedProvider = Layer.override(WithUnrelatedProvider, PasswordsLive)

expectTypeOf<LayerRawRequired<typeof OverriddenWithUnrelatedProvider>>().toEqualTypeOf<never>()

const Broken = Layer.merge(UsersLive, AuthLive)

expectTypeOf<LayerMissing<typeof Broken>>().toEqualTypeOf<
  ServiceToken<'Database', Database> | ServiceToken<'PasswordHasher', PasswordHasher>
>()

expectTypeOf<CompleteLayer<typeof Broken>>().toMatchTypeOf<
  typeof Broken & {
    readonly __betterEffectMissingServices:
      | ServiceToken<'Database', Database>
      | ServiceToken<'PasswordHasher', PasswordHasher>
  }
>()

expectTypeOf<LayerMissing<typeof UsersGeneratedLive>>().toEqualTypeOf<
  ServiceToken<'Database', Database>
>()

const Complete = Layer.merge(DatabaseLive, UsersLive, PasswordsLive, AuthLive)

expectTypeOf<LayerMissing<typeof Complete>>().toEqualTypeOf<never>()

// @ts-expect-error Broken does not provide Database or PasswordHasher
void Runtime.make(Broken, {} as never)
void Runtime.make(Complete, {} as never)

// @ts-expect-error createRuntimeHandle enforces the same complete-Layer contract as Runtime.make
void createRuntimeHandle(Broken, {} as never)
void createRuntimeHandle(Complete, {} as never)

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
