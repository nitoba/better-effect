import { Result } from 'better-result'

import {
  Effect,
  Layer,
  Runtime,
  Scope,
  Service,
  type AnyEffect,
  type AnyService,
  type CloseableScope,
  type DisposableResource,
  type EffectError,
  type EffectRequirements,
  type EffectSuccess,
  type LayerMissing,
  type LayerProvided,
  type LayerRawRequired,
  type LayerSpecs,
  type RuntimeFor,
  type RuntimeOptions,
  type RuntimeShutdownDiagnostic,
  type ScopeFinalizer,
  type ScopeOutcome,
  type ServiceClass,
  type ServiceContract,
  type ServiceIdentity,
  type ServiceInstance,
  type ServiceRequirements,
  type ServiceTag,
  type ServiceToken,
  type ServiceTokenOf
} from 'better-effect'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Expect<Value extends true> = Value

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
const RepositoryLive = Layer.make(Repository)
const AppLive = Layer.merge(DatabaseLive, RepositoryLive)

type Program = typeof program

export type EffectSuccessAlias = Expect<Equal<Effect.Success<Program>, EffectSuccess<Program>>>
export type EffectErrorAlias = Expect<Equal<Effect.Error<Program>, EffectError<Program>>>
export type EffectRequirementsAlias = Expect<
  Equal<Effect.Requirements<Program>, EffectRequirements<Program>>
>
export type EffectAnyAlias = Expect<Equal<Effect.Any, AnyEffect>>

export type ServiceAnyAlias = Expect<Equal<Service.Any, AnyService>>
export type ServiceTokenDefault = Expect<Equal<Service.Token, ServiceToken>>
export type ServiceTokenAlias = Expect<
  Equal<Service.Token<'Database', Database>, ServiceToken<'Database', Database>>
>
export type ServiceClassDefault = Expect<Equal<Service.Class, ServiceClass>>
export type ServiceClassAlias = Expect<
  Equal<Service.Class<'Database', Database>, ServiceClass<'Database', Database>>
>
export type ServiceIdentityAlias = Expect<
  Equal<Service.Identity<'Database'>, ServiceIdentity<'Database'>>
>
export type ServiceContractAlias = Expect<
  Equal<Service.Contract<Database>, ServiceContract<Database>>
>
export type ServiceTokenOfAlias = Expect<Equal<Service.TokenOf<Database>, ServiceTokenOf<Database>>>
export type ServiceFactoryOfAlias = Expect<
  Equal<
    Service.FactoryOf<Database, 'Database'>,
    (this: void, implementation: ServiceContract<Database>) => Database
  >
>
export type ServiceInstanceAlias = Expect<
  Equal<Service.Instance<typeof Database>, ServiceInstance<typeof Database>>
>
export type ServiceTagAlias = Expect<Equal<Service.Tag<Database>, ServiceTag<Database>>>
export type ServiceRequirementsAlias = Expect<
  Equal<Service.Requirements<Repository>, ServiceRequirements<Repository>>
>

export type LayerAnyAlias = Expect<Equal<Layer.Any, Layer<any, any> | Layer<never, any>>>
export type LayerSpecsAlias = Expect<Equal<Layer.Specs<typeof AppLive>, LayerSpecs<typeof AppLive>>>
export type LayerProvidedAlias = Expect<
  Equal<Layer.Provided<typeof AppLive>, LayerProvided<typeof AppLive>>
>
export type LayerRequiredAlias = Expect<
  Equal<Layer.Required<typeof AppLive>, LayerRawRequired<typeof AppLive>>
>
export type LayerMissingAlias = Expect<
  Equal<Layer.Missing<typeof AppLive>, LayerMissing<typeof AppLive>>
>
export type LayerCompleteAlias = Expect<Equal<Layer.Complete<typeof AppLive>, typeof AppLive>>

export type RuntimeForAlias = Expect<Equal<Runtime.For<typeof AppLive>, RuntimeFor<typeof AppLive>>>
export type RuntimeEnvironmentAlias = Expect<
  Equal<Runtime.For<typeof AppLive>, Runtime<Layer.Provided<typeof AppLive>>>
>
export type RuntimeOptionsAlias = Expect<Equal<Runtime.Options, RuntimeOptions>>
export type RuntimeDiagnosticAlias = Expect<
  Equal<Runtime.ShutdownDiagnostic, RuntimeShutdownDiagnostic>
>

export type ScopeCloseableAlias = Expect<Equal<Scope.Closeable, CloseableScope>>
export type ScopeOutcomeAlias = Expect<Equal<Scope.Outcome, ScopeOutcome>>
export type ScopeFinalizerAlias = Expect<Equal<Scope.Finalizer, ScopeFinalizer>>
export type ScopeDisposableAlias = Expect<Equal<Scope.Disposable, DisposableResource>>
