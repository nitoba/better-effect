import { Result } from 'better-result'
import { Hono } from 'hono'
import { validator } from 'hono/validator'

import { Effect, Layer, Runtime, Service } from '../../src'
import { HonoEffect } from '../../src/hono'
import { CurrentRequest } from '../../src/standard-services'

class Available extends Service<Available>()('HonoAvailable') {}
class Missing extends Service<Missing>()('HonoMissing') {}
class RouteFailure extends Error {
  readonly _tag = 'RouteFailure' as const
}
class OtherFailure extends Error {
  readonly _tag = 'OtherFailure' as const
}
class RequestId extends Service<RequestId>()('HonoRequestId') {}
class AnotherRequestId extends Service<AnotherRequestId>()('HonoAnotherRequestId') {}

// SAFETY: This declaration-only fixture never executes the Runtime.
const runtime = {} as Runtime<Available>
const http = HonoEffect.make<Available, RouteFailure>(runtime, {
  onFailure: (error) => new Response(error.message, { status: 400 })
})

const valid = http.gen(async function* () {
  const available = yield* Available
  return Result.ok(available)
})

void valid

const permissive = HonoEffect.make<Available>(runtime).gen(async function* () {
  yield* Result.await(Promise.resolve(Result.ok(undefined)))
  return Result.err(new OtherFailure())
})

void permissive

const invalidFailure = http.gen(
  // @ts-expect-error Hono routes reject an error outside the configured Failure union.
  async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.err(new OtherFailure())
  }
)

void invalidFailure

const invalidFailureHandler = http.handler(() =>
  // @ts-expect-error The private diagnostic is attached at the Program boundary.
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.err(new OtherFailure())
  })
)

void invalidFailureHandler

const invalidFailureGuard = http.guard(
  // @ts-expect-error Hono guards reject an error outside the configured Failure union.
  async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.err(new OtherFailure())
  }
)

void invalidFailureGuard

// @ts-expect-error Hono routes cannot require a Service absent from the Runtime Layer.
const invalidService = http.gen(async function* () {
  const missing = yield* Missing
  return Result.ok(missing)
})

void invalidService

const invalidHandler = http.handler(() =>
  // @ts-expect-error Handler Programs use the same Runtime requirement check as gen.
  Effect.fn(async function* () {
    const missing = yield* Missing
    return Result.ok(missing)
  })
)

void invalidHandler

const requestHttp = HonoEffect.make(runtime, {
  requestLayer: () => Layer.succeed(RequestId, new RequestId())
})

const requestLocal = requestHttp.gen(async function* () {
  const requestId = yield* RequestId
  return Result.ok(requestId)
})

void requestLocal

const requestNeedsCurrentRequest = Layer.gen(RequestId, async function* () {
  const currentRequest = yield* CurrentRequest

  void currentRequest
  return new RequestId()
})

void requestNeedsCurrentRequest

const currentRequestLayerHttp = HonoEffect.make(runtime, {
  requestLayer: () => requestNeedsCurrentRequest
})

void currentRequestLayerHttp

const requestWithMissing = Layer.gen(RequestId, async function* () {
  yield* Missing
  return new RequestId()
})

// @ts-expect-error Request Layer requirements must be supplied by the Runtime Layer.
const invalidRequestLayer = HonoEffect.make(runtime, {
  requestLayer: () => requestWithMissing
})

void invalidRequestLayer

class IncompatibleCurrentRequest extends Service<IncompatibleCurrentRequest>()('CurrentRequest') {}

const incompatibleCurrentRequest = Layer.succeed(
  IncompatibleCurrentRequest,
  new IncompatibleCurrentRequest()
)

// @ts-expect-error Same-tag request overrides must remain contract-compatible.
const invalidRequestOverride = HonoEffect.make(runtime, {
  requestLayer: () => incompatibleCurrentRequest
})

void invalidRequestOverride

const erasedRequestLayer: Layer.Any = Layer.succeed(RequestId, new RequestId())
const uncheckedRequestLayer = HonoEffect.make(runtime, {
  requestLayer: () => erasedRequestLayer
})

void uncheckedRequestLayer

declare const partialRequestLayer: Layer<any, never>

// @ts-expect-error A partially erased request Layer is not an unchecked escape hatch.
const invalidPartialRequestLayer = HonoEffect.make(runtime, {
  requestLayer: () => partialRequestLayer
})

void invalidPartialRequestLayer

const requestLayerUnion =
  Math.random() > 0.5
    ? Layer.succeed(RequestId, new RequestId())
    : Layer.succeed(AnotherRequestId, new AnotherRequestId())

// @ts-expect-error Concrete request Layer unions must be resolved before the boundary.
const invalidRequestLayerUnion = HonoEffect.make(runtime, {
  requestLayer: () => requestLayerUnion
})

void invalidRequestLayerUnion

const validateJson = validator('json', (value: { name?: string } | null) => {
  if (value?.name === undefined) {
    return new Response('invalid', { status: 400 })
  }

  return { name: value.name }
})

const validatedGenerator = http.gen(validateJson, async function* (c) {
  const input = c.req.valid('json')
  const name: string = input.name
  const available = yield* Available

  void available
  return Result.ok(name)
})

void validatedGenerator

// @ts-expect-error Validation-aware handlers keep the Runtime requirement check.
const invalidValidatedGenerator = http.gen(validateJson, async function* () {
  const missing = yield* Missing
  return Result.ok(missing)
})

void invalidValidatedGenerator

const validatedHandler = http.handler(validateJson, (c) => {
  const input = c.req.valid('json')
  const name: string = input.name

  return Effect.fn(async function* () {
    yield* Available
    return Result.ok(name)
  })
})

void validatedHandler

const validateParam = validator('param', (value: { id?: string }) => {
  if (value.id === undefined) {
    return new Response('invalid')
  }

  return { id: value.id }
})

const validateHeader = validator('header', (value: Record<string, string>) => {
  const key = value['x-idempotency-key']

  if (key === undefined) {
    return new Response('invalid')
  }

  return { 'X-Idempotency-Key': key }
})

const combinedApp = new Hono()
combinedApp.post(
  '/api/v1/inspections/:id/check-ins',
  http.gen(validateParam, validateHeader, validateJson, async function* (c) {
    const rawId: string = c.req.param('id')
    const rawKey: string = c.req.header('X-Idempotency-Key')
    const id: string = c.req.valid('param').id
    const key: string = c.req.valid('header')['X-Idempotency-Key']
    const body = c.req.valid('json')
    const available = yield* Available

    void available
    return Result.ok({ rawId, rawKey, id, key, body })
  })
)

const combinedHandler = http.handler(validateParam, validateHeader, (c) => {
  const id: string = c.req.valid('param').id
  const key: string = c.req.valid('header')['X-Idempotency-Key']

  return Effect.fn(async function* () {
    yield* Available
    return Result.ok(`${id}:${key}`)
  })
})

void combinedHandler
