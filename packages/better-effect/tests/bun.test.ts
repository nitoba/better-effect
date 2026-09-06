/* oxlint-disable typescript/await-thenable -- Bun's promise matchers are asynchronous despite their matcher return type. */

import { expect, test } from 'bun:test'
import { Result } from 'better-result'
import { Hono } from 'hono'

import { BunEffect } from '../src/bun'
import type { BunEffectOptions, BunFetchHandler } from '../src/bun'
import {
  CurrentAbortSignal,
  Effect,
  Layer,
  Runtime,
  Service,
  ServiceRuntime,
  type ScopeOutcome
} from '../src'
import { HonoEffect } from '../src/hono'
import { CurrentRequest } from '../src/standard-services'

class RootService extends Service<RootService>()('BunIntegrationRoot') {
  readonly value = 'shared-root'
}

class RequestService extends Service<RequestService>()('BunIntegrationRequest') {
  constructor(readonly path: string) {
    super()
  }
}

class MappedServerService extends Service<MappedServerService>()('BunMappedServer') {
  declare readonly server: Bun.Server<undefined>
}

class DomainFailure extends Error {
  readonly kind = 'domain' as const
}

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })

test('BunEffect.handler is acquired as a Layer operation and runs one request boundary', async () => {
  let handler!: BunFetchHandler
  let requestReleases = 0
  const releasedPaths: string[] = []
  const releaseOutcomes: ScopeOutcome[] = []
  let disconnectStarted!: () => void
  const disconnectRequestStarted = new Promise<void>((resolve) => {
    disconnectStarted = resolve
  })
  let disconnectCleaned!: () => void
  const disconnectReleased = new Promise<void>((resolve) => {
    disconnectCleaned = resolve
  })
  let disconnectSignal: AbortSignal | undefined
  let disconnectRequestSignal: AbortSignal | undefined

  const makeRequestLayer = (request: Request) => {
    const path = new URL(request.url).pathname

    return Layer.scoped(
      RequestService,
      () => new RequestService(path),
      (_service, outcome) => {
        requestReleases += 1
        releasedPaths.push(path)
        releaseOutcomes.push(outcome)

        if (path === '/disconnect') {
          disconnectCleaned()
        }
      }
    )
  }
  type RequestLayer = ReturnType<typeof makeRequestLayer>

  const options: BunEffectOptions<DomainFailure, RequestLayer> = {
    requestLayer: makeRequestLayer,
    onSuccess: ({ value }, request) => {
      expect(request).toBeInstanceOf(Request)
      return Response.json({ data: value })
    },
    onFailure: (error, request) => {
      expect(error).toBeInstanceOf(DomainFailure)
      expect(request).toBeInstanceOf(Request)
      return Response.json({ error: error.message }, { status: 422 })
    }
  }

  const root = Layer.scoped(
    RootService,
    () => new RootService(),
    () => {}
  )
  const handlerLayer = Layer.scopedDiscardGen(
    async function* () {
      handler = yield* BunEffect.handler(options, (request, server) =>
        Effect.fn(async function* () {
          const rootService = yield* RootService
          const requestService = yield* RequestService
          const currentRequest = yield* CurrentRequest
          const signal = yield* CurrentAbortSignal
          // SAFETY: CurrentRequest is the standard service whose request value is a native Request.
          const currentRequestValue = currentRequest.request as Request

          if (requestService.path === '/disconnect') {
            disconnectSignal = signal
            disconnectRequestSignal = currentRequestValue.signal
            disconnectStarted()
            await waitForAbort(signal)
            return Result.err(new DomainFailure('client disconnected'))
          }

          if (requestService.path === '/failure') {
            return Result.err(new DomainFailure('private failure'))
          }

          return Result.ok({
            currentUrl: currentRequestValue.url,
            requestUrl: request.url,
            root: rootService.value,
            serverPort: server.port,
            aborted: signal.aborted
          })
        })
      )
    },
    () => {}
  )
  const runtime = await Runtime.make(Layer.merge(root, handlerLayer))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handler
  })

  try {
    if (server.port === undefined) {
      throw new Error('Bun did not allocate an ephemeral port')
    }

    const origin = `http://127.0.0.1:${server.port}`
    const success = await fetch(`${origin}/success`)
    const failure = await fetch(`${origin}/failure`)

    expect(success.status).toBe(200)
    expect(await success.json()).toEqual({
      data: {
        currentUrl: `${origin}/success`,
        requestUrl: `${origin}/success`,
        root: 'shared-root',
        serverPort: server.port,
        aborted: false
      }
    })
    expect(failure.status).toBe(422)
    expect(await failure.json()).toEqual({ error: 'private failure' })

    const controller = new AbortController()
    const disconnected = fetch(`${origin}/disconnect`, { signal: controller.signal }).then(
      () => 'response' as const,
      () => 'aborted' as const
    )
    await disconnectRequestStarted
    controller.abort()
    expect(await disconnected).toBe('aborted')
    await disconnectReleased
  } finally {
    await server.stop()
    await runtime.dispose()
  }

  expect(disconnectSignal?.aborted).toBe(true)
  expect(disconnectSignal?.reason).toBeDefined()
  expect(disconnectRequestSignal?.aborted).toBe(true)
  expect(requestReleases).toBe(3)
  expect(releasedPaths).toEqual(expect.arrayContaining(['/success', '/failure', '/disconnect']))
  expect(releaseOutcomes.map(({ status }) => status)).toEqual(['success', 'failure', 'failure'])
})

