import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'

import { Auth, credentials } from './auth'
import { readAuthenticatedSession } from './programs'

const main = async (): Promise<void> => {
  const runtime = await Runtime.make(Auth.layer)

  try {
    const rawResult = await runtime.run(
      Effect.fn(async function* () {
        const auth = yield* Auth
        return Result.ok(auth.raw)
      })
    )

    if (Result.isError(rawResult)) {
      throw new Error(`Better Auth acquisition failed: ${String(rawResult.error)}`)
    }

    const rawAuth = rawResult.value
    await rawAuth.api.signUpEmail({
      body: credentials
    })
    const signedIn = await rawAuth.api.signInEmail({
      body: {
        email: credentials.email,
        password: credentials.password
      },
      returnHeaders: true
    })
    const cookie = signedIn.headers.getSetCookie().join('; ')
    const request = new Request('http://localhost:3000/protected', {
      headers: {
        cookie
      }
    })

    const programResult = await runtime.run(readAuthenticatedSession(request))
    if (Result.isError(programResult)) {
      throw new Error(`Authenticated Program failed: ${JSON.stringify(programResult.error)}`)
    }

    const sessionRequest = new Request('http://localhost:3000/api/auth/get-session', {
      headers: {
        cookie
      }
    })
    const directResponse = await rawAuth.handler(sessionRequest)
    const effectResponse = await runtime.run(
      Effect.fn(async function* () {
        const auth = yield* Auth
        return Result.ok(yield* auth.handle(sessionRequest))
      })
    )

    if (Result.isError(effectResponse)) {
      throw new Error(`Effectful handler failed: ${JSON.stringify(effectResponse.error)}`)
    }

    if (directResponse.status !== 200 || effectResponse.value.status !== 200) {
      throw new Error(
        `Better Auth handlers did not return the expected session response: ${directResponse.status}/${effectResponse.value.status}`
      )
    }

    console.log(
      JSON.stringify({
        users: programResult.value.users.total,
        sessionUser: programResult.value.session.user.email
      })
    )
  } finally {
    await runtime.dispose()
  }
}

await main()
