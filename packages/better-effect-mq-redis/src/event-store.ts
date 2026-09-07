// oxlint-disable anti-slop/no-unknown-parameters -- Redis stream replies are validated at the adapter boundary.
// oxlint-disable anti-slop/no-unknown-returns -- event DTOs are decoded before entering the core contract.
// oxlint-disable anti-slop/no-runtime-typeof -- untyped Redis replies and public options are narrowed here.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts are confined to validated Redis/core boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions follow explicit validation.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- Redis stream and hash replies are validated here.

import { Layer, type ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  JobEventStore,
  JobEventCursorExpiredError,
  JobEventStoreFailure,
  jobEventExtension,
  jobEventExtensionVersion,
  type AnyJobEventStoreToken,
  type AwaitEventsOptions,
  type DurableJobEvent,
  type DurableJobEventType,
  type JobEventPage,
  type JobEventReadOptions,
  type JobEventStoreDescriptor,
  type JobEventCursor
} from 'better-effect-mq'
import { RedisClient } from './client'
import {
  sendRedisCommand,
  type RedisJobStoreConfig,
  type RedisJobStoreConnectionConfig
} from './config'
import { normalizeEventOptions, type RedisJobEventStoreOptions } from './event-codec'
import { subscribeWake } from './internal/wake'
import { hashReply } from './internal/replies'

type EventStoreOperation<Value> = ResultType<
  Value,
  JobEventStoreFailure | JobEventCursorExpiredError
>

const MAX_LIMIT = 10_000
const POLL_INTERVAL_MS = 250
const STREAM_ID = /^(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/u
const EVENT_TYPES = new Set<DurableJobEventType>([
  'job-enqueued',
  'job-claimed',
  'job-completed',
  'job-retry-scheduled',
  'job-failed',
  'job-cancelled',
  'job-cancel-requested',
  'job-released',
  'job-stalled-recovered',
  'job-promoted',
  'job-admin-retried',
  'job-removed',
  'queue-paused',
  'queue-resumed'
])
const descriptor: JobEventStoreDescriptor = Object.freeze({
  extension: jobEventExtension,
  extensionVersion: jobEventExtensionVersion,
  jobStoreProtocolVersion: 1
})

const ok = <Value>(value: Value): EventStoreOperation<Value> =>
  Result.ok(value) as EventStoreOperation<Value>
const failure = (operation: string, message: string): JobEventStoreFailure =>
  new JobEventStoreFailure({ operation, message })
const fail = <Value>(operation: string, cause: unknown): EventStoreOperation<Value> => {
  if (JobEventStoreFailure.is(cause) || JobEventCursorExpiredError.is(cause)) {
    return Result.err(cause) as EventStoreOperation<Value>
  }
  const message = cause instanceof Error ? cause.message : `Redis ${operation} failed`
  return Result.err(failure(operation, message)) as EventStoreOperation<Value>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const streamItems = (value: unknown, operation: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw failure(operation, 'Redis stream reply is malformed')
  return value
}

const streamId = (value: unknown, operation: string): string => {
  if (typeof value !== 'string' || !STREAM_ID.test(value)) {
    throw failure(operation, 'Redis stream ID is malformed')
  }
  return value
}

const compareStreamIds = (left: string, right: string): number => {
  const [leftMs, leftSequence] = left.split('-').map((value) => BigInt(value))
  const [rightMs, rightSequence] = right.split('-').map((value) => BigInt(value))
  if (leftMs! !== rightMs!) return leftMs! < rightMs! ? -1 : 1
  if (leftSequence! === rightSequence!) return 0
  return leftSequence! < rightSequence! ? -1 : 1
}

const parseFields = (value: unknown, operation: string): Record<string, string> => {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>
  if (Array.isArray(value)) {
    if (value.length % 2 !== 0) throw failure(operation, 'Redis stream fields are malformed')
    for (let index = 0; index < value.length; index += 2) {
      const key = value[index]
      const item = value[index + 1]
      if (typeof key !== 'string' || typeof item !== 'string') {
        throw failure(operation, 'Redis stream fields are malformed')
      }
      fields[key] = item
    }
    return fields
  }
  if (!isObject(value)) throw failure(operation, 'Redis stream fields are malformed')
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw failure(operation, 'Redis stream fields are malformed')
    fields[key] = item
  }
  return fields
}

const parseEntry = (
  value: unknown,
  operation: string
): { readonly id: string; readonly data: string } => {
  const entry = streamItems(value, operation)
  if (entry.length !== 2) throw failure(operation, 'Redis stream entry is malformed')
  const id = streamId(entry[0], operation)
  const fields = parseFields(entry[1], operation)
  if (typeof fields.data !== 'string') throw failure(operation, 'Redis event payload is missing')
  return Object.freeze({ id, data: fields.data })
}

const positiveInteger = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw failure('read', `${field} must be a positive safe integer`)
  }
  return value
}

const asOptionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw failure('read', `${field} is malformed`)
  return value
}

const decodeEvent = (data: string, cursor: JobEventCursor): DurableJobEvent => {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    throw failure('read', 'Redis event payload is not valid JSON')
  }
  if (!isObject(value) || !EVENT_TYPES.has(value.type as DurableJobEventType)) {
    throw failure('read', 'Redis event payload has an unsupported type')
  }
  if (typeof value.recordedAtMs !== 'number' || !Number.isSafeInteger(value.recordedAtMs)) {
    throw failure('read', 'Redis event payload has an invalid timestamp')
  }
  const attributes = value.attributes
  if (!isObject(attributes)) throw failure('read', 'Redis event attributes are malformed')
  const safeAttributes: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, item] of Object.entries(attributes)) {
    if (typeof item !== 'string') throw failure('read', 'Redis event attributes are malformed')
    safeAttributes[key] = item
  }
  const numberField = (name: string): number | undefined => {
    const item = value[name]
    if (item === undefined || item === null) return undefined
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) {
      throw failure('read', `Redis event ${name} is malformed`)
    }
    return item
  }
  const state = value.state
  if (
    state !== undefined &&
    state !== null &&
    !['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'].includes(state as string)
  ) {
    throw failure('read', 'Redis event state is malformed')
  }
  const duplicate = value.duplicate
  if (duplicate !== undefined && duplicate !== null && typeof duplicate !== 'boolean') {
    throw failure('read', 'Redis event duplicate flag is malformed')
  }
  return Object.freeze({
    cursor,
    type: value.type as DurableJobEventType,
    recordedAtMs: value.recordedAtMs,
    jobId: asOptionalString(value.jobId, 'jobId') as DurableJobEvent['jobId'],
    queue: asOptionalString(value.queue, 'queue') as DurableJobEvent['queue'],
    name: asOptionalString(value.name, 'name'),
    version: numberField('version'),
    state: state === null ? undefined : (state as DurableJobEvent['state']),
    attempt: numberField('attempt'),
    delivery: numberField('delivery'),
    workerId: asOptionalString(value.workerId, 'workerId') as DurableJobEvent['workerId'],
    outcome: asOptionalString(value.outcome, 'outcome'),
    failureKind: asOptionalString(
      value.failureKind,
      'failureKind'
    ) as DurableJobEvent['failureKind'],
    duplicate: duplicate === null ? undefined : duplicate,
    attributes: Object.freeze(safeAttributes)
  })
}

const matches = (event: DurableJobEvent, options: JobEventReadOptions): boolean => {
  if (options.jobId !== undefined && event.jobId !== options.jobId) return false
  if (
    options.queues !== undefined &&
    options.queues.length > 0 &&
    !options.queues.includes(event.queue!)
  ) {
    return false
  }
  if (
    options.types !== undefined &&
    options.types.length > 0 &&
    !options.types.includes(event.type)
  ) {
    return false
  }
  if (options.jobs !== undefined && options.jobs.length > 0) {
    const matched = options.jobs.some(
      (job) => job.queue === event.queue && job.name === event.name && job.version === event.version
    )
    if (!matched) return false
  }
  return true
}

