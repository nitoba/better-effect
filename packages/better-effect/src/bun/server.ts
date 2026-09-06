import type { ServiceRequirement } from '../effect/types'
import { Layer } from '../layer'
import { ServiceRuntime } from '../service'
import type { AnyServiceToken, ServiceContract, ServiceToken } from '../service'
import { Runtime } from '../runtime'
import type { RuntimeExecutor } from '../runtime/executor'

import type {
  BunEffectLayer,
  BunServer,
  BunServerFactory,
  BunServerLayerFactory,
  BunServerLayerSpec,
  BunServeOptions,
  InferGeneratorYield
} from './types'

type BunServerBinding<
  Service extends ServiceToken<any, any>,
  WebSocketData,
  Route extends string
> = BunServerLayerSpec<Service, WebSocketData, Route>

interface BunServerBuild<
  Service extends ServiceToken<any, any>,
  Yield extends ServiceRequirement<any>
> {
  readonly token: Service
  readonly layer: BunEffectLayer<Service, Yield>
}

const runFactory = async <Returned>(
  factory: () =>
    | Generator<ServiceRequirement<any>, Returned, unknown>
    | AsyncGenerator<ServiceRequirement<any>, Returned, unknown>
): Promise<Returned> => {
  const iterator = factory()
  let state = await iterator.next()

  while (!state.done) {
    // SAFETY: Layer generator yields are declaration-only Service token markers.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const token = state.value as unknown as AnyServiceToken
    state = await iterator.next(await ServiceRuntime.resolve(token))
  }

  return state.value
}

class BunServerState<Service extends ServiceToken<any, any>, WebSocketData, Route extends string> {
  private server: BunServer<WebSocketData> | undefined

  private binding: BunServerBinding<Service, WebSocketData, Route> | undefined

  private stopPromise: Promise<void> | undefined

  get acquired(): BunServer<WebSocketData> | undefined {
    return this.server
  }

  acquire(binding: BunServerBinding<Service, WebSocketData, Route>): BunServer<WebSocketData> {
    if (this.server !== undefined) {
      return this.server
    }

    const server = Bun.serve<WebSocketData, Route>(binding.options)
    this.binding = binding
    this.server = server
    return server
  }

  currentBinding(): BunServerBinding<Service, WebSocketData, Route> | undefined {
    return this.binding
  }

  stop(server: BunServer<WebSocketData>): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise
    }

    try {
      this.stopPromise = server.stop()
    } catch (cause) {
      this.stopPromise = Promise.reject(cause)
    }

    this.stopPromise.catch(() => {})
    return this.stopPromise
  }
}

const currentRuntimeExecutor = (): RuntimeExecutor<any> => {
  const iterator = Runtime.executor<any>()[Symbol.iterator]()
  const result = iterator.next()

  if (!result.done) {
    throw new Error('Runtime executor request did not settle synchronously')
  }

  return result.value
}

/** Create a lifecycle-owning Bun server Layer for any Service token. */
export const makeBunLayer = <
  Service extends ServiceToken<any, any>,
  WebSocketData,
  Route extends string,
  const Factory extends BunServerLayerFactory<Service, WebSocketData, Route>
>(
  service: Service,
  factory: Factory
): BunEffectLayer<Service, InferGeneratorYield<Factory>> => {
  const states = new WeakMap<RuntimeExecutor<any>, BunServerState<Service, WebSocketData, Route>>()
  const statesByServer = new WeakMap<
    BunServer<WebSocketData>,
    BunServerState<Service, WebSocketData, Route>
  >()
  const stateForRuntime = (): BunServerState<Service, WebSocketData, Route> => {
    const executor = currentRuntimeExecutor()
    let state = states.get(executor)

    if (state === undefined) {
      state = new BunServerState<Service, WebSocketData, Route>()
      states.set(executor, state)
    }

    return state
  }

  const acquire = (
    state: BunServerState<Service, WebSocketData, Route>,
    binding: BunServerBinding<Service, WebSocketData, Route>
  ): BunServer<WebSocketData> => {
    const server = state.acquire(binding)
    statesByServer.set(server, state)
    return server
  }

  const stateForServer = (
    server: BunServer<WebSocketData>
  ): BunServerState<Service, WebSocketData, Route> => {
    const state = statesByServer.get(server)

    if (state === undefined) {
      throw new Error('Bun server lifecycle state is unavailable')
    }

    return state
  }

  const lifecycle = Layer.scopedDiscardGen(
    async function* () {
      const state = stateForRuntime()
      const existing = state.acquired

      if (existing !== undefined) {
        return existing
      }

      const binding = yield* factory()
      return acquire(state, binding)
    },
    {
      quiesce: (server) => {
        // Bun.stop() stops accepting new connections immediately. Its Promise
        // is held for release so Runtime can drain its executions first.
        // SAFETY: Lifecycle callbacks receive the exact Bun server acquired by this state.
        const state = stateForServer(server as BunServer<WebSocketData>)
        // SAFETY: The same acquired server is passed back to the cached stop operation.
        void state.stop(server as BunServer<WebSocketData>)
      },
      release: (server) => {
        // SAFETY: Lifecycle callbacks receive the exact Bun server acquired by this state.
        const state = stateForServer(server as BunServer<WebSocketData>)
        // SAFETY: The same acquired server is passed back to the cached stop operation.
        return state.stop(server as BunServer<WebSocketData>)
      }
    }
  )

  const provider = Layer.make(service, async () => {
    const state = stateForRuntime()
    let binding = state.currentBinding()

    if (binding === undefined) {
      binding = await runFactory(factory)
      acquire(state, binding)
    }

    const server = state.acquired

    if (server === undefined) {
      throw new Error('Bun server acquisition did not produce a server')
    }

    return await binding.map(server)
  })

  // The provider exposes the mapped Service; the lifecycle entry owns the raw
  // server and makes startup happen once during Runtime acquisition.
  // SAFETY: Layer.merge erases heterogeneous provider entries only at this internal storage boundary.
  return Layer.merge(provider as Layer.Any, lifecycle as Layer.Any) as BunEffectLayer<
    Service,
    InferGeneratorYield<Factory>
  >
}

const identityBinding = <
  Service extends ServiceToken<any, any>,
  WebSocketData,
  Route extends string
>(
  options: BunServeOptions<WebSocketData, Route>
): BunServerBinding<Service, WebSocketData, Route> => ({
  options,
  map: (server) => {
    // SAFETY: The generated token's instance contract is the native Bun server selected by its Data type.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    return server as unknown as ServiceContract<InstanceType<Service>>
  }
})

export const makeBunServer = <
  const Tag extends string,
  WebSocketData,
  Route extends string,
  const Factory extends BunServerFactory<WebSocketData, Route>,
  Service extends ServiceToken<
    Tag,
    BunServer<WebSocketData> & import('../service').ServiceIdentity<Tag>
  >
>(
  factory: Factory,
  token: Service
): BunServerBuild<Service, InferGeneratorYield<Factory>> => {
  const adaptedFactory = async function* () {
    const options = yield* factory()
    return identityBinding<Service, WebSocketData, Route>(options)
  }
  const layer = makeBunLayer<Service, WebSocketData, Route, typeof adaptedFactory>(
    token,
    adaptedFactory
  )

  return { token, layer }
}