test('BunEffect.handler preserves default Responses and thrown defects', async () => {
  const defect = new Error('native defect')
  let handler!: BunFetchHandler
  const layer = Layer.scopedDiscardGen(
    async function* () {
      handler = yield* BunEffect.handler((request) => {
        if (new URL(request.url).pathname === '/defect') {
          // SAFETY: This branch intentionally models a lazy Program that rejects with a defect.
          return (async () => Promise.reject(defect)) as never
        }

        // oxlint-disable-next-line require-yield -- this branch intentionally returns a plain Result.
        return Effect.fn(async function* () {
          if (new URL(request.url).pathname === '/response') {
            return Result.ok(new Response('passthrough', { status: 201 }))
          }

          return Result.err({ secret: 'redact me' })
        })
      })
    },
    () => {}
  )
  const runtime = await Runtime.make(layer)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handler,
    error: () => new Response('server handled defect', { status: 599 })
  })

  try {
    if (server.port === undefined) {
      throw new Error('Bun did not allocate an ephemeral port')
    }

    const origin = `http://127.0.0.1:${server.port}`
    const passthrough = await fetch(`${origin}/response`)
    const failure = await fetch(`${origin}/failure`)
    expect(passthrough.status).toBe(201)
    expect(await passthrough.text()).toBe('passthrough')
    expect(failure.status).toBe(500)
    expect(await failure.json()).toEqual({ error: 'Internal Server Error' })

    const defectResponse = await fetch(`${origin}/defect`)
    expect(defectResponse.status).toBe(599)
  } finally {
    await server.stop()
    await runtime.dispose()
  }
})

test('BunEffect.server starts once during Layer acquisition and provides the raw Bun server', async () => {
  let factoryCalls = 0
  // oxlint-disable-next-line require-yield -- this test factory intentionally needs no Services.
  const ApiServer = BunEffect.server('@tests/BunServer', async function* () {
    factoryCalls += 1
    return {
      hostname: '127.0.0.1',
      port: 0,
      fetch: (_request: Request, server: Bun.Server<undefined>) =>
        new Response(`port:${server.port}`)
    }
  })

  expect(factoryCalls).toBe(0)
  const runtime = await Runtime.make(ApiServer.layer)

  try {
    expect(factoryCalls).toBe(1)
    const result = await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* ApiServer)
      })
    )
    const server = Result.unwrap(result)

    expect(server.url).toBeInstanceOf(URL)
    expect(server.port).toBeGreaterThan(0)
    const response = await fetch(server.url)
    expect(await response.text()).toBe(`port:${server.port}`)
  } finally {
    await runtime.dispose()
  }

  expect(factoryCalls).toBe(1)
})

