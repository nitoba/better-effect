import { Layer, Service } from 'better-effect'
import type { ServiceIdentity, ServiceToken as CoreServiceToken } from 'better-effect'
import { operation } from './operation'
import type { HttpOperation } from './operation'
import type { TransportOptions, TransportRequest } from './internal/ofetch-transport'

export type HttpClientOptions = TransportOptions
export type HttpRequestOptions = Omit<TransportRequest, 'method' | 'path'>
export type HttpClientInstance = ServiceIdentity<string> & {
  readonly get: (path: string, options?: HttpRequestOptions) => HttpOperation
  readonly post: (path: string, options?: HttpRequestOptions) => HttpOperation
  readonly put: (path: string, options?: HttpRequestOptions) => HttpOperation
  readonly patch: (path: string, options?: HttpRequestOptions) => HttpOperation
  readonly delete: (path: string, options?: HttpRequestOptions) => HttpOperation
  readonly head: (path: string, options?: HttpRequestOptions) => HttpOperation
  readonly request: (method: string, path: string, options?: HttpRequestOptions) => HttpOperation
}
export type HttpClientToken<Tag extends string = 'HttpClient'> = CoreServiceToken<
  Tag,
  HttpClientInstance
> & { readonly layer: (options: HttpClientOptions) => ReturnType<typeof Layer.make> }

const makeClient = (config: HttpClientOptions): HttpClientInstance => {
  const request = (method: string, path: string, options: HttpRequestOptions = {}) =>
    operation(config, { ...options, method, path })
  return {
    request,
    get: (p, o) => request('GET', p, o),
    post: (p, o) => request('POST', p, o),
    put: (p, o) => request('PUT', p, o),
    patch: (p, o) => request('PATCH', p, o),
    delete: (p, o) => request('DELETE', p, o),
    head: (p, o) => request('HEAD', p, o)
  } as HttpClientInstance
}

const token = Service<HttpClientInstance>()('HttpClient') as unknown as CoreServiceToken<
  'HttpClient',
  ServiceIdentity<'HttpClient'>
>
const attach = <T>(
  service: T
): T & { readonly layer: (options: HttpClientOptions) => ReturnType<typeof Layer.make> } => {
  Object.defineProperty(service, 'layer', {
    value: (options: HttpClientOptions) =>
      Layer.make(service as never, () => makeClient(options) as never)
  })
  return service as T & {
    readonly layer: (options: HttpClientOptions) => ReturnType<typeof Layer.make>
  }
}

export const HttpClient = Object.assign(attach(token), {
  service<const Tag extends string>(tag: Tag) {
    return attach(
      Service<HttpClientInstance>()(tag as never) as unknown as CoreServiceToken<
        Tag,
        ServiceIdentity<Tag>
      >
    )
  }
})
