import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../../src/effect'
import { Layer } from '../../src/layer'
import { createRuntimeHandle } from '../../src/layer/runtime'
import type { MissingDependencies } from '../../src/internal/missing-dependencies'
import { Runtime } from '../../src/runtime'
import type { ScopeOutcome } from '../../src/scope'

import { Service } from '../../src/service'

declare const backend: never

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

class ConfiguredService extends Service<ConfiguredService>()('ConfiguredService') {
  constructor(readonly value: number) {
    super()
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
Layer.make(Database)

const DatabaseAcquiredStructurally = Layer.make(Database, () => ({
  query: () => 'acquired structurally'
}))

Layer.make(ConfiguredService, () => new ConfiguredService(42))

// @ts-expect-error ConfiguredService requires a constructor argument
Layer.make(ConfiguredService)

Layer.succeed(Database, new Database())

const DatabaseSucceededStructurally = Layer.succeed(Database, {
  query: () => 'succeeded structurally'
})

Layer.scoped(
  Database,

  () => new Database(),

  (database, outcome) => {
    expectTypeOf(database).toEqualTypeOf<Database>()
    expectTypeOf(outcome).toEqualTypeOf<ScopeOutcome>()

    database.query()
  }
)

Layer.scoped(
  Database,
  () => ({ query: () => 'scoped structurally' }),
  (database) => {
    expectTypeOf(database).toEqualTypeOf<Database>()
  }
)

const DatabaseGeneratedStructurally = Layer.gen(
  Database,
  // oxlint-disable-next-line require-yield
  async function* () {
    return { query: () => 'generated structurally' }
  }
)

const DatabaseScopedGeneratedStructurally = Layer.scopedGen(
  Database,
  // oxlint-disable-next-line require-yield
  async function* () {
    return { query: () => 'scoped generated structurally' }
  },
  (database, outcome) => {
    expectTypeOf(database).toEqualTypeOf<Database>()
    expectTypeOf(outcome).toEqualTypeOf<ScopeOutcome>()
  }
)

void DatabaseAcquiredStructurally
void DatabaseSucceededStructurally
void DatabaseGeneratedStructurally
void DatabaseScopedGeneratedStructurally

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

expectTypeOf<Layer.Required<typeof PasswordsGeneratedLive>>().toEqualTypeOf<FactoryDependency>()

expectTypeOf<Layer.Required<typeof PasswordsOverridden>>().toBeNever()

const PasswordsReplacementWithRequirement = Layer.gen(PasswordHasher, async function* () {
  const dependency = yield* ReplacementDependency

  void dependency

  return new PasswordHasher()
})

const PasswordsNeedsReplacementDependency = Layer.override(
  PasswordsGeneratedLive,
  PasswordsReplacementWithRequirement
)

expectTypeOf<
  Layer.Required<typeof PasswordsNeedsReplacementDependency>
>().toEqualTypeOf<ReplacementDependency>()

const PasswordsMultipleOverride = Layer.override(
  PasswordsGeneratedLive,
  PasswordsLive,
  PasswordsReplacementWithRequirement
)

expectTypeOf<
  Layer.Required<typeof PasswordsMultipleOverride>
>().toEqualTypeOf<ReplacementDependency>()

const WithUnrelatedProvider = Layer.merge(DatabaseLive, PasswordsGeneratedLive)
const OverriddenWithUnrelatedProvider = Layer.override(WithUnrelatedProvider, PasswordsLive)

expectTypeOf<Layer.Required<typeof OverriddenWithUnrelatedProvider>>().toBeNever()

const Broken = Layer.merge(UsersLive, AuthLive)

expectTypeOf<Layer.Required<typeof Broken>>().toEqualTypeOf<Database | PasswordHasher>()

expectTypeOf<Layer.Complete<typeof Broken>>().toMatchTypeOf<
  typeof Broken & MissingDependencies<Database | PasswordHasher>
>()

expectTypeOf<Layer.Required<typeof UsersGeneratedLive>>().toEqualTypeOf<Database>()

const Complete = Layer.merge(DatabaseLive, UsersLive, PasswordsLive, AuthLive)

expectTypeOf<Layer.Required<typeof Complete>>().toBeNever()
expectTypeOf<Layer.Missing<typeof Broken>>().toEqualTypeOf<Database | PasswordHasher>()
expectTypeOf(Layer.complete(Complete)).toEqualTypeOf<typeof Complete>()

// @ts-expect-error Layer.complete rejects composition roots with missing Services.
Layer.complete(Broken)

// @ts-expect-error Broken does not provide Database or PasswordHasher
void Runtime.make(Broken, backend)
void Runtime.make(Complete, backend)

// @ts-expect-error createRuntimeHandle enforces the same complete-Layer contract as Runtime.make
void createRuntimeHandle(Broken, backend)
void createRuntimeHandle(Complete, backend)

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
