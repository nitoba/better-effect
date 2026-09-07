import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect, Layer, Program, Runtime, Service } from '../../../src'
import { Clock, Random } from '../../../src/standard-services'

import { HttpClient, endpoint } from './http-contracts.model'

import type {
  EventSchemaMap,
  HttpClientInstance,
  HttpError,
  HttpInterceptor,
  HttpLayerFactory,
  HttpMiddleware,
  HttpObserver,
  HttpOperation,
  HttpPolicies,
  HttpResponse,
  HttpRetryPolicy,
  HttpStream,
  HttpTransportError,
  StandardSchemaV1
} from './http-contracts.model'

type User = {
  readonly id: string
  readonly name: string
}

type WireUser = {
  readonly user_id: string
}

type CreateUserInput = {
  readonly name: string
  readonly draft: boolean
}

type CreateUserOutput = {
  readonly name: string
}

type UserParams = {
  readonly id: string
}

type UserQuery = {
  readonly includePosts?: boolean
}

type CreatedEvent = {
  readonly id: string
}

type DeletedEvent = {
  readonly id: string
  readonly reason: string
}

class HttpConfig extends Service<HttpConfig>()('@design/HttpConfig') {}

class Auth extends Service<Auth>()('@design/Auth') {
  readonly bearer = 'token'
}

class Logger extends Service<Logger>()('@design/Logger') {
  write(message: string): void {
    void message
  }
}

class Metrics extends Service<Metrics>()('@design/Metrics') {}

declare const UserSchema: StandardSchemaV1<WireUser, User>
declare const AsyncUserSchema: StandardSchemaV1<WireUser, User>
declare const CreateUserSchema: StandardSchemaV1<CreateUserInput, CreateUserOutput>
declare const UserParamsSchema: StandardSchemaV1<UserParams, UserParams>
declare const UserQuerySchema: StandardSchemaV1<UserQuery, UserQuery>
declare const NoContentSchema: StandardSchemaV1<unknown, undefined>
declare const CreatedEventSchema: StandardSchemaV1<unknown, CreatedEvent>
declare const DeletedEventSchema: StandardSchemaV1<unknown, DeletedEvent>

declare const authentication: HttpInterceptor<'AuthenticationError', Auth>
declare const retryReads: HttpRetryPolicy<'RetryExhausted', Clock | Random>
declare const observer: HttpObserver<Logger>
declare const middleware: HttpMiddleware<'MiddlewareError', Metrics>

const partnerPolicies = {
  interceptors: [authentication],
  retry: retryReads,
  observers: [observer]
} as const satisfies HttpPolicies

const PartnerHttp = HttpClient.service('@app/PartnerHttp', partnerPolicies)
type PartnerHttpInstance = InstanceType<typeof PartnerHttp>

expectTypeOf<typeof PartnerHttp.serviceTag>().toEqualTypeOf<'@app/PartnerHttp'>()
expectTypeOf<Service.Tag<PartnerHttpInstance>>().toEqualTypeOf<'@app/PartnerHttp'>()
expectTypeOf<PartnerHttpInstance>().toMatchTypeOf<
  HttpClientInstance<'@app/PartnerHttp', typeof partnerPolicies>
>()

declare const plainClient: HttpClientInstance
const plainOperation = plainClient.get('/users/42', { schema: UserSchema })

expectTypeOf<typeof plainOperation>().toEqualTypeOf<HttpOperation<HttpResponse<User>, HttpError>>()
expectTypeOf<'then' extends keyof typeof plainOperation ? true : false>().toEqualTypeOf<false>()

declare const partnerClient: PartnerHttpInstance
const isolatedOperation = partnerClient.get('/users/42', { schema: AsyncUserSchema })

expectTypeOf<typeof isolatedOperation>().toEqualTypeOf<
  HttpOperation<
    HttpResponse<User>,
    HttpError | 'AuthenticationError' | 'RetryExhausted',
    Auth | Clock | Random | Logger
  >
>()
expectTypeOf<HttpTransportError['_tag']>().toEqualTypeOf<'HttpTransportError'>()

