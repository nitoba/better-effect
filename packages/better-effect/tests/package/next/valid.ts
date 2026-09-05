import { Result } from 'better-result'

import { Layer, Service } from 'better-effect'
import { NextEffect } from 'better-effect/next'

class RootService extends Service<RootService>()('PackedNextRoot') {
  value(): string {
    return 'root'
  }
}

class RequestService extends Service<RequestService>()('PackedNextRequest') {
  constructor(readonly value: string) {
    super()
  }
}

class Failure extends Error {
  readonly _tag = 'PackedNextFailure' as const
}

type Context = NextEffect.Context<{ readonly id: string }>
const requestLayer = Layer.succeed(RequestService, new RequestService('request'))
const appLayer = Layer.make(RootService)
const http = NextEffect.managed<typeof appLayer, Failure, typeof requestLayer, Context>(appLayer, {
  requestLayer: (_request, context) => {
    const params: Promise<{ readonly id: string }> = context.params
    void params
    return requestLayer
  },
  onFailure: (error, request, context) => {
    const typed: Failure = error
    const native: Request = request
    const routeContext: Context = context
    void typed
    void native
    void routeContext
    return new Response('failed', { status: 500 })
  }
})

const handler = http.gen(
  async function* (request, context) {
    const root = yield* RootService
    const local = yield* RequestService
    const { id } = await context.params
    const url: string = request.url

    return Result.ok({ id, url, value: `${root.value()}:${local.value}` })
  },
  {
    serialize: (value, request, context) => {
      void context
      return { ...value, method: request.method }
    }
  }
)

const expected: NextEffect.Handler<Context> = handler
void expected
