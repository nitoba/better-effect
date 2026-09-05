import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { Effect, Layer, Service } from '../../src'
import type { EffectRequirements } from '../../src/effect'
import { NextEffect } from '../../src/next'
import type {
  CompleteNextProgram,
  NextEffectContext,
  NextEffectManagedOptions,
  NextEffectOptions,
  NextEffectRouteOptions,
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

const appLayer = Layer.make(RootService)
const requestLayer = Layer.gen(RequestService, async function* () {
  const root = yield* RootService
  return new RequestService(root.value())
})

const managed = NextEffect.managed<
  typeof appLayer,
  ExpectedFailure,
  typeof requestLayer,
  RouteContext
>(appLayer, {
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
})

const successProgram = Effect.fn(async function* () {
  const root = yield* RootService
  const request = yield* RequestService
  return Result.ok({ root: root.value(), request: request.value })
})

const managedHandler = managed.handler(
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
expectTypeOf(managedHandler).toEqualTypeOf<NextRouteHandler<RouteContext>>()

const responseHandler = managed.handler(
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

const generatedHandler = managed.gen(async function* (request, context) {
  const { id } = await context.params
  const requestValue = yield* RequestService
  expectTypeOf(request).toEqualTypeOf<Request>()
  expectTypeOf(requestValue).toEqualTypeOf<RequestService>()
  return Result.ok({ id, request: requestValue.value })
})
expectTypeOf(generatedHandler).toEqualTypeOf<NextRouteHandler<RouteContext>>()

const current = NextEffect.fromCurrent<ExpectedFailure, typeof requestLayer, RouteContext>({
  requestLayer: () => requestLayer,
  onFailure: (error, request, context) => {
    expectTypeOf(error).toEqualTypeOf<ExpectedFailure>()
    expectTypeOf(request).toEqualTypeOf<Request>()
    expectTypeOf(context).toEqualTypeOf<RouteContext>()
    return new Response(error.message)
  }
})

const embeddedProgram = Effect.fn(async function* () {
  const root = yield* RootService
  const request = yield* RequestService
  return Result.ok(`${root.value()}:${request.value}`)
})
const embeddedMaterialized = current.handler(() => embeddedProgram)
const embeddedOuter = Effect.fn(async function* () {
  const handler = yield* embeddedMaterialized
  return Result.ok(handler)
})
expectTypeOf<EffectRequirements<typeof embeddedOuter>>().toEqualTypeOf<RootService>()

const currentGenerated = current.gen(async function* () {
  const root = yield* RootService
  return Result.ok(root.value())
})
const currentOuter = Effect.fn(async function* () {
  return Result.ok(yield* currentGenerated)
})
expectTypeOf<EffectRequirements<typeof currentOuter>>().toEqualTypeOf<RootService>()

const missingProgram = Effect.fn(async function* () {
  const missing = yield* MissingService
  return Result.ok(missing)
})
expectTypeOf<EffectRequirements<typeof missingProgram>>().toEqualTypeOf<MissingService>()

// @ts-expect-error Managed route Programs cannot require a Service absent from the Layer/request Layers.
const invalidManagedProgram = managed.handler(() => missingProgram)
void invalidManagedProgram

const invalidFailureProgram = Effect.fn(async function* () {
  yield* Result.await(Promise.resolve(Result.ok(undefined)))
  return Result.err(new UnexpectedFailure())
})

// @ts-expect-error The Program Failure channel must fit the configured failure policy.
const invalidFailure = managed.handler(() => invalidFailureProgram)
void invalidFailure

const responsePolicy = () => new Response('ok')
const serializePolicy = () => null
const conflictingRespondSerialize = {
  respond: responsePolicy,
  serialize: serializePolicy
}
const conflictingRespondOnSuccess = {
  respond: responsePolicy,
  onSuccess: responsePolicy
}
const conflictingSerializeOnSuccess = {
  serialize: serializePolicy,
  onSuccess: responsePolicy
}
// @ts-expect-error Route success policies are mutually exclusive.
const invalidRespondSerialize: NextEffectRouteOptions<string, RouteContext> =
  conflictingRespondSerialize
// @ts-expect-error Route success policies are mutually exclusive.
const invalidRespondOnSuccess: NextEffectRouteOptions<string, RouteContext> =
  conflictingRespondOnSuccess
// @ts-expect-error Route success policies are mutually exclusive.
const invalidSerializeOnSuccess: NextEffectRouteOptions<string, RouteContext> =
  conflictingSerializeOnSuccess
void invalidRespondSerialize
void invalidRespondOnSuccess
void invalidSerializeOnSuccess

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

const managedOptions: NextEffectManagedOptions<ExpectedFailure, typeof requestLayer, RouteContext> =
  {
    ...options,
    runtime: { warmup: true }
  }
void managedOptions

const incomplete = NextEffect.managed(
  // @ts-expect-error Concrete Layer completeness is enforced by managed construction.
  Layer.gen(RequestService, async function* () {
    const root = yield* RootService
    return new RequestService(root.value())
  })
)
void incomplete

const uncheckedLayer: Layer.Any = requestLayer
const uncheckedCurrent = NextEffect.fromCurrent({ requestLayer: () => uncheckedLayer })
void uncheckedCurrent

const complete: CompleteNextProgram<RootService, typeof requestLayer, typeof successProgram> =
  successProgram
void complete
