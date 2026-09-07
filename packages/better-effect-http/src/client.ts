/* oxlint-disable anti-slop/no-chained-type-assertions -- Service's erased factory instance is restored at one token boundary. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- token assertions are justified by the structural contract below. */
import { Layer, Service } from 'better-effect'
import type { Layer as LayerType, ServiceIdentity, ServiceToken } from 'better-effect'
import { operation } from './operation'
import type { HttpOperation } from './operation'
import type { TransportOptions, TransportRequestOptions } from './internal/ofetch-transport'
import type { HttpDecodeOptions, HttpSchema, HttpResponseSchemas } from './schema'

export type HttpClientOptions = TransportOptions
export type HttpRequestOptions = TransportRequestOptions &
  ({ readonly schema?: never; readonly responses?: never } | HttpDecodeOptions)
export type HttpClientInstance<Tag extends string = string> = ServiceIdentity<Tag> & {
  readonly get: (path: string, options?: HttpRequestOptions) => HttpOperation
  readonly post: (path: string, options?: HttpRequestOptions) => HttpOperation
  readonly put: (path: string, options?: HttpRequestOptions) => HttpOperation
  readonly patch: (path: string, options?: HttpRequestOptions) => HttpOperation
  readonly delete: (path: string, options?: HttpRequestOptions) => HttpOperation
  readonly head: (path: string, options?: HttpRequestOptions) => HttpOperation
  readonly request: (method: string, path: string, options?: HttpRequestOptions) => HttpOperation
}
export type HttpClientToken<Tag extends string = 'HttpClient'> = ServiceToken<
  Tag,
  HttpClientInstance<Tag>
>

export type HttpClientLayer<Tag extends string = 'HttpClient'> = LayerType<
  HttpClientInstance<Tag>,
  never
>

type HttpClientTokenWithLayer<Tag extends string> = HttpClientToken<Tag> & {
  readonly layer: (options: HttpClientOptions) => HttpClientLayer<Tag>
}

const makeClient = <Tag extends string>(config: HttpClientOptions): HttpClientInstance<Tag> => {
  const request = (method: string, path: string, options: HttpRequestOptions = {}) =>
    operation(config, { method, path, options })
  return {
    request,
    get: (p, o) => request('GET', p, o),
    post: (p, o) => request('POST', p, o),
    put: (p, o) => request('PUT', p, o),
    patch: (p, o) => request('PATCH', p, o),
    delete: (p, o) => request('DELETE', p, o),
    head: (p, o) => request('HEAD', p, o)
  } as HttpClientInstance<Tag>
}

// SAFETY: Service's runtime class is the token; this assertion restores its declared instance contract.
const token = Service<HttpClientInstance<'HttpClient'>>()(
  'HttpClient'
) as unknown as HttpClientToken<'HttpClient'>

const attach = <Tag extends string>(
  service: HttpClientToken<Tag>
): HttpClientTokenWithLayer<Tag> => {
  Object.defineProperty(service, 'layer', {
    value: (options: HttpClientOptions) => Layer.make(service, () => makeClient<Tag>(options))
  })
  // SAFETY: `layer` was defined as a non-enumerable own property immediately above.
  return service as HttpClientTokenWithLayer<Tag>
}

export const HttpClient = Object.assign(attach(token), {
  service<const Tag extends string>(tag: Tag): HttpClientTokenWithLayer<Tag> {
    // SAFETY: Service validates the non-empty literal tag at runtime; the cast restores the erased instance contract.
    const service = Service<HttpClientInstance<Tag>>()(
      tag as never
    ) as unknown as HttpClientToken<Tag>
    return attach(service)
  }
})
