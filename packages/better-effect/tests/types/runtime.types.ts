import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import {
  Effect,
  type EffectError,
  type EffectRequirements,
  type EffectSuccess
} from '../../src/effect'
import { Layer, MapLayerBackend, type LayerBackend } from '../../src/layer'
import { createRuntimeHandle, type RuntimeHandle } from '../../src/layer/runtime'
import type { LayerRegistration } from '../../src'
import {
  CurrentAbortSignal,
  Runtime,
  type RuntimeContext,
  type RuntimeDisposeOptions,
  type RuntimeExecutionAttributes,
  type RuntimeExecutionMetadata,
  type RuntimeFor,
  type RuntimeObserver,
  type RuntimeOptions,
  type RuntimeRunOptions
} from '../../src/runtime'
import { Scope, type ScopeOutcome } from '../../src/scope'
import { NodeRuntime, type NodeRuntimeOptions } from '../../src/node'
import { Service, type AnyServiceToken, type ServiceResolver } from '../../src/service'
import type { MissingDependencies } from '../../src/internal/missing-dependencies'
import type { CompleteExecution, ExecutionMissing } from '../../src/layer/inference'

class Database extends Service<Database>()('Database') {
  query() {
    return 'query'
  }
}

class Logger extends Service<Logger>()('Logger') {
  write(message: string) {
    void message
  }
}

class Cache extends Service<Cache>()('Cache') {
  get() {
    return 'cached'
  }
}

declare const backend: LayerBackend

const partialContext: RuntimeContext = { resolutionPath: [] }
expectTypeOf<RuntimeContext['resolver']>().toEqualTypeOf<ServiceResolver | undefined>()
expectTypeOf<RuntimeContext['scope']>().toEqualTypeOf<Scope | undefined>()
void partialContext

const registration: LayerRegistration = {
  service: Database,
  acquire: () => new Database()
}

expectTypeOf<Parameters<LayerBackend['register']>[0]>().toEqualTypeOf<LayerRegistration>()

void registration

backend.register({
  service: Database,
  acquire: () => new Database(),
  // @ts-expect-error LayerRegistration intentionally excludes lifecycle callbacks.
  release: () => {}
})

const DatabaseLive = Layer.succeed(Database, new Database())
const LoggerLive = Layer.succeed(Logger, new Logger())

const AppLive = Layer.merge(DatabaseLive, LoggerLive)
const AppWithTestDatabase = Layer.override(AppLive, Layer.succeed(Database, new Database()))

expectTypeOf<Layer.Provided<typeof AppLive>>().toEqualTypeOf<Database | Logger>()
expectTypeOf<Layer.Provided<typeof AppWithTestDatabase>>().toEqualTypeOf<Database | Logger>()

const builtPromise = createRuntimeHandle(AppLive, backend)
const runtimePromise = Runtime.make(AppLive, backend)
const defaultRuntimePromise = Runtime.make(AppLive)
const configuredRuntimePromise = Runtime.make(AppLive, { backend: new MapLayerBackend() })

const runtimeObserver: RuntimeObserver = {
  onServiceResolve: (event) => {
    expectTypeOf(event.service).toEqualTypeOf<AnyServiceToken>()
    expectTypeOf(event.resolutionPath).toEqualTypeOf<readonly AnyServiceToken[]>()
  },
  onServiceAcquire: (event) => {
    expectTypeOf(event.outcome).toMatchTypeOf<ScopeOutcome>()
  },
  onExecutionStart: (event) => {
    expectTypeOf(event.scope).toEqualTypeOf<Scope>()
    expectTypeOf(event.executionId).toEqualTypeOf<string>()
    expectTypeOf(event.name).toEqualTypeOf<string | undefined>()
    expectTypeOf(event.attributes).toEqualTypeOf<RuntimeExecutionAttributes | undefined>()
    expectTypeOf(event.startedAt).toEqualTypeOf<number>()
  },
  onExecutionEnd: (event) => {
    expectTypeOf(event.outcome).toMatchTypeOf<ScopeOutcome>()
    expectTypeOf(event.executionId).toEqualTypeOf<string>()
    expectTypeOf(event.durationMs).toEqualTypeOf<number>()
  },
  onResourceRelease: (event) => {
    expectTypeOf(event.service).toEqualTypeOf<AnyServiceToken>()
  }
}

