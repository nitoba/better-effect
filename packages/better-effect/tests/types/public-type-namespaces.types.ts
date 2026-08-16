import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import {
  Effect,
  type AnyEffectResult,
  type EffectError,
  type EffectRequirements,
  type EffectSuccess,
  Layer,
  type LayerMissing,
  type LayerProvided,
  type LayerRawRequired,
  type LayerSpecs,
  Runtime,
  type RuntimeFor,
  type RuntimeOptions,
  type RuntimeShutdownDiagnostic,
  Scope,
  type CloseableScope,
  type DisposableResource,
  type ScopeFinalizer,
  type ScopeOutcome,
  Service,
  type AnyServiceToken,
  type ServiceClass,
  type ServiceInstance,
  type ServiceRequirements,
  type ServiceTag,
  type ServiceToken
} from '../../src'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

class Repository extends Service<Repository>()('Repository') {
  load() {
    return Effect.gen(async function* () {
      const database = yield* Database

      return Result.ok(database.query())
    })
  }
}

const program = Effect.gen(async function* () {
  const database = yield* Database
  const repository = yield* Repository

  return Result.ok({ database, repository })
})

const DatabaseLive = Layer.succeed(Database, new Database())
const RepositoryLive = Layer.make(Repository, () => new Repository())
const AppLive = Layer.merge(DatabaseLive, RepositoryLive)

expectTypeOf<Effect.Success<typeof program>>().toEqualTypeOf<EffectSuccess<typeof program>>()
expectTypeOf<Effect.Error<typeof program>>().toEqualTypeOf<EffectError<typeof program>>()
expectTypeOf<Effect.Requirements<typeof program>>().toEqualTypeOf<
  EffectRequirements<typeof program>
>()
expectTypeOf<Effect.AnyResult>().toEqualTypeOf<AnyEffectResult>()

expectTypeOf<Service.Any>().toEqualTypeOf<AnyServiceToken>()
expectTypeOf<Service.Token<'Database', Database>>().toEqualTypeOf<
  ServiceToken<'Database', Database>
>()
expectTypeOf<Service.Class<'Database', Database>>().toEqualTypeOf<
  ServiceClass<'Database', Database>
>()
expectTypeOf<Service.Instance<typeof Database>>().toEqualTypeOf<ServiceInstance<typeof Database>>()
expectTypeOf<Service.Tag<typeof Database>>().toEqualTypeOf<ServiceTag<typeof Database>>()
expectTypeOf<Service.Requirements<typeof Repository>>().toEqualTypeOf<
  ServiceRequirements<typeof Repository>
>()
expectTypeOf<Service.Token>().toEqualTypeOf<ServiceToken>()
expectTypeOf<Service.Class>().toEqualTypeOf<ServiceClass>()

expectTypeOf<Layer.Any>().toEqualTypeOf<Layer<any, any> | Layer<never, any>>()
expectTypeOf<Layer.Specs<typeof AppLive>>().toEqualTypeOf<LayerSpecs<typeof AppLive>>()
expectTypeOf<Layer.Provided<typeof AppLive>>().toEqualTypeOf<LayerProvided<typeof AppLive>>()
expectTypeOf<Layer.Required<typeof AppLive>>().toEqualTypeOf<LayerRawRequired<typeof AppLive>>()
expectTypeOf<Layer.Missing<typeof AppLive>>().toEqualTypeOf<LayerMissing<typeof AppLive>>()
expectTypeOf<Layer.Complete<typeof AppLive>>().toEqualTypeOf<typeof AppLive>()

expectTypeOf<Runtime.For<typeof AppLive>>().toEqualTypeOf<RuntimeFor<typeof AppLive>>()
expectTypeOf<Runtime.Options>().toEqualTypeOf<RuntimeOptions>()
expectTypeOf<Runtime.ShutdownDiagnostic>().toEqualTypeOf<RuntimeShutdownDiagnostic>()

expectTypeOf<Scope.Closeable>().toEqualTypeOf<CloseableScope>()
expectTypeOf<Scope.Outcome>().toEqualTypeOf<ScopeOutcome>()
expectTypeOf<Scope.Finalizer>().toEqualTypeOf<ScopeFinalizer>()
expectTypeOf<Scope.Disposable>().toEqualTypeOf<DisposableResource>()

// @ts-expect-error Service.Token tags must be strings.
expectTypeOf<Service.Token<42>>()

// @ts-expect-error Service.Instance requires a Service token.
expectTypeOf<Service.Instance<object>>()

// @ts-expect-error Layer.Provided requires a Layer.
expectTypeOf<Layer.Provided<object>>()

// @ts-expect-error Runtime.For requires a Layer.
expectTypeOf<Runtime.For<object>>()

void AppLive
void program
