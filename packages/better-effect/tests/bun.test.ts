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

test('BunEffect handles concurrent Bun.serve requests and shuts down cleanly', async () => {
  let rootAcquisitions = 0
  let rootReleases = 0
  let requestReleases = 0
  const requestReleaseOutcomes: ScopeOutcome[] = []
  const successReleaseSnapshots: number[] = []
  const failureReleaseSnapshots: number[] = []
  let readyRequests = 0
  let openRequests!: () => void
  const requestsReady = new Promise<void>((resolve) => {
    openRequests = resolve
  })

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

  const makeRequestLayer = (request: Request) =>
    Layer.scoped(
      RequestService,
      () => new RequestService(new URL(request.url).pathname),
      (_service, outcome) => {
        requestReleases += 1
        requestReleaseOutcomes.push(outcome)
      }
    )
  type RequestLayer = ReturnType<typeof makeRequestLayer>

  const http = BunEffect.make<RootService, DomainFailure, RequestLayer>(runtime, {
    requestLayer: makeRequestLayer,
    onSuccess: ({ value }, request) => {
      expect(request).toBeInstanceOf(Request)
      successReleaseSnapshots.push(requestReleases)
      return Response.json({ data: value })
    },
    onFailure: (error, request) => {
      expect(error).toBeInstanceOf(DomainFailure)
      expect(request).toBeInstanceOf(Request)
      failureReleaseSnapshots.push(requestReleases)
      return Response.json({ error: error.message }, { status: 422 })
    }
  })

  const handler = http.handler((request, server) =>
    Effect.fn(async function* () {
      const root = yield* RootService
      const requestService = yield* RequestService
      const currentRequest = yield* CurrentRequest
      const signal = yield* CurrentAbortSignal

      if (requestService.path === '/first' || requestService.path === '/second') {
        readyRequests += 1
        if (readyRequests === 2) {
          openRequests()
        }
        await requestsReady
      }

      if (requestService.path === '/failure') {
        return Result.err(new DomainFailure('private failure'))
      }

      return Result.ok({
        // SAFETY: BunEffect supplies the Request object through CurrentRequest.
        currentUrl: (currentRequest.request as Request).url,
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
    const [first, second] = await Promise.all([fetch(`${origin}/first`), fetch(`${origin}/second`)])

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

    const failure = await fetch(`${origin}/failure`)
    expect(failure.status).toBe(422)
    expect(await failure.json()).toEqual({ error: 'private failure' })
  } finally {
    await server.stop()
    await runtime.dispose()
  }

  expect(successReleaseSnapshots).toEqual([0, 0])
  expect(failureReleaseSnapshots).toEqual([2])
  expect(requestReleases).toBe(3)
  expect(requestReleaseOutcomes).toEqual([
    { status: 'success' },
    { status: 'success' },
    { status: 'failure', cause: expect.any(DomainFailure) }
  ])
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

test('BunEffect preserves WebEffect response defaults and native defects', async () => {
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
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handler
  })

  try {
    const passthrough = await handler(new Request('https://example.test/response'), server)
    expect(passthrough.status).toBe(201)
    expect(await passthrough.text()).toBe('passthrough')

    const failure = await handler(new Request('https://example.test/failure'), server)
    expect(failure.status).toBe(500)
    expect(await failure.json()).toEqual({ error: 'Internal Server Error' })

    const rejected = await handler(new Request('https://example.test/defect'), server).catch(
      (cause) => cause
    )
    expect(rejected).toBe(defect)
  } finally {
    await server.stop()
    await runtime.dispose()
  }
})
