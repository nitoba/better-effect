import { betterAuth } from 'better-auth'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { admin } from 'better-auth/plugins'
import { Effect, Runtime } from 'better-effect'
import { BetterAuth, BetterAuthApiError, Unauthenticated } from 'better-effect-better-auth'
import { Result } from 'better-result'

const baseURL = 'http://localhost:3000'
const credentials = {
  email: 'consumer-admin@example.com',
  name: 'External Consumer Admin',
  password: 'a-valid-password-123'
}

const makeDatabase = () => ({
  account: [],
  session: [],
  user: [],
  verification: []
})

const releaseGatePlugin = (signals) => ({
  id: 'release-gate',
  endpoints: {
    consumerEcho: createAuthEndpoint('/consumer-echo', { method: 'GET' }, async (context) =>
      context.json({ value: context.query?.value ?? null })
    ),
    consumerFailure: createAuthEndpoint('/consumer-failure', { method: 'GET' }, async () => {
      throw new APIError(
        'TOO_MANY_REQUESTS',
        {
          code: 'CONSUMER_PLUGIN_FAILURE',
          message: 'The consumer plugin failed'
        },
        new Headers({
          'retry-after': '7',
          'set-cookie': 'consumer-secret=do-not-log'
        })
      )
    }),
    consumerForbidden: createAuthEndpoint('/consumer-forbidden', { method: 'GET' }, async () => {
      throw new APIError('FORBIDDEN', {
        code: 'CONSUMER_FORBIDDEN',
        message: 'The consumer request is forbidden'
      })
    }),
    consumerRedirect: createAuthEndpoint(
      '/consumer-redirect',
      { method: 'GET' },
      async (context) => {
        throw context.redirect(`${baseURL}/consumer-target`)
      }
    ),
    consumerReleaseGate: createAuthEndpoint(
      '/consumer-release-gate',
      { method: 'GET' },
      async (context) => context.json({ source: 'real-plugin' })
    ),
    consumerSignal: createAuthEndpoint(
      '/consumer-signal',
      { method: 'GET', requireRequest: true },
      async (context) => {
        signals.push(context.request.signal)
        return context.json({ aborted: context.request.signal.aborted })
      }
    ),
    consumerStream: createAuthEndpoint(
      '/consumer-stream',
      { method: 'GET' },
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('consumer-stream-body'))
              controller.close()
            }
          }),
          { headers: { 'content-type': 'text/plain' } }
        )
    )
  },
  schema: {
    session: {
      fields: {
        tenantId: {
          required: false,
          type: 'string'
        }
      }
    },
    user: {
      fields: {
        plan: {
          required: false,
          type: 'string'
        }
      }
    }
  },
  $ERROR_CODES: {
    CONSUMER_PLUGIN_FAILURE: {
      code: 'CONSUMER_PLUGIN_FAILURE',
      message: 'The consumer plugin failed'
    },
    CONSUMER_FORBIDDEN: {
      code: 'CONSUMER_FORBIDDEN',
      message: 'The consumer request is forbidden'
    }
  }
})

const makeAuth = (options = {}) => {
  const signals = []
  const rawAuth = betterAuth({
    baseURL,
    database: memoryAdapter(makeDatabase()),
    emailAndPassword: {
      enabled: true
    },
    ...options,
    plugins: [admin({ defaultRole: 'admin' }), releaseGatePlugin(signals)],
    secret: 'external-consumer-secret-not-for-production-use'
  })
  return { rawAuth, signals }
}

const { rawAuth, signals } = makeAuth()
const Auth = BetterAuth.service('@consumer/Auth', rawAuth)

const execute = (operation) =>
  Result.gen(async function* () {
    return Result.ok(yield* operation)
  })

