import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { Effect, Layer, Runtime, Service } from '../../src'
import type { EffectRequirements } from '../../src/effect'
import { NextEffect } from '../../src/next'
import type {
  CompleteNextProgram,
  NextEffectContext,
  NextEffectOptions,
  NextRouteHandler
} from '../../src/next/types'

class RootService extends Service<RootService>()('NextTypeRoot') {
  value(): string {
    return 'root'
  }
}

class RequestService extends Service<RequestService>()('NextTypeRequest') {
  constructor(readonly value: string) {
    super()
  }
}

class MissingService extends Service<MissingService>()('NextTypeMissing') {}
class ExpectedFailure extends Error {
  readonly _tag = 'ExpectedFailure' as const
}
class UnexpectedFailure extends Error {
  readonly _tag = 'UnexpectedFailure' as const
}

type RouteContext = NextEffectContext<{ readonly id: string }>

// SAFETY: This declaration-only fixture never executes a Runtime.
const runtime = {} as Runtime<RootService>

const requestLayer = Layer.gen(RequestService, async function* () {
  const root = yield* RootService
  return new RequestService(root.value())
})

const http = NextEffect.make<RootService, ExpectedFailure, typeof requestLayer, RouteContext>(
  runtime,
  {
    requestLayer: (request, context) => {
      expectTypeOf(request).toEqualTypeOf<Request>()
      expectTypeOf(context).toEqualTypeOf<RouteContext>()
      return requestLayer
    },
    onFailure: (error, request, context) => {
      expectTypeOf(error).toEqualTypeOf<ExpectedFailure>()
      expectTypeOf(request).toEqualTypeOf<Request>()
      expectTypeOf(context).toEqualTypeOf<RouteContext>()
      return new Response(error.message, { status: 422 })
    }
  }
)

const successProgram = Effect.fn(async function* () {
  const root = yield* RootService
  const request = yield* RequestService
  return Result.ok({ root: root.value(), request: request.value })
})

const handler = http.handler(
  (request, context) => {
    expectTypeOf(request).toEqualTypeOf<Request>()
    expectTypeOf(context.params).toEqualTypeOf<Promise<{ readonly id: string }>>()
    return successProgram
  },
  {
    serialize: (value, request, context) => {
      expectTypeOf(value).toEqualTypeOf<{ root: string; request: string }>()
      expectTypeOf(request).toEqualTypeOf<Request>()
      expectTypeOf(context).toEqualTypeOf<RouteContext>()
      return { ...value, id: 'serialized' }
    }
  }
)
expectTypeOf(handler).toEqualTypeOf<NextRouteHandler<RouteContext>>()

const contextInferredHandler = NextEffect.make<RootService>(runtime).handler(
  (_request, context: RouteContext) =>
    Effect.fn(async function* () {
      const { id } = await context.params
      yield* Result.await(Promise.resolve(Result.ok(undefined)))
      return Result.ok(id)
    })
)
expectTypeOf(contextInferredHandler).toEqualTypeOf<NextRouteHandler<RouteContext>>()

const responseHandler = http.handler(
  () =>
    Effect.fn(async function* () {
      yield* Result.await(Promise.resolve(Result.ok(undefined)))
      return Result.ok(new Response('ok'))
    }),
  {
    respond: (value, request, context) => {
      expectTypeOf(value).toEqualTypeOf<Response>()
      expectTypeOf(request).toEqualTypeOf<Request>()
      expectTypeOf(context).toEqualTypeOf<RouteContext>()
      return value
    }
  }
)
expectTypeOf(responseHandler).toEqualTypeOf<NextRouteHandler<RouteContext>>()

const generatorHandler = http.gen(async function* (request, context) {
  const { id } = await context.params
  const requestValue = yield* RequestService
  expectTypeOf(request).toEqualTypeOf<Request>()
  expectTypeOf(requestValue).toEqualTypeOf<RequestService>()
  return Result.ok({ id, request: requestValue.value })
})
expectTypeOf(generatorHandler).toEqualTypeOf<NextRouteHandler<RouteContext>>()

const options: NextEffectOptions<ExpectedFailure, typeof requestLayer, RouteContext> = {
  requestLayer: () => requestLayer,
  onSuccess: ({ value }, request, context) => {
    expectTypeOf(value).toEqualTypeOf<unknown>()
    expectTypeOf(request).toEqualTypeOf<Request>()
    expectTypeOf(context).toEqualTypeOf<RouteContext>()
    return new Response('ok')
  },
  onFailure: (error) => new Response(error.message)
}
void options

const missingProgram = Effect.fn(async function* () {
  const missing = yield* MissingService
  return Result.ok(missing)
})
expectTypeOf<EffectRequirements<typeof missingProgram>>().toEqualTypeOf<MissingService>()
// @ts-expect-error The checked Program type carries its missing dependency diagnostic.
const checkedMissing: CompleteNextProgram<RootService, typeof requestLayer, typeof missingProgram> =
  missingProgram
void checkedMissing

// @ts-expect-error Route Programs cannot require a Service absent from the Runtime/request Layers.
const invalidProgram = http.handler(() => missingProgram)
void invalidProgram

const invalidFailureProgram = Effect.fn(async function* () {
  yield* Result.await(Promise.resolve(Result.ok(undefined)))
  return Result.err(new UnexpectedFailure())
})

// @ts-expect-error The Program Failure channel must fit the configured failure policy.
const invalidFailure = http.handler(() => invalidFailureProgram)
void invalidFailure

const invalidResponse = http.handler(() => successProgram, {
  // @ts-expect-error Success policies must return a native Response.
  respond: () => ({})
})
void invalidResponse

// SAFETY: This declaration-only fixture models the explicit unchecked Layer escape hatch.
const uncheckedLayer: Layer.Any = requestLayer
const uncheckedHttp = NextEffect.make<RootService, unknown, Layer.Any, RouteContext>(runtime, {
  requestLayer: () => uncheckedLayer
})
void uncheckedHttp
