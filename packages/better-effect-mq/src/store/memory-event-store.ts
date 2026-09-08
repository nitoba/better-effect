// oxlint-disable anti-slop/no-runtime-typeof -- the reference adapter validates public DTOs.
// oxlint-disable anti-slop/no-unknown-parameters -- event filters are a runtime storage boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- Result and Service erasure are confined to checked adapter boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below follow validated DTO or adapter invariants.

import { Layer } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

import type { QueueName } from '../protocol'
import {
  JobEventStore,
  isDurableJobEventType,
  jobEventExtension,
  jobEventExtensionVersion,
  type AnyJobEventStoreToken,
  type DurableJobEvent,
  type DurableJobEventInput,
  type JobEventCursor,
  type JobEventPage,
  type JobEventReadOptions,
  type JobEventRetention,
  type JobEventStoreContract,
  type JobEventStoreDescriptor,
  type JobEventStoreActivation,
  type JobEventStoreActivationOptions,
  type JobEventStoreReadiness,
  type JobEventStoreWriter,
  type JobEventStoreOperation
} from './event-store'
import {
  JobEventCursorExpiredError,
  JobEventStoreFailure,
  JobEventWriterRejectedError
} from './event-errors'
import type { JobEventStoreError } from './event-errors'
import type { ServiceContract } from 'better-effect'
import { notifyJobHealth } from '../observability/health'
import type { JobHealthSink } from '../observability/health'

type Operation<Value> = JobEventStoreOperation<Value, JobEventStoreError>

export interface MemoryJobEventStoreClock {
  now(): number | Date
}

export interface MemoryJobEventStoreOptions {
  readonly clock?: MemoryJobEventStoreClock | (() => number | Date)
  readonly retention?: JobEventRetention
  /** Optional process-local health sink; durable events remain the source of truth. */
  readonly health?: JobHealthSink
}

export interface MemoryJobEventStoreInternals {
  readonly append: (event: DurableJobEventInput) => DurableJobEvent
  readonly ensureWriterReady: (writer?: JobEventStoreWriter) => void
}

type Waiter = {
  readonly after: number
  readonly queues: ReadonlySet<string> | undefined
  readonly signal: AbortSignal
  readonly onAbort: () => void
  readonly resolve: (value: Operation<void>) => void
  settled: boolean
}

const cursorPrefixBase = 'me1_'
const maxSafeInteger = Number.MAX_SAFE_INTEGER
const maxLimit = 10_000
const maxAttributeLength = 128
const memoryEventDescriptor: JobEventStoreDescriptor = Object.freeze({
  extension: jobEventExtension,
  extensionVersion: jobEventExtensionVersion,
  jobStoreProtocolVersion: 1
})
const defaultWriter: JobEventStoreWriter = Object.freeze({
  id: 'better-effect-mq',
  version: 'current',
  canAppend: true
})
const memoryInternals = new WeakMap<object, MemoryJobEventStoreInternals>()
let nextMemoryEventStoreId = 1

const ok = <Value>(value: Value): Operation<Value> =>
  Result.ok(value) as unknown as Operation<Value>

const fail = <Value>(error: JobEventStoreError): Operation<Value> =>
  Result.err(error) as unknown as Operation<Value>

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nowValue = (
  clock: MemoryJobEventStoreOptions['clock']
): ResultType<number, JobEventStoreFailure> => {
  try {
    const value =
      clock === undefined ? Date.now() : typeof clock === 'function' ? clock() : clock.now()
    const timestamp = value instanceof Date ? value.getTime() : value
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      return Result.err(
        new JobEventStoreFailure({ operation: 'clock', message: 'clock.now must be a timestamp' })
      )
    }
    return Result.ok(timestamp)
  } catch {
    return Result.err(new JobEventStoreFailure({ operation: 'clock', message: 'clock.now failed' }))
  }
}

