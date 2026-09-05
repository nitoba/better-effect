import { expectTypeOf } from 'bun:test'
import { betterAuth } from 'better-auth'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError } from 'better-auth/api'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import type { AnyService } from 'better-effect'
import { Result, TaggedError } from 'better-result'

import {
  BetterAuthHooks,
  type BetterAuthHookContext,
  type BetterAuthHookContextValue,
  type BetterAuthHookFailureResult,
  type BetterAuthHookSuccess,
  type BetterAuthMiddleware,
  type BetterAuthMiddlewareContext
} from '../../src/hooks'

import { BetterAuth } from '../../src'

import type { Assert, Equal, IsAny, IsAssignable } from '../package/public-types/assert'

class Policy extends Service<Policy>()('@types/Policy') {}
class MissingService extends Service<MissingService>()('@types/MissingService') {}
class RequestMetadata extends Service<RequestMetadata>()('@types/RequestMetadata') {
  readonly requestId!: string
}
class MissingLayerService extends Service<MissingLayerService>()('@types/MissingLayerService') {}

class Denied extends TaggedError('@types/Denied')<{
  readonly message: string
}> {}

type PolicyInstance = InstanceType<typeof Policy>
type Provided = PolicyInstance

declare const runtime: Runtime<Provided>
const Hooks = BetterAuthHooks.make('@types/HookContext', runtime)

const DefinedHooks = BetterAuthHooks.define('@types/DefinedHookContext')

const DefinedAuth = BetterAuth.make('@types/DefinedAuth', async function* () {
  const middleware = yield* DefinedHooks.gen(async function* () {
    const hook = yield* DefinedHooks.Context
    const policy = yield* Policy

    expectTypeOf(hook.context).toEqualTypeOf<BetterAuthMiddlewareContext>()
    expectTypeOf(policy).toEqualTypeOf<PolicyInstance>()

    return Result.ok()
  })

  return betterAuth({ hooks: { before: middleware } })
})

expectTypeOf<Layer.Required<typeof DefinedAuth.layer>>().toEqualTypeOf<PolicyInstance>()

const DefinedLayerAuth = BetterAuth.make('@types/DefinedLayerAuth', async function* () {
  const middleware = yield* DefinedHooks.gen(
    async function* () {
      const request = yield* RequestMetadata
      const policy = yield* Policy
      return Result.ok({ context: { path: `${policy.constructor.name}:${request.requestId}` } })
    },
    {
      layer: (context) =>
        Layer.gen(RequestMetadata, async function* () {
          const policy = yield* Policy
          return RequestMetadata.of({ requestId: `${context.path}:${policy.constructor.name}` })
        })
    }
  )

  return betterAuth({ hooks: { before: middleware } })
})

expectTypeOf<Layer.Required<typeof DefinedLayerAuth.layer>>().toEqualTypeOf<PolicyInstance>()

const DefinedFailure = DefinedHooks.gen(
  async function* () {
    yield* Policy
    return Result.err(new Denied({ message: 'denied' }))
  },
  {
    onFailure: (failure) => {
      expectTypeOf(failure).toEqualTypeOf<Denied>()
      return new APIError('FORBIDDEN', { code: failure._tag, message: failure.message })
    }
  }
)

expectTypeOf(DefinedFailure).toMatchTypeOf<BetterAuthHooks.Operation<PolicyInstance>>()

// @ts-expect-error Defined builders reject Better Auth-incompatible success values.
DefinedHooks.gen(async function* () {
  yield* []
  return Result.ok(123)
})

const noFailure = Hooks.middleware((context) =>
  Effect.fn(async function* () {
    const hook = yield* Hooks.Context
    const policy = yield* Policy

    expectTypeOf(context).toEqualTypeOf<BetterAuthMiddlewareContext>()
    expectTypeOf(hook).toEqualTypeOf<BetterAuthHookContextValue>()
    expectTypeOf(hook.context).toEqualTypeOf<BetterAuthMiddlewareContext>()
    expectTypeOf(policy).toEqualTypeOf<PolicyInstance>()
    expectTypeOf(context.request).toEqualTypeOf<Request | undefined>()

    return Result.ok()
  })
)

expectTypeOf(noFailure).toMatchTypeOf<BetterAuthMiddleware>()

