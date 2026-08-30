import { Effect, type Layer, type Runtime } from 'better-effect'
import { Result } from 'better-result'
import type { BetterAuthServiceInstance } from 'better-effect-better-auth'

import type { Assert, Equal } from './assert'
import { authWithPlugins, Auth } from './auth'

type AuthInstance = BetterAuthServiceInstance<'@public-types/Auth', typeof authWithPlugins>
type Session = typeof authWithPlugins.$Infer.Session

const program = Effect.fn(async function* () {
  const auth = yield* Auth
  const optional = yield* auth.session.get(new Headers())
  const required = yield* auth.session.require(new Request('https://example.test/protected'))
  const response = yield* auth.handle(new Request('https://example.test/api/auth/get-session'))

  return Result.ok({ optional, required, response })
})

type _Layer = Assert<Equal<Layer.Provided<typeof Auth.layer>, AuthInstance>>
type _Requirement = Assert<Equal<Effect.Requirements<typeof program>, AuthInstance>>
type _OptionalSession = Assert<Equal<Awaited<typeof optionalValue>, Session | null>>
type _RequiredSession = Assert<Equal<Awaited<typeof requiredValue>, Session>>
type _Response = Assert<Equal<Awaited<typeof responseValue>, Response>>

declare const optionalValue: Session | null
declare const requiredValue: Session
declare const responseValue: Response
declare const runtime: Runtime<AuthInstance>

void program
void runtime.run(program)
declare const layer: Layer<AuthInstance, never>
void layer
