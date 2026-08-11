import { expectTypeOf } from 'bun:test'

import { Result, type UnhandledException } from 'better-result'

import {
  Effect,
  type EffectError,
  type EffectRequirements,
  type EffectSuccess
} from '../../src/effect'
import { Scope, type DisposableResource } from '../../src/scope'

const syncFile = {
  kind: 'sync' as const,
  [Symbol.dispose]() {}
}

const asyncFile = {
  kind: 'async' as const,
  async [Symbol.asyncDispose]() {}
}

const dualFile = {
  kind: 'dual' as const,
  [Symbol.dispose]() {},
  async [Symbol.asyncDispose]() {}
}

const syncScopeAdd = Scope.make().add(syncFile)
const asyncScopeAdd = Scope.make().add(asyncFile)
const dualScopeAdd = Scope.make().add(dualFile)

expectTypeOf<Awaited<typeof syncScopeAdd>>().toEqualTypeOf<typeof syncFile>()
expectTypeOf<Awaited<typeof asyncScopeAdd>>().toEqualTypeOf<typeof asyncFile>()
expectTypeOf<Awaited<typeof dualScopeAdd>>().toEqualTypeOf<typeof dualFile>()

const syncEffect = Effect.gen(async function* () {
  const resource = yield* Effect.add(syncFile)

  return Result.ok(resource)
})

const asyncEffect = Effect.gen(async function* () {
  const resource = yield* Effect.add(asyncFile)

  return Result.ok(resource)
})

const dualEffect = Effect.gen(async function* () {
  const resource = yield* Effect.add(dualFile)

  return Result.ok(resource)
})

expectTypeOf<EffectSuccess<typeof syncEffect>>().toEqualTypeOf<typeof syncFile>()
expectTypeOf<EffectSuccess<typeof asyncEffect>>().toEqualTypeOf<typeof asyncFile>()
expectTypeOf<EffectSuccess<typeof dualEffect>>().toEqualTypeOf<typeof dualFile>()

expectTypeOf<EffectError<typeof syncEffect>>().toEqualTypeOf<UnhandledException>()
expectTypeOf<EffectRequirements<typeof syncEffect>>().toEqualTypeOf<never>()

const resource: DisposableResource = dualFile

void resource

const plain = {}
const weak: { [Symbol.dispose]?: () => void } = {}

// @ts-expect-error plain objects do not expose a disposal protocol.
void Scope.make().add(plain)

// @ts-expect-error weakly typed resources do not guarantee a disposal protocol.
void Scope.make().add(weak)

// @ts-expect-error plain objects do not expose a disposal protocol.
void Effect.add(plain)

// @ts-expect-error weakly typed resources do not guarantee a disposal protocol.
void Effect.add(weak)
