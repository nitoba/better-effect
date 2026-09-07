import { HttpAbortError, HttpStatusError, HttpTimeoutError, HttpTransportError } from '../../errors'
import { HttpStreamReadError } from '../../stream/errors'
import { retryAfterMs, retryableStatus } from '../../retry'
import type { SseReconnectOptions, SseReconnectReason } from './types'

export const validateReconnect = (reconnect: false | SseReconnectOptions | undefined): void => {
  if (reconnect === undefined || reconnect === false) return
  if (!Number.isInteger(reconnect.times) || reconnect.times < 0)
    throw new RangeError('reconnect.times must be a non-negative integer')
}

export const reconnectReason = (cause: unknown): SseReconnectReason => {
  if (cause instanceof HttpStatusError) return 'status'
  if (cause instanceof HttpTimeoutError) return 'timeout'
  if (cause instanceof HttpStreamReadError) return 'read'
  if (cause instanceof HttpTransportError) return 'transport'
  return 'transport'
}

export const reconnectable = (cause: unknown): boolean =>
  cause instanceof HttpTransportError ||
  cause instanceof HttpStreamReadError ||
  (cause instanceof HttpTimeoutError && cause.timeout >= 0) ||
  (cause instanceof HttpStatusError && retryableStatus(cause.status))

export const retryAfter = (cause: unknown): number =>
  cause instanceof HttpStatusError ? (retryAfterMs(cause.headers.get('retry-after')) ?? 0) : 0

export const localDelay = (reconnect: SseReconnectOptions, attempt: number): number => {
  const delay = reconnect.delay?.(attempt) ?? 0
  if (!Number.isFinite(delay) || delay < 0)
    throw new RangeError('reconnect delay must be finite and non-negative')
  return delay
}

export const wait = async (
  milliseconds: number,
  signal: AbortSignal | undefined
): Promise<void> => {
  if (signal?.aborted) throw new HttpAbortError({ phase: 'abort', cause: signal.reason })
  if (milliseconds <= 0) return
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      if (timer !== undefined) clearTimeout(timer)
      reject(new HttpAbortError({ phase: 'abort', cause: signal?.reason }))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
