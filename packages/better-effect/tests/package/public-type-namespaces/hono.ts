import { Result } from 'better-result'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { validator } from 'hono/validator'

import { Effect, Layer, Service } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'

class Available extends Service<Available>()('PackageHonoAvailable') {}
class RequestValue extends Service<RequestValue>()('PackageHonoRequestValue') {}
class Failure extends Error {
  readonly _tag = 'PackageHonoFailure' as const
}

type RouteEnv = {
  readonly Bindings: {
    readonly API_KEY: string
  }
  readonly Variables: {
    readonly user: {
      readonly id: string
    }
  }
}
type RoutePath = '/items/:id'

const requestLayer = Layer.succeed(RequestValue, new RequestValue())
const App = HonoEffect.app(
  '@package/HonoApp',
  {
    requestLayer: (context) => {
      const requestPath: string = context.req.path
      void requestPath
      return requestLayer
    },
    onSuccess: ({ value }, context) => context.json({ data: value }),
    onFailure: (error: Failure, context) => context.json({ error: error.message }, 422)
  },
  async function* (http) {
    const validateJson = validator('json', (value: { name?: string } | null) => ({
      name: value?.name ?? 'anonymous'
    }))
    const routeMiddleware: MiddlewareHandler<RouteEnv, RoutePath> = async (context, next) => {
      const apiKey: string = context.env.API_KEY
      const userId: string = context.get('user').id
      void apiKey
      void userId
      await next()
    }

    const route = yield* http.gen(validateJson, routeMiddleware, async function* (context) {
      const name: string = context.req.valid('json').name
      const id: string = context.req.param('id')
      const available = yield* Available
      const requestValue = yield* RequestValue

      return Result.ok({ id, name, available, requestValue })
    })

    const handler = yield* http.handler(validateJson, (context) => {
      const name: string = context.req.valid('json').name
      return Effect.fn(async function* () {
        yield* Available
        return Result.ok(name)
      })
    })

    const guard = yield* http.guard(async function* () {
      yield* Result.await(Promise.resolve(Result.ok(undefined)))
      return Result.ok()
    })

    const app = new Hono<RouteEnv>()
    app.get('/items/:id', route)
    void handler
    void guard
    return app
  }
)

type AppRoute = Hono<RouteEnv>
// SAFETY: This fixture uses an erased app value only to keep the public namespace import live.
const app = {} as AppRoute
void App
void app