const genericRequest = partnerClient.request('POST', '/users', {
  body: { name: 'Ada' },
  schema: UserSchema
})
expectTypeOf<typeof genericRequest>().toEqualTypeOf<
  HttpOperation<
    HttpResponse<User>,
    HttpError | 'AuthenticationError' | 'RetryExhausted',
    Auth | Clock | Random | Logger
  >
>()

// @ts-expect-error request bodies belong inside options, never in a positional argument.
void partnerClient.post('/users', { name: 'Ada' })

void partnerClient.get('/users', {
  schema: UserSchema,
  // @ts-expect-error one response decoder mode is selected per buffered operation.
  responses: { 200: UserSchema }
})

const requestProgram = Effect.fn(async function* () {
  const http = yield* PartnerHttp
  const response = yield* http.get('/users/42', { schema: UserSchema })

  return Result.ok(response.data)
})

expectTypeOf<Effect.Success<typeof requestProgram>>().toEqualTypeOf<User>()
expectTypeOf<Effect.Error<typeof requestProgram>>().toEqualTypeOf<
  HttpError | 'AuthenticationError' | 'RetryExhausted'
>()
expectTypeOf<Effect.Requirements<typeof requestProgram>>().toEqualTypeOf<
  PartnerHttpInstance | Auth | Clock | Random | Logger
>()

const chainedProgram = Program.andThen(requestProgram, (user) =>
  Effect.gen(function* () {
    const metrics = yield* Metrics

    return Result.ok({ user, metrics })
  })
)

expectTypeOf<Effect.Success<typeof chainedProgram>>().toEqualTypeOf<{
  user: User
  metrics: Metrics
}>()
expectTypeOf<Effect.Error<typeof chainedProgram>>().toEqualTypeOf<
  HttpError | 'AuthenticationError' | 'RetryExhausted'
>()
expectTypeOf<Effect.Requirements<typeof chainedProgram>>().toEqualTypeOf<
  PartnerHttpInstance | Auth | Clock | Random | Logger | Metrics
>()

declare const optionsFactory: HttpLayerFactory<HttpConfig>
const PartnerHttpLive = PartnerHttp.layer(optionsFactory)

expectTypeOf<Layer.Provided<typeof PartnerHttpLive>>().toEqualTypeOf<PartnerHttpInstance>()
expectTypeOf<Layer.Required<typeof PartnerHttpLive>>().toEqualTypeOf<HttpConfig>()

const configLayer = Layer.make(HttpConfig)
const authLayer = Layer.make(Auth)
const loggerLayer = Layer.make(Logger)
const clockLayer = Layer.make(Clock)
const randomLayer = Layer.make(Random)
const incompleteApplication = Layer.merge(configLayer, PartnerHttpLive)
const completeApplication = Layer.merge(
  incompleteApplication,
  authLayer,
  loggerLayer,
  clockLayer,
  randomLayer
)

expectTypeOf<Layer.Required<typeof incompleteApplication>>().toBeNever()
expectTypeOf<Layer.Required<typeof completeApplication>>().toBeNever()
expectTypeOf<Runtime.For<typeof completeApplication>>().toEqualTypeOf<
  Runtime<Layer.Provided<typeof completeApplication>>
>()

const completeRun = Runtime.run(completeApplication, requestProgram)
expectTypeOf<typeof completeRun>().toEqualTypeOf<
  Promise<Awaited<ReturnType<typeof requestProgram>>>
>()

// The client Layer is complete, but its execution Program still requires Auth, Clock, Random and Logger.
// @ts-expect-error incomplete Runtime execution must report the missing policy requirements at the call site.
void Runtime.run(incompleteApplication, requestProgram)

declare const incompleteRuntime: Runtime<Layer.Provided<typeof incompleteApplication>>
// @ts-expect-error a Runtime inferred from an incomplete root cannot run the policy-bearing Program.
void incompleteRuntime.run(requestProgram)

const derivedClient = partnerClient.use(middleware)
const derivedOperation = derivedClient.get('/users/42', { schema: UserSchema })

