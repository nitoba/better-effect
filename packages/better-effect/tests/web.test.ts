import { expect, test } from 'bun:test'
import { Result } from 'better-result'

import {
  CurrentAbortSignal,
  Effect,
  Layer,
  Runtime,
  Service,
  ServiceRuntime,
  type ScopeOutcome
} from '../src'
import { CurrentRequest } from '../src/standard-services'
import { WebEffect, WebEffectSerializationError } from '../src/web'

class RootService extends Service<RootService>()('WebRootService') {
  value(): string {
    return 'root'
  }
}

class RequestService extends Service<RequestService>()('WebRequestService') {
  constructor(readonly url: string) {
    super()
  }
}

class RequestRootOverride extends Service<RequestRootOverride>()('WebRootService') {
  value(): string {
    return 'request-root'
  }
}

class DomainFailure extends Error {
  readonly _tag = 'WebDomainFailure' as const
}

const makeRuntime = async (onRootRelease?: () => void) =>
  Runtime.make(
    Layer.scoped(
      RootService,
      () => new RootService(),
      () => {
        onRootRelease?.()
      }
    )
  )

const request = (url: string, signal?: AbortSignal): Request =>
  new Request(`https://example.test${url}`, signal === undefined ? undefined : { signal })

test('WebEffect runs a lazy Program with CurrentRequest and the linked signal', async () => {
  const runtime = await makeRuntime()
  let programRuns = 0
  const controller = new AbortController()

  try {
    const response = await WebEffect.handle(
      runtime,
      request('/items', controller.signal),
      Effect.fn(async function* () {
        programRuns += 1
        const currentRequest = yield* CurrentRequest
        const signal = yield* CurrentAbortSignal
        const root = yield* RootService

        return Result.ok({
          // SAFETY: WebEffect supplies the Request object through CurrentRequest in this test.
          url: (currentRequest.request as Request).url,
          root: root.value(),
          aborted: signal.aborted
        })
      })
    )

    expect(programRuns).toBe(1)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        url: 'https://example.test/items',
        root: 'root',
        aborted: false
      }
    })
  } finally {
    await runtime.dispose()
  }
})

