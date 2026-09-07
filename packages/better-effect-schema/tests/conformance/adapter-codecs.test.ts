import { describe, expect, test } from 'bun:test'
import * as v from 'valibot'
import * as z from 'zod'
import { Result } from 'better-result'

import { Schema, SchemaAsyncRequired, SchemaExecutionFailure } from '../../dist/esm/index.js'
import { ValibotAdapter } from '../../dist/esm/valibot.js'
import { ZodAdapter } from '../../dist/esm/zod.js'
import { expectFailure, noThrowAsync, noThrowSync, unwrapOk } from './helpers.js'

describe('adapter codec capabilities', () => {
  test('Zod uses explicit codecs and validates their encoded projection once', async () => {
    let calls = 0
    const codec = z.codec(z.string(), z.date(), {
      decode: (value) => new Date(value),
      encode: (value) => {
        calls += 1
        return value.toISOString()
      }
    })
    const local = Schema.with(ZodAdapter)

    const encoded = noThrowSync(() => local.encode(codec, new Date('2026-09-06T00:00:00.000Z')))
    expect(unwrapOk(encoded)).toBe('2026-09-06T00:00:00.000Z')
    expect(calls).toBe(1)

    const invalid = noThrowSync(() =>
      local.encode(
        z.codec(z.string(), z.date(), {
          decode: (value) => new Date(value),
          encode: () => 123
        }),
        new Date()
      )
    )
    expectFailure(invalid, SchemaExecutionFailure)

    const throwingRefinement = z.string().refine(() => {
      throw new Error('refinement secret')
    })
    const refined = noThrowSync(() => local.decodeUnknown(throwingRefinement, 'value'))
    expectFailure(refined, SchemaAsyncRequired)

    const asyncCodec = z.codec(z.string(), z.date(), {
      decode: async (value) => new Date(value),
      encode: async (value) => value.toISOString()
    })
    const syncAsync = noThrowSync(() => local.encode(asyncCodec, new Date()))
    expectFailure(syncAsync, SchemaAsyncRequired)
    const asyncResult = await noThrowAsync(() =>
      local.encodeAsync(asyncCodec, new Date('2026-09-06'))
    )
    expect(unwrapOk(asyncResult)).toBe('2026-09-06T00:00:00.000Z')

    const rejectedCause = new Error('zod async encoder secret')
    const rejecting = z.codec(z.string(), z.date(), {
      decode: (value) => new Date(value),
      encode: async () => {
        throw rejectedCause
      }
    })
    const rejected = await noThrowAsync(() => local.encodeAsync(rejecting, new Date()))
    const rejectionFailure = expectFailure(rejected, SchemaExecutionFailure)
    expect(rejectionFailure.cause).toBe(rejectedCause)
  })

  test('Valibot exposes opt-in encoders and normalizes defects', async () => {
    const schema = v.string()
    const local = Schema.with(ValibotAdapter.withEncoder((_schema, value) => String(value)))
    expect(unwrapOk(noThrowSync(() => local.encode(schema, 42)))).toBe('42')

    const thrown = new Error('valibot encoder secret')
    const throwing = Schema.with(
      ValibotAdapter.withEncoder(() => {
        throw thrown
      })
    )
    const failed = noThrowSync(() => throwing.encode(schema, 'value'))
    const execution = expectFailure(failed, SchemaExecutionFailure)
    expect(execution.cause).toBe(thrown)

    let asyncCalls = 0
    const asyncLocal = Schema.with(
      ValibotAdapter.withEncoder(
        (_schema, value) => String(value),
        async (_schema, value) => {
          asyncCalls += 1
          return `${value}!`
        }
      )
    )
    const asyncResult = await noThrowAsync(() => asyncLocal.encodeAsync(schema, 'value'))
    expect(unwrapOk(asyncResult)).toBe('value!')
    expect(asyncCalls).toBe(1)

    const rejecting = Schema.with(
      ValibotAdapter.withEncoder(() => Promise.reject(new Error('reject')))
    )
    const syncRejection = noThrowSync(() => rejecting.encode(schema, 'value'))
    expectFailure(syncRejection, SchemaAsyncRequired)
    await Promise.resolve()
    expect(Result.isError(syncRejection)).toBe(true)
  })
})
