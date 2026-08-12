import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import {
  Effect,
  type CleanupFailureDiagnostic,
  type CleanupFailureObserver,
  type CloseableScope,
  type EffectRequirements,
  type RuntimeOptions,
  type RuntimeShutdownDiagnostic,
  Scope,
  Service,
  type ServiceToken,
  type ScopeFinalizer,
  type ScopeOutcome
} from '../../src'

class Database extends Service<Database>()('Database') {}

const program = Effect.gen(async function* () {
  const scope = yield* Scope
  const database = yield* Database

  expectTypeOf(scope).toEqualTypeOf<Scope>()

  return Result.ok({ scope, database })
})

expectTypeOf<EffectRequirements<typeof program>>().toEqualTypeOf<
  ServiceToken<'Database', Database>
>()

const onlyScope = Effect.gen(async function* () {
  const scope = yield* Scope

  return Result.ok(scope)
})

expectTypeOf<EffectRequirements<typeof onlyScope>>().toEqualTypeOf<never>()

const owner = Scope.make()

expectTypeOf(owner).toEqualTypeOf<CloseableScope>()
expectTypeOf(owner.fork()).toEqualTypeOf<CloseableScope>()

const current = Scope.current()

expectTypeOf(current).toEqualTypeOf<Scope>()

// @ts-expect-error contextual Scope is non-owning
current.close()

void Scope.run((scope) => {
  expectTypeOf(scope).toEqualTypeOf<Scope>()

  // @ts-expect-error Scope.run exposes a non-owning Scope
  scope.close()

  return undefined
})

const finalizer: ScopeFinalizer = (outcome) => {
  expectTypeOf(outcome).toEqualTypeOf<ScopeOutcome>()
}

void finalizer

const cleanupDiagnostic = null as unknown as CleanupFailureDiagnostic

expectTypeOf(cleanupDiagnostic.outcome).toEqualTypeOf<ScopeOutcome>()
expectTypeOf(cleanupDiagnostic.error.causes).toEqualTypeOf<readonly unknown[]>()

const observer: CleanupFailureObserver = (diagnostic) => {
  expectTypeOf(diagnostic.outcome).toEqualTypeOf<ScopeOutcome>()
}

const runtimeOptions: RuntimeOptions = {
  onCleanupFailure: observer
}

expectTypeOf(runtimeOptions).toEqualTypeOf<RuntimeOptions>()
expectTypeOf<RuntimeShutdownDiagnostic['outcome']>().toEqualTypeOf<ScopeOutcome>()