const derivedOperationContract: HttpOperation<
  HttpResponse<User>,
  HttpError | 'AuthenticationError' | 'RetryExhausted' | 'MiddlewareError',
  Auth | Clock | Random | Logger | Metrics
> = derivedOperation
void derivedOperationContract

const observedToken = HttpClient.service('@app/ObservedHttp', { observers: [observer] as const })
declare const observedClient: InstanceType<typeof observedToken>
const observedOperation = observedClient.get('/health', { schema: UserSchema })

expectTypeOf<typeof observedOperation>().toEqualTypeOf<
  HttpOperation<HttpResponse<User>, HttpError, Logger>
>()

const statusOperation = partnerClient.get('/health', {
  responses: {
    200: UserSchema,
    204: NoContentSchema
  } as const
})

expectTypeOf<typeof statusOperation>().toEqualTypeOf<
  HttpOperation<
    HttpResponse<User, 200> | HttpResponse<undefined, 204>,
    HttpError | 'AuthenticationError' | 'RetryExhausted',
    Auth | Clock | Random | Logger
  >
>()

const binaryStream = partnerClient.stream('/download')
expectTypeOf<typeof binaryStream>().toEqualTypeOf<
  HttpStream<
    Uint8Array,
    HttpError | 'AuthenticationError' | 'RetryExhausted',
    Auth | Clock | Random | Logger
  >
>()

const userStream = partnerClient.ndjson('/users', { schema: AsyncUserSchema })
expectTypeOf<typeof userStream>().toEqualTypeOf<
  HttpStream<
    User,
    HttpError | 'AuthenticationError' | 'RetryExhausted',
    Auth | Clock | Random | Logger
  >
>()

const streamConsumer = Effect.fn(async function* () {
  const logger = yield* Logger
  logger.write('received')

  return Result.ok(undefined)
})

const consumedStream = userStream.forEach((chunk, index) => {
  expectTypeOf(chunk).toEqualTypeOf<User>()
  expectTypeOf(index).toEqualTypeOf<number>()
  return streamConsumer
})

expectTypeOf<Effect.Success<typeof consumedStream>>().toEqualTypeOf<void>()
expectTypeOf<Effect.Error<typeof consumedStream>>().toEqualTypeOf<
  HttpError | 'AuthenticationError' | 'RetryExhausted'
>()
expectTypeOf<Effect.Requirements<typeof consumedStream>>().toEqualTypeOf<
  Auth | Clock | Random | Logger
>()

const streamUse = userStream.use((session) => {
  expectTypeOf(session.body).toEqualTypeOf<ReadableStream<User>>()

  return Effect.gen(function* () {
    const metrics = yield* Metrics

    return Result.ok(metrics)
  })
})

expectTypeOf<Effect.Success<typeof streamUse>>().toEqualTypeOf<Metrics>()
expectTypeOf<Effect.Error<typeof streamUse>>().toEqualTypeOf<
  HttpError | 'AuthenticationError' | 'RetryExhausted'
>()
expectTypeOf<Effect.Requirements<typeof streamUse>>().toEqualTypeOf<
  Auth | Clock | Random | Logger | Metrics
>()
expectTypeOf<Effect.Success<ReturnType<typeof userStream.results>>>().toEqualTypeOf<
  readonly User[]
>()

const schemaSse = partnerClient.sse('/events', { schema: CreatedEventSchema })
expectTypeOf<typeof schemaSse>().toEqualTypeOf<
  HttpStream<
    CreatedEvent,
    HttpError | 'AuthenticationError' | 'RetryExhausted',
    Auth | Clock | Random | Logger
  >
>()

const eventMap = {
  created: CreatedEventSchema,
  deleted: DeletedEventSchema
} as const satisfies EventSchemaMap
const mappedSse = partnerClient.sse('/events', { eventMap })

expectTypeOf<typeof mappedSse>().toEqualTypeOf<
  HttpStream<
    | { readonly type: 'created'; readonly data: CreatedEvent }
    | { readonly type: 'deleted'; readonly data: DeletedEvent },
    HttpError | 'AuthenticationError' | 'RetryExhausted',
    Auth | Clock | Random | Logger
  >
