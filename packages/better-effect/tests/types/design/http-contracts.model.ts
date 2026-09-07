import type { Err } from 'better-result'

import type {
  EffectError,
  EffectRequirements,
  EffectSuccess,
  Layer,
  Program,
  Service,
  ServiceRequirement
} from '../../../src'

/** Structural test-only mirror of the public Standard Schema protocol. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly types?: {
      readonly input: Input
      readonly output: Output
    }
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Standard Schema validates arbitrary external input.
    readonly validate: (
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Standard Schema validates arbitrary external input.
      value: unknown,
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Provider-specific validation options are opaque here.
      options?: Readonly<Record<string, unknown>>
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string }> }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: ReadonlyArray<{ readonly message: string }> }
        >
  }
}

export declare namespace StandardSchemaV1 {
  type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input']
  type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output']
}

/** The errors owned by an HTTP operation's transport and response boundary. */
export type HttpTransportError = {
  readonly _tag: 'HttpTransportError'
  readonly cause: unknown
}

export type HttpStatusError = {
  readonly _tag: 'HttpStatusError'
  readonly status: number
}

export type HttpParseError = {
  readonly _tag: 'HttpParseError'
  readonly cause: unknown
}

export type HttpSchemaError = {
  readonly _tag: 'HttpSchemaError'
  readonly cause: unknown
}

export type HttpHookError = {
  readonly _tag: 'HttpHookError'
  readonly cause: unknown
}

export type HttpAbortError = {
  readonly _tag: 'HttpAbortError'
  readonly cause: unknown
}

export type HttpCleanupError = {
  readonly _tag: 'HttpCleanupError'
  readonly cause: unknown
}

export type HttpError =
  | HttpTransportError
  | HttpStatusError
  | HttpParseError
  | HttpSchemaError
  | HttpHookError
  | HttpAbortError
  | HttpCleanupError

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'

/** The decoded response envelope retained by buffered HTTP operations. */
export type HttpResponse<Data, Status extends number = number> = {
  readonly status: Status
  readonly headers: Headers
  readonly url: string
  readonly data: Data
}

type OperationYield<Error, Requirements extends Service.Any> =
  | Err<never, Error>
  | ([Requirements] extends [never] ? never : ServiceRequirement<Requirements>)

/** A single-use, async-yieldable operation; it is intentionally not Promise-like. */
export type HttpOperation<
  Success,
  Error,
  Requirements extends Service.Any = never
> = AsyncGenerator<OperationYield<Error, Requirements>, Success, unknown>

type HttpRequestOptionsBase = Readonly<{
  readonly body?: unknown
  readonly headers?: HeadersInit
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>
  readonly signal?: AbortSignal
}>

export type StatusSchemaMap = Readonly<Record<number, StandardSchemaV1>>

export type HttpRequestOptions = HttpRequestOptionsBase &
  (
    | Readonly<{ readonly schema?: StandardSchemaV1; readonly responses?: never }>
    | Readonly<{ readonly responses: StatusSchemaMap; readonly schema?: never }>
  )

type SchemaOutput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>

type StatusResponse<Responses extends StatusSchemaMap> = {
  [Status in keyof Responses & number]: HttpResponse<SchemaOutput<Responses[Status]>, Status>
}[keyof Responses & number]

type ResponseFor<Options extends HttpRequestOptions> = Options extends {
  readonly responses: infer Responses extends StatusSchemaMap
}
  ? StatusResponse<Responses>
  : Options extends { readonly schema: infer Schema extends StandardSchemaV1 }
    ? HttpResponse<SchemaOutput<Schema>>
    : HttpResponse<unknown>

/** A policy adds only the channels it actually uses to the derived client. */
export interface HttpPolicy<Error, Requirements extends Service.Any = never> {
  readonly _policy: readonly [Error, Requirements]
}

export type HttpRetryPolicy<Error, Requirements extends Service.Any> = HttpPolicy<
  Error,
  Requirements
>

export type HttpInterceptor<Error, Requirements extends Service.Any = never> = HttpPolicy<
  Error,
  Requirements
> & {
  readonly onRequest?: (
    request: Readonly<HttpRequestOptions>
  ) => HttpOperation<void, Error, Requirements>
}

export type HttpHook<Error, Requirements extends Service.Any = never> = HttpInterceptor<
  Error,
  Requirements
>

export type HttpMiddleware<Error, Requirements extends Service.Any = never> = HttpInterceptor<
  Error,
  Requirements