const validateRetention = (
  retention: JobEventRetention | undefined
): ResultType<Readonly<JobEventRetention>, JobEventStoreFailure> => {
  const value = retention ?? {}
  for (const [field, candidate] of Object.entries(value)) {
    if (field !== 'ageMs' && field !== 'count') {
      return Result.err(
        new JobEventStoreFailure({ operation: 'retention', message: 'unsupported field' })
      )
    }
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate <= 0) {
      return Result.err(
        new JobEventStoreFailure({ operation: 'retention', message: `${field} must be positive` })
      )
    }
  }
  return Result.ok(Object.freeze({ ...value }))
}

const freezeAttributes = (
  value: Readonly<Record<string, string>>
): Readonly<Record<string, string>> => {
  const attributes: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key.length > maxAttributeLength || item.length > maxAttributeLength) {
      throw new TypeError('event attributes must be bounded')
    }
    attributes[key] = item
  }
  return Object.freeze(attributes)
}

const matches = (
  event: DurableJobEvent,
  options: JobEventReadOptions | { readonly queues?: readonly unknown[] | ReadonlySet<string> }
): boolean => {
  const queueFilter = options.queues
  const queueFilterSize =
    queueFilter === undefined
      ? 0
      : queueFilter instanceof Set
        ? queueFilter.size
        : Array.isArray(queueFilter)
          ? queueFilter.length
          : 0
  if (queueFilter !== undefined && queueFilterSize !== 0) {
    const queues = queueFilter instanceof Set ? queueFilter : new Set(queueFilter)
    if (event.queue === undefined || !queues.has(event.queue)) return false
  }
  if ('jobs' in options && options.jobs !== undefined && options.jobs.length > 0) {
    const identities = new Set(
      options.jobs.map((job) => `${job.queue}\u0000${job.name}\u0000${job.version}`)
    )
    if (
      event.queue === undefined ||
      event.name === undefined ||
      event.version === undefined ||
      !identities.has(`${event.queue}\u0000${event.name}\u0000${event.version}`)
    ) {
      return false
    }
  }
  if ('jobId' in options && options.jobId !== undefined && event.jobId !== options.jobId)
    return false
  if ('types' in options && options.types !== undefined && options.types.length > 0) {
    if (!options.types.includes(event.type)) return false
  }
  return true
}

class MemoryJobEventStoreImplementation {
  readonly descriptor = memoryEventDescriptor

  private readonly events: DurableJobEvent[] = []
  private readonly waiters = new Set<Waiter>()
  private readonly clock: MemoryJobEventStoreOptions['clock']
  private readonly retention: Readonly<JobEventRetention>
  private readonly health: JobHealthSink | undefined
  private readonly cursorPrefix: string
  private nextSequence = 1
  private activationState: 'inactive' | 'optional' | 'required' = 'inactive'
  private activationCursor: JobEventCursor | undefined
  private activationRevision = 0
  private activatedAtMs: number | undefined

  constructor(options: MemoryJobEventStoreOptions = {}) {
    const checked = validateRetention(options.retention)
    if (Result.isError(checked)) throw checked.error
    this.clock = options.clock
    this.health = options.health
    this.retention = checked.value
    if (nextMemoryEventStoreId > maxSafeInteger) throw new RangeError('event store IDs exhausted')
    this.cursorPrefix = `${cursorPrefixBase}${nextMemoryEventStoreId.toString(36)}_`
    nextMemoryEventStoreId += 1
    notifyJobHealth(this.health, {
      type: 'retention',
      retainedEventCount: 0,
      oldestRetainedAgeMs: undefined,
      retentionCount: this.retention.count,
      retentionAgeMs: this.retention.ageMs
    })
  }

  append(input: DurableJobEventInput): DurableJobEvent {
    if (!Number.isSafeInteger(input.recordedAtMs) || input.recordedAtMs < 0) {
      throw new TypeError('event recordedAtMs must be a non-negative safe integer')
    }
    if (this.nextSequence > maxSafeInteger) throw new RangeError('event cursor exhausted')
    if (this.activationState === 'inactive') {
      this.activationState = 'optional'
      this.activationCursor = this.encodeCursor(this.nextSequence - 1)
      this.activationRevision = 1
      this.activatedAtMs = input.recordedAtMs
    }
    const event = Object.freeze({
      ...input,
      cursor: this.encodeCursor(this.nextSequence),
      attributes: freezeAttributes(input.attributes)
    })
    this.nextSequence += 1
    this.events.push(event)
    this.prune(input.recordedAtMs)
    this.reportRetention(input.recordedAtMs)
    this.notify(event)
    return event
  }

