import { APIError } from 'better-auth/api'
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

const rawAuth = {
  api: {
    getSession: async () => null
  },
  handler: async () => new Response('ok')
}
const Auth = BetterAuth.service('@external/Auth', rawAuth)

if (!(Auth instanceof Function) || Auth.serviceTag !== '@external/Auth') {
  throw new Error('BetterAuth.service did not return a tagged Service token')
}
if (Auth.layer === null || !(Auth.layer instanceof Object)) {
  throw new Error('BetterAuth.service did not attach its Layer')
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
