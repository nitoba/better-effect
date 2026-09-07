import { createFetch, ofetch } from 'ofetch'
import { HttpStatusError, HttpTransportError } from '../errors'

export type TransportOptions = Readonly<{
  readonly baseURL?: string
  readonly headers?: RequestInit['headers']
  readonly fetch?: typeof globalThis.fetch
}>

export type TransportRequest = Readonly<{
  readonly method: string
  readonly path: string
  readonly query?: Record<string, string | number | boolean | undefined>
  readonly headers?: RequestInit['headers']
  readonly body?: unknown
  readonly signal?: AbortSignal
  readonly responseType?: 'json' | 'text' | 'blob' | 'arrayBuffer'
}>

const isBodyInit = (value: unknown): value is NonNullable<RequestInit['body']> =>
  typeof value === 'string' ||
  value instanceof Blob ||
  value instanceof FormData ||
  value instanceof URLSearchParams ||
  value instanceof ArrayBuffer ||
  ArrayBuffer.isView(value) ||
  (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream)

const urlFor = (baseURL: string | undefined, path: string): string => {
  if (!baseURL) return path
  return new URL(path, baseURL.endsWith('/') ? baseURL : `${baseURL}/`).toString()
}

export const executeRequest = async (
  config: TransportOptions,
  request: TransportRequest
): Promise<Response> => {
  const headers = new Headers(config.headers)
  for (const [name, value] of new Headers(request.headers)) headers.set(name, value)
  let body = request.body
  if (body !== undefined && !isBodyInit(body)) {
    body = JSON.stringify(body)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  }
  try {
    const requester = config.fetch ? createFetch({ fetch: config.fetch }) : ofetch
    const options: Record<string, unknown> = {
      method: request.method,
      headers,
      body: body as RequestInit['body'],
      retry: 0
    }
    if (request.query !== undefined) options.query = request.query
    if (request.signal !== undefined) options.signal = request.signal
    return await requester.raw(urlFor(config.baseURL, request.path), options)
  } catch (cause) {
    throw new HttpTransportError({ phase: 'transport', cause })
  }
}

export const readResponse = async (
  response: Response,
  responseType: TransportRequest['responseType']
): Promise<unknown> => {
  if (
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304 ||
    response.body === null
  )
    return undefined
  try {
    if (responseType === 'text') return await response.text()
    if (responseType === 'blob') return await response.blob()
    if (responseType === 'arrayBuffer') return await response.arrayBuffer()
    const text = await response.text()
    if (text.trim() === '') return undefined
    return JSON.parse(text) as unknown
  } catch (cause) {
    throw new HttpTransportError({ phase: 'transport', cause })
  }
}

export const classifyResponse = async (
  response: Response,
  responseType: TransportRequest['responseType']
): Promise<unknown> => {
  const data = await readResponse(response, responseType)
  if (!response.ok)
    throw new HttpStatusError({
      phase: 'status',
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      url: response.url,
      body: data
    })
  return data
}
