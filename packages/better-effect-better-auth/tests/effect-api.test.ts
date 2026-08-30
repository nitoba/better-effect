import { describe, expect, test } from 'bun:test'
import { APIError } from 'better-auth/api'
import { Result, UnhandledException } from 'better-result'

import { BetterAuthApiError, type BetterAuthOperation } from '../src'
import { makeBetterAuthEffectApi } from '../src/internal/effect-api'

type EndpointInput = {
  readonly value?: string
  readonly delayMs?: number
  readonly asResponse?: boolean
  readonly returnHeaders?: boolean
  readonly returnStatus?: boolean
}

type EndpointData = {
  readonly value: string
  readonly receiver: string
}

type EndpointOutput =
  | EndpointData
  | Response
  | {
      readonly headers: Headers
      readonly response: EndpointData
    }

const execute = <A, E>(operation: BetterAuthOperation<A, E>) =>
  Result.gen(async function* () {
    const value = yield* operation
    return Result.ok(value)
  })

class RawApi {
  readonly receiver = 'raw-api'
  readonly calls: EndpointInput[] = []
  readonly metadata = {
    version: 1
  }

  async endpoint(input: EndpointInput = {}): Promise<EndpointOutput> {
    const snapshot = {
      ...input
    }
    this.calls.push(snapshot)

    if (input.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, input.delayMs))
    }

    const data = {
      value: input.value ?? 'default',
      receiver: this.receiver
    }

    if (input.asResponse === true) {
      const headers = new Headers()
      headers.append('set-cookie', 'first=1; Path=/')
      headers.append('set-cookie', 'second=2; Path=/')
      return Response.json(data, {
        status: 201,
        headers
      })
    }

    if (input.returnHeaders === true) {
      const headers = new Headers()
      headers.append('set-cookie', 'session=active; Path=/')
      return {
        headers,
        response: data
      }
    }

    return data
  }
}

