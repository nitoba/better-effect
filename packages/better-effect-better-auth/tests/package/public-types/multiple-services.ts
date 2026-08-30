import { Effect, Layer, type Runtime } from 'better-effect'
import { Result } from 'better-result'
import { BetterAuth, type BetterAuthServiceInstance } from 'better-effect-better-auth'

import type { Assert, Equal, IsNotAssignable } from './assert'
import { Auth, PlainAuth, authWithPlugins, authWithoutPlugins } from './auth'

type First = BetterAuthServiceInstance<'@public-types/Auth', typeof authWithPlugins>
type Second = BetterAuthServiceInstance<'@public-types/PlainAuth', typeof authWithoutPlugins>
type Environment = First | Second

const AppLive = Layer.merge(Auth.layer, PlainAuth.layer)
const program = Effect.fn(async function* () {
  const first = yield* Auth
  const second = yield* PlainAuth
  const pluginUsers = yield* first.api.listUsers({ query: { limit: 5 } })
  return Result.ok({ first, pluginUsers, second })
})

type _Provided = Assert<Equal<Layer.Provided<typeof AppLive>, Environment>>
type _Requirements = Assert<Equal<Effect.Requirements<typeof program>, Environment>>
type _DistinctPluginSurface = Assert<IsNotAssignable<'listUsers', keyof typeof secondApi>>

declare const secondApi: BetterAuth.EffectApi<
  typeof authWithoutPlugins.api,
  BetterAuth.ErrorCode<typeof authWithoutPlugins>
>
declare const runtime: Runtime<Environment>

void AppLive
void runtime.run(program)
void secondApi