test('WebEffect maps typed failures safely and closes request resources first', async () => {
  const runtime = await makeRuntime()
  const failure = new DomainFailure('private details')
  let requestOutcome: ScopeOutcome | undefined
  let requestLayerCalls = 0
  let responsePolicyCalled = false
  let releasedBeforeResponse = false
  const requestLayer = Layer.scoped(
    RequestService,
    () => new RequestService('request-local'),
    (_service, outcome) => {
      requestOutcome = outcome
      releasedBeforeResponse = true
    }
  )

  try {
    const response = await WebEffect.handle(
      runtime,
      request('/failure'),
      Effect.fn(async function* () {
        const service = yield* RequestService
        expect(service.url).toBe('request-local')
        return Result.err(failure)
      }),
      {
        requestLayer: () => {
          requestLayerCalls += 1
          return requestLayer
        },
        onFailure: (error: DomainFailure) => {
          responsePolicyCalled = error === failure
          expect(releasedBeforeResponse).toBe(false)
          return Response.json({ error: 'safe' }, { status: 422 })
        }
      }
    )

    expect(requestLayerCalls).toBe(1)
    expect(responsePolicyCalled).toBe(true)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'safe' })
    expect(requestOutcome).toEqual({ status: 'failure', cause: failure })
    expect(releasedBeforeResponse).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

test('WebEffect passes a typed Response failure through the default policy', async () => {
  const runtime = await makeRuntime()
  const failureResponse = new Response('not found', { status: 404 })

  try {
    const response = await WebEffect.handle(
      runtime,
      request('/missing'),
      Effect.fn(async function* () {
        yield* Result.await(Promise.resolve(Result.ok(undefined)))
        return Result.err(failureResponse)
      })
    )

    expect(response).toBe(failureResponse)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('not found')
  } finally {
    await runtime.dispose()
  }
})

test('WebEffect redacts non-Response failures and maps standard successes', async () => {
  const runtime = await Runtime.make(Layer.empty)
  const failure = { secret: 'do not expose' }

  try {
    const failureResponse = await WebEffect.handle(
      runtime,
      request('/redacted'),
      Effect.fn(async function* () {
        yield* Result.await(Promise.resolve(Result.ok(undefined)))
        return Result.err(failure)
      })
    )
    const emptyResponse = await WebEffect.handle(
      runtime,
      request('/empty'),
      Effect.fn(async function* () {
        yield* Result.await(Promise.resolve(Result.ok(undefined)))
        return Result.ok(undefined)
      })
    )
    const responseValue = new Response('raw')
    const passthroughResponse = await WebEffect.handle(
      runtime,
      request('/passthrough'),
      Effect.fn(async function* () {
        yield* Result.await(Promise.resolve(Result.ok(undefined)))
        return Result.ok(responseValue)
      })
    )

    expect(failureResponse.status).toBe(500)
    expect(await failureResponse.json()).toEqual({ error: 'Internal Server Error' })
    expect(emptyResponse.status).toBe(204)
    expect(await emptyResponse.text()).toBe('')
    expect(passthroughResponse).toBe(responseValue)
  } finally {
    await runtime.dispose()
  }
})

test('WebEffect accepts asynchronous response policies and rejects invalid policy output', async () => {
  const runtime = await Runtime.make(Layer.empty)

  try {
    const response = await WebEffect.handle(
      runtime,
      request('/policy'),
      Effect.fn(async function* () {
        yield* Result.await(Promise.resolve(Result.ok(undefined)))
        return Result.ok('created')
      }),
      {
        onSuccess: async ({ value }) => new Response(value, { status: 201 })
      }
    )

    expect(response.status).toBe(201)
    expect(await response.text()).toBe('created')

    const invalidPolicyCause = await WebEffect.handle(
      runtime,
      request('/invalid-policy'),
      Effect.fn(async function* () {
        yield* Result.await(Promise.resolve(Result.ok(undefined)))
        return Result.ok('invalid')
      }),
      // SAFETY: This test intentionally bypasses the static Response return type to exercise runtime validation.
      { onSuccess: () => ({}) as Response }
    ).catch((cause) => cause)
    expect(invalidPolicyCause).toBeInstanceOf(TypeError)
  } finally {
    await runtime.dispose()
  }
})

test('WebEffect default success policy preserves the supported JSON value contract', async () => {
  const runtime = await Runtime.make(Layer.empty)

  try {
    const response = await WebEffect.handle(
      runtime,
      request('/json'),
      // oxlint-disable-next-line require-yield -- This fixture checks the default policy with a pure success value.
      Effect.fn(async function* () {
        return Result.ok({
          nullValue: null,
          booleanValue: true,
          numberValue: 42,
          stringValue: 'safe',
          nested: [null, false, 0, 'nested', { value: 1 }]
        })
      })
    )

    expect(await response.json()).toEqual({
      data: {
        nullValue: null,
        booleanValue: true,
        numberValue: 42,
        stringValue: 'safe',
        nested: [null, false, 0, 'nested', { value: 1 }]
      }
    })
  } finally {
    await runtime.dispose()
  }
})

test('WebEffect default success policy rejects unsupported JSON values explicitly', async () => {
  const runtime = await Runtime.make(Layer.empty)
  type CircularValue = { self?: CircularValue }
  const circular: CircularValue = {}
  circular.self = circular
  const symbolKeyedArray = Object.assign([], { [Symbol('unsupported')]: true })
  const unsupported: readonly [string, unknown][] = [
    ['bigint', 1n],
    ['circular', circular],
    ['symbol-keyed', symbolKeyedArray],
    ['function', { callback: () => undefined }],
    ['symbol', { value: Symbol('unsupported') }],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', { value: undefined }]
  ]

  try {
    for (const [name, value] of unsupported) {
      const cause = await WebEffect.handle(
        runtime,
        request(`/unsupported/${name}`),
        // oxlint-disable-next-line require-yield -- This fixture deliberately returns each unsupported value directly.
        Effect.fn(async function* () {
          return Result.ok(value)
        })
      ).catch((error) => error)

      expect(cause).toBeInstanceOf(WebEffectSerializationError)
      expect(cause).toBeInstanceOf(TypeError)
      // SAFETY: The preceding assertions establish that the rejection is an Error instance.
      expect((cause as Error).message).toContain(
        name === 'NaN' || name === 'Infinity' ? 'non-finite' : name
      )
    }
  } finally {
    await runtime.dispose()
  }
})

test('WebEffect accepts compatible alternate Web Responses across policies', async () => {
  const runtime = await Runtime.make(Layer.empty)
  const headers = new Headers()
  // SAFETY: This structural fixture supplies every Response member validated by WebEffect.
  const alternateResponse = {
    body: null,
    bodyUsed: false,
    headers,
    ok: true,
    redirected: false,
    status: 200,
    statusText: 'OK',
    type: 'default',
    url: 'https://example.test/alternate',
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    clone: () => alternateResponse,
    formData: async () => new FormData(),
    json: async () => ({}),
    text: async () => '',
    bytes: async () => new Uint8Array()
  } as Response
  type ResponseOverrides = {
    readonly body?: object | null
    readonly bytes?: unknown
    readonly headers?: object
  }
  const withResponseOverrides = (overrides: ResponseOverrides): Response => {
    // SAFETY: The base fixture has every Response property; overrides intentionally remove one capability.
    return Object.assign({}, alternateResponse, overrides) as Response
  }
  const streamResponse = withResponseOverrides({ body: new ReadableStream<Uint8Array>() })
  const incompleteHeaders = (missing: 'get' | 'set') => ({
    append: () => undefined,
    delete: () => undefined,
    get: missing === 'get' ? undefined : () => null,
    has: () => false,
    set: missing === 'set' ? undefined : () => undefined,
    forEach: () => undefined
  })
  const incompleteResponses: readonly (readonly [string, Response])[] = [
    // SAFETY: These fixtures intentionally omit one required structural capability.
    ['bytes', withResponseOverrides({ bytes: undefined })],
    ['headers.get', withResponseOverrides({ headers: incompleteHeaders('get') })],
    ['headers.set', withResponseOverrides({ headers: incompleteHeaders('set') })],
    [
      'body.getReader',
      withResponseOverrides({
        body: {
          locked: false,
          cancel: () => undefined,
          pipeThrough: () => undefined,
          pipeTo: () => undefined,
          tee: () => undefined
        }
      })
    ]
  ]
  // SAFETY: This fixture intentionally creates an object with a forged Response prototype.
  const forgedResponse = Object.create(Response.prototype) as Response

  try {
    const defaultSuccess = await WebEffect.handle(
      runtime,
      request('/default-success'),
      // oxlint-disable-next-line require-yield -- This fixture checks the default Response policy.
      Effect.fn(async function* () {
        return Result.ok(alternateResponse)
      })
    )
    const defaultFailure = await WebEffect.handle(
      runtime,
      request('/default-failure'),
      // oxlint-disable-next-line require-yield -- This fixture checks the default Response policy.
      Effect.fn(async function* () {
        return Result.err(alternateResponse)
      })
    )
    const customSuccess = await WebEffect.handle(
      runtime,
      request('/custom-success'),
      // oxlint-disable-next-line require-yield -- This fixture checks a custom Response policy.
      Effect.fn(async function* () {
        return Result.ok('ok')
      }),
      { onSuccess: () => streamResponse }
    )
    const customFailure = await WebEffect.handle(
      runtime,
      request('/custom-failure'),
      // oxlint-disable-next-line require-yield -- This fixture checks a custom Response policy.
      Effect.fn(async function* () {
        return Result.err('failure')
      }),
      { onFailure: () => alternateResponse }
    )

    expect(defaultSuccess).toBe(alternateResponse)
    expect(defaultFailure).toBe(alternateResponse)
    expect(customSuccess).toBe(streamResponse)
    expect(customFailure).toBe(alternateResponse)

    for (const [name, incompleteResponse] of incompleteResponses) {
      const defaultSuccessCause = await WebEffect.handle(
        runtime,
        request(`/default-invalid-success/${name}`),
        // oxlint-disable-next-line require-yield -- This fixture deliberately returns a malformed Response.
        Effect.fn(async function* () {
          return Result.ok(incompleteResponse)
        })
      ).catch((cause) => cause)
      const defaultFailure = await WebEffect.handle(
        runtime,
        request(`/default-invalid-failure/${name}`),
        // oxlint-disable-next-line require-yield -- This fixture deliberately returns a malformed Response.
        Effect.fn(async function* () {
          return Result.err(incompleteResponse)
        })
      )
      const successCause = await WebEffect.handle(
        runtime,
        request(`/invalid-success/${name}`),
        // oxlint-disable-next-line require-yield -- This fixture deliberately returns a malformed Response.
        Effect.fn(async function* () {
          return Result.ok('ok')
        }),
        { onSuccess: () => incompleteResponse }
      ).catch((cause) => cause)
      const failureCause = await WebEffect.handle(
        runtime,
        request(`/invalid-failure/${name}`),
        // oxlint-disable-next-line require-yield -- This fixture deliberately returns a malformed Response.
        Effect.fn(async function* () {
          return Result.err('failure')
        }),
        { onFailure: () => incompleteResponse }
      ).catch((cause) => cause)

      expect(defaultSuccessCause).toBeInstanceOf(WebEffectSerializationError)
      expect(defaultFailure).not.toBe(incompleteResponse)
      expect(defaultFailure.status).toBe(500)
      expect(successCause).toBeInstanceOf(TypeError)
      expect(failureCause).toBeInstanceOf(TypeError)
    }

    const forgedCause = await WebEffect.handle(
      runtime,
      request('/forged'),
      // oxlint-disable-next-line require-yield -- This fixture returns a value through the forged Response policy.
      Effect.fn(async function* () {
        return Result.ok('ok')
      }),
      { onSuccess: () => forgedResponse }
    ).catch((cause) => cause)

    expect(forgedCause).toBeInstanceOf(TypeError)
    // SAFETY: The preceding assertion establishes that the rejection is an Error instance.
    expect((forgedCause as Error).message).toContain('must return a Response')
  } finally {
    await runtime.dispose()
  }
})

test('WebEffect keeps thrown defects rejected and still closes request resources', async () => {
  const runtime = await makeRuntime()
  const defect = new Error('defect')
  let requestOutcome: ScopeOutcome | undefined
  const requestLayer = Layer.scoped(
    RequestService,
    () => new RequestService('defect'),
    (_service, outcome) => {
      requestOutcome = outcome
    }
  )
  // SAFETY: This fixture deliberately exercises a defect before a Result exists.
  const defectProgram = (async () => {
    await ServiceRuntime.resolve(RequestService)
    return await Promise.reject(defect)
  }) as WebEffect.Program

  try {
    const defectCause = await WebEffect.handle(runtime, request('/defect'), defectProgram, {
      requestLayer: () => requestLayer
    }).catch((cause) => cause)
    expect(defectCause).toBe(defect)
    expect(requestOutcome).toEqual({ status: 'failure', cause: defect })
  } finally {
    await runtime.dispose()
  }
})

test('WebEffect forwards an already-aborted request signal', async () => {
  const runtime = await makeRuntime()
  const reason = new Error('client disconnected')
  const controller = new AbortController()
  controller.abort(reason)

  try {
    const response = await WebEffect.handle(
      runtime,
      request('/aborted', controller.signal),
      Effect.fn(async function* () {
        const signal = yield* CurrentAbortSignal
        return Result.ok({ aborted: signal.aborted, sameReason: signal.reason === reason })
      })
    )

    expect(await response.json()).toEqual({
      data: {
        aborted: true,
        sameReason: true
      }
    })
  } finally {
    await runtime.dispose()
  }
})

test('WebEffect permits compatible request-local overrides without disposing root instances', async () => {
  let rootReleases = 0
  const runtime = await makeRuntime(() => {
    rootReleases += 1
  })
  const requestLayer = Layer.succeed(RequestRootOverride, new RequestRootOverride())

  try {
    await runtime.run(() => ServiceRuntime.resolve(RootService))

    const response = await WebEffect.handle(
      runtime,
      request('/override'),
      Effect.fn(async function* () {
        const root = yield* RootService
        return Result.ok(root.value())
      }),
      { requestLayer: () => requestLayer }
    )

    expect(await response.json()).toEqual({ data: 'request-root' })
    expect(rootReleases).toBe(0)
  } finally {
    await runtime.dispose()
  }

  expect(rootReleases).toBe(1)
})

test('WebEffect keeps concurrent request Layers and CurrentRequest values isolated', async () => {
  const runtime = await makeRuntime()
  let releaseCount = 0
  let allowFirst!: () => void
  let allowSecond!: () => void
  const firstAllowed = new Promise<void>((resolve) => {
    allowFirst = resolve
  })
  const secondAllowed = new Promise<void>((resolve) => {
    allowSecond = resolve
  })
  const requestLayer = (url: string) =>
    Layer.scoped(
      RequestService,
      () => new RequestService(url),
      () => {
        releaseCount += 1
      }
    )
  const program = Effect.fn(async function* () {
    const currentRequest = yield* CurrentRequest
    const local = yield* RequestService
    const gate = local.url.endsWith('first') ? firstAllowed : secondAllowed
    const release = local.url.endsWith('first') ? allowFirst : allowSecond
    release()
    await gate

    return Result.ok({
      // SAFETY: WebEffect supplies the Request object through CurrentRequest in this test.
      current: (currentRequest.request as Request).url,
      local: local.url
    })
  })

  try {
    const [first, second] = await Promise.all([
      WebEffect.handle(runtime, request('/first'), program, {
        requestLayer: () => requestLayer('first')
      }),
      WebEffect.handle(runtime, request('/second'), program, {
        requestLayer: () => requestLayer('second')
      })
    ])

    expect(await first.json()).toEqual({
      data: {
        current: 'https://example.test/first',
        local: 'first'
      }
    })
    expect(await second.json()).toEqual({
      data: {
        current: 'https://example.test/second',
        local: 'second'
      }
    })
    expect(releaseCount).toBe(2)
  } finally {
    await runtime.dispose()
  }
})
