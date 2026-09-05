import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { Effect, Layer, Runtime, Service } from '../../src'
import type { EffectError } from '../../src/effect/types'
import { CurrentRequest } from '../../src/standard-services'
import { WebEffect } from '../../src/web'
import type { WebEffectOptions } from '../../src/web'

class Available extends Service<Available>()('WebTypeAvailable') {}
class Missing extends Service<Missing>()('WebTypeMissing') {}
class RequestValue extends Service<RequestValue>()('WebTypeRequestValue') {
  constructor(readonly value: string) {
    super()
  }
}
class OtherRequestValue extends Service<OtherRequestValue>()('WebTypeOtherRequestValue') {}
class ExpectedFailure extends Error {
  readonly kind = 'expected' as const
}
class UnexpectedFailure extends Error {
  readonly kind = 'unexpected' as const
}

class RootBoundaryService extends Service<RootBoundaryService>()('WebRootBoundary') {
  value(): string {
    return 'root'
  }
}

class CompatibleRootBoundary extends Service<CompatibleRootBoundary>()('WebRootBoundary') {
  value(): string {
    return 'request'
  }
}

class IncompatibleRootBoundary extends Service<IncompatibleRootBoundary>()('WebRootBoundary') {
  other(): number {
    return 1
  }
}

// SAFETY: These declaration-only fixtures never execute a Runtime.
const runtime = {} as Runtime<Available>
// SAFETY: This declaration-only fixture never executes a Runtime.
const rootBoundaryRuntime = {} as Runtime<RootBoundaryService>
// SAFETY: This declaration-only fixture never executes an executor.
const executor = {} as Runtime.Executor<Available>

const program = Effect.fn(async function* () {
  const available = yield* Available
  const request = yield* CurrentRequest
  const requestValue = yield* RequestValue

  return Result.ok({
    available,
    request,
    requestValue
  })
})

const requestLayer = Layer.gen(RequestValue, async function* () {
  const currentRequest = yield* CurrentRequest
  void currentRequest
  return new RequestValue('request')
})

const response = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  program,
  {
    requestLayer: (request) => {
      expectTypeOf(request).toEqualTypeOf<Request>()
      return requestLayer
    },
    onSuccess: ({ value }) => {
      expectTypeOf(value).toEqualTypeOf<{
        available: Available
        request: CurrentRequest
        requestValue: RequestValue
      }>()
      return Response.json(value)
    }
  }
)

expectTypeOf(response).toEqualTypeOf<Promise<Response>>()

const executorResponse = WebEffect.handleWith(
  executor,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    const currentRequest = yield* CurrentRequest
    const available = yield* Available

    return Result.ok({
      // SAFETY: The Web boundary supplies CurrentRequest from the Request argument.
      url: (currentRequest.request as Request).url,
      value: available
    })
  }),
  {
    onSuccess: ({ value }) => {
      expectTypeOf(value).toEqualTypeOf<{ url: string; value: Available }>()
      return new Response(value.url)
    }
  }
)

expectTypeOf(executorResponse).toEqualTypeOf<Promise<Response>>()

const executorRequestResponse = WebEffect.handleWith(
  executor,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    const requestValue = yield* RequestValue
    return Result.ok(requestValue.value)
  }),
  {
    requestLayer: () => requestLayer
  }
)

expectTypeOf(executorRequestResponse).toEqualTypeOf<Promise<Response>>()

const incompleteExecutor = {
  runWith: () => Promise.resolve(new Response())
}

const invalidExecutor = WebEffect.handleWith(
  // @ts-expect-error WebEffect requires the branded Runtime.Executor capability, not an arbitrary structural runner.
  incompleteExecutor,
  new Request('https://example.test'),
  // oxlint-disable-next-line require-yield -- This fixture checks the executor boundary's invalid Program type.
  Effect.fn(async function* () {
    return Result.ok('invalid')
  })
)
void invalidExecutor

// @ts-expect-error WebEffect intentionally exposes only the executor-based handleWith API.
const legacyHandle = WebEffect.handle
void legacyHandle

const defaultResponse = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  // oxlint-disable-next-line require-yield -- This fixture checks the default Response policy type.
  Effect.fn(async function* () {
    return Result.ok(new Response(null, { status: 204 }))
  })
)
expectTypeOf(defaultResponse).toEqualTypeOf<Promise<Response>>()

const failureProgram = Effect.fn(async function* () {
  yield* Result.await(Promise.resolve(Result.ok(undefined)))
  return Result.err(new ExpectedFailure())
})

const failureResponse = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  failureProgram,
  {
    onFailure: (error: ExpectedFailure) => {
      expectTypeOf(error).toEqualTypeOf<ExpectedFailure>()
      return new Response('expected', { status: 422 })
    }
  }
)

expectTypeOf(failureResponse).toEqualTypeOf<Promise<Response>>()

const responseFailureProgram = Effect.fn(async function* () {
  yield* Result.await(Promise.resolve(Result.ok(undefined)))
  return Result.err(new Response('not found', { status: 404 }))
})
const responseFailureResponse = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  responseFailureProgram
)
expectTypeOf(responseFailureResponse).toEqualTypeOf<Promise<Response>>()

