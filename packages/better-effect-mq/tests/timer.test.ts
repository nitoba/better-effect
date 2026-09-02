// oxlint-disable anti-slop/no-chained-type-assertions -- fake timer handles are opaque test values.

import { expect, test } from 'bun:test'

import { maximumTimerDelay, scheduleDeadline, type TimerHandle } from '../src/worker/timer'

test('scheduleDeadline bounds a delay above the host timer limit', () => {
  let now = 0
  let fired = false
  const delays: number[] = []
  const handles = new Set<TimerHandle>()
  const schedule = (callback: () => void, delay: number): TimerHandle => {
    delays.push(delay)
    // SAFETY: the fake handle is opaque to scheduleDeadline and only used for cancellation.
    const handle = { callback } as unknown as TimerHandle
    handles.add(handle)
    return handle
  }
  const cancel = (handle: TimerHandle) => handles.delete(handle)
  scheduleDeadline(
    maximumTimerDelay + 10,
    () => {
      fired = true
    },
    () => now,
    schedule,
    cancel
  )

  expect(fired).toBe(false)
  expect(delays).toEqual([maximumTimerDelay])
})

test('scheduleDeadline preserves a short duration at the maximum safe clock value', () => {
  let fired = false
  const delays: number[] = []
  const handles = new Set<TimerHandle>()
  const schedule = (callback: () => void, delay: number): TimerHandle => {
    delays.push(delay)
    // SAFETY: the fake handle is opaque to scheduleDeadline.
    const handle = { callback } as unknown as TimerHandle
    handles.add(handle)
    return handle
  }
  const cancel = (handle: TimerHandle) => handles.delete(handle)
  scheduleDeadline(
    2,
    () => {
      fired = true
    },
    () => Number.MAX_SAFE_INTEGER,
    schedule,
    cancel
  )

  expect(delays).toEqual([2])
  expect(fired).toBe(false)
  expect(handles.size).toBe(1)
})

test('scheduleDeadline cancellation removes a pending timer', () => {
  let cancelledHandle: TimerHandle | undefined
  const schedule = (callback: () => void, _delay: number): TimerHandle => {
    void callback
    // SAFETY: the fake handle is opaque to scheduleDeadline.
    return {} as TimerHandle
  }
  const cancel = (handle: TimerHandle) => {
    cancelledHandle = handle
  }
  const stop = scheduleDeadline(
    10,
    () => undefined,
    () => 0,
    schedule,
    cancel
  )
  stop()
  expect(cancelledHandle).toBeDefined()
})

test('scheduleDeadline reschedules using remaining time', () => {
  let now = 0
  let fired = false
  const delays: number[] = []
  let pending: (() => void) | undefined
  const schedule = (callback: () => void, delay: number): TimerHandle => {
    delays.push(delay)
    pending = callback
    // SAFETY: the fake handle is opaque to scheduleDeadline.
    return {} as TimerHandle
  }
  const cancel = () => undefined
  scheduleDeadline(
    maximumTimerDelay + 10,
    () => {
      fired = true
    },
    () => now,
    schedule,
    cancel
  )

  now = maximumTimerDelay
  pending?.()
  expect(fired).toBe(false)
  expect(delays).toEqual([maximumTimerDelay, 10])
  now += 10
  pending?.()
  pending?.()
  expect(fired).toBe(true)
})
