import {
  Result,
  TaggedError,
  type Result as ResultType,
  type UnhandledException
} from 'better-result'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { validator } from 'hono/validator'

import {
  Effect,
  Program,
  Layer,
  pipe,
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
  type LayerBackendDisposeOptions,
  type Program as LazyProgram,
  type RuntimeContextStorage,
  type RuntimeExecutionAttributes,
  type RuntimeExecutionInspection,
  type RuntimeExecutionMetadata,
  type RuntimeFor,
  type RuntimeInspection,
  type RuntimeOptions,
  type RuntimeRunOptions,
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
import { HonoEffect } from 'better-effect/hono'
import { NodeRuntime, type NodeRuntimeOptions } from 'better-effect/node'
import { WebEffect } from 'better-effect/web'
import type { WebEffectOptions } from 'better-effect/web'
import { CurrentRequest } from 'better-effect/standard-services'
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

class DisposablePackageService extends Service<DisposablePackageService>()('DisposablePackage') {
  request(): string {
    return 'request'
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

type PackageConnection = {
  readonly id: string
}

type PackageAcquireFailure = {
  readonly _tag: 'PackageAcquireFailure'
}

const packageResourceProgram = Effect.gen(async function* () {
  const connection = yield* Effect.acquireReleaseResult(
    () => Result.ok<PackageConnection, PackageAcquireFailure>({ id: 'package' }),
    (_connection, outcome) => {
      void outcome
    }
  )

  return Result.ok(connection)
})

const packageDisposableValue = {
  request: () => 'request',
  [Symbol.dispose]() {}
}

const packageDisposable = Effect.gen(async function* () {
  const resource = yield* Effect.acquireDisposable(() => packageDisposableValue)

  return Result.ok(resource)
})

const DisposablePackageLive = Layer.scopedDisposable(
  DisposablePackageService,
  () => new DisposablePackageService()
)

// @ts-expect-error acquireDisposable requires a disposable resource
Effect.acquireDisposable(() => ({ request: () => 'plain' }))
// @ts-expect-error scopedDisposable requires a disposable provider result
Layer.scopedDisposable(Database, () => new Database())

export type PackageResourceSuccess = Expect<
  Equal<EffectSuccess<typeof packageResourceProgram>, PackageConnection>
>
export type PackageResourceError = Expect<
  Equal<EffectError<typeof packageResourceProgram>, PackageAcquireFailure | UnhandledException>
>
export type PackageResourceRequirements = Expect<
  Equal<EffectRequirements<typeof packageResourceProgram>, never>
>
export type PackageDisposableSuccess = Expect<
  Equal<EffectSuccess<typeof packageDisposable>, typeof packageDisposableValue>
>
export type PackageDisposableLayer = Expect<
  Equal<Layer.Provided<typeof DisposablePackageLive>, DisposablePackageService>
>

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

class PackageNotFound extends TaggedError('PackageNotFound')<{
  readonly message: string
}> {}

class PackageDenied extends TaggedError('PackageDenied')<{
  readonly message: string
}> {}

class PackageHttpError extends TaggedError('PackageHttpError')<{
  readonly message: string
}> {}

const program = Effect.gen(async function* () {
  const database = yield* Database
  const repository = yield* Repository

  return Result.ok({ database, repository })
})

type RouteEnv = {
  readonly Bindings: {
    readonly API_KEY: string
  }
  readonly Variables: {
    readonly user: {
      readonly id: string
    }
  }
}
type RoutePath = '/work-orders/:id'

const validateJson = validator('json', (value: { name?: string } | null) => ({
  name: value?.name ?? ''
}))
const routeMiddleware: MiddlewareHandler<RouteEnv, RoutePath> = async (_context, next) => {
  await next()
}
declare const webRuntime: Runtime<never>
const webProgram = Effect.fn(async function* () {
  const currentRequest = yield* CurrentRequest
  return Result.ok(currentRequest.request)
})
const webResponse = WebEffect.handleWith(
  webRuntime.executor,
  new Request('https://example.test'),
  webProgram,
  {
    onSuccess: ({ value }) => Response.json(value)
  }
)
const webOptions: WebEffectOptions<unknown> = {
  onFailure: () => new Response(null, { status: 500 })
}
const webResponseWithOptions = WebEffect.handleWith(
  webRuntime.executor,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('ok')
  }),
  webOptions
)
void webResponse
void webResponseWithOptions

const HonoApp = HonoEffect.app('@package/ValidHonoApp', {}, async function* (http) {
  const validatorFirstHandler = yield* http.gen(
    validateJson,
    routeMiddleware,
    async function* (context) {
      const apiKey: string = context.env.API_KEY
      const userId: string = context.get('user').id
      const input: { name: string } = context.req.valid('json')
      const id: string = context.req.param('id')
      yield* Result.await(Promise.resolve(Result.ok(undefined)))

      return Result.ok(`${apiKey}:${userId}:${input.name}:${id}`)
    }
  )

  const app = new Hono<RouteEnv>()
  app.get('/work-orders/:id', validatorFirstHandler)
  return app
})
void HonoApp

export type ValidatorFirstEnvironment = RouteEnv
export type ValidatorFirstPath = RoutePath

const nodeRuntimeOptions: NodeRuntimeOptions<string, never> = {
  signals: ['SIGINT', 'SIGTERM'],
  onSuccess: (value) => {
    const exact: string = value
    return exact.length > 0 ? 0 : 1
  },
  onFailure: () => 1
}

const nodeRuntimeResult = NodeRuntime.runMain(
  Layer.empty,
  () => Result.ok('node-main'),
  nodeRuntimeOptions
)
void nodeRuntimeResult

const mixedNodeMain = () => (Math.random() > 0.5 ? 42 : Result.ok('mixed-node-main'))
const mixedNodeRuntimeResult = NodeRuntime.runMain(Layer.empty, mixedNodeMain, {
  onSuccess: (value) => {
    const exact: string | number = value
    void exact
    return 0
  }
})
void mixedNodeRuntimeResult

// @ts-expect-error A mixed plain/Result main must not accept a string-only success handler.
void NodeRuntime.runMain(Layer.empty, mixedNodeMain, {
  onSuccess: (value: string) => value.length
})

// @ts-expect-error NodeRuntime has no separate grace-period cancellation policy.
const removedNodeGraceOptions: NodeRuntimeOptions = { gracePeriod: 5_000 }
void removedNodeGraceOptions

const DatabaseLive = Layer.succeed(Database, new Database())
const nativeBackend = new MapLayerBackend()
declare const contextStorage: RuntimeContextStorage
const backendContractOptions = {
  makeBackend: () => nativeBackend,
  acquisitionFailure: 'retry'
} satisfies LayerBackendContractOptions
const backendDisposeOptions = {
  onPendingAcquisitions: async (acquisitions) => {
    await Promise.allSettled(acquisitions)
  }
} satisfies LayerBackendDisposeOptions
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

declare const taggedEffect: Effect<number, PackageNotFound | PackageDenied>
const asyncTapped = Effect.tapBothAsync(taggedEffect, {
  ok: async () => {},
  err: async () => {}
})
const exhaustivelyMatched = Effect.matchError(taggedEffect, {
  PackageNotFound: (error) => new PackageHttpError({ message: error.message }),
  PackageDenied: (error) => new PackageHttpError({ message: error.message })
})
const partiallyMatched = Effect.matchErrorPartial(taggedEffect, {
  PackageNotFound: (error) => new PackageHttpError({ message: error.message })
})
type OptionalHandlers = {
  PackageNotFound?: (error: PackageNotFound) => PackageHttpError
}
declare const optionalHandlers: OptionalHandlers
const optionallyMatched = Effect.matchErrorPartial(taggedEffect, optionalHandlers)

export type AsyncTapAlias = Expect<
  Equal<Awaited<typeof asyncTapped>, Effect<number, PackageNotFound | PackageDenied>>
>
export type ExhaustiveMatchAlias = Expect<
  Equal<typeof exhaustivelyMatched, Effect<number, PackageHttpError>>
>
export type PartialMatchAlias = Expect<
  Equal<typeof partiallyMatched, Effect<number, PackageHttpError | PackageDenied>>
>
export type OptionalPartialMatchAlias = Expect<
  Equal<
    typeof optionallyMatched,
    Effect<number, PackageNotFound | PackageDenied | PackageHttpError>
  >
>
// @ts-expect-error every tagged error variant must be handled
Effect.matchError(taggedEffect, {
  PackageNotFound: (error) => new PackageHttpError({ message: error.message })
})
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

type EagerProgram = typeof program

const lazyProgram = Effect.fn(function* () {
  yield* []
  return Result.ok('lazy')
})
const namedProgram = Program.named('package.lazy', lazyProgram)
const pipedNamedProgram = pipe(lazyProgram, Program.named('package.lazy.piped'))
export type NamedProgramAlias = Expect<Equal<typeof namedProgram, typeof lazyProgram>>
export type PipedNamedProgramAlias = Expect<Equal<typeof pipedNamedProgram, typeof lazyProgram>>
const mappedProgram = Program.map(namedProgram, (value) => value.length)
const chainedProgram = Program.andThen(mappedProgram, (value) => Result.ok(value > 0))
const observedProgram = Program.tap(chainedProgram, () => undefined)
const recoveredProgram = Program.recover(observedProgram, () => Result.ok(false))
const namedCollection = Program.all([namedProgram], { name: 'package.collection' })
const packageExecutionOptions = {
  attributes: { requestId: 'package-request' }
} satisfies RuntimeRunOptions
const packageMetadataRun = Runtime.run(Layer.merge(), namedProgram, packageExecutionOptions)
declare const packageRuntime: Runtime<Database | Repository>
const packageInspection = packageRuntime.inspect()
export type RuntimeInspectionMethod = Expect<Equal<typeof packageInspection, RuntimeInspection>>
export type RuntimeInspectionNamespace = Expect<Equal<Runtime.Inspection, RuntimeInspection>>
export type RuntimeExecutionInspectionNamespace = Expect<
  Equal<Runtime.ExecutionInspection, RuntimeExecutionInspection>
>
// @ts-expect-error Runtime inspection snapshots expose immutable arrays.
packageInspection.executions.push({ executionId: 'mutated', startedAt: 0 })
// @ts-expect-error Runtime inspection snapshots expose immutable service tags.
packageInspection.services.push('mutated')
export type NamedCollectionProgram = Expect<
  Equal<typeof namedCollection, import('better-effect').Program<[string], never>>
>
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- assert the public metadata contract exactly.
export type RuntimeExecutionAttributesAlias = Expect<
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- assert the public metadata contract exactly.
  Equal<RuntimeExecutionAttributes, Readonly<Record<string, unknown>>>
>
export type RuntimeExecutionMetadataAlias = Expect<
  Equal<RuntimeExecutionMetadata['startedAt'], number>
>

const firstCollectionProgram = Effect.fn(async function* () {
  const database = yield* Database

  return Result.ok(database.query())
})
const secondCollectionProgram = Effect.fn(async function* () {
  const repository = yield* Repository

  void repository
  return Result.err<number, 'invalid'>('invalid')
})
const allResultsTuple = Program.allResults([
  firstCollectionProgram,
  secondCollectionProgram
] as const)
export type ProgramAllResultsTuple = Expect<
  Equal<
    typeof allResultsTuple,
    Program<
      readonly [ResultType<string, never>, ResultType<never, 'invalid'>],
      never,
      Database | Repository
    >
  >
>
const collectionArray: Array<typeof firstCollectionProgram | typeof secondCollectionProgram> = [
  firstCollectionProgram,
  secondCollectionProgram
]
const allResultsArray = Program.allResults(collectionArray)
export type ProgramAllResultsArray = Expect<
  Equal<
    typeof allResultsArray,
    Program<readonly ResultType<string, 'invalid'>[], never, Database | Repository>
  >
>
const forEachProgram = Program.forEach(['first', 'second'] as const, (value, index) =>
  Effect.fn(async function* () {
    const database = yield* Database

    return Result.ok(`${database.query()}:${value}:${index}`)
  })
)
export type ProgramForEachAlias = Expect<
  Equal<typeof forEachProgram, Program<readonly string[], never, Database>>
>

void recoveredProgram
void packageExecutionOptions
void packageMetadataRun

export type ProgramAlias = Expect<
  Equal<
    LazyProgram<string, never, Database>,
    import('better-effect').Program<string, never, Database>
  >
>
export type EffectProgramAlias = Expect<
  Equal<Effect.Program<string, never, Database>, LazyProgram<string, never, Database>>
>

export type EffectSuccessAlias = Expect<
  Equal<Effect.Success<EagerProgram>, EffectSuccess<EagerProgram>>
>
export type EffectErrorAlias = Expect<Equal<Effect.Error<EagerProgram>, EffectError<EagerProgram>>>
export type EffectRequirementsAlias = Expect<
  Equal<Effect.Requirements<EagerProgram>, EffectRequirements<EagerProgram>>
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
export type RuntimeInspectionAlias = Expect<Equal<Runtime.Inspection, RuntimeInspection>>
export type RuntimeExecutionInspectionAlias = Expect<
  Equal<Runtime.ExecutionInspection, RuntimeExecutionInspection>
>
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
export type LayerBackendDisposeOptionsAlias = Expect<
  Equal<Parameters<MapLayerBackend['disposeAll']>[0], LayerBackendDisposeOptions | undefined>
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

void nativeBackend.disposeAll(backendDisposeOptions)
void asyncTapped
void packageResourceProgram
void packageDisposable
void DisposablePackageLive
void exhaustivelyMatched
void partiallyMatched
