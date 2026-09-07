/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread, anti-slop/no-unknown-returns, eslint(require-yield) -- SSE translates untrusted bytes and heterogeneous Standard Schema outputs at one codec boundary. */
import { createParser } from 'eventsource-parser'
import type { EventSourceMessage, ParseError } from 'eventsource-parser'
import { SchemaExecutionFailure, decodeUnknownAsync } from 'better-effect-schema'
import { Result } from 'better-result'
import {
  HttpAbortError,
  HttpDecodeError,
  HttpHookError,
  HttpRequestError,
  HttpStatusError,
  HttpTimeoutError
} from '../../errors'
import type { HttpError } from '../../errors'
import type { TransportOptions, TransportRequest } from '../../internal/ofetch-transport'
import { executeRequest } from '../../internal/ofetch-transport'
import { linkSignals } from '../../internal/signals'
import { StreamSession } from '../../stream/session'
import type { HttpStream } from '../../stream/description'
import type { HttpStreamError } from '../../stream/errors'
import { HttpStreamUnexpectedEndError } from '../../stream/errors'
import type { StreamUseCallback } from '../../stream/terminals'
import { SseLimitError, SseParseError, SseResponseError, SseUnexpectedEventError } from './errors'
import type { SseError } from './errors'
import type {
  SseEventMap,
  SseEventMessage,
  SseEventsOptions,
  SseLimits,
  SseMessage,
  SseOptions,
  SseRawOptions,
  SseSchemaOptions,
  SseTimeout
} from './types'
import type { HttpSchema, SchemaOutput } from '../../schema'

export type SseStreamError = HttpError | HttpStreamError | SseError

type AnySseOptions = SseOptions<HttpSchema, SseEventMap> & {
  readonly schema?: HttpSchema
  readonly events?: SseEventMap
}

type SseRequest = Readonly<{
  readonly request: TransportRequest
  readonly timeout: SseTimeout | undefined
  readonly limits: SseLimits | undefined
  readonly schema: HttpSchema | undefined
  readonly events: SseEventMap | undefined
}>

type PendingEvent = Readonly<{
  readonly event: string
  readonly data: string
  readonly id: string | undefined
  readonly lastEventId: string
}>

const timeoutError = (timeout: number): HttpTimeoutError =>
  new HttpTimeoutError({ phase: 'timeout', timeout: Math.max(0, timeout) })

const isKnownError = (cause: unknown): cause is SseStreamError =>
  cause instanceof Error &&
  (cause instanceof HttpDecodeError ||
    cause instanceof HttpStatusError ||
    cause instanceof HttpTimeoutError ||
    cause instanceof SseParseError ||
    cause instanceof SseUnexpectedEventError ||
    cause instanceof SseLimitError ||
    cause instanceof SseResponseError ||
    cause.constructor.name.startsWith('Http'))

const requestFrom = (
  config: TransportOptions,
  path: string,
  options: AnySseOptions
): SseRequest => {
  const { method, reconnect, timeout, limits, schema, events, ...transport } = options
  if (reconnect !== undefined && reconnect !== false) {
    throw new HttpRequestError({
      phase: 'request',
      details: 'SSE reconnection is not supported by this client'
    })
  }
  if (schema !== undefined && events !== undefined) {
    throw new HttpRequestError({
      phase: 'request',
      details: 'SSE schema and events options are mutually exclusive'
    })
  }
  const headers = new Headers(config.headers)
  for (const [name, value] of new Headers(transport.headers)) headers.set(name, value)
  if (!headers.has('accept')) headers.set('accept', 'text/event-stream')
  const request: TransportRequest = {
    ...transport,
    method: method ?? 'GET',
    path,
    headers
  }
  return { request, timeout, limits, schema, events }
}

const limitError = (
  limit: 'maxLineBytes' | 'maxEventBytes' | 'maxBufferedEvents' | 'maxBufferBytes',
  actual: number,
  maximum: number
): SseLimitError => new SseLimitError({ phase: 'limit', limit, actual, maximum })

