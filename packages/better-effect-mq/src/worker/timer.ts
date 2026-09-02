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
  const deadline = now() + delayMs
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
    const remaining = deadline - now()
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
        schedule()
      },
      Math.min(remaining, maximumTimerDelay)
    )
  }

  schedule()
  return cancel
}
