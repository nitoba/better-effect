import { Hono } from 'hono'
import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'

import { Auth, rawAuth } from './auth'

const runtime = await Runtime.make(Auth.layer)
const app = new Hono()

// Better Auth owns this conventional route; no Better Auth Hono adapter is needed.
app.all('/api/auth/*', (context) => rawAuth.handler(context.req.raw))

app.get('/protected', async (context) => {
  const result = await runtime.run(
    Effect.fn(async function* () {
      const auth = yield* Auth
      return Result.ok(yield* auth.session.get(context.req.raw))
    })
  )

  if (Result.isError(result)) {
    return context.json({ error: 'Internal Server Error' }, 500)
  }

  return context.json({ data: result.value })
})

const main = async (): Promise<void> => {
  try {
    const authResponse = await app.request('/api/auth/get-session')
    const protectedResponse = await app.request('/protected')

    if (authResponse.status !== 200 || protectedResponse.status !== 200) {
      throw new Error('Hono routes did not return the expected responses')
    }

    console.log(
      JSON.stringify({
        authStatus: authResponse.status,
        protectedStatus: protectedResponse.status
      })
    )
  } finally {
    await runtime.dispose()
  }
}

await main()
