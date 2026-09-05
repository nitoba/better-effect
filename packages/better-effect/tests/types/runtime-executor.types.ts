import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect, type EffectRequirements, type EffectSuccess } from '../../src/effect'
import { Layer } from '../../src/layer'
import {
  Runtime,
  type RuntimeContext,
  type RuntimeExecutor,
  type RuntimeFor
} from '../../src/runtime'
import { Service, type AnyService } from '../../src/service'

class Database extends Service<Database>()('runtime.executor.database') {
  query(): string {
    return 'database'
  }
}

class Logger extends Service<Logger>()('runtime.executor.logger') {
  write(message: string): void {
    void message
  }
}

class Cache extends Service<Cache>()('runtime.executor.cache') {}

const databaseProgram = Effect.fn(async function* () {
  const database = yield* Database

  return Result.ok(database.query())
})

const loggerProgram = Effect.fn(async function* () {
  const logger = yield* Logger

  return Result.ok(logger)
})

const databaseAndLoggerProgram = Effect.fn(async function* () {
  const database = yield* Database
  const logger = yield* Logger

  return Result.ok({ database, logger })
})

const capture = Effect.fn(async function* () {
  const executor = yield* Runtime.executor<Database | Logger>()

  return Result.ok(executor)
})

const databaseLayer = Layer.make(Database)
const loggerLayer = Layer.make(Logger)
const cacheLayer = Layer.make(Cache)
const completeLayer = Layer.merge(databaseLayer, loggerLayer)

declare const executor: Runtime.Executor<Database>
declare const broadExecutor: Runtime.Executor<Database | Logger>
declare const narrowExecutor: Runtime.Executor<Database>
declare const runtime: RuntimeFor<typeof completeLayer>

expectTypeOf<RuntimeExecutor<Database>>().toEqualTypeOf<Runtime.Executor<Database>>()
expectTypeOf<RuntimeContext['executor']>().toEqualTypeOf<RuntimeExecutor<AnyService> | undefined>()
expectTypeOf<EffectRequirements<typeof capture>>().toEqualTypeOf<Database | Logger>()
expectTypeOf<EffectSuccess<typeof capture>>().toEqualTypeOf<Runtime.Executor<Database | Logger>>()
expectTypeOf<keyof Runtime.Executor<Database>>().toEqualTypeOf<'run' | 'runWith'>()

void executor.run(databaseProgram)
// @ts-expect-error Logger is not available from an executor containing only Database.
void executor.run(loggerProgram)

void executor.runWith(loggerLayer, databaseAndLoggerProgram)
// @ts-expect-error Cache is supplied locally, but Logger remains unavailable.
void executor.runWith(cacheLayer, databaseAndLoggerProgram)
void executor.runWith(Layer.empty, databaseProgram)

// The view is invariant because its completeness checks encode the environment in both run paths.
// @ts-expect-error An executor with a wider environment is not assignable to a narrower view.
const widenedExecutor: Runtime.Executor<Database> = broadExecutor
// @ts-expect-error A Database-only executor cannot promise Logger execution capability.
const narrowedExecutor: Runtime.Executor<Database | Logger> = narrowExecutor

// @ts-expect-error The restricted capability has no Runtime ownership methods.
void executor.dispose()
// @ts-expect-error The restricted capability has no warmup method.
void executor.warmup()
// @ts-expect-error The restricted capability has no inspection method.
void executor.inspect()
// @ts-expect-error The restricted capability has no backend property.
void executor.backend
// @ts-expect-error The restricted capability has no Scope property.
void executor.scope

expectTypeOf(runtime.executor).toEqualTypeOf<Runtime.Executor<Database | Logger>>()
void widenedExecutor
void narrowedExecutor
