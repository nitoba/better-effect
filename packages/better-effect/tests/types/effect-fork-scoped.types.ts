import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import {
  CurrentAbortSignal,
  Effect,
  type EffectError,
  type EffectRequirements,
  type EffectSuccess,
  type ScopedTask,
  type ScopedTaskExit,
  Service
} from '../../src'

class Database extends Service<Database>()('ForkScopedDatabase') {
  query(): string {
    return 'ok'
  }
}

const child = Effect.fn(async function* () {
  const database = yield* Database
  const signal = yield* CurrentAbortSignal

  return Result.ok({ database, signal })
})

const parent = Effect.gen(async function* () {
  const task = yield* Effect.forkScoped(child)

  return Result.ok(task)
})

expectTypeOf<EffectSuccess<typeof child>>().toEqualTypeOf<{
  database: Database
  signal: AbortSignal
}>()
expectTypeOf<EffectError<typeof child>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<typeof child>>().toEqualTypeOf<Database>()
type ParentTask = ScopedTask<
  {
    database: Database
    signal: AbortSignal
  },
  never
>
expectTypeOf<EffectSuccess<typeof parent>>().toEqualTypeOf<ParentTask>()
expectTypeOf<EffectError<typeof parent>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<typeof parent>>().toEqualTypeOf<Database>()

expectTypeOf<ScopedTask<number, string>['state']>().toEqualTypeOf<
  'running' | 'succeeded' | 'failed' | 'defected' | 'interrupted'
>()
expectTypeOf<ScopedTask<number, string>['awaitExit']>().toEqualTypeOf<
  () => Promise<ScopedTaskExit<number, string>>
>()

const nominalProgram = Effect.fn(async function* () {
  yield* []
  return Result.ok('ok')
})
const plainPromise = Promise.resolve(Result.ok('not-a-program'))

void Effect.forkScoped(nominalProgram)
// @ts-expect-error forkScoped requires a nominal Program, not a Promise of a Result.
void Effect.forkScoped(plainPromise)
