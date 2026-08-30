import { expect, test } from 'bun:test'
import { Result } from 'better-result'

import { BunEffect } from '../src/bun'
import type { BunEffectProgram } from '../src/bun'
import { CurrentAbortSignal, Effect, Layer, Runtime, Service, type ScopeOutcome } from '../src'
import { CurrentRequest } from '../src/standard-services'

class RootService extends Service<RootService>()('BunIntegrationRoot') {
  readonly value = 'shared-root'
}

class RequestService extends Service<RequestService>()('BunIntegrationRequest') {
  constructor(readonly path: string) {
    super()
  }
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

test('BunEffect handles real concurrent requests and closes request scopes before responses settle', async () => {
  let rootAcquisitions = 0
  let rootReleases = 0
  let requestReleases = 0
  const releasedPaths: string[] = []
  const requestReleaseOutcomes: ScopeOutcome[] = []
  const successReleaseSnapshots: number[] = []
  const failureReleaseSnapshots: number[] = []
  let readyRequests = 0
  let openRequests!: () => void
  const requestsReady = new Promise<void>((resolve) => {
    openRequests = resolve
  })
  let disconnectStarted!: () => void
  const disconnectRequestStarted = new Promise<void>((resolve) => {
    disconnectStarted = resolve
  })
  let disconnectSeen!: () => void
  const disconnectObserved = new Promise<void>((resolve) => {
    disconnectSeen = resolve
  })
  let disconnectReleased!: () => void
  const disconnectCleaned = new Promise<void>((resolve) => {
    disconnectReleased = resolve
  })
  let disconnectSignal: AbortSignal | undefined
  let disconnectRequestSignal: AbortSignal | undefined

  const runtime = await Runtime.make(
    Layer.scoped(
      RootService,
      () => {
        rootAcquisitions += 1
        return new RootService()
      },
      () => {
        rootReleases += 1
      }
    )
  )

  const makeRequestLayer = (request: Request) => {
    const path = new URL(request.url).pathname

    return Layer.scoped(
      RequestService,
      () => new RequestService(path),
      (_service, outcome) => {
        requestReleases += 1
        releasedPaths.push(path)
        requestReleaseOutcomes.push(outcome)

        if (path === '/disconnect') {
          disconnectReleased()
        }
      }
    )
  }
  type RequestLayer = ReturnType<typeof makeRequestLayer>

  const http = BunEffect.make<RootService, DomainFailure, RequestLayer>(runtime, {
    requestLayer: makeRequestLayer,
    onSuccess: ({ value }, request) => {
      expect(request).toBeInstanceOf(Request)
      if (new URL(request.url).pathname !== '/disconnect') {
        successReleaseSnapshots.push(requestReleases)
      }
      return Response.json({ data: value })
    },
    onFailure: (error, request) => {
      expect(error).toBeInstanceOf(DomainFailure)
      expect(request).toBeInstanceOf(Request)
      if (new URL(request.url).pathname === '/failure') {
        failureReleaseSnapshots.push(requestReleases)
      }
      return Response.json({ error: error.message }, { status: 422 })
    }
  })

  const handler = http.handler((request, server) =>
    Effect.fn(async function* () {
      const root = yield* RootService
      const requestService = yield* RequestService
      const currentRequest = yield* CurrentRequest
      const signal = yield* CurrentAbortSignal
      // SAFETY: BunEffect supplies the Request object through CurrentRequest.
      const currentRequestValue = currentRequest.request as Request

      if (requestService.path === '/first' || requestService.path === '/second') {
        readyRequests += 1
        if (readyRequests === 2) {
          openRequests()
        }
        await requestsReady
      }

      if (requestService.path === '/disconnect') {
        disconnectSignal = signal
        disconnectRequestSignal = currentRequestValue.signal
        disconnectStarted()
        await waitForAbort(signal)
        disconnectSeen()
        return Result.err(new DomainFailure('client disconnected'))
      }

      if (requestService.path === '/failure') {
        return Result.err(new DomainFailure('private failure'))
      }

      return Result.ok({
        currentUrl: currentRequestValue.url,
        requestUrl: request.url,
        requestPath: requestService.path,
        root: root.value,
        serverPort: server.port,
        aborted: signal.aborted
      })
    })
  )

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handler
  })
  const port = server.port

