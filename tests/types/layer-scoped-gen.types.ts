import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../../src/effect'
import {
  Layer,
  type CompleteLayer,
  type LayerBackend,
  type LayerMissing,
  type LayerProvided,
  type LayerRawRequired
} from '../../src/layer'
import { createRuntimeHandle } from '../../src/layer/runtime'
import { Runtime } from '../../src/runtime'
import { Scope, type ScopeOutcome } from '../../src/scope'
import { Service, type ServiceToken } from '../../src/service'

class Database extends Service<Database>() {
  query(): string {
    return 'query'
  }
}

class Logger extends Service<Logger>() {
  write(message: string): void {
    void message
  }
}

class UserRepository extends Service<UserRepository>() {
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

const backend = {} as LayerBackend
const DatabaseLive = Layer.succeed(Database, new Database())
const LoggerLive = Layer.succeed(Logger, new Logger())

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

expectTypeOf<LayerProvided<typeof UserRepositoryLive>>().toEqualTypeOf<typeof UserRepository>()
expectTypeOf<LayerRawRequired<typeof UserRepositoryLive>>().toEqualTypeOf<
  ServiceToken<Database> | ServiceToken<Logger>
>()
expectTypeOf<LayerMissing<typeof UserRepositoryLive>>().toEqualTypeOf<
  ServiceToken<Database> | ServiceToken<Logger>
>()

const Complete = Layer.merge(DatabaseLive, LoggerLive, UserRepositoryLive)

expectTypeOf<LayerMissing<typeof Complete>>().toEqualTypeOf<never>()
expectTypeOf<CompleteLayer<typeof Complete>>().toEqualTypeOf<typeof Complete>()

void createRuntimeHandle(Complete, backend)
void Runtime.make(Complete, backend)

const Incomplete = Layer.merge(UserRepositoryLive)

expectTypeOf<LayerMissing<typeof Incomplete>>().toEqualTypeOf<
  ServiceToken<Database> | ServiceToken<Logger>
>()
expectTypeOf<CompleteLayer<typeof Incomplete>>().toMatchTypeOf<
  typeof Incomplete & {
    readonly __betterEffectMissingServices: ServiceToken<Database> | ServiceToken<Logger>
  }
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

expectTypeOf<LayerRawRequired<typeof ScopeOnly>>().toEqualTypeOf<ServiceToken<Logger>>()
