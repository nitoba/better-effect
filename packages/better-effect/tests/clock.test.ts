import { describe, expect, test } from 'bun:test'

import { Clock, ClockTest } from '../src/standard-services'

type ListenerCounts = {
  readonly added: () => number
  readonly removed: () => number
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- tests need to inspect arbitrary rejection causes.
const captureRejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (cause) => cause
  )

const observeAbortListeners = (signal: AbortSignal): ListenerCounts => {
  let added = 0
  let removed = 0
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)

  // SAFETY: The wrapper delegates every call and only counts abort listener registrations.
  signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
    if (args[0] === 'abort') {
      added += 1
    }

    return add(...args)
  }) as AbortSignal['addEventListener']

  // SAFETY: The wrapper delegates every call and only counts abort listener removals.
  signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
    if (args[0] === 'abort') {
      removed += 1
    }

    return remove(...args)
  }) as AbortSignal['removeEventListener']

  return {
    added: () => added,
    removed: () => removed
  }
}

describe('Clock', () => {
  test('rejects an already-aborted signal without adding a listener', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled before sleeping')
    controller.abort(reason)
    const listeners = observeAbortListeners(controller.signal)

    const waiting = new Clock().sleep(1_000, { signal: controller.signal })

    expect(await captureRejection(waiting)).toBe(reason)
    expect(listeners.added()).toBe(0)
    expect(listeners.removed()).toBe(0)
  })

  test('cancels a pending sleep and removes its abort listener', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled while sleeping')
    const listeners = observeAbortListeners(controller.signal)
    const waiting = new Clock().sleep(60_000, { signal: controller.signal })

    expect(listeners.added()).toBe(1)
    controller.abort(reason)

    expect(await captureRejection(waiting)).toBe(reason)
    expect(listeners.removed()).toBe(1)
  })

  test('removes its abort listener after a fulfilled sleep', async () => {
    const controller = new AbortController()
    const listeners = observeAbortListeners(controller.signal)

    await new Clock().sleep(0, { signal: controller.signal })

    expect(listeners.added()).toBe(1)
    expect(listeners.removed()).toBe(1)
  })

  test('uses an AbortError-compatible fallback when no reason is available', async () => {
    // SAFETY: The minimal signal shape intentionally exercises the undefined-reason fallback.
    const signal = {
      aborted: true,
      reason: undefined
    } as AbortSignal

    const cause = await captureRejection(new Clock().sleep(1, { signal }))

    expect(cause).toBeInstanceOf(Error)
    if (cause instanceof Error) {
      expect(cause.name).toBe('AbortError')
    }
  })
})

describe('ClockTest', () => {
  test('orders deadlines ascending and equal deadlines FIFO', async () => {
    const clock = new ClockTest(0)
    const order: string[] = []
    const waits = [
      clock.sleep(30).then(() => order.push('30')),
      clock.sleep(10).then(() => order.push('10-first')),
      clock.sleep(10).then(() => order.push('10-second')),
      clock.sleep(20).then(() => order.push('20'))
    ]

    expect(clock.pendingSleeps).toBe(4)
    expect(clock.advanceToNext()).toBe(true)
    expect(clock.now().getTime()).toBe(10)
    await Promise.resolve()
    expect(order).toEqual(['10-first', '10-second'])
    expect(clock.pendingSleeps).toBe(2)

    expect(clock.advanceToNext()).toBe(true)
    expect(clock.now().getTime()).toBe(20)
    await Promise.resolve()
    expect(order).toEqual(['10-first', '10-second', '20'])

    expect(clock.advanceToNext()).toBe(true)
    expect(clock.now().getTime()).toBe(30)
    await Promise.all(waits)
    expect(order).toEqual(['10-first', '10-second', '20', '30'])
    expect(clock.pendingSleeps).toBe(0)
    expect(clock.advanceToNext()).toBe(false)
  })

  test('removes cancelled waits from the pending queue', async () => {
    const clock = new ClockTest(0)
    const controller = new AbortController()
    const reason = new Error('test cancellation')
    const waiting = clock.sleep(100, { signal: controller.signal })

    expect(clock.pendingSleeps).toBe(1)
    controller.abort(reason)

    expect(await captureRejection(waiting)).toBe(reason)
    expect(clock.pendingSleeps).toBe(0)
    expect(clock.advanceToNext()).toBe(false)
  })

  test('runAll advances waits scheduled by resumed code', async () => {
    const clock = new ClockTest(0)
    const times: number[] = []
    const task = (async () => {
      await clock.sleep(10)
      times.push(clock.now().getTime())
      await clock.sleep(5)
      times.push(clock.now().getTime())
    })()

    expect(await clock.runAll()).toBe(2)
    await task
    expect(times).toEqual([10, 15])
    expect(clock.pendingSleeps).toBe(0)
  })

  test('runAll stops endlessly rescheduled waits at maxSteps', async () => {
    const clock = new ClockTest(0)
    const controller = new AbortController()
    const reason = new Error('stop loop')
    const loop = (async () => {
      while (true) {
        await clock.sleep(1, { signal: controller.signal })
      }
    })()

    const guardFailure = await captureRejection(clock.runAll({ maxSteps: 3 }))
    expect(guardFailure).toBeInstanceOf(RangeError)
    if (guardFailure instanceof RangeError) {
      expect(guardFailure.message).toMatch(/maxSteps/)
    }
    expect(clock.pendingSleeps).toBe(1)
    controller.abort(reason)
    expect(await captureRejection(loop)).toBe(reason)
    expect(clock.pendingSleeps).toBe(0)
  })

  test('documents backward setTime movement through absolute deadlines', async () => {
    const clock = new ClockTest(100)
    const waiting = clock.sleep(10)

    clock.setTime(90)
    expect(clock.now().getTime()).toBe(90)
    expect(clock.pendingSleeps).toBe(1)

    clock.setTime(110)
    await waiting
    expect(clock.pendingSleeps).toBe(0)
  })

  test('returns a clear no-wait result', async () => {
    const clock = new ClockTest()

    expect(clock.advanceToNext()).toBe(false)
    expect(await clock.runAll()).toBe(0)
  })
})
