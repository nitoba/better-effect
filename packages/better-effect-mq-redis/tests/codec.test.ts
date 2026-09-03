// oxlint-disable anti-slop/no-known-value-widening -- test dictionaries intentionally model corrupt Redis replies.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- hostile DTO fixtures intentionally use open dictionaries.
// oxlint-disable anti-slop/no-chained-type-assertions -- hostile DTO fixtures intentionally bypass branded record types.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- hostile DTO fixtures intentionally bypass branded record types.

import { describe, expect, test } from 'bun:test'
import { Result } from 'better-result'

import { JobId, JobName, QueueName, makeJobRecord, validateAttemptRecord } from 'better-effect-mq'
import { decodeAttempt, decodeJobRecord, encodeAttempt, encodeJobRecord } from '../src/index'
import type { AttemptRecord, JobRecord } from 'better-effect-mq'

const unwrap = <Value, Failure>(result: Result<Value, Failure>): Value => {
  if (Result.isError(result)) throw result.error
  return result.value
}

const record = (payload: JobRecord['payload'] = { z: 1, a: ['通知', '\u0000'] }): JobRecord =>
  unwrap(
    makeJobRecord({
      id: unwrap(JobId.make('job-1')),
      name: unwrap(JobName.make('send-email')),
      version: 1,
      queue: unwrap(QueueName.make('emails')),
      state: 'waiting',
      payload,
      metadata: { z: 'last', a: 'first' },
      priority: 10,
      runAt: 100,
      orderingSequence: 1,
      attemptsMax: 3,
      attemptsMade: 0,
      deliveryCount: 0,
      stalledCount: 0,
      backoff: undefined,
      timeoutMs: undefined,
      idempotencyKey: undefined,
      createdAt: 1,
      updatedAt: 100,
      processedAt: undefined,
      finishedAt: undefined,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      cancellationRequestedAt: undefined,
      result: undefined,
      failure: undefined
    })
  )

const attempt = (): AttemptRecord =>
  unwrap(
    validateAttemptRecord({
      attempt: 1,
      delivery: 1,
      startedAt: 100,
      finishedAt: 200,
      outcome: 'completed',
      result: { ok: true, text: '通知\u0000' },
      failure: undefined
    })
  )

describe('Redis codecs', () => {
  test('round-trips complete records and preserves NUL/Unicode JSON', () => {
    const encoded = encodeJobRecord(record())
    expect(encoded.payload).toBe('{"a":["通知","\\u0000"],"z":1}')
    expect(encoded.metadata).toBe('{"a":"first","z":"last"}')

    const decoded = decodeJobRecord(encoded)
    expect(Result.isError(decoded)).toBe(false)
    if (Result.isError(decoded)) return
    expect(decoded.value).toEqual(record())
    expect(Object.isFrozen(decoded.value)).toBe(true)
  })

  test('canonicalizes equivalent JSON object insertion orders', () => {
    const first = encodeJobRecord(record({ first: 1, second: { z: 2, a: 3 } }))
    const second = encodeJobRecord(record({ second: { a: 3, z: 2 }, first: 1 }))
    expect(first.payload).toBe(second.payload)
  })

  test('encodes and decodes attempt ledger JSON', () => {
    const encoded = encodeAttempt(attempt())
    const decoded = decodeAttempt(encoded)
    expect(Result.isError(decoded)).toBe(false)
    if (Result.isError(decoded)) return
    expect(decoded.value).toEqual(attempt())
  })

  test('fails closed for corrupt hashes and keeps sensitive values out of errors', () => {
    const fields = { ...encodeJobRecord(record()) } as Record<string, string>
    delete fields.payload
    const missing = decodeJobRecord(fields)
    expect(Result.isError(missing)).toBe(true)

    const corrupt: Record<string, string> = {
      ...encodeJobRecord(record()),
      payload: '{"secret":"do-not-log"}'
    }
    delete corrupt.metadata
    const invalid = decodeJobRecord(corrupt)
    expect(Result.isError(invalid)).toBe(true)
    if (Result.isError(invalid)) {
      expect(invalid.error.message).not.toContain('do-not-log')
    }

    const unknown: Record<string, string> = { ...encodeJobRecord(record()), unexpected: 'field' }
    expect(Result.isError(decodeJobRecord(unknown))).toBe(true)
    expect(Result.isError(decodeAttempt('{"outcome":"unknown"}'))).toBe(true)
  })

  test('rejects accessors before encoding and does not execute them', () => {
    const source = { ...record() } as unknown as Record<string, unknown>
    Object.defineProperty(source, 'payload', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute')
      }
    })
    expect(() => encodeJobRecord(source as unknown as JobRecord)).toThrow()

    const sourceAttempt = { ...attempt() } as unknown as Record<string, unknown>
    Object.defineProperty(sourceAttempt, 'result', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute')
      }
    })
    expect(() => encodeAttempt(sourceAttempt as unknown as AttemptRecord)).toThrow()
  })

  test('does not execute accessors or accept prototype-polluted fields', () => {
    const fields = encodeJobRecord(record())
    const getter = { ...fields } as Record<string, string>
    Object.defineProperty(getter, 'payload', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute')
      }
    })
    expect(Result.isError(decodeJobRecord(getter))).toBe(true)

    const inherited = Object.create({ payload: fields.payload }) as Record<string, string>
    Object.assign(inherited, fields)
    delete inherited.payload
    expect(Result.isError(decodeJobRecord(inherited))).toBe(true)
  })
})
