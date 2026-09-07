/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, eslint(require-yield) -- SSE translates untrusted bytes and heterogeneous Standard Schema outputs at one codec boundary. */
import { createParser } from 'eventsource-parser'
import type { EventSourceMessage, ParseError } from 'eventsource-parser'
import { SchemaExecutionFailure, decodeUnknownAsync } from 'better-effect-schema'
import { Result } from 'better-result'
import { CurrentAbortSignal } from 'better-effect'
import {
  HttpAbortError,
  HttpDecodeError,
  HttpHookError,
  HttpRequestError,
  HttpStatusError,
  HttpTimeoutError
} from '../../errors'
import type { HttpError } from '../../errors'
import type { HttpAdmission } from '../../limits'
import type { TransportOptions, TransportRequest } from '../../internal/ofetch-transport'
import { executeRequest } from '../../internal/ofetch-transport'
import { applyRequestInterceptors, notifyStreamReconnect } from '../../internal/hooks'
import type { HttpHook } from '../../internal/hooks'
import { linkSignals } from '../../internal/signals'
import { HttpRequest } from '../../request'
import type { HttpRequest as HttpRequestType } from '../../request'
import type { HttpStreamReconnectContext } from '../../interceptors'
import { StreamSession } from '../../stream/session'
import type { HttpStream } from '../../stream/description'
import { HttpStreamReadError, HttpStreamUnexpectedEndError } from '../../stream/errors'
import type { HttpStreamError } from '../../stream/errors'
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
  SseReconnectOptions,
  SseRawOptions,
  SseSchemaOptions,
  SseTimeout
} from './types'
import { SseCursor } from './cursor'
import {
  localDelay,
  reconnectable,
  reconnectReason,
  retryAfter,
  validateReconnect,
  wait
} from './reconnect'
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
  readonly lastEventId: string
  readonly reconnect: false | SseReconnectOptions | undefined
}>

