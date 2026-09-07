import { decodeUnknownAsync, SchemaExecutionFailure } from 'better-effect-schema'
import { Result } from 'better-result'
import { HttpDecodeError, HttpRequestError, HttpStatusError } from './errors'
import type { HttpResponse } from './operation'
import type {
  HttpDecodeOptions,
  HttpSchema,
  HttpResponseSchemas,
  ResponseData,
  SchemaOutput
} from './schema'
import { readResponse } from './internal/ofetch-transport'
import type { TransportRequestInput } from './internal/ofetch-transport'

type ResponseEnvelope<A, Status extends number> = HttpResponse<A, Status>

const envelope = <A>(response: Response, data: A): HttpResponse<A> => ({
  status: response.status,
  statusText: response.statusText,
  headers: response.headers,
  url: response.url,
  data
})

const statusError = (response: Response): HttpStatusError =>
  new HttpStatusError({
    phase: 'status',
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    url: response.url
  })

const responseTypeOf = (request: TransportRequestInput) =>
  'options' in request ? request.options.responseType : request.responseType

const decodeErrorKind = (cause: unknown): 'schema' | 'provider' =>
  cause instanceof SchemaExecutionFailure ? 'provider' : 'schema'

const assertExclusive = (options: HttpDecodeOptions): void => {
  const hasSchema = 'schema' in options
  const hasResponses = 'responses' in options
  if (hasSchema && hasResponses) {
    throw new HttpRequestError({
      phase: 'request',
      details: 'schema and responses are mutually exclusive'
    })
  }
}

export async function responseWithSchema<S extends HttpSchema>(
  response: Response,
  request: TransportRequestInput,
  options: HttpDecodeOptions<S, never> & { readonly schema: S }
): Promise<ResponseEnvelope<SchemaOutput<S>, number>>
export async function responseWithSchema<R extends HttpResponseSchemas>(
  response: Response,
  request: TransportRequestInput,
  options: HttpDecodeOptions<never, R> & { readonly responses: R }
): Promise<ResponseData<R>>
export async function responseWithSchema(
  response: Response,
  request: TransportRequestInput,
  options: HttpDecodeOptions
): Promise<HttpResponse>
export async function responseWithSchema(
  response: Response,
  request: TransportRequestInput,
  options: HttpDecodeOptions
): Promise<HttpResponse> {
  assertExclusive(options)

  let selected: HttpSchema | undefined
  const responses = 'responses' in options ? options.responses : undefined
  if (responses !== undefined) {
    selected = responses[response.status]
    if (selected === undefined) throw statusError(response)
  } else {
    if (!response.ok) throw statusError(response)
    const schema = 'schema' in options ? options.schema : undefined
    if (schema === undefined) {
      throw new HttpRequestError({ phase: 'request', details: 'a schema option is required' })
    }
    selected = schema
  }

  try {
    const data = await readResponse(response, responseTypeOf(request), request.method)
    const result = await decodeUnknownAsync(selected, data)
    if (Result.isError(result)) {
      throw new HttpDecodeError({
        phase: 'decode',
        kind: decodeErrorKind(result.error),
        cause: result.error
      })
    }
    return envelope(response, result.value)
  } catch (cause) {
    if (cause instanceof HttpDecodeError || cause instanceof HttpRequestError) throw cause
    throw new HttpDecodeError({
      phase: 'decode',
      kind: decodeErrorKind(cause),
      cause
    })
  }
}
