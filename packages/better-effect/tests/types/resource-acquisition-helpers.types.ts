import { expectTypeOf } from 'bun:test'

import { Result, type UnhandledException } from 'better-result'

import {
  Effect,
  type EffectError,
  type EffectRequirements,
  type EffectSuccess
} from '../../src/effect'
import { Layer } from '../../src/layer'
import type { ScopeOutcome } from '../../src/scope'
import { Service } from '../../src/service'

type AcquireFailure = {
  readonly _tag: 'AcquireFailure'
}

type Connection = {
  readonly id: string
}

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

class DisposableClient extends Service<DisposableClient>()('DisposableClient') {
  request(): string {
    return 'request'
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

class PlainClient extends Service<PlainClient>()('PlainClient') {
  request(): string {
    return 'request'
  }
}

const syncProgram = Effect.gen(async function* () {
  const connection = yield* Effect.acquireReleaseResult(
    () => Result.ok<Connection, AcquireFailure>({ id: 'sync' }),
    (_connection, outcome) => {
      expectTypeOf(outcome).toEqualTypeOf<ScopeOutcome>()
    }
  )

  return Result.ok(connection)
})

const asyncProgram = Effect.gen(async function* () {
  const connection = yield* Effect.acquireReleaseResult(
    async () => Result.ok<Connection, AcquireFailure>({ id: 'async' }),
    async (_connection, outcome) => {
      expectTypeOf(outcome).toEqualTypeOf<ScopeOutcome>()
    }
  )

  return Result.ok(connection)
})

const serviceProgram = Effect.gen(async function* () {
  const database = yield* Database
  const connection = yield* Effect.acquireReleaseResult(
    () => Result.ok<Connection, AcquireFailure>({ id: 'service' }),
    (resource) => {
      void resource
    }
  )

  return Result.ok({ database, connection })
})

expectTypeOf<EffectSuccess<typeof syncProgram>>().toEqualTypeOf<Connection>()
expectTypeOf<EffectError<typeof syncProgram>>().toEqualTypeOf<AcquireFailure | UnhandledException>()
expectTypeOf<EffectRequirements<typeof syncProgram>>().toBeNever()
expectTypeOf<EffectSuccess<typeof asyncProgram>>().toEqualTypeOf<Connection>()
expectTypeOf<EffectError<typeof asyncProgram>>().toEqualTypeOf<
  AcquireFailure | UnhandledException
>()
expectTypeOf<EffectRequirements<typeof asyncProgram>>().toBeNever()
expectTypeOf<EffectSuccess<typeof serviceProgram>>().toEqualTypeOf<{
  database: Database
  connection: Connection
}>()
expectTypeOf<EffectError<typeof serviceProgram>>().toEqualTypeOf<
  AcquireFailure | UnhandledException
>()
expectTypeOf<EffectRequirements<typeof serviceProgram>>().toEqualTypeOf<Database>()

const disposable = {
  value: 42,
  [Symbol.dispose]() {}
}

const asyncDisposable = {
  value: 'async',
  async [Symbol.asyncDispose]() {}
}

const disposableProgram = Effect.gen(async function* () {
  const resource = yield* Effect.acquireDisposable(() => disposable)

  return Result.ok(resource)
})

const asyncDisposableProgram = Effect.gen(async function* () {
  const resource = yield* Effect.acquireDisposable(async () => asyncDisposable)

  return Result.ok(resource)
})

expectTypeOf<EffectSuccess<typeof disposableProgram>>().toEqualTypeOf<typeof disposable>()
expectTypeOf<EffectError<typeof disposableProgram>>().toEqualTypeOf<UnhandledException>()
expectTypeOf<EffectRequirements<typeof disposableProgram>>().toBeNever()
expectTypeOf<EffectSuccess<typeof asyncDisposableProgram>>().toEqualTypeOf<typeof asyncDisposable>()

const plain = {}
const weak = {} satisfies { [Symbol.dispose]?: () => void }

// @ts-expect-error plain values cannot be acquired as disposable resources.
Effect.acquireDisposable(() => plain)
// @ts-expect-error weakly typed values do not guarantee a disposal protocol.
Effect.acquireDisposable(() => weak)

const disposableLayer = Layer.scopedDisposable(DisposableClient, () => new DisposableClient())

expectTypeOf<Layer.Provided<typeof disposableLayer>>().toEqualTypeOf<DisposableClient>()
expectTypeOf<Layer.Required<typeof disposableLayer>>().toBeNever()

const structuralDisposableLayer = Layer.scopedDisposable(DisposableClient, () => ({
  request: () => 'structural',
  async [Symbol.asyncDispose]() {}
}))

expectTypeOf<Layer.Provided<typeof structuralDisposableLayer>>().toEqualTypeOf<DisposableClient>()

// @ts-expect-error a scoped disposable provider must return a disposable contract.
Layer.scopedDisposable(PlainClient, () => new PlainClient())
// @ts-expect-error the structural provider must include a disposal protocol.
Layer.scopedDisposable(DisposableClient, () => ({ request: () => 'not disposable' }))

class Dependency extends Service<Dependency>()('Dependency') {}

class DependentDisposable extends Service<DependentDisposable>()('DependentDisposable') {
  use() {
    return Effect.gen(async function* () {
      const dependency = yield* Dependency

      return Result.ok(dependency)
    })
  }

  [Symbol.dispose](): void {}
}

const dependentLayer = Layer.scopedDisposable(DependentDisposable, () => new DependentDisposable())

expectTypeOf<Layer.Provided<typeof dependentLayer>>().toEqualTypeOf<DependentDisposable>()
expectTypeOf<Layer.Required<typeof dependentLayer>>().toEqualTypeOf<Dependency>()