const cursorFromId = (prefix: string, id: string): JobEventCursor =>
  `${prefix}${id}` as JobEventCursor

const decodeCursor = (prefix: string, value: unknown): string => {
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    throw failure('cursor', 'cursor is not valid for this store')
  }
  return streamId(value.slice(prefix.length), 'cursor')
}

class RedisJobEventStoreImplementation {
  readonly descriptor = descriptor
  private readonly cursorPrefix: string
  private closed = false
  private disposal: Promise<void> | undefined
  private unsubscribeWake: (() => Promise<void>) | undefined
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private readonly waiters = new Set<{
    readonly after: string
    readonly queues: readonly string[]
    readonly signal: AbortSignal
    readonly resolve: (result: EventStoreOperation<void>) => void
    readonly listener: () => void
    settled: boolean
  }>()

  constructor(
    private readonly redis: RedisClient,
    options: RedisJobEventStoreOptions = {}
  ) {
    normalizeEventOptions(options)
    this.cursorPrefix = `re1_${Buffer.from(redis.layout.base, 'utf8').toString('base64url')}_`
  }

  async start(): Promise<void> {
    this.unsubscribeWake = await subscribeWake(
      this.redis.subscriber,
      this.redis.layout.wakeChannel,
      () => this.checkWaiters(),
      () => this.checkWaiters(),
      this.redis.ownsSubscriber
    )
  }

  private command<T = unknown>(args: readonly string[]): Promise<T> {
    if (this.closed) throw failure('command', 'Redis JobEventStore has been disposed')
    return sendRedisCommand(this.redis.client, [...args], this.redis.layout.base) as Promise<T>
  }

  private async firstEntry(
    reverse = false
  ): Promise<{ readonly id: string; readonly data: string } | undefined> {
    const reply = await this.command<unknown>(
      reverse
        ? ['XREVRANGE', this.redis.layout.events, '+', '-', 'COUNT', '1']
        : ['XRANGE', this.redis.layout.events, '-', '+', 'COUNT', '1']
    )
    const entries = streamItems(reply, 'tailCursor')
    return entries.length === 0 ? undefined : parseEntry(entries[0], 'tailCursor')
  }

  private async metadata(): Promise<Record<string, string>> {
    return hashReply(await this.command(['HGETALL', this.redis.layout.eventsMeta]))
  }

  private async assertCursor(after: string): Promise<void> {
    const tail = await this.firstEntry(true)
    if (tail !== undefined && compareStreamIds(after, tail.id) > 0) {
      throw failure('cursor', 'cursor is ahead of the store tail')
    }
    const metadata = await this.metadata()
    const oldest = metadata.trimmedThrough
    if (oldest !== undefined && compareStreamIds(after, oldest) < 0) {
      throw new JobEventCursorExpiredError({
        cursor: cursorFromId(this.cursorPrefix, after),
        oldestAvailableCursor: cursorFromId(this.cursorPrefix, oldest)
      })
    }
  }

  async tailCursor(): Promise<EventStoreOperation<JobEventCursor>> {
    try {
      const last = await this.firstEntry(true)
      return ok(cursorFromId(this.cursorPrefix, last?.id ?? '0-0'))
    } catch (cause) {
      return fail('tailCursor', cause)
    }
  }

