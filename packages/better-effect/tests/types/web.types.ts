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

// SAFETY: This declaration-only fixture never executes a Runtime.
const runtime = {} as Runtime<Available>

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

const response = WebEffect.handle(runtime, new Request('https://example.test'), program, {
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
})

expectTypeOf(response).toEqualTypeOf<Promise<Response>>()

const failureProgram = Effect.fn(async function* () {
  yield* Result.await(Promise.resolve(Result.ok(undefined)))
  return Result.err(new ExpectedFailure())
})

const failureResponse = WebEffect.handle(
  runtime,
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

const configuredResponse = WebEffect.handle(
  runtime,
  new Request('https://example.test'),
  configuredProgram,
  options
)
expectTypeOf(configuredResponse).toEqualTypeOf<Promise<Response>>()

const missingProgram = Effect.fn(async function* () {
  const missing = yield* Missing
  return Result.ok(missing)
})

const invalidProgram = WebEffect.handle(
  runtime,
  new Request('https://example.test'),
  // @ts-expect-error WebEffect Programs cannot require a Service absent from the root/request Layers.
  missingProgram
)
void invalidProgram

const requestNeedsMissing = Layer.gen(RequestValue, async function* () {
  yield* Missing
  return new RequestValue('missing')
})

// @ts-expect-error Request Layer external requirements must be provided by the Runtime.
const invalidRequestLayer = WebEffect.handle(
  runtime,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('ok')
  }),
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
const invalidFailure = WebEffect.handle(
  runtime,
  new Request('https://example.test'),
  unexpectedFailureProgram,
  // @ts-expect-error The typed failure channel must fit the configured Web failure policy.
  expectedFailurePolicy
)
void invalidFailure
const explicitInvalidFailure = WebEffect.handle<
  Available,
  typeof unexpectedFailureProgram,
  UnexpectedFailure
>(
  runtime,
  new Request('https://example.test'),
  unexpectedFailureProgram,
  // @ts-expect-error Explicitly selecting the unexpected failure channel also rejects the narrower policy.
  expectedFailurePolicy
)
void explicitInvalidFailure

const erasedRequestLayer: Layer.Any = Layer.succeed(RequestValue, new RequestValue('unchecked'))
const unchecked = WebEffect.handle(
  runtime,
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
// @ts-expect-error A partially erased request Layer is not an unchecked escape hatch.
const invalidPartial = WebEffect.handle(
  runtime,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('invalid')
  }),
  { requestLayer: () => partialRequestLayer }
)
void invalidPartial

const requestLayerUnion =
  Math.random() > 0.5 ? requestLayer : Layer.succeed(OtherRequestValue, new OtherRequestValue())
// @ts-expect-error Concrete request Layer unions must be narrowed before the Web boundary.
const invalidUnion = WebEffect.handle(
  runtime,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('invalid')
  }),
  { requestLayer: () => requestLayerUnion }
)
void invalidUnion

class IncompatibleCurrentRequest extends Service<IncompatibleCurrentRequest>()('CurrentRequest') {}
const incompatibleCurrentRequest = Layer.succeed(
  IncompatibleCurrentRequest,
  new IncompatibleCurrentRequest()
)

// @ts-expect-error Same-tag request overrides must remain contract-compatible.
const invalidOverride = WebEffect.handle(
  runtime,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('invalid')
  }),
  { requestLayer: () => incompatibleCurrentRequest }
)
void invalidOverride
