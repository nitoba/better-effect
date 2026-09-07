// oxlint-disable anti-slop/no-known-value-widening -- the ofetch options are assembled at the transport boundary.
// oxlint-disable anti-slop/no-runtime-typeof -- BodyInit is narrowed at the JavaScript fetch boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- request bodies and JSON responses are intentionally untyped here.
// oxlint-disable anti-slop/no-unknown-returns -- the default JSON response is deliberately unknown until a schema is applied.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- the transport option object is checked by ofetch's named contract.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions restore the platform BodyInit contract after narrowing.
import { createFetch, ofetch } from 'ofetch'
import { CurrentAbortSignal } from 'better-effect'
import type { FetchOptions } from 'ofetch'
import { HttpDecodeError, HttpStatusError, HttpTransportError } from '../errors'
import { linkSignals } from './signals'
import { deadline } from './deadlines'

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
  readonly timeout?:
    | number
    | Readonly<{ readonly attemptMs?: number; readonly totalMs?: number | false }>
  readonly responseType?: 'json' | 'text' | 'blob' | 'arrayBuffer'
}>

export type TransportRequestOptions = Readonly<Omit<TransportRequest, 'method' | 'path'>>

/** Request shape used by clients so option getters are not read until consumption. */
export type DeferredTransportRequest = Readonly<{
  readonly method: string
  readonly path: string
  readonly options: TransportRequestOptions
}>

export type TransportRequestInput = TransportRequest | DeferredTransportRequest

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
  input: TransportRequestInput
): Promise<Response> => {
  const request: TransportRequest =
    'options' in input ? { ...input.options, method: input.method, path: input.path } : input
  const headers = new Headers(config.headers)
  for (const [name, value] of new Headers(request.headers)) headers.set(name, value)
  let body = request.body
  if (body !== undefined && !isBodyInit(body)) {
    body = JSON.stringify(body)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  }
  try {
    const timeout =
      typeof request.timeout === 'number' ? request.timeout : request.timeout?.attemptMs
    const timed = deadline(timeout)
    const linked = linkSignals(request.signal, yieldCurrentSignal(), timed?.signal)
    const requester = config.fetch ? createFetch({ fetch: config.fetch }) : ofetch
    const options: FetchOptions<'stream'> = {
      method: request.method,
      headers,
      body: body as RequestInit['body'],
      retry: 0,
      ignoreResponseError: true,
      responseType: 'stream'
    }
    if (request.query !== undefined) options.query = request.query
    options.signal = linked.signal
    try {
      return await requester.raw(urlFor(config.baseURL, request.path), options)
    } finally {
      linked.dispose()
      timed?.dispose()
    }
  } catch (cause) {
    throw new HttpTransportError({ phase: 'transport', cause })
  }
}

const yieldCurrentSignal = (): AbortSignal | undefined => {
  try {
    return CurrentAbortSignal[Symbol.iterator]().next().value as AbortSignal
  } catch {
    return undefined
  }
}

export const readResponse = async (
  response: Response,
  responseType: TransportRequest['responseType'],
  method?: string
): Promise<unknown> => {
  if (
    method === 'HEAD' ||
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
    throw new HttpDecodeError({ phase: 'decode', kind: 'provider', cause })
  }
}

export const classifyResponse = async (
  response: Response,
  responseType: TransportRequest['responseType'],
  method?: string
): Promise<unknown> => {
  if (!response.ok) {
    let body: unknown
    try {
      body = await readResponse(response, responseType, method)
    } catch {
      // Preserve the HTTP status even when an error body cannot be decoded.
      body = undefined
    }
    throw new HttpStatusError({
      phase: 'status',
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      url: response.url,
      body
    })
  }
  return await readResponse(response, responseType, method)
}