>()

// @ts-expect-error schema and eventMap are mutually exclusive SSE decoding modes.
void partnerClient.sse('/events', {
  schema: CreatedEventSchema,
  eventMap
})

const createUserEndpoint = endpoint({
  method: 'POST',
  path: '/users/:id',
  params: UserParamsSchema,
  query: UserQuerySchema,
  body: CreateUserSchema,
  response: UserSchema
})

const createUserOperation = createUserEndpoint({
  params: { id: '42' },
  query: { includePosts: true },
  body: { name: 'Ada', draft: false }
})

expectTypeOf<typeof createUserOperation>().toEqualTypeOf<
  HttpOperation<HttpResponse<User>, HttpError>
>()

void createUserEndpoint({
  params: { id: '42' },
  query: { includePosts: true },
  // @ts-expect-error draft is required by the Standard Schema input.
  body: { name: 'Ada' }
})

// @ts-expect-error endpoint path parameters are required when declared by the endpoint.
void createUserEndpoint({
  query: { includePosts: true },
  body: { name: 'Ada', draft: false }
})

const statusEndpoint = endpoint({
  method: 'GET',
  path: '/health',
  responses: {
    200: UserSchema,
    204: NoContentSchema
  } as const
})

const statusEndpointOperation = statusEndpoint({})
expectTypeOf<typeof statusEndpointOperation>().toEqualTypeOf<
  HttpOperation<HttpResponse<User, 200> | HttpResponse<undefined, 204>, HttpError>
>()

declare const defaultOptionsFactory: HttpLayerFactory<never>
const defaultLayerWithHooks = HttpClient.layer(defaultOptionsFactory)
expectTypeOf<Layer.Provided<typeof defaultLayerWithHooks>>().toEqualTypeOf<HttpClientInstance>()

// Effectful hooks in Layer configuration do not mutate the already-declared standard token's A/E/R type.
const plainAgainOperation = plainClient.get('/users/42', { schema: UserSchema })
expectTypeOf<typeof plainAgainOperation>().toEqualTypeOf<
  HttpOperation<HttpResponse<User>, HttpError>
>()

class StructuralClientA extends Service<StructuralClientA>()('@design/structural-client') {
  request(): string {
    return 'a'
  }
}

class StructuralClientB extends Service<StructuralClientB>()('@design/structural-client') {
  request(): string {
    return 'b'
  }
}

const structuralA = StructuralClientA.of({ request: () => 'a' })
const structuralB = StructuralClientB.of({ request: () => 'b' })
expectTypeOf<typeof structuralA>().toEqualTypeOf<StructuralClientA>()
expectTypeOf<typeof structuralB>().toEqualTypeOf<StructuralClientB>()

const structuralBase = Layer.succeed(StructuralClientA, structuralA)
const structuralOverride = Layer.override(
  structuralBase,
  Layer.succeed(StructuralClientB, structuralB)
)

expectTypeOf<Layer.Provided<typeof structuralOverride>>().toEqualTypeOf<StructuralClientB>()

class IncompatibleClient extends Service<IncompatibleClient>()('@design/structural-client') {
  request(): string {
    return 'incompatible'
  }

  required(): number {
    return 1
  }
}

const incompatible = IncompatibleClient.of({
  request: () => 'incompatible',
  required: () => 1
})

// @ts-expect-error same-tag overrides must be bidirectionally contract-compatible.
void Layer.override(structuralBase, Layer.succeed(IncompatibleClient, incompatible))

declare const arbitrarySchema: StandardSchemaV1<{ readonly raw: string }, { readonly id: number }>
const providerNeutralOperation = plainClient.post('/decode', {
  body: { raw: '42' },
  schema: arbitrarySchema
})

expectTypeOf<typeof providerNeutralOperation>().toEqualTypeOf<
  HttpOperation<HttpResponse<{ readonly id: number }>, HttpError>
>()