const makeByteLimiter = (limits: SseLimits | undefined) => {
  let lineBytes = 0
  let eventBytes = 0
  let pendingCr = false
  const check = (limit: 'maxLineBytes' | 'maxEventBytes' | 'maxBufferBytes', actual: number) => {
    const maximum = limits?.[limit]
    return maximum !== undefined && actual > maximum
      ? limitError(limit, actual, maximum)
      : undefined
  }
  return (chunk: Uint8Array): SseLimitError | undefined => {
    if (limits === undefined) return undefined
    for (const byte of chunk) {
      if (pendingCr) {
        if (byte === 0x0a) {
          pendingCr = false
          continue
        }
        pendingCr = false
      }
      if (byte === 0x0d || byte === 0x0a) {
        const lineFailure = check('maxLineBytes', lineBytes)
        if (lineFailure) return lineFailure
        if (lineBytes === 0) eventBytes = 0
        lineBytes = 0
        if (byte === 0x0d) pendingCr = true
        continue
      }
      lineBytes++
      eventBytes++
      const eventFailure = check('maxEventBytes', eventBytes) ?? check('maxBufferBytes', eventBytes)
      if (eventFailure) return eventFailure
    }
    return check('maxLineBytes', lineBytes)
  }
}

const decodeEvent = async (
  event: PendingEvent,
  schema: HttpSchema | undefined,
  events: SseEventMap | undefined
): Promise<SseMessage<string, unknown>> => {
  const eventSchema = events?.[event.event]
  if (
    events !== undefined &&
    (!Object.prototype.hasOwnProperty.call(events, event.event) || eventSchema === undefined)
  ) {
    throw new SseUnexpectedEventError({ phase: 'event', event: event.event })
  }
  const selected = eventSchema ?? schema
  if (selected === undefined) return event
  let input: unknown
  try {
    input = JSON.parse(event.data) as unknown
  } catch (cause) {
    throw new HttpDecodeError({ phase: 'decode', kind: 'provider', cause })
  }
  const result = await decodeUnknownAsync(selected, input)
  if (Result.isError(result)) {
    throw new HttpDecodeError({
      phase: 'decode',
      kind: result.error instanceof SchemaExecutionFailure ? 'provider' : 'schema',
      cause: result.error
    })
  }
  return { ...event, data: result.value }
}

const withTimeout = async (
  operation: Promise<Awaited<ReturnType<StreamSession['read']>>>,
  timeout: number | undefined,
  started: number,
  totalMs: number | false | undefined
): Promise<Awaited<ReturnType<StreamSession['read']>>> => {
  const remaining =
    totalMs === undefined || totalMs === false ? undefined : totalMs - (Date.now() - started)
  const duration =
    remaining === undefined
      ? timeout
      : timeout === undefined
        ? remaining
        : Math.min(timeout, remaining)
  if (duration !== undefined && duration <= 0) throw timeoutError(duration)
  if (duration === undefined) return await operation
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(duration)), duration)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const openWithTimeout = async (
  config: TransportOptions,
  description: SseRequest,
  started: number
): Promise<Response> => {
  const timeout = description.timeout
  const totalRemaining =
    timeout?.totalMs === undefined || timeout.totalMs === false
      ? undefined
      : timeout.totalMs - (Date.now() - started)
  const duration =
    totalRemaining === undefined
      ? timeout?.headersMs
      : timeout?.headersMs === undefined
        ? totalRemaining
        : Math.min(timeout.headersMs, totalRemaining)
  if (duration !== undefined && duration <= 0) throw timeoutError(duration)

  const controller = new AbortController()
  const linked = linkSignals(description.request.signal, controller.signal)
  const request = { ...description.request, signal: linked.signal }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const operation = executeRequest(config, request)
    if (duration === undefined) return await operation
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = timeoutError(duration)
          controller.abort(error)
          reject(error)
        }, duration)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    linked.dispose()
  }
}

