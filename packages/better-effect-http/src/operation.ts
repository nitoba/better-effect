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

export type HttpResponse<A = unknown, Status extends number = number> = Readonly<{
  status: Status
  statusText: string
  headers: Headers
  url: string
  data: A
}>
export type HttpOperation = AsyncGenerator<Err<never, HttpError>, HttpResponse, unknown>

export const operation = (
  config: TransportOptions,
  request: TransportRequestInput
): HttpOperation => {
  let consumed = false
  return (async function* () {
    if (consumed)
      return yield* Result.err(
        new HttpRequestError({ phase: 'request', details: 'HTTP operation was already consumed' })
      )
    consumed = true
    try {
      const response = await executeRequest(config, request)
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
