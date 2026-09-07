import { Result } from 'better-result'
import type { Err } from 'better-result'
import {
  HttpAbortError,
  HttpDecodeError,
  HttpHookError,
  HttpRequestError,
  HttpStatusError,
  HttpTimeoutError,
  HttpTransportError
} from './errors'
import type { HttpError } from './errors'
import { classifyResponse, executeRequest } from './internal/ofetch-transport'
import type { TransportOptions, TransportRequestInput } from './internal/ofetch-transport'
import type { HttpDecodeOptions, HttpSchema, HttpResponseSchemas } from './schema'
import { responseWithSchema } from './response-status'

export type HttpResponse<A = unknown, Status extends number = number> = Readonly<{
  status: Status
  statusText: string
  headers: Headers
  url: string
  data: A
}>
export type HttpOperation<A = unknown> = AsyncGenerator<Err<never, HttpError>, HttpResponse<A>, unknown>

export const operation = <S extends HttpSchema = never, R extends HttpResponseSchemas = never>(
  config: TransportOptions,
  request: TransportRequestInput & (HttpDecodeOptions<S, R> | { readonly schema?: never; readonly responses?: never })
): HttpOperation<unknown> => {
  let consumed = false
  return (async function* () {
    if (consumed)
      return yield* Result.err(
        new HttpRequestError({ phase: 'request', details: 'HTTP operation was already consumed' })
      )
    consumed = true
    try {
      const response = await executeRequest(config, request)
      const decodeOptions = 'options' in request && ('schema' in request.options || 'responses' in request.options)
        ? request.options as HttpDecodeOptions<S, R>
        : !('options' in request) && ('schema' in request || 'responses' in request)
          ? request as HttpDecodeOptions<S, R>
          : undefined
      if (decodeOptions !== undefined) return await responseWithSchema(response, request, decodeOptions)
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
        cause instanceof HttpTransportError
      )
        return yield* Result.err(cause)
      const signal = 'options' in request ? request.options.signal : request.signal
      if (signal?.aborted) return yield* Result.err(new HttpAbortError({ phase: 'abort', cause }))
      return yield* Result.err(new HttpRequestError({ phase: 'request', cause }))
    }
  })()
}