const results = async function* (
  config: TransportOptions,
  description: SseRequest
): AsyncGenerator<Result<SseMessage<string, unknown>, SseStreamError>, void, unknown> {
  const started = Date.now()
  let session: StreamSession | undefined
  try {
    session = await openWithConfig(config, description, started)
    const decoder = new TextDecoder()
    const queue: PendingEvent[] = []
    let cursor = 0
    let lastEventId = ''
    let fatal: SseError | undefined
    const checkBytes = makeByteLimiter(description.limits)
    const maxBufferedEvents = description.limits?.maxBufferedEvents
    const parser = createParser({
      ...(description.limits?.maxBufferBytes === undefined
        ? {}
        : { maxBufferSize: description.limits.maxBufferBytes }),
      onEvent(event: EventSourceMessage) {
        if (maxBufferedEvents !== undefined && queue.length - cursor >= maxBufferedEvents) {
          fatal = limitError('maxBufferedEvents', queue.length - cursor + 1, maxBufferedEvents)
          return
        }
        if (event.id !== undefined) lastEventId = event.id
        queue.push({
          event: event.event ?? 'message',
          data: event.data,
          id: event.id,
          lastEventId
        })
      },
      onError(error: ParseError) {
        if (error.type === 'max-buffer-size-exceeded')
          fatal = new SseParseError({ phase: 'parse', cause: error })
      }
    })
    const drain = async function* (): AsyncGenerator<
      Result<SseMessage<string, unknown>, SseStreamError>,
      void,
      unknown
    > {
      while (cursor < queue.length) {
        const event = queue[cursor++]
        if (event === undefined) continue
        yield Result.ok(await decodeEvent(event, description.schema, description.events))
      }
      queue.length = 0
      cursor = 0
    }
    while (true) {
      const chunk = await withTimeout(
        session.read(),
        description.timeout?.readIdleMs,
        started,
        description.timeout?.totalMs
      )
      if (chunk.done) break
      const byteFailure = checkBytes(chunk.value)
      if (byteFailure) {
        yield Result.err(byteFailure)
        return
      }
      parser.feed(decoder.decode(chunk.value, { stream: true }))
      if (fatal) {
        yield Result.err(fatal)
        return
      }
      for await (const value of drain()) {
        yield value
      }
    }
    const tail = decoder.decode()
    if (tail !== '') parser.feed(tail)
    if (fatal) {
      yield Result.err(fatal)
      return
    }
    for await (const value of drain()) {
      yield value
    }
    parser.reset()
  } catch (cause) {
    if (isKnownError(cause)) {
      yield Result.err(cause)
      return
    }
    if (cause instanceof Error && cause.name === 'AbortError') {
      yield Result.err(new HttpAbortError({ phase: 'abort', cause }))
      return
    }
    yield Result.err(new SseParseError({ phase: 'parse', cause }))
  } finally {
    await session?.close().catch(() => undefined)
  }
}

const openWithConfig = async (
  config: TransportOptions,
  description: SseRequest,
  started = Date.now()
): Promise<StreamSession> => {
  const response = await openWithTimeout(config, description, started)
  if (response.status === 204) return await StreamSession.make(response)
  if (!response.ok) {
    await response.body?.cancel()
    throw new HttpStatusError({
      phase: 'status',
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      url: response.url
    })
  }
  const contentType = response.headers.get('content-type')
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/event-stream') {
    await response.body?.cancel()
    throw new SseResponseError({
      phase: 'response',
      reason: 'mime',
      status: response.status,
      ...(contentType === null ? {} : { contentType })
    })
  }
  if (response.body === null)
    throw new SseResponseError({ phase: 'response', reason: 'body', status: response.status })
  return await StreamSession.make(response)
}

