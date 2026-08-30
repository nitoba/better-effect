import { APIError } from 'better-auth/api'
import { BetterAuthApiError, Unauthenticated } from 'better-effect-better-auth'

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
const runtimeExports = Object.keys(await import('better-effect-better-auth')).sort()

if (JSON.stringify(runtimeExports) !== JSON.stringify(['BetterAuthApiError', 'Unauthenticated'])) {
  throw new Error(`Unexpected runtime exports: ${runtimeExports.join(', ')}`)
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
