import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'
import { Hono } from 'hono'
import type { Handler, MiddlewareHandler } from 'hono'
import { validator } from 'hono/validator'

import { Effect, Layer, Runtime, Service } from '../../src'
import type { EffectError } from '../../src/effect'
import { HonoEffect } from '../../src/hono'
import type {
  HonoEffectOperation,
  HonoEffectContext,
  HonoEffectOptions,
  MiddlewareInputs
} from '../../src/hono/types'
import { CurrentRequest } from '../../src/standard-services'

class Available extends Service<Available>()('@types/HonoAvailable') {}
class Other extends Service<Other>()('@types/HonoOther') {}
class Missing extends Service<Missing>()('@types/HonoMissing') {}
class RequestValue extends Service<RequestValue>()('@types/HonoRequestValue') {}

class RouteFailure extends Error {
  readonly _tag = 'RouteFailure' as const
}

class OtherFailure extends Error {
  readonly _tag = 'OtherFailure' as const
}

const requestLayer = Layer.succeed(RequestValue, new RequestValue())
const rootRequestLayer = Layer.gen(RequestValue, async function* () {
  yield* Available
  return new RequestValue()
})

const validateJson = validator('json', (value: { name?: string } | null) => ({
  name: value?.name ?? 'anonymous'
}))

type RouteEnv = {
  readonly Bindings: { readonly API_KEY: string }
  readonly Variables: { readonly user: { readonly id: string } }
}

type RoutePath = '/work-orders/:id'

const environmentMiddleware: MiddlewareHandler<RouteEnv, RoutePath> = async (context, next) => {
  expectTypeOf(context.env.API_KEY).toEqualTypeOf<string>()
  expectTypeOf(context.get('user')).toEqualTypeOf<{ readonly id: string }>()
  await next()
}

// The app factory receives a builder; no Runtime is needed at the composition site.
const appOptions = {
  requestLayer: () => requestLayer,
  onFailure: (error: RouteFailure) => new Response(error.message, { status: 400 })
} satisfies HonoEffectOptions<RouteFailure, typeof requestLayer>

const App = HonoEffect.app('@types/HonoApp', appOptions, async function* (http) {
  const app = new Hono<RouteEnv>()
  app.use('*', yield* http.middleware())

  const first = yield* http.gen(validateJson, environmentMiddleware, async function* (context) {
    const name: string = context.req.valid('json').name
    const id: string = context.req.param('id')
    const current = yield* CurrentRequest
    const requestValue = yield* RequestValue
    const available = yield* Available

    void current
    return Result.ok({ id, name, requestValue, available })
  })

  const second = yield* http.handler((context: HonoEffectContext<RouteEnv, RoutePath, {}>) =>
    Effect.fn(async function* () {
      const other = yield* Other
      void other
      return Result.ok(context.req.path)
    })
  )

  app.post('/work-orders/:id', first)
  app.get('/other', second)
  return app
})

type AppRequirements = Layer.Required<typeof App.layer>
expectTypeOf<AppRequirements>().toEqualTypeOf<Available | Other>()
expectTypeOf<Layer.Provided<typeof App.layer>>().toMatchTypeOf<InstanceType<typeof App>>()
expectTypeOf(App).toHaveProperty('layer')

const concreteRoot = Layer.merge(
  Layer.succeed(Available, new Available()),
  Layer.succeed(Other, new Other()),
  App.layer
)
// SAFETY: This declaration fixture models the Runtime type inferred from the composed Layer.
const runtime = {} as Runtime<Available | Other | InstanceType<typeof App>>
void Runtime.make(concreteRoot)
void runtime

// SAFETY: This declaration fixture supplies the operation's public phantom requirements explicitly.
const operation = {} as HonoEffectOperation<string, Available>
expectTypeOf(operation[Symbol.iterator]).toMatchTypeOf<() => Generator<any, string, unknown>>()
expectTypeOf(operation[Symbol.asyncIterator]).toMatchTypeOf<
  () => AsyncGenerator<any, string, unknown>
>()

const CustomApplication = class CustomApplication extends Service<CustomApplication>()(
  '@types/CustomApplication'
) {
  declare readonly app: Hono
}

