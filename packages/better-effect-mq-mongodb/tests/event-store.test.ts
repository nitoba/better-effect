// oxlint-disable anti-slop/no-unsafe-dictionary-type -- this test records opaque BSON documents at the driver seam.
// oxlint-disable anti-slop/no-object-parameters -- the fake driver mirrors the optional MongoDB peer boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test doubles are intentionally cast to the narrow driver seam.

import { describe, expect, test } from 'bun:test'
import { appendMongoJobEvent } from '../src/event-store'

describe('MongoDB durable event append', () => {
  test('allocates a namespace-local cursor and passes one session to both writes', async () => {
    const session = { id: 'session' }
    const calls: string[] = []
    const events: Array<{ readonly document: Record<string, unknown>; readonly session: unknown }> =
      []
    const counters = {
      findOneAndUpdate: async (_filter: object, _update: object, options?: object) => {
        calls.push('counter')
        expect((options as { readonly session?: unknown }).session).toBe(session)
        return { value: { value: 12 } }
      }
    }
    const eventCollection = {
      insertOne: async (document: object, options?: object) => {
        calls.push('event')
        expect((options as { readonly session?: unknown }).session).toBe(session)
        events.push({
          document: document as Record<string, unknown>,
          session: (options as { readonly session?: unknown }).session
        })
      }
    }
    const db = {
      collection: (name: string) => (name.endsWith('_counters') ? counters : eventCollection)
    }
    const cursor = await appendMongoJobEvent(
      session as never,
      { db, namespace: 'billing', collectionPrefix: 'better_effect_mq' } as never,
      {
        type: 'job-enqueued',
        recordedAtMs: 10,
        jobId: 'job-1' as never,
        queue: 'emails' as never,
        name: 'send',
        version: 1,
        state: 'waiting',
        attempt: undefined,
        delivery: undefined,
        workerId: undefined,
        outcome: undefined,
        failureKind: undefined,
        duplicate: false,
        attributes: Object.freeze({})
      }
    )

    expect(calls).toEqual(['counter', 'event'])
    expect(events[0]?.document).toMatchObject({
      namespace: 'billing',
      cursor: 12,
      type: 'job-enqueued',
      jobId: 'job-1'
    })
    expect(cursor).toMatch(/^mo1_[0-9a-f]+_[0-9a-z]+$/u)
  })
})
