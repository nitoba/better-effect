import * as Http from '../../src'

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