const customLayer = HonoEffect.layer(
  CustomApplication,
  { requestLayer: () => requestLayer },
  async function* (http) {
    const app = new Hono()
    app.use('*', yield* http.middleware())
    return CustomApplication.of({ app })
  }
)

expectTypeOf<Layer.Provided<typeof customLayer>>().toEqualTypeOf<
  InstanceType<typeof CustomApplication>
>()
expectTypeOf<Layer.Required<typeof customLayer>>().toBeNever()

// @ts-expect-error HonoEffect.layer must return the contract of its Service token.
// oxlint-disable-next-line require-yield -- this negative fixture keeps the generator-shaped factory API.
HonoEffect.layer(CustomApplication, {}, async function* () {
  return {}
})

const rootDependentApp = HonoEffect.app(
  '@types/RootDependentApp',
  {
    requestLayer: () => rootRequestLayer
  },
  async function* (http) {
    const app = new Hono()
    app.use('*', yield* http.middleware())
    return app
  }
)

expectTypeOf<Layer.Required<typeof rootDependentApp.layer>>().toEqualTypeOf<Available>()

const invalidServiceApp = HonoEffect.app('@types/MissingApp', {}, async function* (http) {
  const app = new Hono()
  app.use(
    '*',
    yield* http.gen(
      // oxlint-disable-next-line require-yield -- this fixture keeps the generator-shaped route API.
      async function* () {
        const missing = yield* Missing
        return Result.ok(missing)
      }
    )
  )
  return app
})

expectTypeOf<Layer.Required<typeof invalidServiceApp.layer>>().toEqualTypeOf<Missing>()
// @ts-expect-error Runtime.make enforces the app Layer's missing root Service.
void Runtime.make(invalidServiceApp.layer)

const failureOptions = {
  onFailure: (error: RouteFailure) => new Response(error.message)
} satisfies HonoEffectOptions<RouteFailure>

const failureApp = HonoEffect.app('@types/FailureApp', failureOptions, async function* (http) {
  const app = new Hono()
  app.use('*', yield* http.middleware())
  app.get(
    '/',
    yield* http.gen(
      // oxlint-disable-next-line require-yield -- this fixture keeps the generator-shaped route API.
      async function* () {
        return Result.ok('ok')
      }
    )
  )
  return app
})

const invalidFailure = HonoEffect.app(
  '@types/InvalidFailureApp',
  failureOptions,
  async function* (http) {
    const app = new Hono()
    app.use('*', yield* http.middleware())
    app.get(
      '/',
      yield* http.gen(
        // @ts-expect-error The route failure must be accepted by onFailure.
        // oxlint-disable-next-line require-yield -- this negative fixture keeps the generator-shaped route API.
        async function* () {
          return Result.err(new OtherFailure())
        }
      )
    )
    return app
  }
)
void failureApp
void invalidFailure

const validated = HonoEffect.app('@types/ValidatedApp', {}, async function* (http) {
  const app = new Hono<RouteEnv>()
  app.use('*', yield* http.middleware())
  const route = yield* http.gen(
    validateJson,
    environmentMiddleware,
    // oxlint-disable-next-line require-yield -- this fixture keeps the generator-shaped route API.
    async function* (context) {
      const name: string = context.req.valid('json').name
      return Result.ok(name)
    }
  )
  expectTypeOf(route).toEqualTypeOf<
    Handler<
      RouteEnv,
      RoutePath,
      MiddlewareInputs<[typeof validateJson, typeof environmentMiddleware]>,
      Promise<Response>
    >
  >()
  app.post('/work-orders/:id', route)
  return app
})
void validated

const program = Effect.fn(async function* () {
  yield* Other
  return Result.err(new OtherFailure())
})
expectTypeOf<EffectError<typeof program>>().toEqualTypeOf<OtherFailure>()
// @ts-expect-error Runtime-first HonoEffect.make was removed from the public API.
void HonoEffect.make

// @ts-expect-error HonoEffect.app factories must be sync or async generators.
HonoEffect.app('@types/InvalidFactory', {}, () => new Hono())