type SseLimiter = Readonly<{
  readonly admit: (signal?: AbortSignal) => Promise<HttpAdmission>
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
    cause instanceof HttpStreamReadError ||
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
  const { method, lastEventId, reconnect, timeout, limits, schema, events, ...transport } = options
  validateReconnect(reconnect)
  const requestMethod = (method ?? 'GET').toUpperCase()
  if (
    reconnect !== undefined &&
    reconnect !== false &&
    (!['GET', 'HEAD', 'OPTIONS'].includes(requestMethod) || transport.body !== undefined)
  ) {
    throw new HttpRequestError({
      phase: 'request',
      details: 'SSE reconnection requires a replayable bodyless safe method'
    })
  }
  if (schema !== undefined && events !== undefined) {
    throw new HttpRequestError({
      phase: 'request',
      details: 'SSE schema and events options are mutually exclusive'
    })
  }
  let headers: Headers
  try {
    headers = new Headers(config.headers)
    for (const [name, value] of new Headers(transport.headers)) headers.set(name, value)
  } catch (cause) {
    throw new HttpRequestError({ phase: 'request', cause })
  }
  if (!headers.has('accept')) headers.set('accept', 'text/event-stream')
  const optionCursor = lastEventId
  const headerCursor = headers.get('last-event-id')
  const initialCursor = optionCursor ?? headerCursor ?? ''
  if (initialCursor.includes('\0') || initialCursor.includes('\r') || initialCursor.includes('\n'))
    throw new HttpRequestError({
      phase: 'request',
      details: 'SSE Last-Event-ID contains an illegal character'
    })
  if (optionCursor !== undefined) {
    if (optionCursor === '') headers.delete('last-event-id')
    else headers.set('last-event-id', optionCursor)
  }
  const request: TransportRequest = {
    ...transport,
    method: requestMethod,
    path,
    headers
  }
  return { request, timeout, limits, schema, events, lastEventId: initialCursor, reconnect }
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

type OpenedSse = Readonly<{
  readonly session: StreamSession
  readonly admission: HttpAdmission | undefined
  readonly status: number
}>

type ConnectionOutcome =
  | Readonly<{ readonly kind: 'eof' }>
  | Readonly<{ readonly kind: 'error'; readonly cause: unknown }>

type CursorSlot = {
  readonly id: string
  readonly hasData: boolean
  event?: EventSourceMessage
}

type ParsedOutput =
  | Readonly<{ readonly kind: 'event'; readonly event: PendingEvent }>
  | Readonly<{ readonly kind: 'cursor'; readonly value: string }>

type ConnectionState = {
  serverRetryMs: number | undefined
}

const totalExpired = (description: SseRequest, started: number): boolean =>
  description.timeout?.totalMs !== undefined &&
  description.timeout.totalMs !== false &&
  Date.now() - started >= description.timeout.totalMs

const currentAbortSignal = (): AbortSignal | undefined => {
  try {
    return CurrentAbortSignal[Symbol.iterator]().next().value as AbortSignal | undefined
  } catch {
    return undefined
  }
}

const isAborted = (description: SseRequest): boolean =>
  description.request.signal?.aborted === true || currentAbortSignal()?.aborted === true

const requestForCursor = (description: SseRequest, cursor: string): SseRequest => {
  if (description.reconnect === undefined || description.reconnect === false) return description
  const headers = new Headers(description.request.headers)
  if (description.reconnect.resume === 'last-event-id' && cursor === '')
    headers.delete('last-event-id')
  else if (description.reconnect.resume === 'last-event-id') headers.set('last-event-id', cursor)
  return { ...description, request: { ...description.request, headers } }
}

const requestWithHooks = async (
  description: SseRequest,
  hooks: readonly HttpHook[]
): Promise<SseRequest> => {
  if (hooks.length === 0) return description
  const initial = HttpRequest.make(description.request.path, {
    method: description.request.method,
    headers: new Headers(description.request.headers),
    ...(description.request.query === undefined ? {} : { query: description.request.query }),
    // SAFETY: the hook boundary accepts the same JSON/BodyInit values as TransportRequest.
    ...(description.request.body === undefined
      ? {}
      : { body: description.request.body as NonNullable<HttpRequestType['body']> })
  })
  const transformed = await applyRequestInterceptors(hooks, initial)
  if (Result.isError(transformed)) throw transformed.error
  const request: TransportRequest = {
    ...description.request,
    method: transformed.value.method,
    headers: transformed.value.headers,
    ...(transformed.value.body === undefined ? {} : { body: transformed.value.body }),
    ...(transformed.value.query === undefined
      ? {}
      : {
          // SAFETY: TransportRequest's query is the narrowed ofetch query shape used at this boundary.
          query: transformed.value.query as NonNullable<TransportRequest['query']>
        })
  }
  return { ...description, request }
}

const admitWithDeadline = async (
  limiter: SseLimiter | undefined,
  description: SseRequest,
  started: number
): Promise<HttpAdmission | undefined> => {
  if (limiter === undefined) return undefined
  const totalMs = description.timeout?.totalMs
  const remaining =
    totalMs === undefined || totalMs === false ? undefined : totalMs - (Date.now() - started)
  if (remaining !== undefined && remaining <= 0) throw timeoutError(remaining)
  const external = linkSignals(description.request.signal, currentAbortSignal())
  if (remaining === undefined) {
    try {
      return await limiter.admit(external.signal)
    } finally {
      external.dispose()
    }
  }
  const controller = new AbortController()
  const linked = linkSignals(external.signal, controller.signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      limiter.admit(linked.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = timeoutError(remaining)
          controller.abort(error)
          reject(error)
        }, remaining)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    linked.dispose()
    external.dispose()
  }
}

const openWithConfig = async (
  config: TransportOptions,
  description: SseRequest,
  cursor: string,
  limiter: SseLimiter | undefined,
  hooks: readonly HttpHook[],
  started = Date.now()
): Promise<OpenedSse> => {
  const admission = await admitWithDeadline(limiter, description, started)
  try {
    const request = await requestWithHooks(requestForCursor(description, cursor), hooks)
    const response = await openWithTimeout(config, request, started)
    if (response.status === 204)
      return { session: await StreamSession.make(response), admission, status: response.status }
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
    return { session: await StreamSession.make(response), admission, status: response.status }
  } catch (cause) {
    admission?.release()
    throw cause
  }
}

const normalizeFailure = (cause: unknown): SseStreamError => {
  if (isKnownError(cause)) return cause
  if (cause instanceof Error && cause.name === 'AbortError')
    return new HttpAbortError({ phase: 'abort', cause })
  return new SseParseError({ phase: 'parse', cause })
}