test('BunEffect.server hosts Hono without a second request boundary', async () => {
  const executions: string[] = []
  const App = HonoEffect.app('@tests/BunHonoApp', {}, async function* (http) {
    const app = new Hono()
    app.use('*', yield* http.middleware())
    app.get(
      '/',
      yield* http.gen(
        // oxlint-disable-next-line require-yield -- the route intentionally needs no Services.
        async function* () {
          return Result.ok('hono-hosted')
        }
      )
    )
    return app
  })
  const ApiServer = BunEffect.server('@tests/BunHonoServer', async function* () {
    const app = yield* App
    return { hostname: '127.0.0.1', port: 0, fetch: app.fetch }
  })
  const runtime = await Runtime.make(Layer.merge(App.layer, ApiServer.layer), {
    observers: [
      {
        onExecutionStart: ({ executionId }) => {
          executions.push(executionId)
        }
      }
    ]
  })

  try {
    const server = Result.unwrap(
      await runtime.run(
        Effect.fn(async function* () {
          return Result.ok(yield* ApiServer)
        })
      )
    )
    const before = executions.length
    const response = await fetch(server.url)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: 'hono-hosted' })
    expect(executions.length - before).toBe(1)
  } finally {
    await runtime.dispose()
  }
})

test('BunEffect.layer maps the owned native server into an application Service', async () => {
  let factoryCalls = 0
  // oxlint-disable-next-line require-yield -- this test factory intentionally needs no Services.
  const serverLayer = BunEffect.layer(MappedServerService, async function* () {
    factoryCalls += 1
    return {
      options: {
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response('mapped')
      },
      map: (server) => MappedServerService.of({ server })
    }
  })
  const runtime = await Runtime.make(serverLayer)
  const secondRuntime = await Runtime.make(serverLayer)

  try {
    const mapped = await runtime.run(() => ServiceRuntime.resolve(MappedServerService))
    const secondMapped = await secondRuntime.run(() => ServiceRuntime.resolve(MappedServerService))
    expect(factoryCalls).toBe(2)
    expect(await (await fetch(mapped.server.url)).text()).toBe('mapped')
    expect(await (await fetch(secondMapped.server.url)).text()).toBe('mapped')
  } finally {
    await Promise.all([runtime.dispose(), secondRuntime.dispose()])
  }

  expect(factoryCalls).toBe(2)
})

test('BunEffect.server quiesces before Runtime drain and releases idempotently', async () => {
  const events: string[] = []
  let requestStarted!: () => void
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve
  })
  let finishRequest!: () => void
  const requestFinished = new Promise<void>((resolve) => {
    finishRequest = resolve
  })

  // oxlint-disable-next-line require-yield -- this test factory intentionally needs no Services.
  const ApiServer = BunEffect.server('@tests/BunPhasedServer', async function* () {
    return {
      hostname: '127.0.0.1',
      port: 0,
      fetch: async () => {
        requestStarted()
        await requestFinished
        return new Response('finished')
      }
    }
  })
  const runtime = await Runtime.make(ApiServer.layer, {
    observers: [
      {
        onShutdown: ({ phase }) => {
          events.push(phase)
        }
      }
    ]
  })
  const server = Result.unwrap(
    await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* ApiServer)
      })
    )
  )
  const request = fetch(server.url)
  await started

  const firstDispose = runtime.dispose()
  const secondDispose = runtime.dispose()
  expect(firstDispose).toBe(secondDispose)

  finishRequest()
  const response = await request
  expect(await response.text()).toBe('finished')
  await firstDispose
  expect(events).toEqual([
    'shutdown-requested',
    'quiesce-start',
    'quiesce-end',
    'drain-start',
    'drain-end',
    'release-start',
    'release-end',
    'shutdown-complete'
  ])
})

test('BunEffect.server preserves a stop failure and calls Bun cleanup once', async () => {
  // oxlint-disable-next-line require-yield -- this test factory intentionally needs no Services.
  const ApiServer = BunEffect.server('@tests/BunFailingServer', async function* () {
    return {
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('ok')
    }
  })
  const runtime = await Runtime.make(ApiServer.layer)
  const server = Result.unwrap(
    await runtime.run(
      Effect.fn(async function* () {
        return Result.ok(yield* ApiServer)
      })
    )
  )
  const originalStop = server.stop.bind(server)
  const cleanupFailure = new Error('Bun stop failed')
  let stopCalls = 0

  server.stop = async () => {
    stopCalls += 1
    throw cleanupFailure
  }

  try {
    const firstDispose = runtime.dispose()
    const secondDispose = runtime.dispose()

    expect(firstDispose).toBe(secondDispose)
    await expect(firstDispose).rejects.toThrow('Failed to dispose Layer')
    expect(stopCalls).toBe(1)
  } finally {
    await originalStop()
  }
})