const runtime = await Runtime.make(Auth.layer)
let result
try {
  result = await runtime.run(
    Effect.fn(async function* () {
      const auth = yield* Auth
      const created = yield* auth.api.signUpEmail({
        body: credentials
      })
      const signedIn = yield* auth.api.signInEmail.withHeaders({
        body: {
          email: credentials.email,
          password: credentials.password
        }
      })
      const cookies = signedIn.headers.getSetCookie()
      const headers = new Headers({
        cookie: cookies.join('; ')
      })
      const request = new Request(`${baseURL}/protected`, { headers })
      const session = yield* auth.session.require(request)
      const users = yield* auth.api.listUsers({
        headers,
        query: {
          limit: 5
        }
      })
      const plugin = yield* auth.api.consumerReleaseGate({ headers })
      const pluginResponse = yield* auth.api.consumerReleaseGate.asResponse({ headers })
      const streamResponse = yield* auth.handle(new Request(`${baseURL}/api/auth/consumer-stream`))
      const signalRequest = new Request(`${baseURL}/api/auth/consumer-signal`)
      const signalResponse = yield* auth.handle(signalRequest)
      const abortedController = new AbortController()
      abortedController.abort()
      const abortedRequest = new Request(`${baseURL}/api/auth/consumer-signal`, {
        signal: abortedController.signal
      })
      const abortedResponse = yield* auth.handle(abortedRequest)
      const invalidHandler = yield* auth.handle(
        new Request(`${baseURL}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: credentials.email,
            password: 'not-the-password'
          })
        })
      )
      const badRequestHandler = yield* auth.handle(
        new Request(`${baseURL}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'not-an-email',
            password: 'not-a-password'
          })
        })
      )
      const handler = yield* auth.handle(
        new Request(`${baseURL}/api/auth/get-session`, {
          headers
        })
      )
      const signOut = yield* auth.api.signOut.asResponse({ headers })

      return Result.ok({
        abortedRequest,
        abortedResponse,
        auth,
        badRequestHandler,
        cookies,
        created,
        handler,
        invalidHandler,
        plugin,
        pluginResponse,
        session,
        signalRequest,
        signalResponse,
        signOut,
        streamResponse,
        users
      })
    })
  )
} finally {
  await runtime.dispose()
}

if (!Result.isOk(result)) {
  throw new Error(`External Better Auth Program failed: ${String(result.error)}`)
}
if (
  result.value.created.user.role !== 'admin' ||
  result.value.cookies.length === 0 ||
  result.value.session.user.email !== credentials.email ||
  result.value.users.total !== 1 ||
  result.value.plugin.source !== 'real-plugin' ||
  result.value.pluginResponse.status !== 200 ||
  result.value.pluginResponse.bodyUsed ||
  result.value.streamResponse.status !== 200 ||
  result.value.streamResponse.bodyUsed ||
  result.value.signalResponse.status !== 200 ||
  result.value.signalResponse.bodyUsed ||
  result.value.abortedResponse.status !== 200 ||
  result.value.abortedResponse.bodyUsed ||
  result.value.invalidHandler.status !== 401 ||
  result.value.invalidHandler.bodyUsed ||
  result.value.badRequestHandler.status !== 400 ||
  result.value.badRequestHandler.bodyUsed ||
  result.value.handler.status !== 200 ||
  result.value.handler.bodyUsed ||
  result.value.signOut.status !== 200 ||
  result.value.signOut.headers.getSetCookie().length === 0
) {
  throw new Error('External Better Auth Service behavior did not pass')
}
if ((await result.value.pluginResponse.text()) !== '{"source":"real-plugin"}') {
  throw new Error('External plugin Response mode did not preserve its body')
}
if ((await result.value.streamResponse.text()) !== 'consumer-stream-body') {
  throw new Error('External handler streaming Response did not preserve its body')
}
if ((await result.value.signalResponse.json()).aborted !== false) {
  throw new Error('External handler did not preserve a live Request AbortSignal')
}
if ((await result.value.abortedResponse.json()).aborted !== true) {
  throw new Error('External handler did not preserve an aborted Request AbortSignal')
}
if (
  signals[0] !== result.value.signalRequest.signal ||
  signals[1] !== result.value.abortedRequest.signal
) {
  throw new Error('External handler changed the Request AbortSignal identity')
}

