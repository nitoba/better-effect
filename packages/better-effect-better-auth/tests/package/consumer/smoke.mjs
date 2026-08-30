import { APIError } from 'better-auth/api'
import { Effect, Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { BetterAuth, BetterAuthApiError, Unauthenticated } from 'better-effect-better-auth'

const headers = new Headers({
  'set-cookie': 'session=secret'
})
const source = new APIError(
  'UNAUTHORIZED',
  {
    code: 'INVALID_EMAIL_OR_PASSWORD',
    message: 'Invalid email or password',
    secret: 'body-secret'
  },
  headers
)
const normalized = BetterAuthApiError.from(source)
const unauthenticated = new Unauthenticated({
  message: 'Authentication is required'
})
const publicApi = await import('better-effect-better-auth')
const runtimeExports = Object.keys(publicApi).sort()
const expectedRuntimeExports = ['BetterAuth', 'BetterAuthApiError', 'Unauthenticated']

if (JSON.stringify(runtimeExports) !== JSON.stringify(expectedRuntimeExports)) {
  throw new Error(`Unexpected runtime exports: ${runtimeExports.join(', ')}`)
}
if (publicApi.BetterAuth !== BetterAuth) {
  throw new Error('BetterAuth static import does not match the package export')
}
if (BetterAuth === null || !(BetterAuth.service instanceof Function)) {
  throw new Error('BetterAuth.service is not callable')
}

const session = Object.freeze({
  session: Object.freeze({ id: 'packed-session' }),
  user: Object.freeze({ id: 'packed-user' })
})
const request = new Request('https://example.test/protected', {
  headers: {
    authorization: 'Bearer packed'
  }
})
const apiInputs = []
const rawApi = {
  async getSession(input) {
    if (this !== rawApi) {
      throw new Error('Better Auth API receiver was not preserved')
    }
    if (
      input.asResponse !== false ||
      input.returnHeaders !== false ||
      input.returnStatus !== false
    ) {
      throw new Error('Better Auth API transport flags were not normalized')
    }

    apiInputs.push(input)
    return input.headers.get('authorization') === 'Bearer packed' ? session : null
  }
}
let handlerResponse
const rawAuth = {
  api: rawApi,
  async handler(input) {
    if (this !== rawAuth || input !== request) {
      throw new Error('Better Auth handler receiver or Request was not preserved')
    }

    handlerResponse = new Response('packed-handler', {
      status: 207,
      headers: {
        'x-packed-auth': 'ok'
      }
    })
    return handlerResponse
  }
}
const Auth = BetterAuth.service('@external/Auth', rawAuth)
const constructed = new Auth()

if (!(Auth instanceof Function) || Auth.serviceTag !== '@external/Auth') {
  throw new Error('BetterAuth.service did not return a tagged Service token')
}
if (Auth.layer === null || !(Auth.layer instanceof Object)) {
  throw new Error('BetterAuth.service did not attach its Layer')
}
if (constructed.raw !== rawAuth || !(constructed.api instanceof Object)) {
  throw new Error('Constructed Better Auth Service is incomplete')
}

const runtime = await Runtime.make(Layer.merge(Auth.layer, Layer.empty))
let result
try {
  result = await runtime.run(
    Effect.fn(async function* () {
      const auth = yield* Auth
      const apiSession = yield* auth.api.getSession({ headers: request.headers })
      const requiredSession = yield* auth.session.require(request)
      const response = yield* auth.handle(request)

      return Result.ok({ auth, apiSession, requiredSession, response })
    })
  )
} finally {
  await runtime.dispose()
}

if (!Result.isOk(result)) {
  throw new Error(`Packed Better Auth program failed: ${String(result.error)}`)
}
if (
  result.value.auth.raw !== rawAuth ||
  result.value.apiSession !== session ||
  result.value.requiredSession !== session ||
  result.value.response !== handlerResponse ||
  result.value.response.status !== 207 ||
  result.value.response.headers.get('x-packed-auth') !== 'ok' ||
  (await result.value.response.text()) !== 'packed-handler' ||
  apiInputs.length !== 2
) {
  throw new Error('Packed Better Auth program did not preserve Service behavior')
}
if (
  normalized.cause !== source ||
  normalized.headers !== headers ||
  normalized.statusCode !== 401
) {
  throw new Error('BetterAuthApiError did not preserve the APIError in memory')
}
if (normalized.code !== 'INVALID_EMAIL_OR_PASSWORD') {
  throw new Error('BetterAuthApiError did not preserve the runtime code')
}
if (unauthenticated._tag !== 'Unauthenticated') {
  throw new Error('Unauthenticated did not preserve its tagged identity')
}

const json = JSON.stringify(normalized)
if (json.includes('session=secret') || json.includes('body-secret')) {
  throw new Error('BetterAuthApiError serialized sensitive fields')
}