  tailCursor(): Operation<JobEventCursor> {
    const current = nowValue(this.clock)
    if (Result.isError(current)) return this.failureResult(current.error)
    this.prune(current.value)
    this.reportRetention(current.value)
    return ok(this.encodeCursor(this.nextSequence - 1))
  }

  activation(): Operation<JobEventStoreActivation> {
    return ok(this.activationSnapshot())
  }

  readiness(writer: JobEventStoreWriter = defaultWriter): Operation<JobEventStoreReadiness> {
    const activation = this.activationSnapshot()
    const ready = activation.state !== 'required' || writer.canAppend
    return ok({
      ...activation,
      ready,
      writer,
      reason:
        activation.state === 'required'
          ? ready
            ? 'required'
            : 'append-unsupported'
          : activation.state
    })
  }

  activate(options: JobEventStoreActivationOptions): Operation<JobEventStoreActivation> {
    try {
      if (
        options === null ||
        typeof options !== 'object' ||
        (options.mode !== 'optional' && options.mode !== 'required')
      ) {
        return this.failureResult(this.failure('activate', 'mode must be optional or required'))
      }
      const now =
        options.now === undefined
          ? nowValue(this.clock)
          : Number.isSafeInteger(options.now) && options.now >= 0
            ? Result.ok(options.now)
            : Result.err(this.failure('activate', 'now must be a timestamp'))
      if (Result.isError(now)) return this.failureResult(now.error)
      if (this.activationState === 'inactive') {
        this.activationState = options.mode
        this.activationCursor = this.encodeCursor(this.nextSequence - 1)
        this.activationRevision = 1
        this.activatedAtMs = now.value
      } else if (this.activationState === 'optional' && options.mode === 'required') {
        this.activationState = 'required'
        this.activationRevision += 1
        this.activatedAtMs = now.value
      } else if (this.activationState === 'required' && options.mode === 'optional') {
        return this.failureResult(
          this.failure('activate', 'required activation cannot be downgraded')
        )
      }
      return ok(this.activationSnapshot())
    } catch {
      return this.failureResult(this.failure('activate', 'could not activate event extension'))
    }
  }

  ensureWriterReady(writer: JobEventStoreWriter = defaultWriter): void {
    if (this.activationState === 'required' && !writer.canAppend) {
      throw new JobEventWriterRejectedError({
        operation: 'mutation',
        revision: this.activationRevision,
        writerId: writer.id,
        writerVersion: writer.version
      })
    }
  }

  private activationSnapshot(): JobEventStoreActivation {
    return Object.freeze({
      state: this.activationState,
      mode: this.activationState === 'inactive' ? undefined : this.activationState,
      activationCursor: this.activationCursor,
      revision: this.activationRevision,
      activatedAtMs: this.activatedAtMs
    })
  }