>

export type HttpObserver<Requirements extends Service.Any = never> = HttpPolicy<
  never,
  Requirements
> & {
  readonly onEvent: Program<void, never, Requirements>
}

export type HttpPolicies = Readonly<{
  readonly retry?: HttpRetryPolicy<unknown, Service.Any>
  readonly interceptors?: readonly HttpInterceptor<unknown, Service.Any>[]
  readonly hooks?: readonly HttpHook<unknown, Service.Any>[]
  readonly observers?: readonly HttpObserver<Service.Any>[]
}>

export type NoHttpPolicies = {
  readonly retry?: never
  readonly interceptors?: never
  readonly hooks?: never
  readonly observers?: never
}

type PolicyValue<Value> = Value extends readonly (infer Entry)[] ? Entry : Value

type PolicyEntries<Policies extends HttpPolicies> =
  | PolicyValue<Policies extends { readonly retry?: infer Retry } ? Retry : never>
  | PolicyValue<
      Policies extends { readonly interceptors?: infer Interceptors } ? Interceptors : never
    >
  | PolicyValue<Policies extends { readonly hooks?: infer Hooks } ? Hooks : never>
  | PolicyValue<Policies extends { readonly observers?: infer Observers } ? Observers : never>

type PolicyError<Policies extends HttpPolicies> =
  PolicyEntries<Policies> extends infer Entry
    ? Entry extends HttpPolicy<infer Error, infer _Requirements>
      ? Error
      : never
    : never

type PolicyRequirements<Policies extends HttpPolicies> =
  PolicyEntries<Policies> extends infer Entry
    ? Entry extends HttpPolicy<infer _Error, infer Requirements>
      ? Requirements
      : never
    : never

type PolicyErrorChannel<Policies extends HttpPolicies> = HttpError | PolicyError<Policies>
type PolicyRequirementChannel<Policies extends HttpPolicies> = PolicyRequirements<Policies>

type RequestMethod<Policies extends HttpPolicies> = {
  <Path extends string, Options extends HttpRequestOptions = HttpRequestOptions>(
    path: Path,
    options?: Options
  ): HttpOperation<
    ResponseFor<Options>,
    PolicyErrorChannel<Policies>,
    PolicyRequirementChannel<Policies>
  >
}

type GenericRequestMethod<Policies extends HttpPolicies> = {
  <
    Method extends HttpMethod,
    Path extends string,
    Options extends HttpRequestOptions = HttpRequestOptions
  >(
    method: Method,
    path: Path,
    options?: Options
  ): HttpOperation<
    ResponseFor<Options>,
    PolicyErrorChannel<Policies>,
    PolicyRequirementChannel<Policies>
  >
}

export type EventSchemaMap = Readonly<Record<string, StandardSchemaV1>>

export type SseOptions =
  | {
      readonly schema: StandardSchemaV1
      readonly eventMap?: never
    }
  | {
      readonly eventMap: EventSchemaMap
      readonly schema?: never
    }

type SseEvent<Options extends SseOptions> = Options extends {
  readonly schema: infer Schema extends StandardSchemaV1
}
  ? SchemaOutput<Schema>
  : Options extends { readonly eventMap: infer Events extends EventSchemaMap }
    ? {
        [Event in keyof Events & string]: {
          readonly type: Event
          readonly data: SchemaOutput<Events[Event]>
        }
      }[keyof Events & string]
    : never

export type HttpStreamSession<Chunk> = {
  readonly body: ReadableStream<Chunk>
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Stream cancellation accepts the caller's arbitrary reason.
  readonly cancel: (reason?: unknown) => Promise<void>
}

/** Lazy stream terminals compose source and consumer A/E/R channels. */
export type HttpStream<Chunk, Error, Requirements extends Service.Any = never> = {
  readonly forEach: <Consumer>(
    consumer: (chunk: Chunk, index: number) => Consumer
  ) => Program<void, Error | EffectError<Consumer>, Requirements | EffectRequirements<Consumer>>
  readonly use: <Consumer>(
    consumer: (session: HttpStreamSession<Chunk>) => Consumer
  ) => Program<
    EffectSuccess<Consumer>,
    Error | EffectError<Consumer>,
    Requirements | EffectRequirements<Consumer>
  >
  readonly results: () => Program<readonly Chunk[], Error, Requirements>
}

export type HttpClientConfig = Readonly<{
  readonly baseUrl?: string
  readonly arbitraryEffectfulHooks?: readonly HttpHook<unknown, Service.Any>[]
}>

