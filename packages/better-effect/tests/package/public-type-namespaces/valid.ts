import { Result } from 'better-result'

import {
  Effect,
  Layer,
  MapLayerBackend,
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
  type Program as LazyProgram,
  type RuntimeContextStorage,
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
import {
  layerBackendContract,
  runtimeContextStorageContract,
  type ContextConcurrency,
  type ContractScenario,
  type LayerBackendAcquisitionFailure,
  type LayerBackendContractOptions,
  type RuntimeContextStorageContractOptions
} from 'better-effect/testing'

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

class Repository extends Service<Repository>()('Repository') {}

class Config extends Service<Config>()('Config') {}

class Mailer extends Service<Mailer>()('Mailer') {}

class RichDatabase extends Service<RichDatabase>()('DeclarationDatabase') {
  query(): string {
    return 'rich'
  }

  migrate(): void {}
}

class LeanDatabase extends Service<LeanDatabase>()('DeclarationDatabase') {
  query(): string {
    return 'lean'
  }
}

const program = Effect.gen(async function* () {
  const database = yield* Database
  const repository = yield* Repository

  return Result.ok({ database, repository })
})

const DatabaseLive = Layer.succeed(Database, new Database())
const nativeBackend = new MapLayerBackend()
declare const contextStorage: RuntimeContextStorage
const backendContractOptions = {
  makeBackend: () => nativeBackend,
  acquisitionFailure: 'retry'
} satisfies LayerBackendContractOptions
const contextContractOptions = {
  makeStorage: () => contextStorage,
  concurrency: 'sequential'
} satisfies RuntimeContextStorageContractOptions
const RepositoryLive = Layer.gen(Repository, async function* () {
  const database = yield* Database
  void database
  return new Repository()
}) satisfies Layer<Repository, Database>
const MailerLive = Layer.gen(Mailer, async function* () {
  const config = yield* Config
  void config
  return new Mailer()
})
const AppLive = Layer.merge(DatabaseLive, RepositoryLive)
const MixedLive = Layer.merge(RepositoryLive, MailerLive)
const RepositoryFake = Layer.succeed(Repository, new Repository())
const PreciseOverride = Layer.override(MixedLive, RepositoryFake)
const ErasedMailer: Layer<Mailer, Config> = MailerLive
const MixedErasedLive = Layer.merge(RepositoryLive, ErasedMailer)
const ErasedMailerOverride = Layer.override(MixedErasedLive, Layer.succeed(Mailer, new Mailer()))

export type MixedRequired = Expect<Equal<Layer.Required<typeof PreciseOverride>, Config>>
export type ErasedRequired = Expect<
  Equal<Layer.Required<typeof ErasedMailerOverride>, Database | Config>
>

const RichLive = Layer.make(RichDatabase)
const LeanLive = Layer.make(LeanDatabase)
// @ts-expect-error incompatible same-tag overrides fail at the call site
Layer.override(RichLive, LeanLive)

type Program = typeof program

export type ProgramAlias = Expect<
  Equal<
    LazyProgram<string, never, Database>,
    import('better-effect').Program<string, never, Database>
  >
>
export type EffectProgramAlias = Expect<
  Equal<Effect.Program<string, never, Database>, LazyProgram<string, never, Database>>
>

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

// oxlint-disable-next-line typescript/no-redundant-type-constituents -- Layer.Any intentionally includes the unchecked escape-hatch branches.
export type LayerAnyAlias = Expect<Equal<Layer.Any, Layer<any, any> | Layer<never, any>>>
export type LayerProvidedAlias = Expect<
  Equal<Layer.Provided<typeof AppLive>, Database | Repository>
>
export type LayerRequiredAlias = Expect<Equal<Layer.Required<typeof AppLive>, never>>
export type LayerMissingAlias = Expect<Equal<Layer.Missing<typeof AppLive>, never>>
export type LayerCompleteAlias = Expect<Equal<Layer.Complete<typeof AppLive>, typeof AppLive>>

export type RuntimeForAlias = Expect<Equal<Runtime.For<typeof AppLive>, RuntimeFor<typeof AppLive>>>
export type RuntimeEnvironmentAlias = Expect<
  Equal<Runtime.For<typeof AppLive>, Runtime<Layer.Provided<typeof AppLive>>>
>
export type RuntimeOptionsAlias = Expect<Equal<Runtime.Options, RuntimeOptions>>
export type RuntimeDiagnosticAlias = Expect<
  Equal<Runtime.ShutdownDiagnostic, RuntimeShutdownDiagnostic>
>
export type LayerBackendContractFailureAlias = Expect<
  Equal<LayerBackendAcquisitionFailure, 'retry' | 'sticky'>
>
export type ContextConcurrencyAlias = Expect<Equal<ContextConcurrency, 'concurrent' | 'sequential'>>

const backendScenarios = layerBackendContract(backendContractOptions)
const contextScenarios = runtimeContextStorageContract(contextContractOptions)

export type LayerBackendScenarioAlias = Expect<
  Equal<typeof backendScenarios, readonly ContractScenario[]>
>
export type RuntimeContextStorageScenarioAlias = Expect<
  Equal<typeof contextScenarios, readonly ContractScenario[]>
>

export type ScopeCloseableAlias = Expect<Equal<Scope.Closeable, CloseableScope>>
export type ScopeOutcomeAlias = Expect<Equal<Scope.Outcome, ScopeOutcome>>
export type ScopeFinalizerAlias = Expect<Equal<Scope.Finalizer, ScopeFinalizer>>
export type ScopeDisposableAlias = Expect<Equal<Scope.Disposable, DisposableResource>>

void nativeBackend
