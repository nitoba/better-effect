import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import {
  Effect,
  type EffectError,
  type EffectRequirements,
  type EffectSuccess
} from '../../src/effect'
import {
  Layer,
  buildLayer,
  type BuiltLayer,
  type LayerBackend,
  type LayerProvided
} from '../../src/layer'
import type { LayerRegistration } from '../../src'
import { Runtime, type RuntimeFor } from '../../src/runtime'
import { Scope } from '../../src/scope'
import { Service, type AnyServiceToken } from '../../src/service'
import type {
  CompleteExecution,
  ExecutionMissing,
  MissingRuntimeServices
} from '../../src/layer/inference'

class Database extends Service<Database>() {
  query() {
    return 'query'
  }
}

class Logger extends Service<Logger>() {
  write(message: string) {
    void message
  }
}

class Cache extends Service<Cache>() {
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

expectTypeOf<LayerProvided<typeof AppLive>>().toEqualTypeOf<typeof Database | typeof Logger>()
expectTypeOf<LayerProvided<typeof AppWithTestDatabase>>().toEqualTypeOf<
  typeof Database | typeof Logger
>()

const builtPromise = buildLayer(AppLive, backend)
const runtimePromise = Runtime.make(AppLive, backend)

expectTypeOf<Awaited<typeof builtPromise>>().toEqualTypeOf<
  BuiltLayer<typeof Database | typeof Logger>
>()
expectTypeOf<Awaited<typeof runtimePromise>>().toEqualTypeOf<
  Runtime<typeof Database | typeof Logger>
>()
expectTypeOf<RuntimeFor<typeof AppLive>>().toEqualTypeOf<Runtime<typeof Database | typeof Logger>>()

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
expectTypeOf<EffectRequirements<CompleteProgram>>().toEqualTypeOf<
  | import('../../src/service').ServiceToken<Database>
  | import('../../src/service').ServiceToken<Logger>
>()

type MissingLogger = ExecutionMissing<typeof Database, CompleteProgram>

expectTypeOf<MissingLogger>().toEqualTypeOf<import('../../src/service').ServiceToken<Logger>>()
expectTypeOf<MissingRuntimeServices<MissingLogger>>().toEqualTypeOf<{
  readonly __betterEffectMissingRuntimeServices: import('../../src/service').ServiceToken<Logger>
}>()
type IncompleteProgram = CompleteExecution<typeof Database, CompleteProgram>

expectTypeOf<IncompleteProgram>().toEqualTypeOf<
  (() => CompleteProgram | PromiseLike<CompleteProgram>) &
    MissingRuntimeServices<import('../../src/service').ServiceToken<Logger>>
>()

const typedRuntime = {} as Runtime<typeof Database | typeof Logger>
const typedBuiltLayer = {} as BuiltLayer<typeof Database | typeof Logger>

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
void ({} as Runtime<typeof Database>).run(requiresDatabaseAndLogger)

// @ts-expect-error Logger is not supplied by this BuiltLayer.
void ({} as BuiltLayer<typeof Database>).run(requiresDatabaseAndLogger)

// @ts-expect-error Logger is not supplied by this one-shot Layer.
void Runtime.run(DatabaseLive, backend, requiresDatabaseAndLogger)

const requiresLoggerAndCache = () =>
  Effect.gen(async function* () {
    const logger = yield* Logger
    const cache = yield* Cache

    return Result.ok({ logger, cache })
  })

expectTypeOf<
  ExecutionMissing<typeof Database, ReturnType<typeof requiresLoggerAndCache>>
>().toEqualTypeOf<
  import('../../src/service').ServiceToken<Logger> | import('../../src/service').ServiceToken<Cache>
>()

// @ts-expect-error Both Logger and Cache are absent from this managed Runtime.
void ({} as Runtime<typeof Database>).run(requiresLoggerAndCache)

// @ts-expect-error Both Logger and Cache are absent from this BuiltLayer.
void ({} as BuiltLayer<typeof Database>).run(requiresLoggerAndCache)

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
void ({} as Runtime<typeof Database>).run(requiresDatabaseThenLogger)
void ({} as Runtime<typeof Database | typeof Logger>).run(requiresDatabaseThenLogger)

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
void ({} as BuiltLayer<never>).run(plainValue)
void ({} as BuiltLayer<never>).run(plainResult)
void ({} as BuiltLayer<never>).run(scopeOnly)
void ({} as BuiltLayer<never>).run(acquireReleaseOnly)
void Runtime.run(DatabaseLive, backend, plainValue)
void Runtime.run(DatabaseLive, backend, plainResult)
void Runtime.run(DatabaseLive, backend, scopeOnly)
void Runtime.run(DatabaseLive, backend, acquireReleaseOnly)

const erasedRuntime: Runtime = {} as Runtime
const erasedBuiltLayer: BuiltLayer = {} as BuiltLayer
const erasedRuntimeFromInference: Runtime = {} as Awaited<typeof runtimePromise>
const erasedBuiltLayerFromInference: BuiltLayer = {} as Awaited<typeof builtPromise>

void erasedRuntime.run(requiresDatabaseAndLogger)
void erasedBuiltLayer.run(requiresDatabaseAndLogger)
void erasedRuntimeFromInference.run(requiresDatabaseAndLogger)
void erasedBuiltLayerFromInference.run(requiresDatabaseAndLogger)

const resultWithError = () => Result.err('failed')
const exactErrorResult = typedRuntime.run(resultWithError)

expectTypeOf<EffectSuccess<ReturnType<typeof resultWithError>>>().toEqualTypeOf<never>()
expectTypeOf<EffectError<ReturnType<typeof resultWithError>>>().toEqualTypeOf<string>()
expectTypeOf(exactErrorResult).toEqualTypeOf<Promise<Awaited<ReturnType<typeof resultWithError>>>>()

const allTokens: AnyServiceToken = Database
void allTokens
