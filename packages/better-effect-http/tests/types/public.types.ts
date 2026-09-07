import * as Http from '../../src'
import type {
  HttpClientInstance,
  HttpOperation,
  HttpResponseOperation,
  ResponseData
} from '../../src'
import type { StandardSchemaV1 } from 'better-effect-schema'

const request = Http.HttpRequest.make('https://example.test')
const authenticated = Http.HttpRequest.bearerToken(request, 'secret')
const status: Http.HttpStatusError = new Http.HttpStatusError({
  phase: 'status',
  status: 500,
  statusText: 'Error',
  headers: new Headers(),
  url: request.url
})

const exactTag: '_tag' extends keyof typeof status ? true : never = true
const immutable: typeof request extends Readonly<{ url: string }> ? true : never = true
void authenticated
void exactTag
void immutable

declare const userSchema: StandardSchemaV1<unknown, { readonly id: number }>
declare const notFoundSchema: StandardSchemaV1<unknown, { readonly reason: string }>
declare const client: HttpClientInstance<'Api'>

const user = client.get('/users/42', { schema: userSchema })
const responses = client.response('/users/42', {
  responses: { 200: userSchema, 404: notFoundSchema }
})

const expectedUser: HttpOperation<{ readonly id: number }> = user
const expectedResponses: HttpResponseOperation<
  ResponseData<{ 200: typeof userSchema; 404: typeof notFoundSchema }>
> = responses

const recovery = Http.HttpAuth.refresh({
  maxReplays: 1,
  key: 'session',
  refresh: 'token'
})
const typedRecovery: Http.HttpAuthMiddleware<never, never> = recovery
const configured = Http.HttpClient.service('Configured', {
  interceptors: [Http.HttpAuth.authentication({ credential: 'token' })],
  middleware: [typedRecovery]
})

void expectedUser
void expectedResponses
void typedRecovery
void configured
