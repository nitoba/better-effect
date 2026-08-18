import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect, type Effect as EffectType } from '../../src/effect'
import { Service } from '../../src/service'

class Database extends Service<Database>()('NewCombinatorDatabase') {
  read(): string {
    return 'value'
  }
}

class Cache extends Service<Cache>()('NewCombinatorCache') {}

declare const databaseEffect: EffectType<string, never, Database>
declare const cacheEffect: EffectType<Cache, never, Cache>
declare const nestedEffect: EffectType<EffectType<Cache, never, Cache>, never, Database>
declare const failedEffect: EffectType<number, 'missing', Database>

expectTypeOf(Effect.tap(databaseEffect, () => {})).toEqualTypeOf<
  EffectType<string, never, Database>
>()

expectTypeOf(Effect.recover(failedEffect, () => cacheEffect)).toEqualTypeOf<
  EffectType<number | Cache, never, Database | Cache>
>()

expectTypeOf(Effect.flatten(nestedEffect)).toEqualTypeOf<
  EffectType<Cache, never, Database | Cache>
>()

expectTypeOf(Effect.as(databaseEffect, 1)).toEqualTypeOf<EffectType<number, never, Database>>()
expectTypeOf(Effect.asVoid(databaseEffect)).toEqualTypeOf<EffectType<void, never, Database>>()

const matched = Effect.match(databaseEffect, {
  ok: () => cacheEffect,
  err: () => Result.err<never, 'failed'>('failed')
})

expectTypeOf(matched).toEqualTypeOf<EffectType<Cache, 'failed', Database | Cache>>()

expectTypeOf(Effect.all([databaseEffect, cacheEffect] as const)).toEqualTypeOf<
  EffectType<[string, Cache], never, Database | Cache>
>()
expectTypeOf(Effect.zip(databaseEffect, cacheEffect)).toEqualTypeOf<
  EffectType<[string, Cache], never, Database | Cache>
>()