  async read(options: JobEventReadOptions): Promise<EventStoreOperation<JobEventPage>> {
    try {
      if (!isObject(options)) throw failure('read', 'options must be an object')
      const limit = options.limit === undefined ? 100 : positiveInteger(options.limit, 'limit')
      if (limit > MAX_LIMIT) throw failure('read', 'limit must be between 1 and 10000')
      const after = decodeCursor(
        this.cursorPrefix,
        options.after === undefined ? cursorFromId(this.cursorPrefix, '0-0') : options.after
      )
      await this.assertCursor(after)
      const events: DurableJobEvent[] = []
      let examined: string | undefined
      let start = after === '0-0' ? '-' : `(${after}`
      for (let page = 0; page < MAX_LIMIT; page += 1) {
        const raw = await this.command<unknown>([
          'XRANGE',
          this.redis.layout.events,
          start,
          '+',
          'COUNT',
          String(Math.max(limit, 128))
        ])
        const entries = streamItems(raw, 'read')
        if (entries.length === 0) break
        for (const rawEntry of entries) {
          const entry = parseEntry(rawEntry, 'read')
          examined = entry.id
          const event = decodeEvent(entry.data, cursorFromId(this.cursorPrefix, entry.id))
          if (matches(event, options)) events.push(event)
          if (events.length >= limit) break
        }
        if (events.length >= limit || entries.length < Math.max(limit, 128)) break
        if (examined === undefined) break
        start = `(${examined}`
      }
      if (examined === undefined) {
        return ok(Object.freeze({ events: Object.freeze([]), nextCursor: undefined }))
      }
      return ok(
        Object.freeze({
          events: Object.freeze(events),
          nextCursor: cursorFromId(this.cursorPrefix, examined)
        })
      )
    } catch (cause) {
      return fail('read', cause)
    }
  }

  private async hasMatchingEvent(after: string, queues: readonly string[]): Promise<boolean> {
    const options: JobEventReadOptions =
      queues.length === 0
        ? { after: cursorFromId(this.cursorPrefix, after), limit: 1 }
        : {
            after: cursorFromId(this.cursorPrefix, after),
            limit: 1,
            queues: queues.map((queue) => queue as never)
          }
    const page = await this.read(options)
    if (Result.isError(page)) throw page.error
    return page.value.events.length > 0
  }

