type FetchInput = Parameters<typeof globalThis.fetch>[0]
type FetchInit = Parameters<typeof globalThis.fetch>[1]
type FetchBody = BodyInit
type FetchHeaders = HeadersInit
export type HttpTestRequest = Readonly<{ readonly input: FetchInput; readonly init?: FetchInit; readonly method: string; readonly url: string; readonly index: number }>
export type HttpTestHistory = HttpTestRequest & Readonly<{ readonly outcome: 'response' | 'error' }>
export type HttpTestMatcher = Readonly<{ readonly method?: string; readonly url?: string | RegExp | ((url: string) => boolean) }>
export type ControlledStream = ReadableStream<Uint8Array> & Readonly<{ readonly releaseHeaders: () => void; readonly push: (chunk: string | Uint8Array) => void; readonly end: () => void; readonly fail: (cause?: unknown) => void; readonly stats: Readonly<{ readonly reads: number; readonly cancels: number; readonly releases: number }> }>
export type HttpTestStep = (request: HttpTestRequest) => Response | Promise<Response>
const matches = (request: HttpTestRequest, matcher: HttpTestMatcher): boolean => {
  if (matcher.method && matcher.method.toUpperCase() !== request.method) return false
  if (matcher.url === undefined) return true
  return matcher.url instanceof RegExp ? matcher.url.test(request.url) : typeof matcher.url === 'function' ? matcher.url(request.url) : matcher.url === request.url
}
const bytes = (body: string | Uint8Array): Uint8Array => typeof body === 'string' ? new TextEncoder().encode(body) : body
export const controlledStream = (): ControlledStream => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined; let released = false; let reads = 0; let cancels = 0
  const stream = new ReadableStream<Uint8Array>({ start(next) { controller = next }, pull() { reads++ }, cancel() { cancels++; released = true } }) as ControlledStream
  Object.defineProperties(stream, {
    releaseHeaders: { value: () => { released = true } },
    push: { value: (chunk: string | Uint8Array) => { if (!released) throw new Error('stream headers are not released'); controller?.enqueue(bytes(chunk)) } },
    end: { value: () => { released = true; controller?.close() } },
    fail: { value: (cause?: unknown) => { released = true; controller?.error(cause ?? new Error('controlled stream failure')) } },
    stats: { get: () => ({ reads, cancels, releases: released ? 1 : 0 }) }
  }); return stream
}
const makeResponse = (status: number, body?: unknown, headers?: FetchHeaders): Response => {
  if (body === undefined || status === 204 || status === 205 || status === 304) return new Response(null, { status, headers })
  if (body instanceof ReadableStream || typeof body === 'string' || body instanceof Uint8Array) return new Response(body as FetchBody, { status, headers })
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) } })
}
export type HttpTestScenario = Readonly<{ readonly fetch: typeof globalThis.fetch; readonly history: readonly HttpTestHistory[]; readonly calls: number; readonly remaining: number }>
export const HttpTest = {
  response(status: number, body?: unknown, options?: { readonly headers?: FetchHeaders; readonly match?: HttpTestMatcher }): HttpTestStep { return request => { if (options?.match && !matches(request, options.match)) throw new Error(`HttpTest request mismatch at ${request.index} (${request.method} ${request.url})`); return makeResponse(status, body, options?.headers) } },
  text(status: number, body: string, options?: { readonly headers?: FetchHeaders; readonly match?: HttpTestMatcher }): HttpTestStep { return HttpTest.response(status, body, options) },
  bytes(status: number, body: Uint8Array, options?: { readonly headers?: FetchHeaders; readonly match?: HttpTestMatcher }): HttpTestStep { return HttpTest.response(status, body, options) },
  error(cause: unknown, match?: HttpTestMatcher): HttpTestStep { return request => { if (match && !matches(request, match)) throw new Error(`HttpTest request mismatch at ${request.index}`); throw cause } },
  stream(stream: ReadableStream<Uint8Array>, status = 200, headers?: FetchHeaders): HttpTestStep { return () => makeResponse(status, stream, headers) },
  sequence(steps: readonly HttpTestStep[]): HttpTestScenario {
    const history: HttpTestHistory[] = []; let cursor = 0
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(); const url = input instanceof Request ? input.url : String(input)
      const request: HttpTestRequest = { input, ...(init === undefined ? {} : { init }), method, url, index: history.length }; const step = steps[cursor++]
      if (!step) throw new Error(`HttpTest sequence exhausted at request ${request.index} (${method} ${url})`)
      try { const response = await step(request); history.push({ ...request, outcome: 'response' }); return response } catch (error) { history.push({ ...request, outcome: 'error' }); throw error }
    }) as typeof globalThis.fetch
    return { fetch, history, get calls() { return history.length }, get remaining() { return steps.length - cursor } }
  }
}
