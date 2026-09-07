import { Scope } from 'better-effect'
import { expect, test } from 'bun:test'
import { HttpStreamConsumedError, HttpStreamReadError, StreamSession } from '../src/stream'

test('reads chunks on demand and releases the body at EOF', async () => {
  let pulls = 0
  let cancelled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      if (pulls === 1) controller.enqueue(new Uint8Array([1, 2]))
      else controller.close()
    },
    cancel() {
      cancelled++
    }
  })
  await Scope.run(async () => {
    const session = await StreamSession.make(new Response(body, { status: 200 }))
    // Response construction may perform one platform pull; the session itself
    // does not call read until its consumer asks for a chunk.
    expect(pulls).toBeLessThanOrEqual(1)
    expect(await session.read()).toEqual({ done: false, value: new Uint8Array([1, 2]) })
    expect(await session.read()).toEqual({ done: true })
    expect(cancelled).toBe(0)
    await expect(session.read()).rejects.toBeInstanceOf(HttpStreamConsumedError)
  })
})

test('turns a late reader failure into a typed stream error', async () => {
  const cause = new Error('late')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(cause)
    }
  })
  await Scope.run(async () => {
    const session = await StreamSession.make(new Response(body, { status: 200 }))
    await expect(session.read()).rejects.toMatchObject({
      _tag: 'HttpStreamReadError',
      bytesRead: 0
    })
    await expect(session.read()).rejects.toBeInstanceOf(HttpStreamConsumedError)
  })
  expect(new HttpStreamReadError({ phase: 'read', cause, bytesRead: 0 })).toBeInstanceOf(Error)
})