  read(options: JobEventReadOptions): Operation<JobEventPage> {
    try {
      if (!isObject(options))
        return this.failureResult(this.failure('read', 'options must be an object'))
      const current = nowValue(this.clock)
      if (Result.isError(current)) return this.failureResult(current.error)
      this.prune(current.value)
      this.reportRetention(current.value)
      const after: ResultType<number, JobEventStoreFailure> =
        options.after === undefined ? Result.ok(0) : this.decodeCursor(options.after)
      if (Result.isError(after)) return this.failureResult(after.error)
      if (after.value > this.nextSequence - 1) {
        return this.failureResult(this.failure('cursor', 'cursor is ahead of the store tail'))
      }
      const expired = this.expired(after.value)
      if (expired !== undefined) return this.failureResult(expired)
      const limit = options.limit === undefined ? 100 : options.limit
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maxLimit) {
        return this.failureResult(this.failure('read', 'limit must be between 1 and 10000'))
      }
      if (
        options.types !== undefined &&
        (!Array.isArray(options.types) ||
          options.types.some((type) => !isDurableJobEventType(type)))
      ) {
        return this.failureResult(this.failure('read', 'types contains an unknown event type'))
      }
      const events: DurableJobEvent[] = []
      let examined: number | undefined
      for (const event of this.events) {
        const sequence = this.sequenceOf(event.cursor)
        if (sequence <= after.value) continue
        examined = sequence
        if (matches(event, options)) events.push(event)
        if (events.length >= limit) break
      }
      return ok(
        Object.freeze({
          events: Object.freeze(events),
          nextCursor: examined === undefined ? undefined : this.encodeCursor(examined)
        })
      )
    } catch {
      return this.failureResult(this.failure('read', 'could not read event options'))
    }
  }

  awaitEvents(options: {
    readonly after: JobEventCursor
    readonly queues?: readonly QueueName[]
    readonly signal: AbortSignal
  }): Operation<void> {
    const after = this.decodeCursor(options?.after)
    if (Result.isError(after)) return this.failureResult(after.error)
    if (after.value > this.nextSequence - 1) {
      return this.failureResult(this.failure('cursor', 'cursor is ahead of the store tail'))
    }
    const current = nowValue(this.clock)
    if (Result.isError(current)) return this.failureResult(current.error)
    this.prune(current.value)
    this.reportRetention(current.value)
    const expired = this.expired(after.value)
    if (expired !== undefined) {
      return this.failureResult(expired)
    }
    if (!isObject(options.signal) || typeof options.signal.addEventListener !== 'function') {
      return this.failureResult(this.failure('awaitEvents', 'signal must be an AbortSignal'))
    }
    if (options.signal.aborted)
      return this.failureResult(this.failure('awaitEvents', 'wait was aborted'))
    const queues =
      options.queues === undefined || options.queues.length === 0
        ? undefined
        : new Set(options.queues.map((queue) => String(queue)))
    const queueOptions = queues === undefined ? {} : { queues }
    if (
      this.events.some(
        (event) => this.sequenceOf(event.cursor) > after.value && matches(event, queueOptions)
      )
    ) {
      return ok(undefined)
    }
    return new Promise<Operation<void>>((resolve) => {
      const waiter: Waiter = {
        after: after.value,
        queues,
        signal: options.signal,
        onAbort: () =>
          this.finish(waiter, fail<void>(this.failure('awaitEvents', 'wait was aborted'))),
        resolve,
        settled: false
      }
      this.waiters.add(waiter)
      options.signal.addEventListener('abort', waiter.onAbort, { once: true })
      if (options.signal.aborted) waiter.onAbort()
    }) as unknown as Operation<void>
  }

  private sequenceOf(cursor: JobEventCursor): number {
    return this.decodeCursor(cursor).unwrap()
  }

  private encodeCursor(sequence: number): JobEventCursor {
    return `${this.cursorPrefix}${sequence.toString(36)}` as JobEventCursor
  }

  private decodeCursor(value: unknown): ResultType<number, JobEventStoreFailure> {
    if (typeof value !== 'string' || !value.startsWith(this.cursorPrefix)) {
      return Result.err(
        new JobEventStoreFailure({
          operation: 'cursor',
          message: 'cursor is not valid for this store'
        })
      )
    }
    const encoded = value.slice(this.cursorPrefix.length)
    if (encoded.length === 0 || !/^[0-9a-z]+$/.test(encoded)) {
      return Result.err(
        new JobEventStoreFailure({ operation: 'cursor', message: 'cursor is malformed' })
      )
    }
    const sequence = Number.parseInt(encoded, 36)
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      return Result.err(
        new JobEventStoreFailure({ operation: 'cursor', message: 'cursor is malformed' })
      )
    }
    return Result.ok(sequence)
  }

  private failure(operation: string, message: string): JobEventStoreFailure {
    return new JobEventStoreFailure({ operation, message })
  }

  private failureResult<Value>(error: JobEventStoreError): Operation<Value> {
    if (JobEventCursorExpiredError.is(error)) {
      notifyJobHealth(this.health, { type: 'cursor-expired' })
    } else if (JobEventStoreFailure.is(error) || JobEventWriterRejectedError.is(error)) {
      notifyJobHealth(this.health, {
        type: 'store-operation-failed',
        operation: error.operation,
        retryable: false
      })
    }
    return fail(error)
  }

  private expired(after: number): JobEventCursorExpiredError | undefined {
    const first = this.events[0]
    if (first === undefined) {
      return after < this.nextSequence - 1
        ? new JobEventCursorExpiredError({
            cursor: this.encodeCursor(after),
            oldestAvailableCursor: this.encodeCursor(this.nextSequence - 1)
          })
        : undefined
    }
    const firstSequence = this.sequenceOf(first.cursor)
    return after < firstSequence - 1
      ? new JobEventCursorExpiredError({
          cursor: this.encodeCursor(after),
          oldestAvailableCursor: this.encodeCursor(firstSequence - 1)
        })
      : undefined
  }

  private prune(now: number): void {
    const ageMs = this.retention.ageMs
    const count = this.retention.count
    let start = 0
    if (ageMs !== undefined) {
      const cutoff = now - ageMs
      while (start < this.events.length && this.events[start]!.recordedAtMs < cutoff) start += 1
    }
    if (count !== undefined) start = Math.max(start, this.events.length - count)
    if (start > 0) this.events.splice(0, start)
  }

  private reportRetention(now: number): void {
    const oldest = this.events[0]
    notifyJobHealth(this.health, {
      type: 'retention',
      retainedEventCount: this.events.length,
      oldestRetainedAgeMs:
        oldest === undefined ? undefined : Math.max(0, now - oldest.recordedAtMs),
      retentionCount: this.retention.count,
      retentionAgeMs: this.retention.ageMs
    })
  }

  private notify(event: DurableJobEvent): void {
    for (const waiter of this.waiters) {
      const sequence = this.sequenceOf(event.cursor)
      if (sequence <= waiter.after) continue
      if (
        waiter.queues !== undefined &&
        (event.queue === undefined || !waiter.queues.has(event.queue))
      ) {
        continue
      }
      this.finish(waiter, ok(undefined))
    }
  }

  private finish(waiter: Waiter, result: Operation<void>): void {
    if (waiter.settled) return
    waiter.settled = true
    this.waiters.delete(waiter)
    try {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    } catch {
      // The waiter is detached even if a host AbortSignal rejects removal.
    }
    waiter.resolve(result)
  }
}

