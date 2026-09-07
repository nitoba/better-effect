/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread, typescript/no-base-to-string -- endpoint boundaries validate external values and erase heterogeneous schema contracts at one boundary. */
import { decodeUnknownAsync, encodeAsync } from 'better-effect-schema'
import { Result } from 'better-result'
import { HttpRequestError } from './errors'
import type { HttpClientInstance, HttpRequestOptions } from './client'
import type { HttpOperation } from './operation'
import type { HttpSchema } from './schema'
import type { AnySchemaCodec, CodecOutput } from 'better-effect-schema'
import type { StandardSchemaV1 } from 'better-effect-schema'

type Parts = Readonly<{ params?: HttpSchema; query?: HttpSchema; body?: HttpSchema }>
type Definition = Readonly<
  Parts & {
    readonly bodyCodec?: AnySchemaCodec
    readonly schema?: HttpSchema
    readonly responses?: Readonly<Record<number, HttpSchema>>
  }
>
type Input<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferInput<S> : never
export type HttpEndpointArgs<D extends HttpEndpointDefinition> = (D['params'] extends HttpSchema
  ? { readonly params: Input<D['params']> }
  : {}) &
  (D['query'] extends HttpSchema ? { readonly query: Input<D['query']> } : {}) &
  (D['body'] extends HttpSchema ? { readonly body: Input<D['body']> } : {}) &
  (D['bodyCodec'] extends AnySchemaCodec ? { readonly body: CodecOutput<D['bodyCodec']> } : {})

export type HttpEndpointDefinition<D extends Definition = Definition> = D
export type HttpEndpoint<D extends Definition = Definition> = Readonly<{
  method: string
  path: string
  definition: D
}>

const encodePath = async (path: string, params: unknown): Promise<string> => {
  if (params === undefined || params === null || typeof params !== 'object') return path
  return path.replace(/:([A-Za-z_$][\w$]*)/g, (match, key: string) => {
    const value = (params as Record<string, unknown>)[key]
    if (value === undefined)
      throw new HttpRequestError({ phase: 'request', details: `missing path parameter: ${key}` })
    return encodeURIComponent(String(value))
  })
}

const validated = async (schema: HttpSchema | undefined, value: unknown): Promise<unknown> => {
  if (!schema) return value
  const result = await decodeUnknownAsync(schema, value)
  if (Result.isError(result)) throw new HttpRequestError({ phase: 'request', cause: result.error })
  return result.value
}

export const HttpEndpoint = {
  get<const P extends string, const D extends Definition>(path: P, definition: D): HttpEndpoint<D> {
    return { method: 'GET', path, definition }
  },
  post<const P extends string, const D extends Definition>(
    path: P,
    definition: D
  ): HttpEndpoint<D> {
    return { method: 'POST', path, definition }
  },
  put<const P extends string, const D extends Definition>(path: P, definition: D): HttpEndpoint<D> {
    return { method: 'PUT', path, definition }
  },
  patch<const P extends string, const D extends Definition>(
    path: P,
    definition: D
  ): HttpEndpoint<D> {
    return { method: 'PATCH', path, definition }
  },
  delete<const P extends string, const D extends Definition>(
    path: P,
    definition: D
  ): HttpEndpoint<D> {
    return { method: 'DELETE', path, definition }
  }
}

export const bindEndpoints = <E extends Record<string, HttpEndpoint>>(
  client: HttpClientInstance,
  endpoints: E
) =>
  Object.fromEntries(
    Object.entries(endpoints).map(([key, endpoint]) => [
      key,
      (args: unknown) => {
        const definition = endpoint.definition
        const run = async function* (): HttpOperation {
          try {
            const input = (args ?? {}) as Record<string, unknown>
            const params = await validated(definition.params, input.params)
            const query = await validated(definition.query, input.query)
            let body = await validated(definition.body, input.body)
            if (definition.bodyCodec) {
              const encoded = await encodeAsync(definition.bodyCodec, input.body)
              if (Result.isError(encoded))
                throw new HttpRequestError({ phase: 'request', cause: encoded.error })
              body = encoded.value
            }
            const path = await encodePath(endpoint.path, params)
            const options: HttpRequestOptions = { query: query as never, body }
            return yield* client.request(endpoint.method, path, {
              ...options,
              ...(definition.schema ? { schema: definition.schema } : {}),
              ...(definition.responses ? { responses: definition.responses } : {})
            } as never)
          } catch (cause) {
            return yield* Result.err(
              cause instanceof HttpRequestError
                ? cause
                : new HttpRequestError({ phase: 'request', cause })
            )
          }
        }
        return run()
      }
    ])
  ) as { [K in keyof E]: (args: HttpEndpointArgs<E[K]['definition']>) => HttpOperation }