const warmupOptions: RuntimeOptions = {
  warmup: true,
  observers: [runtimeObserver]
}

expectTypeOf<Awaited<typeof builtPromise>>().toEqualTypeOf<RuntimeHandle<Database | Logger>>()
expectTypeOf<Awaited<typeof runtimePromise>>().toEqualTypeOf<Runtime<Database | Logger>>()
expectTypeOf<Awaited<typeof defaultRuntimePromise>>().toEqualTypeOf<Runtime<Database | Logger>>()
expectTypeOf<Awaited<typeof configuredRuntimePromise>>().toEqualTypeOf<Runtime<Database | Logger>>()
expectTypeOf<RuntimeFor<typeof AppLive>>().toEqualTypeOf<Runtime<Database | Logger>>()
expectTypeOf(warmupOptions).toEqualTypeOf<RuntimeOptions>()
expectTypeOf<RuntimeExecutionMetadata['attributes']>().toEqualTypeOf<
  RuntimeExecutionAttributes | undefined
>()

const requiresDatabaseAndLogger = () =>
  Effect.gen(async function* () {
    const database = yield* Database
    const logger = yield* Logger

    return Result.ok({ database, logger })
  })

type CompleteProgram = ReturnType<typeof requiresDatabaseAndLogger>

const readsAbortSignal = () =>
  Effect.gen(async function* () {
    const signal = yield* CurrentAbortSignal

    return Result.ok(signal.aborted)
  })

expectTypeOf<EffectSuccess<ReturnType<typeof readsAbortSignal>>>().toEqualTypeOf<boolean>()
expectTypeOf<EffectRequirements<ReturnType<typeof readsAbortSignal>>>().toEqualTypeOf<never>()

expectTypeOf<EffectSuccess<CompleteProgram>>().toEqualTypeOf<{
  database: Database
  logger: Logger
}>()
expectTypeOf<EffectError<CompleteProgram>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<CompleteProgram>>().toEqualTypeOf<Database | Logger>()

type MissingLogger = ExecutionMissing<Database, CompleteProgram>

expectTypeOf<MissingLogger>().toEqualTypeOf<Logger>()
type IncompleteProgram = CompleteExecution<Database, CompleteProgram>
expectTypeOf<IncompleteProgram>().toMatchTypeOf<MissingDependencies<Logger>>()

declare const typedRuntime: Runtime<Database | Logger>
declare const typedBuiltLayer: RuntimeHandle<Database | Logger>

declare const databaseRuntime: Runtime<Database>
declare const databaseHandle: RuntimeHandle<Database>
declare const emptyRuntime: Runtime<never>
declare const emptyHandle: RuntimeHandle<never>

const managedResult = typedRuntime.run(requiresDatabaseAndLogger)
const managedMetadataResult = typedRuntime.run(requiresDatabaseAndLogger, {
  attributes: { requestId: 'request-1' }
})
const managedCancellationResult = typedRuntime.run(readsAbortSignal, {
  signal: new AbortController().signal
})
const builtResult = typedBuiltLayer.run(requiresDatabaseAndLogger)
const oneShotResult = Runtime.run(AppLive, backend, requiresDatabaseAndLogger)
const defaultOneShotResult = Runtime.run(AppLive, requiresDatabaseAndLogger)
const oneShotMetadataResult = Runtime.run(AppLive, requiresDatabaseAndLogger, {
  attributes: { requestId: 'request-2' }
})
const oneShotCancellationResult = Runtime.run(AppLive, readsAbortSignal, {
  signal: new AbortController().signal
})
const configuredOneShotResult = Runtime.run(
  AppLive,
  { backend: new MapLayerBackend() },
  requiresDatabaseAndLogger
)
const trailingOptionsOneShotResult = Runtime.run(AppLive, requiresDatabaseAndLogger, {
  backend: new MapLayerBackend()
})
const managedByUse = Runtime.use(AppLive, (runtime) => runtime.run(requiresDatabaseAndLogger))
const configuredManagedByUse = Runtime.use(
  AppLive,
  (runtime) => runtime.run(requiresDatabaseAndLogger),
  { backend: new MapLayerBackend() }
)
const explicitlyTypedOneShot = Runtime.run<CompleteProgram, typeof AppLive>(
  AppLive,
  backend,
  requiresDatabaseAndLogger
)