const makeMemoryJobEventStore = (options?: MemoryJobEventStoreOptions): JobEventStoreContract => {
  const implementation = new MemoryJobEventStoreImplementation(options)
  const contract = JobEventStore.of(implementation as never)
  memoryInternals.set(contract as object, implementation)
  return contract
}

export const getMemoryJobEventStoreInternals = (
  store: JobEventStoreContract
): MemoryJobEventStoreInternals | undefined => memoryInternals.get(store as object)

const makeMemoryLayer = <Token extends AnyJobEventStoreToken>(
  token: Token,
  options?: MemoryJobEventStoreOptions
): Layer<InstanceType<Token>, never> =>
  Layer.make(
    token,
    () => makeMemoryJobEventStore(options) as unknown as ServiceContract<InstanceType<Token>>
  ) as Layer<InstanceType<Token>, never>

const memoryJobEventStoreApi = {
  get layer() {
    return makeMemoryLayer(JobEventStore)
  },
  layerWith(options?: MemoryJobEventStoreOptions) {
    return makeMemoryLayer(JobEventStore, options)
  },
  layerFor<Token extends AnyJobEventStoreToken>(
    token: Token,
    options?: MemoryJobEventStoreOptions
  ) {
    return makeMemoryLayer(token, options)
  },
  make(options?: MemoryJobEventStoreOptions): JobEventStoreContract {
    return makeMemoryJobEventStore(options)
  }
}

/** The isolated in-process reference implementation of the durable event log. */
export const MemoryJobEventStore = Object.freeze(memoryJobEventStoreApi)