const missing = await execute(result.value.auth.session.get(new Headers()))
const requiredMissing = await execute(result.value.auth.session.require(new Headers()))
const invalidCredentials = await execute(
  result.value.auth.api.signInEmail({
    body: {
      email: credentials.email,
      password: 'not-the-password'
    }
  })
)
const pluginFailure = await execute(result.value.auth.api.consumerFailure())
const forbiddenHandler = await execute(
  result.value.auth.handle(new Request(`${baseURL}/api/auth/consumer-forbidden`))
)
const redirect = await execute(
  result.value.auth.handle(new Request(`${baseURL}/api/auth/consumer-redirect`))
)
const failedHandler = await execute(
  result.value.auth.handle(new Request(`${baseURL}/api/auth/consumer-failure`))
)
const notFound = await execute(
  result.value.auth.handle(new Request(`${baseURL}/api/auth/not-a-real-endpoint`))
)
const [slow, fast] = await Promise.all([
  execute(result.value.auth.api.consumerEcho({ query: { value: 'slow' } })),
  execute(result.value.auth.api.consumerEcho({ query: { value: 'fast' } }))
])

if (
  !Result.isOk(missing) ||
  missing.value !== null ||
  !Result.isError(requiredMissing) ||
  !(requiredMissing.error instanceof Unauthenticated) ||
  !Result.isError(invalidCredentials) ||
  !(invalidCredentials.error instanceof BetterAuthApiError) ||
  invalidCredentials.error.code !== 'INVALID_EMAIL_OR_PASSWORD' ||
  !Result.isError(pluginFailure) ||
  !(pluginFailure.error instanceof BetterAuthApiError) ||
  pluginFailure.error.statusCode !== 429 ||
  pluginFailure.error.code !== 'CONSUMER_PLUGIN_FAILURE' ||
  new Headers(pluginFailure.error.headers).get('retry-after') !== '7' ||
  JSON.stringify(pluginFailure.error).includes('consumer-secret') ||
  !Result.isOk(forbiddenHandler) ||
  forbiddenHandler.value.status !== 403 ||
  forbiddenHandler.value.bodyUsed ||
  !Result.isOk(redirect) ||
  redirect.value.status !== 302 ||
  redirect.value.headers.get('location') !== `${baseURL}/consumer-target` ||
  !Result.isOk(failedHandler) ||
  failedHandler.value.status !== 429 ||
  failedHandler.value.headers.get('retry-after') !== '7' ||
  failedHandler.value.headers.getSetCookie()[0] !== 'consumer-secret=do-not-log' ||
  !Result.isOk(notFound) ||
  notFound.value.status !== 404 ||
  !Result.isOk(slow) ||
  !Result.isOk(fast) ||
  slow.value.value !== 'slow' ||
  fast.value.value !== 'fast'
) {
  throw new Error('External error, handler, or concurrency checks failed')
}

const throwing = makeAuth({ onAPIError: { throw: true } })
const ThrowingAuth = BetterAuth.service('@consumer/ThrowingAuth', throwing.rawAuth)
const throwingRuntime = await Runtime.make(ThrowingAuth.layer)
let throwingResult
try {
  throwingResult = await throwingRuntime.run(
    Effect.fn(async function* () {
      const auth = yield* ThrowingAuth
      return Result.ok(await execute(auth.api.consumerFailure()))
    })
  )
} finally {
  await throwingRuntime.dispose()
}
if (
  !Result.isOk(throwingResult) ||
  !Result.isError(throwingResult.value) ||
  !(throwingResult.value.error instanceof BetterAuthApiError) ||
  throwingResult.value.error.statusCode !== 429 ||
  throwingResult.value.error.code !== 'CONSUMER_PLUGIN_FAILURE'
) {
  throw new Error('Public Better Auth onAPIError.throw handling did not pass')
}

console.log('packed Better Auth consumer passed')
