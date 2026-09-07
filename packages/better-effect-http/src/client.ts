/* oxlint-disable anti-slop/no-chained-type-assertions -- Service's erased factory instance is restored at one token boundary. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- token assertions are justified by the structural contract below. */
import { Layer, Service } from 'better-effect'
import type { Layer as LayerType, ServiceIdentity, ServiceToken } from 'better-effect'
import { operation } from './operation'
import type { HttpOperation, HttpResponseOperation } from './operation'
import type { TransportOptions, TransportRequestOptions } from './internal/ofetch-transport'
import type {
  HttpDecodeOptions,
  HttpSchema,
  HttpResponseSchemas,
  ResponseData,
  SchemaOutput
} from './schema'
import { bindEndpoints } from './endpoints'
import type { HttpEndpoint, HttpEndpointArgs } from './endpoints'
import type { HttpInterceptor, HttpObserver } from './interceptors'
import type { HttpMiddleware } from './middleware'
import type { HttpRetryPolicy } from './retry'
import { makeHttpLimiter } from './limits'

export type HttpClientOptions = TransportOptions & {
  readonly limits?: import('./limits').HttpLimits
}
export type HttpRequestOptions = TransportRequestOptions & {
  readonly retry?: HttpRetryPolicy | false
} & ({ readonly schema?: never; readonly responses?: never } | HttpDecodeOptions)

export type HttpRequestMethod = {
  <S extends HttpSchema>(
    path: string,
    options: TransportRequestOptions & { readonly schema: S; readonly responses?: never }
  ): HttpOperation<SchemaOutput<S>>
  <R extends HttpResponseSchemas>(
    path: string,
    options: TransportRequestOptions & { readonly responses: R; readonly schema?: never }
  ): HttpResponseOperation<ResponseData<R>>
  (path: string, options?: TransportRequestOptions): HttpOperation
}

export type HttpRequestFunction = {
  <S extends HttpSchema>(
    method: string,
    path: string,
    options: TransportRequestOptions & { readonly schema: S; readonly responses?: never }
  ): HttpOperation<SchemaOutput<S>>
  <R extends HttpResponseSchemas>(
    method: string,
    path: string,
    options: TransportRequestOptions & { readonly responses: R; readonly schema?: never }
  ): HttpResponseOperation<ResponseData<R>>
  (method: string, path: string, options?: TransportRequestOptions): HttpOperation
}

export type HttpClientInstance<Tag extends string = string> = ServiceIdentity<Tag> & {
  readonly endpoints: <E extends Record<string, HttpEndpoint>>(
    endpoints: E
  ) => { [K in keyof E]: (args: HttpEndpointArgs<E[K]['definition']>) => HttpOperation }
  readonly use: (
    ...hooks: readonly (
      | HttpInterceptor<any, any>
      | HttpObserver<any>
      | HttpMiddleware<any, any, any>
    )[]
  ) => HttpClientInstance<Tag>
  readonly get: HttpRequestMethod
  readonly post: HttpRequestMethod
  readonly put: HttpRequestMethod
  readonly patch: HttpRequestMethod
  readonly delete: HttpRequestMethod
  readonly head: HttpRequestMethod
  readonly request: HttpRequestFunction
  readonly response: <R extends HttpResponseSchemas>(
    path: string,
    options: TransportRequestOptions & { readonly responses: R; readonly schema?: never }
  ) => HttpResponseOperation<ResponseData<R>>
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

const makeClient = <Tag extends string>(
  config: HttpClientOptions,
  hooks: readonly unknown[] = [],
  limiter = makeHttpLimiter(config.limits)
): HttpClientInstance<Tag> => {
  const request = (method: string, path: string, options: HttpRequestOptions = {}) =>
    operation(config, { method, path, options }, limiter)
  const method = (name: string) => (path: string, options?: HttpRequestOptions) =>
    request(name, path, options)
  const client = {
    endpoints: (endpoints: Record<string, HttpEndpoint>) => bindEndpoints(client, endpoints),
    use: (...added: readonly unknown[]) => makeClient(config, [...hooks, ...added], limiter),
    request,
    get: method('GET'),
    post: method('POST'),
    put: method('PUT'),
    patch: method('PATCH'),
    delete: method('DELETE'),
    head: method('HEAD'),
    response: (
      path: string,
      options: TransportRequestOptions & {
        readonly responses: HttpResponseSchemas
        readonly schema?: never
      }
    ) => request('GET', path, options)
  } as HttpClientInstance<Tag>
  return client
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
