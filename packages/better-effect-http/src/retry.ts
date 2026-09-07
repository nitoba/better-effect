import type { HttpError } from './errors'
export type HttpRetryDelay = (attempt: number) => number
export type HttpRetryOptions = Readonly<{
  readonly times: number
  readonly methods?: readonly string[]
  readonly delay?: HttpRetryDelay
  readonly respectRetryAfter?: boolean
  readonly totalMs?: number
  readonly when?: (input: { readonly error: HttpError; readonly attempt: number }) => boolean
}>
export type HttpRetryPolicy = HttpRetryOptions
const nonNegative = (name: string, value: number) => {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${name} must be finite and non-negative`)
}
const fixed = (milliseconds: number): HttpRetryDelay => {
  nonNegative('delay', milliseconds)
  return () => milliseconds
}
const exponential = (
  o: Readonly<{
    readonly initialMs: number
    readonly factor: number
    readonly maxMs?: number
    readonly jitter?: 'full'
  }>
): HttpRetryDelay => {
  nonNegative('initialMs', o.initialMs)
  if (!Number.isFinite(o.factor) || o.factor < 0)
    throw new RangeError('factor must be finite and non-negative')
  if (o.maxMs !== undefined) nonNegative('maxMs', o.maxMs)
  return (attempt) => {
    const raw = Math.min(
      o.maxMs ?? Number.MAX_SAFE_INTEGER,
      o.initialMs * o.factor ** Math.max(0, attempt - 1)
    )
    return o.jitter === 'full' ? Math.floor(raw * Math.random()) : raw
  }
}
const make = (o: HttpRetryOptions): HttpRetryPolicy => {
  if (!Number.isInteger(o.times) || o.times < 0)
    throw new RangeError('times must be a non-negative integer')
  if (o.totalMs !== undefined) nonNegative('totalMs', o.totalMs)
  return o
}
export const HttpRetry = {
  make,
  transient: (o: HttpRetryOptions) =>
    make({ ...o, methods: o.methods ?? ['GET', 'HEAD', 'OPTIONS'] }),
  fixed,
  exponential
} as const
export const retryableStatus = (status: number): boolean =>
  [408, 429, 500, 502, 503, 504].includes(status)
export const retryAfterMs = (value: string | null, now = Date.now()): number | undefined => {
  if (value === null || value.trim() === '') return undefined
  if (/^-\d+(?:\.\d+)?$/u.test(value.trim())) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) && date >= now ? date - now : undefined
}
