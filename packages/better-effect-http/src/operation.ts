import { Result } from 'better-result'
import { HttpAbortError, HttpRequestError, HttpStatusError, HttpTransportError } from './errors'
import type { HttpError } from './errors'
import { classifyResponse, executeRequest } from './internal/ofetch-transport'
import type { TransportOptions, TransportRequest } from './internal/ofetch-transport'

export type HttpResponse<A = unknown, Status extends number = number> = Readonly<{
  status: Status
  statusText: string
  headers: Headers
  url: string
  data: A
}>
export type HttpOperation<A = unknown> = AsyncGenerator<
  never,
  Result<HttpResponse<A>, HttpError>,
  unknown
>

export const operation = <A>(
  config: TransportOptions,
  request: TransportRequest
): HttpOperation<A> => {
  let consumed = false
  return (async function* () {
    if (consumed)
      return Result.err(
        new HttpRequestError({ phase: 'request', details: 'HTTP operation was already consumed' })
      )
    consumed = true
    try {
      const response = await executeRequest(config, request)
      const data = await classifyResponse(response, request.responseType)
      return Result.ok({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        url: response.url,
        data: data as A
      })
    } catch (cause) {
      if (cause instanceof HttpStatusError || cause instanceof HttpTransportError)
        return Result.err(cause)
      if (request.signal?.aborted) return Result.err(new HttpAbortError({ phase: 'abort', cause }))
      return Result.err(new HttpRequestError({ phase: 'request', cause }))
    }
  })()
}
