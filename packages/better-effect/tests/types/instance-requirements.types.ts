import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { Effect, type EffectRequirements } from '../../src/effect'
import { Layer } from '../../src/layer'
import type { MissingServices } from '../../src/layer/inference'
import { Runtime, type RuntimeFor } from '../../src/runtime'
import {
  Service,
  type ServiceContract,
  type ServiceIdentity,
  type ServiceTag,
  type ServiceToken,
  type ServiceTokenOf
} from '../../src/service'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'database'
  }
}

class Logger extends Service<Logger>()('Logger') {
  log(): void {}
}

class Cache extends Service<Cache>()('Cache') {
  get(): string {
    return 'cache'
  }
}

void Cache

class Repository extends Service<Repository>()('Repository') {
  load() {
    return Effect.gen(async function* () {
      const database = yield* Database
      const logger = yield* Logger

      return Result.ok({ database, logger })
    })
  }
}

const program = Effect.gen(async function* () {
  const database = yield* Database
  const logger = yield* Logger

  return Result.ok({ database, logger })
})

type Program = Awaited<typeof program>

expectTypeOf<Program>().toEqualTypeOf<
  Effect<{ database: Database; logger: Logger }, never, Database | Logger>
>()
expectTypeOf<EffectRequirements<typeof program>>().toEqualTypeOf<Database | Logger>()
expectTypeOf<Effect.Requirements<typeof program>>().toEqualTypeOf<Database | Logger>()
expectTypeOf<Database>().toMatchTypeOf<ServiceIdentity<'Database'>>()
expectTypeOf<ServiceTag<Database>>().toEqualTypeOf<'Database'>()
expectTypeOf<ServiceContract<Database>>().toEqualTypeOf<{ query(): string }>()
expectTypeOf<ServiceTokenOf<Database>>().toEqualTypeOf<ServiceToken<'Database', Database>>()
expectTypeOf<ServiceTokenOf<Database | Logger>>().toEqualTypeOf<
  ServiceToken<'Database', Database> | ServiceToken<'Logger', Logger>
>()

const DatabaseLive = Layer.make(Database)
const LoggerLive = Layer.make(Logger)
const RepositoryLive = Layer.make(Repository)
const AppLive = Layer.merge(DatabaseLive, LoggerLive, RepositoryLive)

expectTypeOf<Layer.Provided<typeof AppLive>>().toEqualTypeOf<Database | Logger | Repository>()
expectTypeOf<Layer.Required<typeof AppLive>>().toBeNever()
expectTypeOf<Layer.Required<typeof RepositoryLive>>().toEqualTypeOf<Database | Logger>()
expectTypeOf<RuntimeFor<typeof AppLive>>().toEqualTypeOf<Runtime<Database | Logger | Repository>>()
expectTypeOf<MissingServices<Logger, Database>>().toEqualTypeOf<Logger>()
expectTypeOf<MissingServices<Database | Logger, Database>>().toEqualTypeOf<Logger>()
expectTypeOf<MissingServices<Database, Database>>().toBeNever()
expectTypeOf<MissingServices<any, Database>>().toBeNever()
expectTypeOf<MissingServices<Database, any>>().toBeNever()
expectTypeOf<MissingServices<Service.Any, Database>>().toBeNever()
expectTypeOf<MissingServices<Database, Service.Any>>().toBeNever()

// @ts-expect-error arbitrary objects are not Service environments
type InvalidObjectEffect = Effect<string, Error, object>
// @ts-expect-error empty objects are not Service environments
type InvalidEmptyEffect = Effect<string, Error, {}>
// @ts-expect-error unknown is not a Service environment
type InvalidUnknownEffect = Effect<string, Error, unknown>

expectTypeOf<InvalidObjectEffect>()
expectTypeOf<InvalidEmptyEffect>()
expectTypeOf<InvalidUnknownEffect>()

// SAFETY: The empty object is never executed; this cast supplies only the static receiver for the complete Runtime requirement check.
void ({} as Runtime<Database | Logger>).run(() => program)
// SAFETY: The empty object is never executed; this cast supplies only the static receiver for the intentional missing-Logger check.
// @ts-expect-error Logger is not provided
void ({} as Runtime<Database>).run(() => program)

expectTypeOf<EffectRequirements<Effect.Any>>().toEqualTypeOf<Service.Any>()

declare const erasedEffect: Effect.Any
declare const explicitAnyEffect: Effect<unknown, never, any>

// SAFETY: The empty object is never executed; this cast tests the erased Effect.Any contract against a statically empty Runtime.
void ({} as Runtime<never>).run(() => erasedEffect)
// SAFETY: The empty object is never executed; this cast tests the explicit-any Effect contract against a statically empty Runtime.
void ({} as Runtime<never>).run(() => explicitAnyEffect)
// SAFETY: The empty object is never executed; this cast exercises the intentional Runtime<any> requirement escape hatch.
void ({} as Runtime<any>).run(() => program)
// SAFETY: The empty object is never executed; this cast exercises the intentional Runtime<Service.Any> requirement escape hatch.
void ({} as Runtime<Service.Any>).run(() => program)
// SAFETY: The empty object is never executed; this cast exercises the intentionally erased default Runtime requirement.
void ({} as Runtime).run(() => program)

type RequirementFree = Effect<string, Error>
expectTypeOf<RequirementFree>().toEqualTypeOf<Effect<string, Error, never>>()
expectTypeOf<EffectRequirements<RequirementFree>>().toBeNever()

function runSame<R extends Service.Any>(runtime: Runtime<R>, effect: Effect<unknown, never, R>) {
  void runtime.run(() => effect)
}

function rejectUnrelated<R extends Service.Any>(
  runtime: Runtime<Database>,
  effect: Effect<unknown, never, R>
) {
  // @ts-expect-error R is not proven to be provided by Runtime<Database>
  void runtime.run(() => effect)
}

void runSame
void rejectUnrelated
