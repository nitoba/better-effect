import { HttpAbortError, HttpLimitError } from './errors'
export type HttpLimits = Readonly<{
  readonly concurrency?: number
  readonly rate?: Readonly<{ readonly requests: number; readonly perMs: number }>
  readonly queue?: Readonly<{ readonly maxSize: number }>
}>
const positive = (name: string, value: number) => {
  if (!Number.isInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive integer`)
}
export const validateHttpLimits = (limits: HttpLimits | undefined): void => {
  if (!limits) return
  if (limits.concurrency !== undefined) positive('concurrency', limits.concurrency)
  if (limits.rate) {
    positive('rate.requests', limits.rate.requests)
    positive('rate.perMs', limits.rate.perMs)
  }
  if (limits.queue) positive('queue.maxSize', limits.queue.maxSize)
}
export type HttpAdmission = { readonly release: () => void }
export const makeHttpLimiter = (limits: HttpLimits | undefined) => {
  validateHttpLimits(limits)
  if (!limits?.concurrency && !limits?.rate && !limits?.queue) return undefined
  let active = 0
  const queue: {
    signal: AbortSignal | undefined
    resolve: () => void
    reject: (cause: unknown) => void
    abort: () => void
  }[] = []
  const admissions: number[] = []
  const pump = () => {
    const time = Date.now()
    if (limits.rate)
      while (admissions[0] !== undefined && admissions[0] <= time - limits.rate.perMs)
        admissions.shift()
    while (
      queue.length &&
      (!limits.concurrency || active < limits.concurrency) &&
      (!limits.rate || admissions.length < limits.rate.requests)
    ) {
      const waiter = queue.shift()!
      if (waiter.signal?.aborted) {
        waiter.signal.removeEventListener('abort', waiter.abort)
        waiter.reject(new HttpAbortError({ phase: 'abort', cause: waiter.signal.reason }))
        continue
      }
      waiter.signal?.removeEventListener('abort', waiter.abort)
      active++
      if (limits.rate) admissions.push(time)
      waiter.resolve()
    }
    if (limits.rate && queue.length && admissions[0] !== undefined)
      setTimeout(pump, Math.max(0, admissions[0] + limits.rate.perMs - Date.now()))
  }
  const admit = (signal?: AbortSignal): Promise<HttpAdmission> => {
    if (signal?.aborted)
      return Promise.reject(new HttpAbortError({ phase: 'abort', cause: signal.reason }))
    if (limits.queue && queue.length >= limits.queue.maxSize)
      return Promise.reject(new HttpLimitError({ phase: 'admission', reason: 'queue-full' }))
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        const i = queue.indexOf(waiter)
        if (i >= 0) queue.splice(i, 1)
        signal?.removeEventListener('abort', abort)
        reject(new HttpAbortError({ phase: 'abort', cause: signal?.reason }))
      }
      const waiter = { signal, resolve, reject, abort }
      signal?.addEventListener('abort', abort, { once: true })
      queue.push(waiter)
      pump()
    }).then(() => {
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          active--
          pump()
        }
      }
    })
  }
  return { admit }
}
