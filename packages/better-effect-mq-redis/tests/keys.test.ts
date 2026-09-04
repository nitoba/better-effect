// oxlint-disable anti-slop/no-chained-type-assertions -- malformed runtime values intentionally bypass the string API in rejection tests.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- malformed runtime values are deliberately passed to test fail-closed validation.

import { describe, expect, test } from 'bun:test'

import {
  MAX_KEY_SEGMENT_BYTES,
  assertSameRedisHashSlot,
  decodeDelayedMember,
  decodeIdentity,
  decodeKeySegment,
  decodeWaitingMember,
  encodeDelayedMember,
  encodeIdentity,
  encodeKeySegment,
  encodeWaitingMember,
  makeRedisKeyLayout,
  redisHashSlot,
  waitingScore,
  RedisLayoutError
} from '../src/index'

describe('Redis key layout', () => {
  test('uses one Cluster hash slot for every namespace key', () => {
    const layout = makeRedisKeyLayout('better-effect-mq', 'notifications')
    const keys = [
      layout.job('job-1'),
      layout.attempts('job-1'),
      layout.sequenceJobs,
      layout.sequenceOutcome,
      layout.identities('mail'),
      layout.waiting('mail', 'send:email', 1),
      layout.delayed('mail', 'send:email', 1),
      layout.active,
      layout.queues,
      layout.queue('mail'),
      layout.wake,
      layout.layoutLock,
      layout.counts,
      layout.idempotency('scope'),
      layout.all,
      layout.byQueue('mail'),
      layout.byIdentity('send:email', 1),
      layout.byState('waiting'),
      layout.finished('completed'),
      layout.created,
      layout.runAt,
      layout.finishedAt,
      layout.layout
    ]

    expect(new Set(keys.map(redisHashSlot)).size).toBe(1)
    expect(assertSameRedisHashSlot(keys)).toBe(redisHashSlot(keys[0]!))
  })

  test('round-trips delimiter-heavy and Unicode key segments', () => {
    const values = ['plain-id', 'a:b/{c}?', '通知/é', `nul-${'x'.repeat(5)}`]
    for (const value of values) expect(decodeKeySegment(encodeKeySegment(value))).toBe(value)

    const identity = encodeIdentity('send:通知', Number.MAX_SAFE_INTEGER)
    expect(decodeIdentity(identity)).toEqual({
      name: 'send:通知',
      version: Number.MAX_SAFE_INTEGER
    })

    const waiting = encodeWaitingMember(Number.MAX_SAFE_INTEGER, 42, 'job:通知')
    expect(decodeWaitingMember(waiting)).toEqual({
      runAt: Number.MAX_SAFE_INTEGER,
      orderingSequence: 42,
      jobId: 'job:通知'
    })

    const delayed = encodeDelayedMember(42, 'job:通知')
    expect(decodeDelayedMember(delayed)).toEqual({ orderingSequence: 42, jobId: 'job:通知' })
  })

  test('keeps priority independent from safe-integer member ordering', () => {
    expect(waitingScore(Number.MAX_SAFE_INTEGER)).toBe(-Number.MAX_SAFE_INTEGER)
    expect(waitingScore(-Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    const member = encodeWaitingMember(1, Number.MAX_SAFE_INTEGER, 'job')
    expect(member).toContain('0000000000000001')
    expect(member).toContain('9007199254740991')
  })

  test('rejects malformed layout input', () => {
    expect(() => makeRedisKeyLayout('prefix{bad}', 'namespace')).toThrow(RedisLayoutError)
    expect(() => makeRedisKeyLayout('prefix', '{bad}')).toThrow(RedisLayoutError)
    expect(() => encodeKeySegment('')).toThrow(RedisLayoutError)
    expect(() => encodeKeySegment('\u0000')).toThrow(RedisLayoutError)
    expect(() => decodeKeySegment('~')).toThrow(RedisLayoutError)
    expect(() => decodeWaitingMember('0000000000000001:bad')).toThrow(RedisLayoutError)
    expect(() => decodeWaitingMember(1 as unknown as string)).toThrow(RedisLayoutError)
    expect(() => decodeDelayedMember(1 as unknown as string)).toThrow(RedisLayoutError)
    expect(() => decodeIdentity(1 as unknown as string)).toThrow(RedisLayoutError)
    expect(() => encodeDelayedMember(Number.MAX_SAFE_INTEGER + 1, 'job')).toThrow(RedisLayoutError)
    expect(() => encodeKeySegment('x'.repeat(MAX_KEY_SEGMENT_BYTES + 1))).toThrow(RedisLayoutError)
    expect(() => assertSameRedisHashSlot([])).toThrow(RedisLayoutError)
  })
})
