import { Result } from 'better-result'

import {
  Effect,
  Layer,
  Runtime,
  Service,
  ServiceRuntime,
  type EffectRequirements,
  type LayerBackend,
  type LayerMissing,
  type LayerProvided,
  type RuntimeFor,
  type ServiceResolver,
  type ServiceToken
} from 'better-effect'

import { Database, Logger } from './exported-service'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Expect<Value extends true> = Value

const program = Effect.gen(async function* () {
  const database = yield* Database
  const logger = yield* Logger

  logger.log()

  return Result.ok(database.query())
})

type Program = Awaited<typeof program>
export type ProgramContract = Expect<Equal<Program, Effect<string, never, Database | Logger>>>
export type Requirements = Expect<Equal<Effect.Requirements<typeof program>, Database | Logger>>
export type RequirementsHelper = Expect<
  Equal<EffectRequirements<typeof program>, Database | Logger>
>
export type Token = Expect<Equal<Service.TokenOf<Database>, Service.Token<'Database', Database>>>
export type TokenHelper = Expect<
  Equal<Service.TokenOf<Database>, ServiceToken<'Database', Database>>
>

const DatabaseLive = Layer.make(Database)
const LoggerLive = Layer.make(Logger)
const AppLive = Layer.merge(DatabaseLive, LoggerLive)

export type Provided = Expect<Equal<LayerProvided<typeof AppLive>, Database | Logger>>
export type Missing = Expect<Equal<LayerMissing<typeof AppLive>, never>>
export type RuntimeEnvironment = Expect<
  Equal<RuntimeFor<typeof AppLive>, Runtime<Database | Logger>>
>

const structuralDatabase = Database.of({ query: () => 'structural' })
const erasedLayer: Layer.Any = AppLive

declare const backend: LayerBackend
declare const erasedEffect: Effect.Any
declare const explicitAnyEffect: Effect<unknown, never, any>
declare const defaultRuntime: Runtime
declare const anyRuntime: Runtime<any>
declare const serviceAnyRuntime: Runtime<Service.Any>
declare const emptyRuntime: Runtime<never>

void defaultRuntime.run(() => program)
void anyRuntime.run(() => program)
void serviceAnyRuntime.run(() => program)
void emptyRuntime.run(() => erasedEffect)
void emptyRuntime.run(() => explicitAnyEffect)
void Runtime.run(AppLive, backend, () => program)

function runSame<R extends Service.Any>(runtime: Runtime<R>, effect: Effect<unknown, never, R>) {
  void runtime.run(() => effect)
}

function resolveExactly<T extends Service.Token>(resolver: ServiceResolver, token: T) {
  const resolved = resolver.resolve(token)

  return resolved satisfies InstanceType<T> | PromiseLike<InstanceType<T>>
}

async function resolveDatabase() {
  const database = await ServiceRuntime.resolve(Database)

  return database satisfies Database
}

void structuralDatabase
void erasedLayer
void runSame
void resolveExactly
void resolveDatabase
