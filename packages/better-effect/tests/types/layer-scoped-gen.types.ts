import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../../src/effect'
import { Layer, type LayerBackend } from '../../src/layer'
import type { MissingDependencies } from '../../src/internal/missing-dependencies'
import { createRuntimeHandle } from '../../src/layer/runtime'
import { Runtime } from '../../src/runtime'
import { Scope, type ScopeOutcome } from '../../src/scope'
import { Service } from '../../src/service'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

class Logger extends Service<Logger>()('Logger') {
  write(message: string): void {
    void message
  }
}

class UserRepository extends Service<UserRepository>()('UserRepository') {
  constructor(readonly database: Database) {
    super()
  }

  audit() {
    return Effect.gen(async function* () {
      const logger = yield* Logger

      return Result.ok(logger)
    })
  }
}

declare const backend: LayerBackend
const DatabaseLive = Layer.succeed(Database, new Database())
const LoggerLive = Layer.succeed(Logger, new Logger())

const StructuralDatabaseLive = Layer.scopedGen(
  Database,
  // oxlint-disable-next-line require-yield
  async function* () {
    return { query: () => 'structurally acquired' }
  },
  (database, outcome) => {
    expectTypeOf(database).toEqualTypeOf<Database>()
    expectTypeOf(outcome).toEqualTypeOf<ScopeOutcome>()
  }
)

const UserRepositoryLive = Layer.scopedGen(
  UserRepository,
  async function* () {
    const database = yield* Database

    return new UserRepository(database)
  },
  (repository, outcome) => {
    expectTypeOf(repository).toEqualTypeOf<UserRepository>()
    expectTypeOf(outcome).toEqualTypeOf<ScopeOutcome>()

    void repository
    void outcome
  }
)

expectTypeOf<Layer.Provided<typeof UserRepositoryLive>>().toEqualTypeOf<UserRepository>()
expectTypeOf<Layer.Required<typeof UserRepositoryLive>>().toEqualTypeOf<Database | Logger>()

const Complete = Layer.merge(DatabaseLive, LoggerLive, UserRepositoryLive)

expectTypeOf<Layer.Required<typeof Complete>>().toBeNever()
expectTypeOf<Layer.Complete<typeof Complete>>().toEqualTypeOf<typeof Complete>()

void createRuntimeHandle(Complete, backend)
void Runtime.make(Complete, backend)
void StructuralDatabaseLive

const Incomplete = Layer.merge(UserRepositoryLive)

expectTypeOf<Layer.Required<typeof Incomplete>>().toEqualTypeOf<Database | Logger>()
expectTypeOf<Layer.Complete<typeof Incomplete>>().toMatchTypeOf<
  typeof Incomplete & MissingDependencies<Database | Logger>
>()

// @ts-expect-error Database and Logger are not supplied by this Layer.
void createRuntimeHandle(Incomplete, backend)

// @ts-expect-error Database and Logger are not supplied by this Layer.
void Runtime.make(Incomplete, backend)

Layer.scoped(
  UserRepository,
  () => new UserRepository(new Database()),
  (repository) => {
    expectTypeOf(repository).toEqualTypeOf<UserRepository>()
  }
)

Layer.scopedGen(
  UserRepository,
  // @ts-expect-error The scopedGen factory must return the requested Service instance.
  async function* () {
    const database = yield* Database

    return database
  },
  (_repository, _outcome) => {}
)

const ScopeOnly = Layer.scopedGen(
  UserRepository,
  async function* () {
    const scope = yield* Scope

    void scope

    return new UserRepository(new Database())
  },
  (_repository, outcome) => {
    expectTypeOf(outcome).toEqualTypeOf<ScopeOutcome>()
  }
)

expectTypeOf<Layer.Required<typeof ScopeOnly>>().toEqualTypeOf<Logger>()
