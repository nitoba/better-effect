import { decodeUnknownAsync } from 'better-effect-schema'
import { Result } from 'better-result'
import { HttpDecodeError, HttpStatusError } from './errors'
import type { HttpResponse } from './operation'
import type { HttpDecodeOptions, HttpSchema, HttpResponseSchemas } from './schema'
import { readResponse } from './internal/ofetch-transport'
import type { TransportRequestInput } from './internal/ofetch-transport'

type Decoded<S extends HttpSchema> = HttpResponse<S extends HttpSchema ? import('better-effect-schema').StandardSchemaV1.InferOutput<S> : never>

export const responseWithSchema = async function <
  S extends HttpSchema,
  R extends HttpResponseSchemas
>(
  response: Response,
  request: TransportRequestInput,
  options: HttpDecodeOptions<S, R>
): Promise<Decoded<S> | HttpResponse> {
  const selected = 'responses' in options ? options.responses[response.status] : options.schema
  if (selected === undefined) {
    if (!response.ok) throw new HttpStatusError({ phase: 'status', status: response.status, statusText: response.statusText, headers: response.headers, url: response.url })
    return { status: response.status, statusText: response.statusText, headers: response.headers, url: response.url, data: await readResponse(response, 'options' in request ? request.options.responseType : request.responseType, request.method) }
  }
  try {
    const data = await readResponse(response, 'options' in request ? request.options.responseType : request.responseType, request.method)
    const result = await decodeUnknownAsync(selected, data)
    if (Result.isError(result)) throw new HttpDecodeError({ phase: 'decode', kind: 'schema', cause: result.error })
    return { status: response.status, statusText: response.statusText, headers: response.headers, url: response.url, data: result.value }
  } catch (cause) {
    if (cause instanceof HttpDecodeError) throw cause
    throw new HttpDecodeError({ phase: 'decode', kind: 'schema', cause })
  }
}
