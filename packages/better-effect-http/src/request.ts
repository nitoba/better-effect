export type HttpBody =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | FormData
  | URLSearchParams
  | ReadableStream<Uint8Array>
export type HttpQueryValue = string | number | boolean | null | undefined
export type HttpQuery = Readonly<Record<string, HttpQueryValue | readonly HttpQueryValue[]>>
export type HttpRequest = Readonly<{
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly query?: HttpQuery
  readonly body?: HttpBody | object
}>

const copy = (request: HttpRequest, changes: Partial<HttpRequest>): HttpRequest => ({
  ...request,
  ...changes,
  headers: changes.headers ?? new Headers(request.headers)
})

export const HttpRequest = {
  make(url: string, options: Omit<Partial<HttpRequest>, 'url'> = {}): HttpRequest {
    return {
      url,
      method: options.method ?? 'GET',
      headers: new Headers(options.headers),
      ...(options.query === undefined ? {} : { query: { ...options.query } }),
      ...(options.body === undefined ? {} : { body: options.body })
    }
  },
  setHeader(request: HttpRequest, name: string, value: string): HttpRequest {
    const headers = new Headers(request.headers)
    headers.set(name, value)
    return copy(request, { headers })
  },
  appendHeader(request: HttpRequest, name: string, value: string): HttpRequest {
    const headers = new Headers(request.headers)
    headers.append(name, value)
    return copy(request, { headers })
  },
  bearerToken(request: HttpRequest, token: string): HttpRequest {
    return HttpRequest.setHeader(request, 'authorization', `Bearer ${token}`)
  },
  setQuery(
    request: HttpRequest,
    name: string,
    value: HttpQueryValue | readonly HttpQueryValue[]
  ): HttpRequest {
    return copy(request, {
      query: { ...request.query, [name]: Array.isArray(value) ? [...value] : value }
    })
  }
} as const