export type HttpLayerFactory<Requirements extends Service.Any = never> = () =>
  | Generator<ServiceRequirement<Requirements>, HttpClientConfig, unknown>
  | AsyncGenerator<ServiceRequirement<Requirements>, HttpClientConfig, unknown>

declare const HttpClientTypeId: unique symbol

export type HttpClientApi<Tag extends string, Policies extends HttpPolicies> = {
  readonly get: RequestMethod<Policies>
  readonly post: RequestMethod<Policies>
  readonly put: RequestMethod<Policies>
  readonly patch: RequestMethod<Policies>
  readonly delete: RequestMethod<Policies>
  readonly head: RequestMethod<Policies>
  readonly request: GenericRequestMethod<Policies>
  readonly stream: <Path extends string, Options extends HttpRequestOptions = HttpRequestOptions>(
    path: Path,
    options?: Options
  ) => HttpStream<Uint8Array, PolicyErrorChannel<Policies>, PolicyRequirementChannel<Policies>>
  readonly ndjson: <Schema extends StandardSchemaV1>(
    path: string,
    options: Readonly<{ readonly schema: Schema }>
  ) => HttpStream<
    SchemaOutput<Schema>,
    PolicyErrorChannel<Policies>,
    PolicyRequirementChannel<Policies>
  >
  readonly sse: <Options extends SseOptions>(
    path: string,
    options: Options
  ) => HttpStream<
    SseEvent<Options>,
    PolicyErrorChannel<Policies>,
    PolicyRequirementChannel<Policies>
  >
  readonly use: <const Interceptors extends readonly HttpInterceptor<unknown, Service.Any>[]>(
    ...interceptors: Interceptors
  ) => HttpClientInstance<Tag, Policies & { readonly interceptors: Interceptors }>
  readonly [HttpClientTypeId]: readonly [Tag, Policies]
}

export type HttpClientInstance<
  Tag extends string = 'HttpClient',
  Policies extends HttpPolicies = NoHttpPolicies
> = Service.Identity<Tag> & HttpClientApi<Tag, Policies>

export type HttpClient = HttpClientInstance

export type HttpClientToken<Tag extends string, Policies extends HttpPolicies> = Service.Token<
  Tag,
  HttpClientInstance<Tag, Policies>
> & {
  readonly layer: <Requirements extends Service.Any = never>(
    factory: HttpLayerFactory<Requirements>
  ) => Layer<HttpClientInstance<Tag, Policies>, Requirements>
}

/** Design-only declaration for the standard and named client tokens. */
export declare const HttpClient: HttpClientToken<'HttpClient', NoHttpPolicies> & {
  readonly service: <
    const Tag extends string,
    const Policies extends HttpPolicies = NoHttpPolicies
  >(
    tag: Tag,
    policies?: Policies
  ) => HttpClientToken<Tag, Policies>
}

export type EndpointDefinition = Readonly<{
  readonly method: HttpMethod
  readonly path: string
  readonly params?: StandardSchemaV1
  readonly query?: StandardSchemaV1
  readonly body?: StandardSchemaV1
  readonly response?: StandardSchemaV1
  readonly responses?: StatusSchemaMap
}>

type InputOf<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>

type EndpointInput<Definition extends EndpointDefinition> = (Definition extends {
  readonly params: infer Schema extends StandardSchemaV1
}
  ? { readonly params: InputOf<Schema> }
  : { readonly params?: never }) &
  (Definition extends { readonly query: infer Schema extends StandardSchemaV1 }
    ? { readonly query: InputOf<Schema> }
    : { readonly query?: never }) &
  (Definition extends { readonly body: infer Schema extends StandardSchemaV1 }
    ? { readonly body: InputOf<Schema> }
    : { readonly body?: never })

type EndpointResponse<Definition extends EndpointDefinition> = Definition extends {
  readonly responses: infer Responses extends StatusSchemaMap
}
  ? StatusResponse<Responses>
  : Definition extends { readonly response: infer Schema extends StandardSchemaV1 }
    ? HttpResponse<SchemaOutput<Schema>>
    : HttpResponse<unknown>

export type HttpEndpoint<Definition extends EndpointDefinition> = (
  input: EndpointInput<Definition>
) => HttpOperation<EndpointResponse<Definition>, HttpError>

export declare const endpoint: <const Definition extends EndpointDefinition>(
  definition: Definition
) => HttpEndpoint<Definition>