const layeredMiddleware = Hooks.middleware(
  (context) =>
    Effect.fn(async function* () {
      const metadata = yield* RequestMetadata

      expectTypeOf(context).toEqualTypeOf<BetterAuthMiddlewareContext>()
      expectTypeOf(metadata).toEqualTypeOf<InstanceType<typeof RequestMetadata>>()

      return Result.ok({ context: { path: metadata.requestId } })
    }),
  {
    layer: (context) => {
      expectTypeOf(context).toEqualTypeOf<BetterAuthMiddlewareContext>()

      return Layer.gen(RequestMetadata, async function* () {
        const policy = yield* Policy
        return RequestMetadata.of({ requestId: policy.constructor.name })
      })
    }
  }
)

expectTypeOf(layeredMiddleware).toMatchTypeOf<BetterAuthMiddleware>()

const typedFailure = Hooks.middleware(
  () =>
    Effect.fn(async function* () {
      yield* []
      return Result.err(new Denied({ message: 'denied' }))
    }),
  {
    onFailure: (failure, context) => {
      expectTypeOf(failure).toEqualTypeOf<Denied>()
      expectTypeOf(context).toEqualTypeOf<BetterAuthMiddlewareContext>()
      return new APIError('FORBIDDEN', {
        code: failure._tag,
        message: failure.message
      })
    }
  }
)

expectTypeOf(typedFailure).toMatchTypeOf<BetterAuthMiddleware>()

const responseFailure = Hooks.middleware(
  () =>
    Effect.fn(async function* () {
      yield* []
      return Result.err(new Denied({ message: 'denied' }))
    }),
  {
    onFailure: async () => new Response(null, { status: 403 })
  }
)

expectTypeOf(responseFailure).toMatchTypeOf<BetterAuthMiddleware>()

const plugin = {
  id: 'types-plugin',
  hooks: {
    before: [
      {
        matcher: (context) => context.path === '/types',
        handler: noFailure
      }
    ],
    after: [
      {
        matcher: (context) => context.path === '/types',
        handler: typedFailure
      }
    ]
  },
  middlewares: [
    {
      path: '/types/*',
      middleware: noFailure
    }
  ]
} satisfies BetterAuthPlugin

void plugin.hooks

const needsMissingService = () =>
  Effect.fn(async function* () {
    yield* MissingService
    return Result.ok()
  })

// @ts-expect-error the Runtime does not provide MissingService
Hooks.middleware(needsMissingService)

const layerNeedsMissingService = () =>
  Layer.gen(RequestMetadata, async function* () {
    yield* MissingLayerService
    return RequestMetadata.of({ requestId: 'missing' })
  })

Hooks.middleware(
  () =>
    Effect.fn(async function* () {
      yield* Policy
      return Result.ok()
    }),
  // @ts-expect-error the per-invocation Layer requires a Service absent from the Runtime
  { layer: layerNeedsMissingService }
)

declare const completeRuntime: Runtime<Provided | InstanceType<typeof MissingService>>
const CompleteHooks = BetterAuthHooks.make('@types/CompleteHookContext', completeRuntime)
const completeMiddleware = CompleteHooks.middleware(needsMissingService)

expectTypeOf(completeMiddleware).toMatchTypeOf<BetterAuthMiddleware>()

const invalidSuccess = () =>
  Effect.fn(async function* () {
    yield* Policy
    return Result.ok(123)
  })

// @ts-expect-error Better Auth middleware success values cannot be arbitrary primitives
Hooks.middleware(invalidSuccess)

declare const _contextAlias: BetterAuthHookContext
const successAlias: BetterAuthHookSuccess = undefined
const failureResult: BetterAuthHookFailureResult = new Response(null)
if (successAlias !== undefined) {
  throw new Error('unreachable success fixture')
}

type _AliasContext = Assert<Equal<BetterAuthHookContext, BetterAuthMiddlewareContext>>
type _ContextNotAny = Assert<IsAny<BetterAuthMiddlewareContext> extends false ? true : false>
type _SuccessResponse = Assert<IsAssignable<Response, BetterAuthHookSuccess>>
type _FailureResponse = Assert<IsAssignable<Response, BetterAuthHookFailureResult>>
type _NoSelfServiceRequirement = Assert<
  IsAssignable<InstanceType<typeof Hooks.Context>, BetterAuthHookContextValue & AnyService>
>

void failureResult
