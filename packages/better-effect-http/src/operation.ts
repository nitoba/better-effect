import { Result } from 'better-result'
import type { Err } from 'better-result'
import {
  HttpAbortError,
  HttpDecodeError,
  HttpHookError,
  HttpRequestError,
  HttpStatusError,
  HttpTimeoutError,
  HttpTransportError,
  HttpLimitError
} from './errors'
import type { HttpError } from './errors'
import { classifyResponse, executeRequest } from './internal/ofetch-transport'
import type {
  DeferredTransportRequest,
  TransportOptions,
  TransportRequest,
  TransportRequestInput,
  TransportRequestOptions
} from './internal/ofetch-transport'
import type {
  HttpDecodeOptions,
  HttpSchema,
  HttpResponseSchemas,
  ResponseData,
  SchemaOutput
} from './schema'
import { responseWithSchema } from './response-status'
import { retryAfterMs, retryableStatus } from './retry'
import type { HttpRetryPolicy } from './retry'
import type { HttpAdmission } from './limits'

export type HttpResponse<A = unknown, Status extends number = number> = Readonly<{
  status: Status
  statusText: string
  headers: Headers
  url: string
  data: A
}>

export type HttpOperation<A = unknown, Status extends number = number> = AsyncGenerator<
  Err<never, HttpError>,
  HttpResponse<A, Status>,
  unknown
>

export type HttpResponseOperation<Response extends HttpResponse = HttpResponse> = AsyncGenerator<
  Err<never, HttpError>,
  Response,
  unknown
>

type RequestOptions<S extends HttpSchema, R extends HttpResponseSchemas> = TransportRequestOptions &
  HttpDecodeOptions<S, R>

export type HttpOperationRequest<
  S extends HttpSchema = never,
  R extends HttpResponseSchemas = never
> =
  | (TransportRequest & HttpDecodeOptions<S, R>)
  | (DeferredTransportRequest & {
      readonly options: RequestOptions<S, R> | TransportRequestOptions
    })

type AnyOperationRequest =
  | TransportRequestInput
  | (TransportRequest & HttpDecodeOptions<HttpSchema, HttpResponseSchemas>)
  | (DeferredTransportRequest & {
      readonly options: TransportRequestOptions & HttpDecodeOptions<HttpSchema, HttpResponseSchemas>
    })

export function operation<S extends HttpSchema>(
  config: TransportOptions,
  request: HttpOperationRequest<S, never>
): HttpOperation<SchemaOutput<S>>
export function operation<R extends HttpResponseSchemas>(
  config: TransportOptions,
  request: HttpOperationRequest<never, R>
): HttpResponseOperation<ResponseData<R>>
export function operation(
  config: TransportOptions,
  request: AnyOperationRequest,
  limiter?: { admit: (signal?: AbortSignal) => Promise<HttpAdmission> }
): HttpOperation
export function operation(config: TransportOptions, request: AnyOperationRequest): HttpOperation
export function operation(
  config: TransportOptions,
  request: AnyOperationRequest,
  limiter?: { admit: (signal?: AbortSignal) => Promise<HttpAdmission> }
): HttpOperation {
  const requestOptions = 'options' in request ? request.options : request
  const hasSchema = 'schema' in requestOptions
  const hasResponses = 'responses' in requestOptions
  const hasDecodeOptions = hasSchema || hasResponses

  if (hasSchema && hasResponses) {
    return (async function* () {
      return yield* Result.err(
        new HttpRequestError({
          phase: 'request',
          details: 'schema and responses are mutually exclusive'
        })
      )
    })()
  }

  let consumed = false
  return (async function* () {
    if (consumed)
      return yield* Result.err(
        new HttpRequestError({
          phase: 'request',
          details: 'HTTP operation was already consumed'
        })
      )
    consumed = true
    try {
      const retry = requestOptions.retry
      const policy: HttpRetryPolicy | undefined = retry === false ? undefined : retry
      const methods = policy?.methods?.map((method) => method.toUpperCase())
      let attempt = 0
      const started = Date.now()
      let response: Response
      while (true) {
        const admission = limiter ? await limiter.admit(requestOptions.signal) : undefined
        try {
          response = await executeRequest(config, request)
        } finally {
          admission?.release()
        }
        if (policy === undefined) break
        try {
          const responseType =
            'options' in request ? request.options.responseType : request.responseType
          const responseSchemas =
            'responses' in requestOptions &&
            requestOptions.responses !== null &&
            requestOptions.responses !== undefined
              ? requestOptions.responses
              : undefined
          const expectedStatus =
            !response.ok &&
            responseSchemas !== undefined &&
            Object.prototype.hasOwnProperty.call(responseSchemas, response.status)
          if (!response.ok && !expectedStatus)
            await classifyResponse(response, responseType, request.method)
          break
        } catch (error) {
          // SAFETY: classifyResponse and executeRequest only reach this branch with a typed HTTP failure.
          const httpError = error as import('./errors').HttpError
          const eligible =
            policy !== undefined &&
            (methods === undefined || methods.includes(request.method.toUpperCase())) &&
            (httpError._tag === 'HttpStatusError'
              ? retryableStatus(httpError.status)
              : httpError._tag === 'HttpTransportError' || httpError._tag === 'HttpTimeoutError') &&
            (policy.when === undefined || policy.when({ error: httpError, attempt: attempt + 1 }))
          if (!eligible || attempt >= policy.times) throw error
          const local = policy.delay?.(attempt + 1) ?? 0
          const server =
            policy.respectRetryAfter && httpError._tag === 'HttpStatusError'
              ? (retryAfterMs(httpError.headers.get('retry-after')) ?? 0)
              : 0
          const wait = Math.max(local, server)
          if (policy.totalMs !== undefined && Date.now() - started + wait > policy.totalMs)
            throw error
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, wait)
            requestOptions.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                reject(requestOptions.signal?.reason)
              },
              { once: true }
            )
          })
          attempt++
        }
      }
      if (hasDecodeOptions) {
        // SAFETY: `hasDecodeOptions` was derived from this exact request before execution.
        return await responseWithSchema(response, request, requestOptions as HttpDecodeOptions)
      }
      const responseType =
        'options' in request ? request.options.responseType : request.responseType
      const data = await classifyResponse(response, responseType, request.method)
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        url: response.url,
        data
      }
    } catch (cause) {
      if (
        cause instanceof HttpAbortError ||
        cause instanceof HttpDecodeError ||
        cause instanceof HttpHookError ||
        cause instanceof HttpRequestError ||
        cause instanceof HttpStatusError ||
        cause instanceof HttpTimeoutError ||
        cause instanceof HttpTransportError ||
        cause instanceof HttpLimitError
      )
        return yield* Result.err(cause)
      const signal = 'options' in request ? request.options.signal : request.signal
      if (signal?.aborted) return yield* Result.err(new HttpAbortError({ phase: 'abort', cause }))
      return yield* Result.err(new HttpRequestError({ phase: 'request', cause }))
    }
  })()
}