const consumeConnection = async function* (
  session: StreamSession,
  description: SseRequest,
  initialCursor: string,
  state: ConnectionState,
  started: number,
  committed: { value: string }
): AsyncGenerator<Result<SseMessage<string, unknown>, SseStreamError>, ConnectionOutcome, unknown> {
  const decoder = new TextDecoder()
  const slots: CursorSlot[] = []
  const outputs: ParsedOutput[] = []
  let outputIndex = 0
  let fatal: SseError | undefined
  let bufferedEvents = 0
  const checkBytes = makeByteLimiter(description.limits)
  const maxBufferedEvents = description.limits?.maxBufferedEvents
  const cursor = new SseCursor(initialCursor)
  const parser = createParser({
    ...(description.limits?.maxBufferBytes === undefined
      ? {}
      : { maxBufferSize: description.limits.maxBufferBytes }),
    onEvent(event: EventSourceMessage) {
      const slot = slots.find((candidate) => candidate.hasData && candidate.event === undefined)
      if (slot === undefined) {
        outputs.push({
          kind: 'event',
          event: {
            event: event.event ?? 'message',
            data: event.data,
            id: event.id,
            lastEventId: event.id ?? initialCursor
          }
        })
        return
      }
      if (maxBufferedEvents !== undefined && bufferedEvents >= maxBufferedEvents) {
        fatal = limitError('maxBufferedEvents', bufferedEvents + 1, maxBufferedEvents)
        return
      }
      bufferedEvents++
      slot.event = event
    },
    onRetry(interval) {
      state.serverRetryMs = interval
    },
    onError(error: ParseError) {
      if (error.type === 'max-buffer-size-exceeded')
        fatal = new SseParseError({ phase: 'parse', cause: error })
    }
  })
  const drainSlots = (): void => {
    while (slots[0] !== undefined) {
      const slot = slots[0]
      if (slot.hasData && slot.event === undefined) return
      slots.shift()
      if (!slot.hasData) outputs.push({ kind: 'cursor', value: slot.id })
      else if (slot.event !== undefined) {
        outputs.push({
          kind: 'event',
          event: {
            event: slot.event.event ?? 'message',
            data: slot.event.data,
            id: slot.event.id,
            lastEventId: slot.id
          }
        })
      }
    }
  }
  const drainOutputs = async function* (): AsyncGenerator<
    Result<SseMessage<string, unknown>, SseStreamError>,
    void,
    unknown
  > {
    while (outputIndex < outputs.length) {
      const output = outputs[outputIndex++]
      if (output === undefined) continue
      if (output.kind === 'cursor') {
        committed.value = output.value
        continue
      }
      committed.value = output.event.lastEventId
      yield Result.ok(await decodeEvent(output.event, description.schema, description.events))
    }
    outputs.length = 0
    outputIndex = 0
    bufferedEvents = 0
  }
  try {
    while (true) {
      const chunk = await withTimeout(
        session.read(),
        description.timeout?.readIdleMs,
        started,
        description.timeout?.totalMs
      )
      if (chunk.done) break
      const byteFailure = checkBytes(chunk.value)
      if (byteFailure) return { kind: 'error', cause: byteFailure }
      const text = decoder.decode(chunk.value, { stream: true })
      cursor.feed(text, (frame) => slots.push({ ...frame }))
      parser.feed(text)
      drainSlots()
      if (fatal !== undefined) return { kind: 'error', cause: fatal }
      for await (const value of drainOutputs()) yield value
    }
    const tail = decoder.decode()
    if (tail !== '') {
      cursor.feed(tail, (frame) => slots.push({ ...frame }))
      parser.feed(tail)
      drainSlots()
    }
    if (fatal !== undefined) return { kind: 'error', cause: fatal }
    for await (const value of drainOutputs()) yield value
    parser.reset()
    return { kind: 'eof' }
  } catch (cause) {
    return { kind: 'error', cause: normalizeFailure(cause) }
  }
}

