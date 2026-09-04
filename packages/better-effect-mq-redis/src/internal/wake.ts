// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Result wrappers are contract boundary casts.
// oxlint-disable anti-slop/no-chained-type-assertions -- the optional Redis peer has incompatible callback overloads.
// oxlint-disable anti-slop/no-runtime-typeof -- optional unsubscribe capability is checked at the I/O boundary.
// oxlint-disable anti-slop/no-unknown-returns -- optional Redis client event methods expose driver values.
import { Result, type Result as ResultType } from 'better-result'
import { JobStoreFailure, JobStoreWakeAbortedError } from 'better-effect-mq'
import type { RedisSubscriberClient, MaybePromise } from '../config'

export type WakeResult = ResultType<void, any>
type WakeMessage = (message: string, channel: string) => MaybePromise<void>
type WakeReconnect = () => MaybePromise<void>

type EventfulSubscriber = RedisSubscriberClient & {
  on?: (event: string, listener: (...args: readonly unknown[]) => void) => unknown
  off?: (event: string, listener: (...args: readonly unknown[]) => void) => unknown
  removeListener?: (event: string, listener: (...args: readonly unknown[]) => void) => unknown
}

/**
 * Subscribe before a store is exposed and keep the optimization alive across
 * subscriber disconnects. Durable wake versions remain the correctness path;
 * reconnect failures only delay notifications and never alter job data.
 */
export const subscribeWake = async (
  subscriber: RedisSubscriberClient,
  channel: string,
  onWake: WakeMessage,
  onReconnect?: WakeReconnect,
  allowReconnect = false
): Promise<() => Promise<void>> => {
  const eventful = subscriber as EventfulSubscriber
  const subscribeMethod = subscriber.subscribe as unknown as (
    channel: string,
    listener: WakeMessage
  ) => MaybePromise<unknown>
  const subscribe = (targetChannel: string, listener: WakeMessage): MaybePromise<unknown> =>
    subscribeMethod.call(subscriber, targetChannel, listener)
  const unsubscribeMethod = subscriber.unsubscribe as
    | ((channel?: string, listener?: WakeMessage) => MaybePromise<unknown>)
    | undefined
  const unsubscribe = unsubscribeMethod
    ? (targetChannel?: string, listener?: WakeMessage): MaybePromise<unknown> =>
        unsubscribeMethod.call(subscriber, targetChannel, listener)
    : undefined
  // A borrowed client without unsubscribe cannot be made safe: subscribing
  // would leave this callback attached after the wait/store is disposed.
  // Durable wake polling remains the correctness path in that case.
  if (typeof subscriber.unsubscribe !== 'function') return async () => undefined
  let stopped = false
  let retryDelay = 25
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let reconnecting = false
  let reconnectPromise: Promise<void> | undefined

  const listener = async (message: string, receivedChannel: string): Promise<void> => {
    try {
      await onWake(message, receivedChannel)
    } catch {
      // A malformed notification is deliberately non-fatal. Polling versions
      // are authoritative and will still wake the waiting worker.
    }
  }
  const scheduleReconnect = (): void => {
    if (stopped || retryTimer !== undefined || reconnecting) return
    const delay = retryDelay
    retryDelay = Math.min(5_000, retryDelay * 2)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (stopped) return
      reconnecting = true
      const attempt = Promise.resolve().then(async () => {
        if (stopped) return
        try {
          if (subscriber.connect !== undefined && subscriber.isOpen !== true)
            await subscriber.connect()
          await subscribe(channel, listener)
        } catch (cause) {
          try {
            await unsubscribe?.(channel, listener)
          } catch {
            // The next durable poll remains the correctness path.
          }
          throw cause
        }
        if (stopped) await unsubscribe?.(channel, listener)
        else {
          retryDelay = 25
          try {
            await onReconnect?.()
          } catch {
            // Reconnect notifications are advisory; the subscription remains usable.
          }
        }
      })
      reconnectPromise = attempt
      void attempt
        .catch(() => undefined)
        .finally(() => {
          reconnecting = false
          if (reconnectPromise === attempt) reconnectPromise = undefined
          if (retryTimer === undefined && !stopped && retryDelay > 25) scheduleReconnect()
        })
    }, delay)
  }
  const onConnectionEvent = (event: string) => (): void => {
    if (allowReconnect && (event === 'error' || event === 'end')) scheduleReconnect()
  }
  const eventListeners = new Map<string, (...args: readonly unknown[]) => void>()
  const removeListeners = (): unknown[] => {
    const errors: unknown[] = []
    for (const [event, handler] of eventListeners) {
      const remove = eventful.off ?? eventful.removeListener
      try {
        remove?.call(eventful, event, handler)
      } catch (cause) {
        errors.push(cause)
      }
    }
    return errors
  }

  try {
    if (allowReconnect) {
      for (const event of ['error', 'end']) {
        const handler = onConnectionEvent(event)
        eventListeners.set(event, handler)
        eventful.on?.(event, handler)
      }
    }
    try {
      await subscribe(channel, listener)
    } catch (cause) {
      try {
        await unsubscribe?.(channel, listener)
      } catch (cleanupCause) {
        throw new AggregateError([cause, cleanupCause], 'Redis wake setup failed')
      }
      throw cause
    }
  } catch (cause) {
    stopped = true
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = undefined
    const errors = removeListeners()
    if (reconnectPromise !== undefined) await reconnectPromise.catch((error) => errors.push(error))
    if (errors.length > 0) throw new AggregateError([cause, ...errors], 'Redis wake setup failed')
    throw cause
  }

  return async (): Promise<void> => {
    stopped = true
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = undefined
    const errors = removeListeners()
    if (reconnectPromise !== undefined) await reconnectPromise.catch((cause) => errors.push(cause))
    try {
      await unsubscribe?.(channel, listener)
    } catch (cause) {
      errors.push(cause)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Redis wake cleanup failed')
  }
}

export const abortedWake = (): WakeResult =>
  Result.err(new JobStoreWakeAbortedError()) as WakeResult
export const wakeFailure = (message: string): WakeResult =>
  Result.err(
    new JobStoreFailure({ operation: 'awaitWake', retryable: false, message })
  ) as WakeResult