const configuredProgram = Effect.fn(async function* () {
  yield* Result.await(Promise.resolve(Result.ok(undefined)))
  return Result.ok('configured')
})
const options: WebEffectOptions<ExpectedFailure, typeof requestLayer, string> & {
  readonly requestLayer: (request: Request) => typeof requestLayer
} = {
  requestLayer: () => requestLayer,
  onSuccess: ({ value }) => {
    expectTypeOf(value).toEqualTypeOf<string>()
    return new Response(value)
  },
  onFailure: (error) => {
    expectTypeOf(error).toEqualTypeOf<ExpectedFailure>()
    return new Response('failure')
  }
}

const configuredResponse = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  configuredProgram,
  options
)
expectTypeOf(configuredResponse).toEqualTypeOf<Promise<Response>>()

const asynchronousConfiguredResponse = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  configuredProgram,
  {
    onSuccess: async ({ value }) => {
      expectTypeOf(value).toEqualTypeOf<string>()
      return new Response(value, { status: 201 })
    },
    onFailure: async (error: ExpectedFailure) => {
      expectTypeOf(error).toEqualTypeOf<ExpectedFailure>()
      return new Response('failure', { status: 422 })
    }
  }
)
expectTypeOf(asynchronousConfiguredResponse).toEqualTypeOf<Promise<Response>>()

const invalidPolicyResponse = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  configuredProgram,
  // @ts-expect-error Response policies must return a standard Response.
  {
    onSuccess: () => ({})
  }
)
void invalidPolicyResponse

const missingProgram = Effect.fn(async function* () {
  const missing = yield* Missing
  return Result.ok(missing)
})

const invalidExecutorProgram = WebEffect.handleWith(
  executor,
  new Request('https://example.test'),
  // @ts-expect-error Executor WebEffect Programs cannot require a Service absent from the root/request Layers.
  missingProgram
)
void invalidExecutorProgram

const invalidProgram = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  // @ts-expect-error WebEffect Programs cannot require a Service absent from the root/request Layers.
  missingProgram
)
void invalidProgram

const requestNeedsMissing = Layer.gen(RequestValue, async function* () {
  yield* Missing
  return new RequestValue('missing')
})

const invalidRequestLayer = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('ok')
  }),
  // @ts-expect-error Request Layer external requirements must be provided by the Runtime.
  { requestLayer: () => requestNeedsMissing }
)
void invalidRequestLayer

const unexpectedFailureProgram = Effect.fn(async function* () {
  yield* Result.await(Promise.resolve(Result.ok(undefined)))
  return Result.err(new UnexpectedFailure())
})
expectTypeOf<EffectError<typeof unexpectedFailureProgram>>().toEqualTypeOf<UnexpectedFailure>()

const expectedFailurePolicy: WebEffectOptions<ExpectedFailure> = {
  onFailure: (error) => new Response(error.message)
}
const invalidFailure = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  unexpectedFailureProgram,
  // @ts-expect-error The typed failure channel must fit the configured Web failure policy.
  expectedFailurePolicy
)
void invalidFailure
const explicitInvalidFailure = WebEffect.handleWith<
  Available,
  typeof unexpectedFailureProgram,
  UnexpectedFailure
>(
  runtime.executor,
  new Request('https://example.test'),
  unexpectedFailureProgram,
  // @ts-expect-error Explicitly selecting the unexpected failure channel also rejects the narrower policy.
  expectedFailurePolicy
)
void explicitInvalidFailure

const erasedRequestLayer: Layer.Any = Layer.succeed(RequestValue, new RequestValue('unchecked'))
const unchecked = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    const value = yield* RequestValue
    return Result.ok(value)
  }),
  { requestLayer: () => erasedRequestLayer }
)
void unchecked

// SAFETY: This declaration-only fixture models a partially erased Layer.
const partialRequestLayer = {} as Layer<any, never>
const invalidPartial = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('invalid')
  }),
  // @ts-expect-error A partially erased request Layer is not an unchecked escape hatch.
  { requestLayer: () => partialRequestLayer }
)
void invalidPartial

const requestLayerUnion =
  Math.random() > 0.5 ? requestLayer : Layer.succeed(OtherRequestValue, new OtherRequestValue())
const invalidUnion = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('invalid')
  }),
  // @ts-expect-error Concrete request Layer unions must be narrowed before the Web boundary.
  { requestLayer: () => requestLayerUnion }
)
void invalidUnion

class IncompatibleCurrentRequest extends Service<IncompatibleCurrentRequest>()('CurrentRequest') {}
const incompatibleCurrentRequest = Layer.succeed(
  IncompatibleCurrentRequest,
  new IncompatibleCurrentRequest()
)

const invalidOverride = WebEffect.handleWith(
  runtime.executor,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('invalid')
  }),
  // @ts-expect-error Same-tag request overrides must remain contract-compatible.
  { requestLayer: () => incompatibleCurrentRequest }
)
void invalidOverride

const compatibleRootOverride = WebEffect.handleWith(
  rootBoundaryRuntime.executor,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    const service = yield* RootBoundaryService
    return Result.ok(service.value())
  }),
  {
    requestLayer: () => Layer.succeed(CompatibleRootBoundary, new CompatibleRootBoundary())
  }
)
void compatibleRootOverride

const invalidRootOverride = WebEffect.handleWith(
  rootBoundaryRuntime.executor,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('invalid')
  }),
  // @ts-expect-error Request overrides must also be compatible with same-tag root Runtime providers.
  {
    requestLayer: () => Layer.succeed(IncompatibleRootBoundary, new IncompatibleRootBoundary())
  }
)
void invalidRootOverride