expectTypeOf(managedResult).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(managedMetadataResult).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(managedCancellationResult).toEqualTypeOf<
  Promise<Awaited<ReturnType<typeof readsAbortSignal>>>
>()
expectTypeOf(builtResult).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(oneShotResult).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(oneShotMetadataResult).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(defaultOneShotResult).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(oneShotCancellationResult).toEqualTypeOf<
  Promise<Awaited<ReturnType<typeof readsAbortSignal>>>
>()
expectTypeOf(configuredOneShotResult).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(trailingOptionsOneShotResult).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(managedByUse).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(configuredManagedByUse).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(explicitlyTypedOneShot).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf<Awaited<typeof runtimePromise>>().toMatchTypeOf<AsyncDisposable>()

const runOptions: RuntimeRunOptions = { signal: new AbortController().signal }
const disposeOptions: RuntimeDisposeOptions = {
  gracePeriod: 5_000,
  abortAfterGracePeriod: true
}

void typedRuntime.run(readsAbortSignal, runOptions)
void typedRuntime.dispose(disposeOptions)

// @ts-expect-error Logger is not supplied by this managed Runtime.
void databaseRuntime.run(requiresDatabaseAndLogger)
// @ts-expect-error Optional execution attributes must not weaken requirement checks.
void databaseRuntime.run(requiresDatabaseAndLogger, { attributes: { requestId: 'missing' } })

// @ts-expect-error Logger is not supplied by this RuntimeHandle.
void databaseHandle.run(requiresDatabaseAndLogger)

// @ts-expect-error Logger is not supplied by this one-shot Layer.
void Runtime.run(DatabaseLive, backend, requiresDatabaseAndLogger)

const requiresLoggerAndCache = () =>
  Effect.gen(async function* () {
    const logger = yield* Logger
    const cache = yield* Cache

    return Result.ok({ logger, cache })
  })

expectTypeOf<ExecutionMissing<Database, ReturnType<typeof requiresLoggerAndCache>>>().toEqualTypeOf<
  Logger | Cache
>()

// @ts-expect-error Both Logger and Cache are absent from this managed Runtime.
void databaseRuntime.run(requiresLoggerAndCache)

// @ts-expect-error Both Logger and Cache are absent from this RuntimeHandle.
void databaseHandle.run(requiresLoggerAndCache)

// @ts-expect-error Both Logger and Cache are absent from this one-shot Layer.
void Runtime.run(DatabaseLive, backend, requiresLoggerAndCache)

const requiresDatabaseThenLogger = () =>
  Effect.gen(async function* () {
    const database = yield* Database
    void database
    const composed = await Effect.gen(async function* () {
      const logger = yield* Logger

      return Result.ok(logger)
    })

    return composed
  })

// @ts-expect-error Returned composed Effects contribute Logger to the final requirements.
void databaseRuntime.run(requiresDatabaseThenLogger)
void typedRuntime.run(requiresDatabaseThenLogger)

const plainValue = () => 42
const plainResult = () => Result.ok('plain')
const scopeOnly = () =>
  Effect.gen(async function* () {
    const scope = yield* Scope

    return Result.ok(scope)
  })
const acquireReleaseOnly = () =>
  Effect.gen(async function* () {
    const value = yield* Effect.acquireRelease(
      () => Promise.resolve('resource'),
      (resource) => {
        void resource
      }
    )

    return Result.ok(value)
  })

expectTypeOf<EffectRequirements<ReturnType<typeof plainValue>>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<ReturnType<typeof plainResult>>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<ReturnType<typeof scopeOnly>>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<ReturnType<typeof acquireReleaseOnly>>>().toEqualTypeOf<never>()

void emptyRuntime.run(plainValue)
void emptyRuntime.run(plainResult)
void emptyRuntime.run(scopeOnly)
void emptyRuntime.run(acquireReleaseOnly)
void emptyHandle.run(plainValue)
void emptyHandle.run(plainResult)
void emptyHandle.run(scopeOnly)
void emptyHandle.run(acquireReleaseOnly)

