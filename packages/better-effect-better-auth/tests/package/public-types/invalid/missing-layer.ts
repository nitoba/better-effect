import { Effect, type Runtime } from 'better-effect'
import { Result } from 'better-result'
import { BetterAuth } from 'better-effect-better-auth'

import { authWithPlugins } from '../auth'

const Auth = BetterAuth.service('@invalid/MissingLayer', authWithPlugins)
const program = Effect.fn(async function* () {
  const auth = yield* Auth
  return Result.ok(auth.raw)
})
declare const runtime: Runtime<never>

void runtime.run(program)