  try {
    if (port === undefined) {
      throw new Error('Bun did not allocate an ephemeral port')
    }

    const origin = `http://127.0.0.1:${port}`
    const fetchAndCheckCleanup = (path: string): Promise<Response> =>
      fetch(`${origin}${path}`).then((response) => {
        expect(releasedPaths).toContain(path)
        return response
      })
    const [first, second] = await Promise.all([
      fetchAndCheckCleanup('/first'),
      fetchAndCheckCleanup('/second')
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await first.json()).toEqual({
      data: {
        currentUrl: `${origin}/first`,
        requestUrl: `${origin}/first`,
        requestPath: '/first',
        root: 'shared-root',
        serverPort: port,
        aborted: false
      }
    })
    expect(await second.json()).toEqual({
      data: {
        currentUrl: `${origin}/second`,
        requestUrl: `${origin}/second`,
        requestPath: '/second',
        root: 'shared-root',
        serverPort: port,
        aborted: false
      }
    })

    const failure = await fetchAndCheckCleanup('/failure')
    expect(failure.status).toBe(422)
    expect(await failure.json()).toEqual({ error: 'private failure' })

    const controller = new AbortController()
    const disconnectResponse = fetch(`${origin}/disconnect`, { signal: controller.signal }).then(
      () => 'response' as const,
      () => 'aborted' as const
    )
    await disconnectRequestStarted
    controller.abort()
    expect(await disconnectResponse).toBe('aborted')
    await Promise.all([disconnectObserved, disconnectCleaned])
  } finally {
    await server.stop()
    await runtime.dispose()
  }

  expect(disconnectSignal?.aborted).toBe(true)
  expect(disconnectSignal?.reason).toBeDefined()
  expect(disconnectRequestSignal?.aborted).toBe(true)
  expect(successReleaseSnapshots).toEqual([0, 0])
  expect(failureReleaseSnapshots).toEqual([2])
  expect(requestReleases).toBe(4)
  expect(releasedPaths).toEqual(
    expect.arrayContaining(['/first', '/second', '/failure', '/disconnect'])
  )
  expect(requestReleaseOutcomes.map(({ status }) => status)).toEqual([
    'success',
    'success',
    'failure',
    'failure'
  ])
  expect(
    requestReleaseOutcomes
      .filter((outcome) => outcome.status === 'failure')
      .every((outcome) => outcome.cause instanceof DomainFailure)
  ).toBe(true)
  expect(rootAcquisitions).toBe(1)
  expect(rootReleases).toBe(1)
  expect(runtime.inspect()).toMatchObject({
    state: 'disposed',
    activeExecutions: 0
  })

  const replacement = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: () => new Response('replacement')
  })
  await replacement.stop()
})

test('BunEffect keeps defects on Bun.serve error and preserves WebEffect defaults', async () => {
  const runtime = await Runtime.make(Layer.empty)
  const defect = new Error('native defect')
  const http = BunEffect.make(runtime)
  // SAFETY: This fixture deliberately supplies a raw rejecting Program to preserve the native defect.
  const defectProgram = (async () => Promise.reject(defect)) as BunEffectProgram
  const handler = http.handler((request) => {
    const path = new URL(request.url).pathname

    if (path === '/defect') {
      return defectProgram
    }

    return Effect.fn(async function* () {
      yield* Result.await(Promise.resolve(Result.ok(undefined)))

      if (path === '/response') {
        return Result.ok(new Response('passthrough', { status: 201 }))
      }

      return Result.err({ secret: 'redact me' })
    })
  })
  let reportedDefect: unknown
  let reportError!: () => void
  const errorReported = new Promise<void>((resolve) => {
    reportError = resolve
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handler,
    error: (error) => {
      reportedDefect = error
      reportError()
      return new Response('server handled defect', { status: 599 })
    }
  })

  try {
    if (server.port === undefined) {
      throw new Error('Bun did not allocate an ephemeral port')
    }

    const origin = `http://127.0.0.1:${server.port}`
    const passthrough = await fetch(`${origin}/response`)
    expect(passthrough.status).toBe(201)
    expect(await passthrough.text()).toBe('passthrough')

    const failure = await fetch(`${origin}/failure`)
    expect(failure.status).toBe(500)
    expect(await failure.json()).toEqual({ error: 'Internal Server Error' })

    const defectResponse = await fetch(`${origin}/defect`)
    expect(defectResponse.status).toBe(599)
    expect(await defectResponse.text()).toBe('server handled defect')
    await errorReported
    expect(reportedDefect).toBe(defect)
  } finally {
    await server.stop()
    await runtime.dispose()
  }
})