const results = async function* (
  config: TransportOptions,
  description: SseRequest,
  limiter: SseLimiter | undefined,
  hooks: readonly HttpHook[]
): AsyncGenerator<Result<SseMessage<string, unknown>, SseStreamError>, void, unknown> {
  const started = Date.now()
  const reconnect = description.reconnect
  const state: ConnectionState = { serverRetryMs: undefined }
  const committed = { value: description.lastEventId }
  let reconnects = 0
  while (true) {
    let opened: OpenedSse | undefined
    let outcome: ConnectionOutcome
    try {
      opened = await openWithConfig(config, description, committed.value, limiter, hooks, started)
      if (opened.status === 204) return
      const connection = consumeConnection(
        opened.session,
        description,
        committed.value,
        state,
        started,
        committed
      )
      while (true) {
        const step = await connection.next()
        if (step.done) {
          outcome = step.value
          break
        }
        yield step.value
      }
    } catch (cause) {
      outcome = { kind: 'error', cause: normalizeFailure(cause) }
    } finally {
      await opened?.session.close().catch(() => undefined)
      opened?.admission?.release()
    }
    if (isAborted(description)) {
      yield Result.err(
        new HttpAbortError({
          phase: 'abort',
          cause: description.request.signal?.reason ?? currentAbortSignal()?.reason
        })
      )
      return
    }
    if (outcome.kind === 'eof') {
      if (
        reconnect === undefined ||
        reconnect === false ||
        reconnect.onEnd !== 'reconnect' ||
        reconnects >= reconnect.times
      )
        return
    } else if (
      reconnect === undefined ||
      reconnect === false ||
      !reconnectable(outcome.cause) ||
      reconnects >= reconnect.times ||
      totalExpired(description, started) ||
      isAborted(description)
    ) {
      yield Result.err(outcome.cause as SseStreamError)
      return
    }
    const nextAttempt = reconnects + 1
    let delay: number
    try {
      const local = localDelay(reconnect, nextAttempt)
      const server = reconnect.respectServerRetry ? (state.serverRetryMs ?? 0) : 0
      delay = Math.max(local, server, outcome.kind === 'error' ? retryAfter(outcome.cause) : 0)
    } catch (cause) {
      yield Result.err(new HttpRequestError({ phase: 'request', cause }))
      return
    }
    const totalMs = description.timeout?.totalMs
    if (totalMs !== undefined && totalMs !== false && Date.now() - started + delay >= totalMs) {
      if (outcome.kind === 'error') yield Result.err(outcome.cause as SseStreamError)
      return
    }
    try {
      const context: HttpStreamReconnectContext = {
        connection: reconnects + 2,
        attempt: nextAttempt,
        delayMs: delay,
        reason: outcome.kind === 'eof' ? 'eof' : reconnectReason(outcome.cause),
        lastEventId: committed.value
      }
      const observed = await notifyStreamReconnect(hooks, context)
      if (Result.isError(observed)) {
        yield Result.err(observed.error)
        return
      }
      const linked = linkSignals(description.request.signal, currentAbortSignal())
      try {
        await wait(delay, linked.signal)
      } finally {
        linked.dispose()
      }
    } catch (cause) {
      yield Result.err(normalizeFailure(cause))
      return
    }
    reconnects++
  }
}

const make = <A extends SseMessage>(
  config: TransportOptions,
  description: SseRequest,
  limiter: SseLimiter | undefined,
  hooks: readonly HttpHook[]
): HttpStream<A, SseStreamError, never> => {
  const request = Object.freeze({
    method: description.request.method,
    path: description.request.path,
    options: (() => {
      const { method: _method, path: _path, ...options } = description.request
      return Object.freeze(options)
    })()
  })
  const openResults = () => results(config, description, limiter, hooks)
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
    use: (callback: StreamUseCallback<unknown, unknown>) =>
      // oxlint-disable-next-line require-yield -- terminal preserves the existing lazy Result generator contract.
      (async function* () {
        let session: StreamSession | undefined
        let opened: OpenedSse | undefined
        try {
          opened = await openWithConfig(
            config,
            description,
            description.lastEventId,
            limiter,
            hooks
          )
          session = opened.session
          const openedSession = opened.session
          const value = callback({
            body: openedSession.bodyStream,
            cancel: async () => openedSession.close()
          })
          return (await (typeof value === 'function' ? value() : value)) as Result<unknown, unknown>
        } catch (cause) {
          if (isKnownError(cause)) return Result.err(cause)
          return Result.err(new HttpHookError({ phase: 'hook', cause }))
        } finally {
          await session?.close().catch(() => undefined)
          opened?.admission?.release()
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
  }) as unknown as HttpStream<A, SseStreamError, never>
}

export function sse<Schema extends HttpSchema>(
  config: TransportOptions,
  path: string,
  options: SseSchemaOptions<Schema>,
  limiter?: SseLimiter,
  hooks?: readonly HttpHook[]
): HttpStream<SseMessage<string, SchemaOutput<Schema>>, SseStreamError, never>
export function sse<Events extends SseEventMap>(
  config: TransportOptions,
  path: string,
  options: SseEventsOptions<Events>,
  limiter?: SseLimiter,
  hooks?: readonly HttpHook[]
): HttpStream<SseEventMessage<Events>, SseStreamError, never>
export function sse(
  config: TransportOptions,
  path: string,
  options?: SseRawOptions,
  limiter?: SseLimiter,
  hooks?: readonly HttpHook[]
): HttpStream<SseMessage<string, string>, SseStreamError, never>
export function sse(
  config: TransportOptions,
  path: string,
  options: AnySseOptions = {},
  limiter?: SseLimiter,
  hooks: readonly HttpHook[] = []
): HttpStream<SseMessage, SseStreamError, never> {
  const description = requestFrom(config, path, options)
  return make(config, description, limiter, hooks)
}