const nodePlainResult = NodeRuntime.runMain(Layer.empty, plainValue, {
  onSuccess: (value) => {
    expectTypeOf(value).toEqualTypeOf<number>()
    return 0
  }
})
const nodeTypedResult = NodeRuntime.runMain(AppLive, backend, requiresDatabaseAndLogger, {
  onSuccess: (value) => {
    expectTypeOf(value).toEqualTypeOf<{ database: Database; logger: Logger }>()
    return 0
  }
})
const nodeOkResult = NodeRuntime.runMain(Layer.empty, plainResult, {
  onSuccess: (value) => {
    expectTypeOf(value).toEqualTypeOf<string>()
    return 0
  }
})
const nodeFailureResult = NodeRuntime.runMain(Layer.empty, plainResult, {
  onFailure: (error) => {
    expectTypeOf(error).toEqualTypeOf<never>()
    return 1
  }
})
const nodeOptions: NodeRuntimeOptions<string, Error> = {
  signals: ['SIGINT', 'SIGTERM'],
  onSuccess: (value) => {
    expectTypeOf(value).toEqualTypeOf<string>()
    return 0
  },
  onFailure: (error) => {
    expectTypeOf(error).toEqualTypeOf<Error>()
    return 1
  }
}

expectTypeOf(nodePlainResult).toEqualTypeOf<Promise<Awaited<ReturnType<typeof plainValue>>>>()
expectTypeOf(nodeTypedResult).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(nodeOkResult).toEqualTypeOf<Promise<Awaited<ReturnType<typeof plainResult>>>>()
expectTypeOf(nodeFailureResult).toEqualTypeOf<Promise<Awaited<ReturnType<typeof plainResult>>>>()
expectTypeOf<NodeRuntime.Options<string, Error>>().toEqualTypeOf<
  NodeRuntimeOptions<string, Error>
>()
void nodeOptions

// @ts-expect-error Logger is not supplied by this NodeRuntime Layer.
void NodeRuntime.runMain(DatabaseLive, requiresDatabaseAndLogger)

void Runtime.run(DatabaseLive, backend, plainValue)
void Runtime.run(DatabaseLive, backend, plainResult)
void Runtime.run(DatabaseLive, backend, scopeOnly)
void Runtime.run(DatabaseLive, backend, acquireReleaseOnly)

declare const erasedRuntime: Runtime
declare const erasedBuiltLayer: RuntimeHandle
// SAFETY: This compile-time-only value deliberately erases the inferred Runtime environment.
const erasedRuntimeFromInference: Runtime = {} as Awaited<typeof runtimePromise>
// SAFETY: This compile-time-only value deliberately erases the inferred RuntimeHandle environment.
const erasedBuiltLayerFromInference: RuntimeHandle = {} as Awaited<typeof builtPromise>

void erasedRuntime.run(requiresDatabaseAndLogger)
void erasedBuiltLayer.run(requiresDatabaseAndLogger)
void erasedRuntimeFromInference.run(requiresDatabaseAndLogger)
void erasedBuiltLayerFromInference.run(requiresDatabaseAndLogger)

const resultWithError = () => Result.err('failed')
const exactErrorResult = typedRuntime.run(resultWithError)

expectTypeOf<EffectSuccess<ReturnType<typeof resultWithError>>>().toEqualTypeOf<never>()
expectTypeOf<EffectError<ReturnType<typeof resultWithError>>>().toEqualTypeOf<string>()
expectTypeOf(exactErrorResult).toEqualTypeOf<Promise<Awaited<ReturnType<typeof resultWithError>>>>()

type ErasedEffect = Effect.Any
type ExplicitAnyEffect = Effect<unknown, never, any>
expectTypeOf<ExecutionMissing<Database, ErasedEffect>>().toBeNever()
expectTypeOf<ExecutionMissing<Service.Any, Effect<string, Error, Database>>>().toBeNever()
expectTypeOf<ExecutionMissing<Database, ExplicitAnyEffect>>().toBeNever()

const allTokens: AnyServiceToken = Database
void allTokens
