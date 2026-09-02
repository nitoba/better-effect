/** Maximum delay accepted by the host timer APIs without overflow/clamping. */
export const maximumTimerDelay = 2_147_483_646

export type TimerHandle = ReturnType<typeof setTimeout>
export type TimerScheduler = (callback: () => void, delayMs: number) => TimerHandle
export type TimerCanceller = (handle: TimerHandle) => void

/** Schedule a deadline without allowing large safe-integer delays to overflow. */
export const scheduleDeadline = (
  delayMs: number,
  callback: () => void,
  now: () => number = Date.now,
  scheduleTimer: TimerScheduler = setTimeout,
  cancelTimer: TimerCanceller = clearTimeout
): (() => void) => {
  // Keep the duration separate from the clock sample. Adding the two can lose
  // the duration or overflow when the clock is near MAX_SAFE_INTEGER.
  let lastNow = now()
  let remaining = delayMs
  let handle: TimerHandle | undefined
  let cancelled = false

  const cancel = (): void => {
    cancelled = true
    if (handle !== undefined) {
      cancelTimer(handle)
      handle = undefined
    }
  }

  const schedule = (): void => {
    if (cancelled) return
    if (remaining <= 0) {
      handle = scheduleTimer(() => {
        handle = undefined
        if (!cancelled) callback()
      }, 0)
      return
    }
    handle = scheduleTimer(
      () => {
        handle = undefined
        if (cancelled) return
        const currentNow = now()
        // A backwards clock must not extend the deadline. Only elapsed forward
        // movement consumes the duration, avoiding timestamp arithmetic.
        if (currentNow > lastNow) {
          remaining -= currentNow - lastNow
          lastNow = currentNow
        }
        schedule()
      },
      Math.min(remaining, maximumTimerDelay)
    )
  }

  schedule()
  return cancel
}
