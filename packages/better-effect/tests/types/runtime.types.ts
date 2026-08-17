import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import {
  Effect,
  type EffectError,
  type EffectRequirements,
  type EffectSuccess
} from '../../src/effect'
import { Layer, type LayerBackend, type LayerProvided } from '../../src/layer'
import { createRuntimeHandle, type RuntimeHandle } from '../../src/layer/runtime'
import type { LayerRegistration } from '../../src'
import { Runtime, type RuntimeFor } from '../../src/runtime'
import { Scope } from '../../src/scope'
import { Service, type AnyServiceToken } from '../../src/service'
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

const backend = {} as LayerBackend

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

expectTypeOf<LayerProvided<typeof AppLive>>().toEqualTypeOf<Database | Logger>()
expectTypeOf<LayerProvided<typeof AppWithTestDatabase>>().toEqualTypeOf<Database | Logger>()

const builtPromise = createRuntimeHandle(AppLive, backend)
const runtimePromise = Runtime.make(AppLive, backend)

expectTypeOf<Awaited<typeof builtPromise>>().toEqualTypeOf<RuntimeHandle<Database | Logger>>()
expectTypeOf<Awaited<typeof runtimePromise>>().toEqualTypeOf<Runtime<Database | Logger>>()
expectTypeOf<RuntimeFor<typeof AppLive>>().toEqualTypeOf<Runtime<Database | Logger>>()

const requiresDatabaseAndLogger = () =>
  Effect.gen(async function* () {
    const database = yield* Database
    const logger = yield* Logger

    return Result.ok({ database, logger })
  })

type CompleteProgram = ReturnType<typeof requiresDatabaseAndLogger>

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

const typedRuntime = {} as Runtime<Database | Logger>
const typedBuiltLayer = {} as RuntimeHandle<Database | Logger>

const managedResult = typedRuntime.run(requiresDatabaseAndLogger)
const builtResult = typedBuiltLayer.run(requiresDatabaseAndLogger)
const oneShotResult = Runtime.run(AppLive, backend, requiresDatabaseAndLogger)
const explicitlyTypedOneShot = Runtime.run<CompleteProgram, typeof AppLive>(
  AppLive,
  backend,
  requiresDatabaseAndLogger
)

expectTypeOf(managedResult).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(builtResult).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(oneShotResult).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()
expectTypeOf(explicitlyTypedOneShot).toEqualTypeOf<Promise<Awaited<CompleteProgram>>>()

// @ts-expect-error Logger is not supplied by this managed Runtime.
void ({} as Runtime<Database>).run(requiresDatabaseAndLogger)

// @ts-expect-error Logger is not supplied by this RuntimeHandle.
void ({} as RuntimeHandle<Database>).run(requiresDatabaseAndLogger)

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
void ({} as Runtime<Database>).run(requiresLoggerAndCache)

// @ts-expect-error Both Logger and Cache are absent from this RuntimeHandle.
void ({} as RuntimeHandle<Database>).run(requiresLoggerAndCache)

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
void ({} as Runtime<Database>).run(requiresDatabaseThenLogger)
void ({} as Runtime<Database | Logger>).run(requiresDatabaseThenLogger)

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

void ({} as Runtime<never>).run(plainValue)
void ({} as Runtime<never>).run(plainResult)
void ({} as Runtime<never>).run(scopeOnly)
void ({} as Runtime<never>).run(acquireReleaseOnly)
void ({} as RuntimeHandle<never>).run(plainValue)
void ({} as RuntimeHandle<never>).run(plainResult)
void ({} as RuntimeHandle<never>).run(scopeOnly)
void ({} as RuntimeHandle<never>).run(acquireReleaseOnly)
void Runtime.run(DatabaseLive, backend, plainValue)
void Runtime.run(DatabaseLive, backend, plainResult)
void Runtime.run(DatabaseLive, backend, scopeOnly)
void Runtime.run(DatabaseLive, backend, acquireReleaseOnly)

const erasedRuntime: Runtime = {} as Runtime
const erasedBuiltLayer: RuntimeHandle = {} as RuntimeHandle
const erasedRuntimeFromInference: Runtime = {} as Awaited<typeof runtimePromise>
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