  private finish(
    waiter: {
      readonly signal: AbortSignal
      readonly listener: () => void
      readonly resolve: (result: EventStoreOperation<void>) => void
      settled: boolean
    },
    result: EventStoreOperation<void>
  ): void {
    if (waiter.settled) return
    waiter.settled = true
    this.waiters.delete(waiter as never)
    if (this.waiters.size === 0 && this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
    try {
      waiter.signal.removeEventListener('abort', waiter.listener)
    } catch {
      // Detachment is best effort; the result has already been fixed.
    }
    waiter.resolve(result)
  }

  private checkWaiters(): void {
    for (const waiter of this.waiters) {
      if (waiter.settled) continue
      if (waiter.signal.aborted) {
        this.finish(
          waiter,
          Result.err(failure('awaitEvents', 'wait was aborted')) as EventStoreOperation<void>
        )
        continue
      }
      void this.hasMatchingEvent(waiter.after, waiter.queues)
        .then((matched) => {
          if (matched) this.finish(waiter, ok(undefined))
        })
        .catch((cause) => this.finish(waiter, fail('awaitEvents', cause)))
    }
    this.schedulePoll()
  }

  private schedulePoll(): void {
    if (this.closed || this.waiters.size === 0 || this.pollTimer !== undefined) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      this.checkWaiters()
    }, POLL_INTERVAL_MS)
  }

  async awaitEvents(options: AwaitEventsOptions): Promise<EventStoreOperation<void>> {
    try {
      if (!isObject(options)) throw failure('awaitEvents', 'options must be an object')
      if (!options.signal || typeof options.signal.addEventListener !== 'function') {
        throw failure('awaitEvents', 'signal must be an AbortSignal')
      }
      const after = decodeCursor(this.cursorPrefix, options.after)
      await this.assertCursor(after)
      if (options.signal.aborted) throw failure('awaitEvents', 'wait was aborted')
      const queues = (options.queues ?? []).map((queue) => String(queue))
      if (await this.hasMatchingEvent(after, queues)) return ok(undefined)
      return new Promise<EventStoreOperation<void>>((resolve) => {
        const waiter = {
          after,
          queues,
          signal: options.signal,
          resolve,
          settled: false,
          listener: () =>
            this.finish(
              waiter,
              Result.err(failure('awaitEvents', 'wait was aborted')) as EventStoreOperation<void>
            )
        }
        options.signal.addEventListener('abort', waiter.listener, { once: true })
        if (options.signal.aborted) {
          this.finish(
            waiter,
            Result.err(failure('awaitEvents', 'wait was aborted')) as EventStoreOperation<void>
          )
          return
        }
        this.waiters.add(waiter)
        this.schedulePoll()
        this.checkWaiters()
      })
    } catch (cause) {
      return fail('awaitEvents', cause)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    this.pollTimer = undefined
    this.disposal = this.disposeOnce()
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    const errors: unknown[] = []
    for (const waiter of this.waiters) {
      this.finish(
        waiter,
        Result.err(
          failure('awaitEvents', 'Redis JobEventStore has been disposed')
        ) as EventStoreOperation<void>
      )
    }
    if (this.unsubscribeWake !== undefined) {
      try {
        await this.unsubscribeWake()
      } catch (cause) {
        errors.push(cause)
      }
    }
    try {
      await this.redis.dispose()
    } catch (cause) {
      errors.push(cause)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Redis JobEventStore cleanup failed')
  }
}

const eventNamespaceFor = (token: AnyJobEventStoreToken, namespace: string): string => {
  const defaultTag = '@better-effect/mq/JobEventStore'
  if (token.serviceTag === defaultTag) return namespace
  const suffix = token.serviceTag.slice(`${defaultTag}/`.length)
  return `${namespace}:store-${Buffer.from(`@better-effect/mq/JobStore/${suffix}`).toString('base64url')}`
}

const makeLayer = <Token extends AnyJobEventStoreToken>(
  token: Token,
  acquire: () => Promise<RedisClient>,
  options?: RedisJobEventStoreOptions
): Layer<InstanceType<Token>, never> =>
  Layer.scoped(
    token,
    async () => {
      const redis = await acquire()
      const implementation = new RedisJobEventStoreImplementation(redis, options)
      try {
        await redis.initialize()
        await implementation.start()
        return JobEventStore.of(implementation as never) as unknown as ServiceContract<
          InstanceType<Token>
        >
      } catch (cause) {
        try {
          await implementation.dispose()
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            'Redis JobEventStore acquisition cleanup failed'
          )
        }
        throw cause
      }
    },
    async (store) => {
      await (store as unknown as RedisJobEventStoreImplementation).dispose()
    }
  )

const eventStoreApi = {
  layer(config: RedisJobStoreConfig, options?: RedisJobEventStoreOptions) {
    return makeLayer(JobEventStore, async () => RedisClient.fromClients(config), options)
  },
  layerFor<Token extends AnyJobEventStoreToken>(
    token: Token,
    config: RedisJobStoreConfig,
    options?: RedisJobEventStoreOptions
  ) {
    return makeLayer(
      token,
      async () =>
        RedisClient.fromClients({
          ...config,
          namespace: eventNamespaceFor(token, config.namespace ?? 'default')
        }),
      options
    )
  },
  layerFromConfig(config: RedisJobStoreConnectionConfig, options?: RedisJobEventStoreOptions) {
    return makeLayer(JobEventStore, async () => RedisClient.fromConfig(config), options)
  },
  layerFromConfigFor<Token extends AnyJobEventStoreToken>(
    token: Token,
    config: RedisJobStoreConnectionConfig,
    options?: RedisJobEventStoreOptions
  ) {
    return makeLayer(
      token,
      async () =>
        RedisClient.fromConfig({
          ...config,
          namespace: eventNamespaceFor(token, config.namespace ?? 'default')
        }),
      options
    )
  }
}

export const RedisJobEventStore = Object.freeze(eventStoreApi)

export type { RedisJobEventStoreOptions } from './event-codec'
