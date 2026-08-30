import { Effect } from 'better-effect'
import { Result } from 'better-result'

import { Auth } from './auth'

export const readAuthenticatedSession = (request: Request) =>
  Effect.fn(async function* () {
    const auth = yield* Auth
    const session = yield* auth.session.require(request)
    const users = yield* auth.api.listUsers({
      headers: request.headers,
      query: {
        limit: 5
      }
    })

    return Result.ok({ session, users })
  })

export const readOptionalSession = (request: Request) =>
  Effect.fn(async function* () {
    const auth = yield* Auth
    const session = yield* auth.session.get(request)

    return Result.ok(session)
  })