const make = <A extends SseMessage>(
  config: TransportOptions,
  description: SseRequest
): HttpStream<A, SseStreamError, never> => {
  const request = Object.freeze({
    method: description.request.method,
    path: description.request.path,
    options: (() => {
      const { method: _method, path: _path, ...options } = description.request
      return Object.freeze(options)
    })()
  })
  const openResults = () => results(config, description)
  const safeResults = () =>
    (async function* () {
      try {
        yield* openResults()
      } catch (cause) {
        if (isKnownError(cause)) yield Result.err(cause)
        else throw cause
      }
    })()
  return Object.freeze({
    request,
    results: async function* () {
      yield* safeResults()
    },
    forEach: (
      callback: (
        value: A,
        index: number
      ) => Result<unknown, unknown> | Promise<Result<unknown, unknown>>
    ) =>
      // oxlint-disable-next-line require-yield -- terminal preserves the existing lazy Result generator contract.
      (async function* () {
        let index = 0
        for await (const item of safeResults()) {
          if (Result.isError(item)) return Result.err(item.error)
          let outcome: Result<unknown, unknown>
          try {
            outcome = await callback(item.value as A, index++)
          } catch (cause) {
            return Result.err(new HttpHookError({ phase: 'hook', cause }))
          }
          if (Result.isError(outcome)) return Result.err(outcome.error)
        }
        return Result.ok(undefined)
      })(),
    takeUntil: (
      predicate: (value: A) => boolean | Promise<boolean>,
      options?: { readonly requireMatch?: boolean }
    ) =>
      // oxlint-disable-next-line require-yield -- terminal preserves the existing lazy Result generator contract.
      (async function* () {
        for await (const item of safeResults()) {
          if (Result.isError(item)) return Result.err(item.error)
          const value = item.value as A
          try {
            if (await predicate(value)) return Result.ok(value)
          } catch (cause) {
            return Result.err(new HttpHookError({ phase: 'hook', cause }))
          }
        }
        return options?.requireMatch
          ? Result.err(new HttpStreamUnexpectedEndError({ phase: 'takeUntil' }))
          : Result.ok(undefined as never)
      })(),
    use: (callback: StreamUseCallback<unknown>) =>
      // oxlint-disable-next-line require-yield -- terminal preserves the existing lazy Result generator contract.
      (async function* () {
        let session: StreamSession | undefined
        try {
          const opened = await openWithConfig(config, description)
          session = opened
          const value = callback({
            body: opened.bodyStream,
            cancel: async () => opened.close()
          })
          return (await (typeof value === 'function' ? value() : value)) as Result<unknown, unknown>
        } catch (cause) {
          if (isKnownError(cause)) return Result.err(cause)
          return Result.err(new HttpHookError({ phase: 'hook', cause }))
        } finally {
          await session?.close().catch(() => undefined)
        }
      })(),
    pipeTo: () =>
      // oxlint-disable-next-line require-yield -- terminal preserves the existing lazy Result generator contract.
      (async function* () {
        return Result.err(
          new SseParseError({
            phase: 'parse',
            cause: new Error('pipeTo is only available for byte streams')
          })
        )
      })()
  }) as HttpStream<A, SseStreamError, never>
}

export function sse<Schema extends HttpSchema>(
  config: TransportOptions,
  path: string,
  options: SseSchemaOptions<Schema>
): HttpStream<SseMessage<string, SchemaOutput<Schema>>, SseStreamError, never>
export function sse<Events extends SseEventMap>(
  config: TransportOptions,
  path: string,
  options: SseEventsOptions<Events>
): HttpStream<SseEventMessage<Events>, SseStreamError, never>
export function sse(
  config: TransportOptions,
  path: string,
  options?: SseRawOptions
): HttpStream<SseMessage<string, string>, SseStreamError, never>
export function sse(
  config: TransportOptions,
  path: string,
  options: AnySseOptions = {}
): HttpStream<SseMessage, SseStreamError, never> {
  const description = requestFrom(config, path, options)
  return make(config, description)
}