describe('makeBetterAuthEffectApi', () => {
  test('adapts all transport modes without mutating the input or losing the receiver', async () => {
    const raw = new RawApi()
    // oxlint-disable-next-line typescript/unbound-method -- The test compares the raw prototype method with the adapted endpoint.
    const originalEndpoint = raw.endpoint
    const api = makeBetterAuthEffectApi<RawApi, 'AUTH_ERROR'>(raw)
    const input = {
      value: 'data'
    }

    const dataResult = await execute(api.endpoint(input))
    const responseResult = await execute(api.endpoint.asResponse(input))
    const headersResult = await execute(api.endpoint.withHeaders(input))

    expect(Result.isOk(dataResult)).toBe(true)
    expect(Result.isOk(responseResult)).toBe(true)
    expect(Result.isOk(headersResult)).toBe(true)

    if (Result.isOk(dataResult)) {
      expect(dataResult.value).toEqual({
        value: 'data',
        receiver: 'raw-api'
      })
    }

    if (Result.isOk(responseResult)) {
      expect(responseResult.value).toBeInstanceOf(Response)
      expect(responseResult.value.status).toBe(201)
      expect(responseResult.value.headers.getSetCookie()).toEqual([
        'first=1; Path=/',
        'second=2; Path=/'
      ])
    }

    if (Result.isOk(headersResult)) {
      expect(headersResult.value.response).toEqual({
        value: 'data',
        receiver: 'raw-api'
      })
      expect(headersResult.value.headers.getSetCookie()).toEqual(['session=active; Path=/'])
    }

    expect(input).toEqual({
      value: 'data'
    })
    expect(raw.calls).toEqual([
      {
        value: 'data',
        asResponse: false,
        returnHeaders: false,
        returnStatus: false
      },
      {
        value: 'data',
        asResponse: true,
        returnHeaders: false,
        returnStatus: false
      },
      {
        value: 'data',
        asResponse: false,
        returnHeaders: true,
        returnStatus: false
      }
    ])
    // oxlint-disable-next-line typescript/unbound-method -- The raw method must remain unchanged after adaptation.
    expect(raw.endpoint).toBe(originalEndpoint)
    // oxlint-disable-next-line typescript/unbound-method -- The raw method must not gain transport helpers.
    expect('asResponse' in raw.endpoint).toBe(false)
  })

  test('caches endpoint wrappers and their transport functions', () => {
    const api = makeBetterAuthEffectApi<RawApi, 'AUTH_ERROR'>(new RawApi())

    expect(api.endpoint).toBe(api.endpoint)
    expect(api.endpoint.asResponse).toBe(api.endpoint.asResponse)
    expect(api.endpoint.withHeaders).toBe(api.endpoint.withHeaders)
  })

  test('normalizes Better Auth API errors and unexpected defects', async () => {
    const defect = new Error('database unavailable')
    const raw = {
      apiFailure: async () => {
        throw new APIError('UNAUTHORIZED', {
          code: 'INVALID_SESSION',
          message: 'Invalid session'
        })
      },
      defect: async () => {
        throw defect
      }
    }
    const api = makeBetterAuthEffectApi<typeof raw, 'INVALID_SESSION'>(raw)

    const apiFailure = await execute(api.apiFailure())
    const unexpectedFailure = await execute(api.defect())

    expect(Result.isError(apiFailure)).toBe(true)
    expect(Result.isError(unexpectedFailure)).toBe(true)

    if (Result.isError(apiFailure)) {
      expect(apiFailure.error).toBeInstanceOf(BetterAuthApiError)

      if (apiFailure.error instanceof BetterAuthApiError) {
        expect(apiFailure.error.code).toBe('INVALID_SESSION')
      }
    }

    if (Result.isError(unexpectedFailure)) {
      expect(unexpectedFailure.error).toBeInstanceOf(UnhandledException)
      expect(unexpectedFailure.error.cause).toBe(defect)
    }
  })

  test('rejects conflicting runtime transport flags before invoking the endpoint', async () => {
    const raw = new RawApi()
    const api = makeBetterAuthEffectApi<RawApi, 'AUTH_ERROR'>(raw)

    // SAFETY: this test deliberately bypasses the public input type to verify the JavaScript boundary.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The test must forge an invalid JavaScript input type.
    const callWithConflict = api.endpoint as unknown as (
      input: EndpointInput
    ) => BetterAuthOperation<EndpointOutput, BetterAuthApiError<'AUTH_ERROR'> | UnhandledException>

    const dataConflict = await execute(
      callWithConflict({
        asResponse: true
      })
    )

    const responseConflict = await execute(
      // SAFETY: this test deliberately bypasses the public input type to verify the JavaScript boundary.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The test must forge an invalid JavaScript input type.
      (api.endpoint.asResponse as unknown as typeof callWithConflict)({
        returnHeaders: true
      })
    )

    expect(Result.isError(dataConflict)).toBe(true)
    expect(Result.isError(responseConflict)).toBe(true)

    if (Result.isError(dataConflict)) {
      expect(dataConflict.error).toBeInstanceOf(UnhandledException)
      expect(dataConflict.error.cause).toBeInstanceOf(TypeError)
    }

    if (Result.isError(responseConflict)) {
      expect(responseConflict.error).toBeInstanceOf(UnhandledException)
      expect(responseConflict.error.cause).toBeInstanceOf(TypeError)
    }

    expect(raw.calls).toEqual([])
  })

  test('isolates concurrent arguments and preserves result ordering at the caller', async () => {
    const raw = new RawApi()
    const api = makeBetterAuthEffectApi<RawApi, 'AUTH_ERROR'>(raw)

    const [slow, fast] = await Promise.all([
      execute(
        api.endpoint({
          value: 'slow',
          delayMs: 10
        })
      ),
      execute(
        api.endpoint({
          value: 'fast',
          delayMs: 0
        })
      )
    ])

    expect(Result.isOk(slow)).toBe(true)
    expect(Result.isOk(fast)).toBe(true)

    if (Result.isOk(slow) && Result.isOk(fast)) {
      expect(slow.value).toMatchObject({
        value: 'slow'
      })
      expect(fast.value).toMatchObject({
        value: 'fast'
      })
    }

    expect(raw.calls).toHaveLength(2)
    expect(raw.calls[0]).not.toBe(raw.calls[1])
  })

  test('does not synthesize effectful endpoints for inherited, symbol, or non-function values', () => {
    const raw = new RawApi()
    const api = makeBetterAuthEffectApi<RawApi, 'AUTH_ERROR'>(raw)

    // SAFETY: runtime access intentionally probes values excluded by the public mapped type.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- The test needs an opaque view to probe excluded runtime properties.
    const runtimeApi = api as unknown as Readonly<Record<PropertyKey, unknown>>

    expect(runtimeApi.metadata).toBeUndefined()
    // oxlint-disable-next-line typescript/unbound-method -- The test checks that the inherited method is hidden.
    expect(runtimeApi.toString).toBeUndefined()
    expect(runtimeApi[Symbol.toStringTag]).toBeUndefined()
  })
})
