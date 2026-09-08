// oxlint-disable anti-slop/no-runtime-typeof -- BSON documents and public event requests are validated at this adapter boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- MongoDB replies are narrowed before becoming public values.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- BSON event documents are field-based by design.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions are confined to validated driver boundaries.
// oxlint-disable anti-slop/no-chained-type-assertions -- BSON and erased Service boundaries are restored after validation.
// oxlint-disable anti-slop/no-known-value-widening -- MongoDB query documents intentionally use the adapter's open BSON shape.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional event fields are omitted from BSON records.
// oxlint-disable anti-slop/no-unknown-returns -- driver values are narrowed immediately inside this adapter.

import { createHash } from 'node:crypto'
import { Layer, type ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  JobEventCursorExpiredError,
  JobEventStore,
  JobEventStoreFailure,
  durableJobEventTypes,
  jobEventExtension,
  jobEventExtensionVersion,
  jobEventStoreTag,
  JobStore,
  makeJobId,
  makeJobName,
  makeQueueName,
  type AnyJobEventStoreToken,
  type DurableJobEvent,
  type DurableJobEventInput,
  type DurableJobEventType,
  type JobEventCursor,
  type JobEventPage,
  type JobEventReadOptions,
  type JobEventRetention,
  type JobEventStoreContract,
  type JobEventStoreError,
  type JobEventStoreDescriptor,
  type JobEventStoreActivation,
  type JobEventStoreActivationOptions,
  type JobEventStoreReadiness,
  type JobEventStoreWriter,
  type JobEventStoreOperation,
  type JobIdentity
} from 'better-effect-mq'
import { JobEventWriterRejectedError } from 'better-effect-mq'
import { MongoJobStoreClient } from './client'
import type { MongoJobStoreConfig, MongoJobStoreConnectionConfig, MongoSession } from './config'
import { mongoCollections, namespaceId, type MongoCollections } from './collections'
import { MongoJobStoreMigrator } from './migrator'
import { MongoJobStoreTopologyError } from './errors'

export interface MongoJobEventStoreConfig extends MongoJobStoreConfig {
  readonly retention?: JobEventRetention
}

export interface MongoJobEventStoreConnectionConfig extends MongoJobStoreConnectionConfig {
  readonly retention?: JobEventRetention
}

export interface MongoJobEventStoreOptions {
  readonly retention?: JobEventRetention
  readonly writer?: JobEventStoreWriter
}

type Doc = Record<string, unknown>
type EventResult<Value> = ResultType<Value, JobEventStoreError>
type Operation<Value> = JobEventStoreOperation<Value>

const MAX = Number.MAX_SAFE_INTEGER
const MAX_LIMIT = 10_000
const MAX_SCAN = 20_000
const POLL_MS = 250
const EVENT_TYPES = new Set<DurableJobEventType>(durableJobEventTypes)

const descriptor: JobEventStoreDescriptor = Object.freeze({
  extension: jobEventExtension,
  extensionVersion: jobEventExtensionVersion,
  jobStoreProtocolVersion: 1
})
const defaultWriter: JobEventStoreWriter = Object.freeze({
  id: 'better-effect-mq-mongodb',
  version: 'current',
  canAppend: true
})

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 32)
const ok = <Value>(value: Value): EventResult<Value> => Result.ok(value)
const failure = (operation: string, message: string): JobEventStoreFailure =>
  new JobEventStoreFailure({ operation, message })
const fail = <Value>(error: JobEventStoreError): EventResult<Value> => Result.err(error)
const asOperation = <Value>(result: EventResult<Value>): Operation<Value> =>
  result as unknown as Operation<Value>
const asPromiseOperation = <Value>(result: Promise<EventResult<Value>>): Operation<Value> =>
  result as unknown as Operation<Value>

const isObject = (value: unknown): value is Doc =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const integer = (value: unknown, field: string, positive = false): number => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    (positive ? value < 1 : value < 0)
  )
    throw new Error(`${field} must be a ${positive ? 'positive' : 'non-negative'} safe integer`)
  return value
}

const validateRetention = (value: JobEventRetention | undefined): JobEventRetention => {
  if (value === undefined) return Object.freeze({})
  if (!isObject(value)) throw new TypeError('retention must be an object')
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'ageMs' && key !== 'count')
      throw new TypeError('retention contains unsupported fields')
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0)
      throw new TypeError(`retention.${key} must be positive`)
  }
  return Object.freeze({ ...value })
}

const decodeBase36 = (value: string): number | undefined => {
  if (value.length === 0 || !/^[0-9a-z]+$/u.test(value)) return undefined
  const parsed = Number.parseInt(value, 36)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const normalizeOptions = (
  options: JobEventReadOptions,
  decode: (value: unknown) => ResultType<number, JobEventStoreFailure>
): {
  readonly after: number
  readonly limit: number
  readonly queues?: readonly string[]
  readonly jobs?: readonly JobIdentity[]
  readonly jobId?: string
  readonly types?: readonly DurableJobEventType[]
} => {
  if (!isObject(options)) throw new Error('read options must be an object')
  const input = options as unknown as {
    readonly after?: unknown
    readonly limit?: unknown
    readonly queues?: readonly unknown[]
    readonly jobs?: readonly unknown[]
    readonly jobId?: unknown
    readonly types?: readonly DurableJobEventType[]
  }
  const decoded = input.after === undefined ? Result.ok(0) : decode(input.after)
  if (Result.isError(decoded)) throw decoded.error
  const limit = input.limit === undefined ? 100 : integer(input.limit, 'limit', true)
  if (limit > MAX_LIMIT) throw new Error('limit must be between 1 and 10000')
  const queues = input.queues?.map((queue) => {
    const checked = makeQueueName(queue)
    if (Result.isError(checked)) throw checked.error
    return checked.value as string
  })
  const jobs = input.jobs?.map((job) => {
    if (!isObject(job)) throw new Error('jobs contains an invalid identity')
    const queue = makeQueueName(job.queue)
    const name = makeJobName(job.name)
    if (Result.isError(queue)) throw queue.error
    if (Result.isError(name)) throw name.error
    return { queue: queue.value, name: name.value, version: integer(job.version, 'version', true) }
  })
  const jobId =
    input.jobId === undefined
      ? undefined
      : (() => {
          const checked = makeJobId(input.jobId)
          if (Result.isError(checked)) throw checked.error
          return checked.value as string
        })()
  const types = input.types?.map((type) => {
    if (!EVENT_TYPES.has(type)) throw new Error('types contains an unknown event type')
    return type
  })
  const result: {
    readonly after: number
    readonly limit: number
    readonly queues?: readonly string[]
    readonly jobs?: readonly JobIdentity[]
    readonly jobId?: string
    readonly types?: readonly DurableJobEventType[]
  } = { after: decoded.value, limit }
  if (queues !== undefined) (result as { queues: readonly string[] }).queues = queues
  if (jobs !== undefined) (result as { jobs: readonly JobIdentity[] }).jobs = jobs
  if (jobId !== undefined) (result as { jobId: string }).jobId = jobId
  if (types !== undefined) (result as { types: readonly DurableJobEventType[] }).types = types
  return result
}

const matches = (event: DurableJobEvent, options: ReturnType<typeof normalizeOptions>): boolean => {
  if (options.jobId !== undefined && options.jobId !== event.jobId) return false
  if (options.queues !== undefined && options.queues.length > 0) {
    if (event.queue === undefined || !options.queues.includes(event.queue)) return false
  }
  if (options.jobs !== undefined && options.jobs.length > 0) {
    if (
      event.queue === undefined ||
      event.name === undefined ||
      event.version === undefined ||
      !options.jobs.some(
        (job) =>
          job.queue === event.queue && job.name === event.name && job.version === event.version
      )
    )
      return false
  }
  return (
    options.types === undefined || options.types.length === 0 || options.types.includes(event.type)
  )
}

const safeAttributes = (value: unknown): Readonly<Record<string, string>> => {
  if (!isObject(value)) throw new Error('event attributes are malformed')
  const attributes = Object.create(null) as Record<string, string>
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 128 || typeof item !== 'string' || item.length > 128)
      throw new Error('event attributes must be bounded strings')
    attributes[key] = item
  }
  return Object.freeze(attributes)
}

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is malformed`)
  return value
}

const decodeEvent = (document: Doc, prefix: string): DurableJobEvent => {
  const cursor = integer(document.cursor, 'event.cursor', true)
  const type = document.eventType
  if (typeof type !== 'string' || !EVENT_TYPES.has(type as DurableJobEventType))
    throw new Error('event.type is unknown')
  const jobId = optionalString(document.jobId, 'event.jobId')
  const queue = optionalString(document.queue, 'event.queue')
  const name = optionalString(document.name, 'event.name')
  const version =
    document.version == null ? undefined : integer(document.version, 'event.version', true)
  const state = optionalString(document.state, 'event.state') as DurableJobEvent['state']
  const attempt =
    document.attempt == null ? undefined : integer(document.attempt, 'event.attempt', true)
  const delivery =
    document.delivery == null ? undefined : integer(document.delivery, 'event.delivery', true)
  const recordedAtMs = integer(document.recordedAtMs, 'event.recordedAtMs')
  const duplicate = document.duplicate == null ? undefined : document.duplicate
  if (duplicate !== undefined && typeof duplicate !== 'boolean')
    throw new Error('event.duplicate is malformed')
  return Object.freeze({
    cursor: `${prefix}${cursor.toString(36)}` as JobEventCursor,
    type: type as DurableJobEventType,
    recordedAtMs,
    jobId: jobId as DurableJobEvent['jobId'],
    queue: queue as DurableJobEvent['queue'],
    name,
    version,
    state,
    attempt,
    delivery,
    workerId: optionalString(document.workerId, 'event.workerId') as DurableJobEvent['workerId'],
    outcome: optionalString(document.outcome, 'event.outcome'),
    failureKind: optionalString(
      document.failureKind,
      'event.failureKind'
    ) as DurableJobEvent['failureKind'],
    duplicate,
    attributes: safeAttributes(document.attributes)
  })
}

const eventDocument = (namespace: string, cursor: number, input: DurableJobEventInput): Doc => ({
  _id: namespaceId(namespace, String(cursor)),
  namespace,
  cursor,
  recordedAtMs: input.recordedAtMs,
  eventType: input.type,
  ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
  ...(input.queue === undefined ? {} : { queue: input.queue }),
  ...(input.name === undefined ? {} : { name: input.name }),
  ...(input.version === undefined ? {} : { version: input.version }),
  ...(input.state === undefined ? {} : { state: input.state }),
  ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
  ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
  ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
  ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
  ...(input.failureKind === undefined ? {} : { failureKind: input.failureKind }),
  ...(input.duplicate === undefined ? {} : { duplicate: input.duplicate }),
  attributes: input.attributes
})

const counterValue = (value: unknown): number => {
  const document = isObject(value) && isObject(value.value) ? value.value : value
  if (!isObject(document)) throw new Error('event cursor counter is missing')
  return integer(document.value, 'event cursor', true)
}

/** Append a safe event in the caller-owned MongoDB transaction. */
export const appendMongoJobEvent = async (
  session: MongoSession,
  collections: MongoCollections,
  namespace: string,
  input: DurableJobEventInput
): Promise<JobEventCursor> => {
  await ensureOptionalActivation(session, collections, namespace, input.recordedAtMs)
  const next = await collections.counters.findOneAndUpdate(
    {
      _id: namespaceId(namespace, 'job-event-sequence'),
      $or: [{ value: { $lt: MAX } }, { value: { $exists: false } }]
    },
    {
      $setOnInsert: { namespace, name: 'job-event-sequence', value: 0 },
      $inc: { value: 1 }
    },
    { upsert: true, returnDocument: 'after', session }
  )
  const cursor = counterValue(next)
  await collections.events.insertOne(eventDocument(namespace, cursor, input), { session })
  return `${cursor.toString(36)}` as JobEventCursor
}

const activationId = (namespace: string): string => namespaceId(namespace, 'job-event-activation')

const activationDocument = (
  namespace: string,
  state: 'optional' | 'required',
  cursor: number,
  revision: number,
  now: number
): Doc => ({
  _id: activationId(namespace),
  namespace,
  name: 'job-event-activation',
  activationState: state,
  activationCursor: cursor,
  activationRevision: revision,
  activatedAtMs: now
})

const activationFromDocument = (
  document: Doc | null,
  encode: (value: number) => JobEventCursor
): JobEventStoreActivation => {
  if (document === null)
    return Object.freeze({
      state: 'inactive',
      mode: undefined,
      activationCursor: undefined,
      revision: 0,
      activatedAtMs: undefined
    })
  const state = document.activationState
  if (state !== 'optional' && state !== 'required') throw new Error('invalid activation state')
  return Object.freeze({
    state,
    mode: state,
    activationCursor: encode(integer(document.activationCursor, 'activationCursor')),
    revision: integer(document.activationRevision, 'activationRevision', true),
    activatedAtMs: integer(document.activatedAtMs, 'activatedAtMs')
  })
}

const ensureOptionalActivation = async (
  session: MongoSession,
  collections: MongoCollections,
  namespace: string,
  now: number
): Promise<void> => {
  const current = await collections.counters.findOne({ _id: activationId(namespace) }, { session })
  if (current !== null) return
  const sequence = await collections.counters.findOne(
    { _id: namespaceId(namespace, 'job-event-sequence') },
    { session }
  )
  const tail = sequence === null ? 0 : integer(sequence.value, 'event cursor')
  await collections.counters.findOneAndUpdate(
    { _id: activationId(namespace), activationState: { $exists: false } },
    { $setOnInsert: activationDocument(namespace, 'optional', tail, 1, now) },
    { upsert: true, returnDocument: 'after', session }
  )
}

export const assertMongoJobEventWriterReady = async (
  session: MongoSession,
  collections: MongoCollections,
  namespace: string,
  operation: string,
  writer: JobEventStoreWriter
): Promise<void> => {
  const row = await collections.counters.findOne({ _id: activationId(namespace) }, { session })
  if (row?.activationState === 'required' && !writer.canAppend) {
    throw new JobEventWriterRejectedError({
      operation,
      revision: integer(row.activationRevision, 'activationRevision', true),
      writerId: writer.id,
      writerVersion: writer.version
    })
  }
}

type Waiter = { readonly wake: () => void }

class MongoJobEventStoreImplementation {
  readonly descriptor = descriptor
  private readonly collections: MongoCollections
  private readonly prefix: string
  private readonly retention: JobEventRetention
  private readonly waiters = new Set<Waiter>()
  private readonly writer: JobEventStoreWriter
  private stream:
    | { on(event: string, listener: (value: unknown) => void): unknown; close(): Promise<void> }
    | undefined
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly client: MongoJobStoreClient,
    options: MongoJobEventStoreOptions = {},
    private readonly ownsClient = false
  ) {
    this.collections = mongoCollections(client.db, client.collectionPrefix)
    this.prefix = `mongo1_${hash(`${client.collectionPrefix}\u0000${client.namespace}`)}_`
    this.retention = validateRetention(options.retention)
    this.writer = options.writer ?? defaultWriter
  }

  async start(): Promise<void> {
    const hello = await this.client.db.admin().command({ hello: 1 })
    if (
      typeof hello.logicalSessionTimeoutMinutes !== 'number' ||
      (typeof hello.setName !== 'string' && hello.msg !== 'isdbgrid')
    )
      throw new MongoJobStoreTopologyError(
        'standalone',
        'MongoDB JobEventStore requires a replica set or a transaction-capable mongos deployment'
      )
    if (this.client.validateLayout)
      await MongoJobStoreMigrator.validate(this.client.db, this.client.collectionPrefix)
    if (this.client.notifications === 'auto' && this.client.db.watch !== undefined) {
      try {
        this.stream = this.client.db.watch(
          [
            {
              $match: {
                operationType: 'insert',
                'ns.coll': `${this.client.collectionPrefix}_events`,
                'fullDocument.namespace': this.client.namespace
              }
            }
          ],
          { fullDocument: 'default' }
        )
        this.stream.on('change', () => this.wake())
        this.stream.on('error', () => this.wake())
      } catch {
        this.stream = undefined
      }
    }
  }

  private encode(cursor: number): JobEventCursor {
    return `${this.prefix}${cursor.toString(36)}` as JobEventCursor
  }

  private decode(value: unknown): ResultType<number, JobEventStoreFailure> {
    if (typeof value !== 'string' || !value.startsWith(this.prefix))
      return Result.err(failure('cursor', 'cursor is not valid for this store'))
    const cursor = decodeBase36(value.slice(this.prefix.length))
    return cursor === undefined
      ? Result.err(failure('cursor', 'cursor is malformed'))
      : Result.ok(cursor)
  }

  private async tail(): Promise<number> {
    const row = await this.collections.counters.findOne({
      _id: namespaceId(this.client.namespace, 'job-event-sequence')
    })
    return row === null ? 0 : integer(row.value, 'event cursor')
  }

  private async readActivation(): Promise<JobEventStoreActivation> {
    const row = await this.collections.counters.findOne({
      _id: activationId(this.client.namespace)
    })
    return activationFromDocument(row, (value) => this.encode(value))
  }

  activation(): Operation<JobEventStoreActivation> {
    return asPromiseOperation(
      (async () => {
        try {
          return ok(await this.readActivation())
        } catch {
          return fail(failure('activation', 'MongoDB activation read failed'))
        }
      })()
    )
  }

  readiness(writer: JobEventStoreWriter = this.writer): Operation<JobEventStoreReadiness> {
    return asPromiseOperation(
      (async () => {
        try {
          const activation = await this.readActivation()
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
        } catch {
          return fail(failure('readiness', 'MongoDB readiness read failed'))
        }
      })()
    )
  }

  activate(options: JobEventStoreActivationOptions): Operation<JobEventStoreActivation> {
    return asPromiseOperation(
      (async () => {
        try {
          if (
            options === null ||
            typeof options !== 'object' ||
            (options.mode !== 'optional' && options.mode !== 'required')
          )
            throw new Error('mode must be optional or required')
          const now = options.now ?? Date.now()
          if (!Number.isSafeInteger(now) || now < 0) throw new Error('now must be a timestamp')
          const current = await this.collections.counters.findOne({
            _id: activationId(this.client.namespace)
          })
          if (current?.activationState === 'required' && options.mode === 'optional')
            throw new Error('required activation cannot be downgraded')
          if (current === null) {
            await this.collections.counters.insertOne(
              activationDocument(this.client.namespace, options.mode, await this.tail(), 1, now)
            )
          } else if (current.activationState === 'optional' && options.mode === 'required') {
            await this.collections.counters.updateOne(
              { _id: activationId(this.client.namespace), activationState: 'optional' },
              {
                $set: { activationState: 'required', activatedAtMs: now },
                $inc: { activationRevision: 1 }
              }
            )
          }
          return ok(await this.readActivation())
        } catch (cause) {
          return fail(
            failure(
              'activate',
              cause instanceof Error ? cause.message : 'MongoDB activation failed'
            )
          )
        }
      })()
    )
  }

  private async prune(now: number): Promise<void> {
    if (this.retention.ageMs !== undefined)
      await this.collections.events.deleteMany({
        namespace: this.client.namespace,
        recordedAtMs: { $lt: now - this.retention.ageMs }
      })
    if (this.retention.count !== undefined) {
      const rows = await this.collections.events
        .find(
          { namespace: this.client.namespace },
          { sort: { cursor: -1 }, limit: this.retention.count }
        )
        .toArray()
      const oldest = rows.at(-1)?.cursor
      if (oldest !== undefined)
        await this.collections.events.deleteMany({
          namespace: this.client.namespace,
          cursor: { $lt: oldest }
        })
    }
  }

  private async assertReadable(after: number): Promise<void> {
    const tail = await this.tail()
    if (after > tail) throw failure('cursor', 'cursor is ahead of the store tail')
    const first = await this.collections.events
      .find({ namespace: this.client.namespace }, { sort: { cursor: 1 }, limit: 1 })
      .toArray()
    const oldest = first[0]?.cursor
    if (oldest === undefined) {
      if (after < tail)
        throw new JobEventCursorExpiredError({
          cursor: this.encode(after),
          oldestAvailableCursor: this.encode(tail)
        })
      return
    }
    const value = integer(oldest, 'event.cursor', true)
    if (after < value - 1)
      throw new JobEventCursorExpiredError({
        cursor: this.encode(after),
        oldestAvailableCursor: this.encode(value - 1)
      })
  }

  tailCursor(): Operation<JobEventCursor> {
    return asPromiseOperation(
      (async () => {
        try {
          await this.prune(Date.now())
          return ok(this.encode(await this.tail()))
        } catch {
          return fail(failure('tailCursor', 'MongoDB tail cursor read failed'))
        }
      })()
    )
  }

  read(options: JobEventReadOptions): Operation<JobEventPage> {
    try {
      const normalized = normalizeOptions(options, (value) => this.decode(value))
      return asPromiseOperation(
        (async () => {
          try {
            await this.prune(Date.now())
            await this.assertReadable(normalized.after)
            const rows = await this.collections.events
              .find(
                { namespace: this.client.namespace, cursor: { $gt: normalized.after } },
                { sort: { cursor: 1 }, limit: Math.min(MAX_SCAN, normalized.limit + MAX_LIMIT) }
              )
              .toArray()
            const events: DurableJobEvent[] = []
            let examined: number | undefined
            for (const row of rows) {
              const event = decodeEvent(row, this.prefix)
              examined =
                event.cursor === undefined
                  ? undefined
                  : decodeBase36(event.cursor.slice(this.prefix.length))
              if (matches(event, normalized)) events.push(event)
              if (events.length >= normalized.limit) break
            }
            return ok({
              events: Object.freeze(events),
              nextCursor: examined === undefined ? undefined : this.encode(examined)
            })
          } catch (cause) {
            return fail(
              cause instanceof JobEventCursorExpiredError
                ? cause
                : failure(
                    'read',
                    cause instanceof Error ? cause.message : 'MongoDB event read failed'
                  )
            )
          }
        })()
      )
    } catch (cause) {
      return asOperation(
        fail(failure('read', cause instanceof Error ? cause.message : 'invalid read options'))
      )
    }
  }

  private async hasEventsAfter(
    after: number,
    queues: readonly string[] | undefined
  ): Promise<boolean> {
    await this.prune(Date.now())
    await this.assertReadable(after)
    const filter: Doc = { namespace: this.client.namespace, cursor: { $gt: after } }
    if (queues !== undefined && queues.length > 0) filter.queue = { $in: queues }
    const rows = await this.collections.events.find(filter, { limit: 1 }).toArray()
    return rows.length > 0
  }

  awaitEvents(options: {
    readonly after: JobEventCursor
    readonly queues?: readonly import('better-effect-mq').QueueName[]
    readonly signal: AbortSignal
  }): Operation<void> {
    if (!isObject(options) || options.signal === undefined)
      return asOperation(fail(failure('awaitEvents', 'options.signal is required')))
    const after = this.decode(options.after)
    if (Result.isError(after)) return asOperation(fail(after.error))
    const queues = options.queues?.map((queue) => {
      const checked = makeQueueName(queue)
      if (Result.isError(checked)) throw checked.error
      return checked.value as string
    })
    if (options.signal.aborted) return asOperation(fail(failure('awaitEvents', 'wait was aborted')))
    return new Promise<EventResult<void>>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: EventResult<void>) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        this.waiters.delete(waiter)
        options.signal.removeEventListener('abort', abort)
        resolve(result)
      }
      const check = async () => {
        if (settled) return
        if (this.closed) {
          finish(fail(failure('awaitEvents', 'store is closed')))
          return
        }
        try {
          if (await this.hasEventsAfter(after.value, queues)) finish(ok(undefined))
          else if (!settled) timer = setTimeout(() => void check(), POLL_MS)
        } catch (cause) {
          finish(
            fail(
              cause instanceof JobEventCursorExpiredError || JobEventStoreFailure.is(cause)
                ? cause
                : failure('awaitEvents', 'MongoDB event wait failed')
            )
          )
        }
      }
      const abort = () => finish(fail(failure('awaitEvents', 'wait was aborted')))
      const waiter: Waiter = { wake: () => void check() }
      this.waiters.add(waiter)
      options.signal.addEventListener('abort', abort, { once: true })
      void check()
    }) as unknown as Operation<void>
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter.wake()
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = (async () => {
      for (const waiter of this.waiters) waiter.wake()
      await this.stream?.close()
      if (this.ownsClient) await this.client.dispose()
    })()
    return this.disposal
  }
}

const namespaceFor = (token: AnyJobEventStoreToken, namespace: string): string => {
  if (token.serviceTag === jobEventStoreTag) return namespace
  const suffix = token.serviceTag.slice(`${jobEventStoreTag}/`.length)
  return `${namespace}:store-${JobStore.serviceTag}/${suffix}`
}

const makeLayer = <Token extends AnyJobEventStoreToken>(
  token: Token,
  acquire: () => Promise<MongoJobStoreClient>,
  options: MongoJobEventStoreOptions,
  ownsClient: boolean
): Layer<InstanceType<Token>, never> =>
  Layer.scoped(
    token,
    async () => {
      const client = await acquire()
      let implementation: MongoJobEventStoreImplementation | undefined
      try {
        implementation = new MongoJobEventStoreImplementation(client, options, ownsClient)
        await implementation.start()
        return JobEventStore.of(implementation as never) as unknown as ServiceContract<
          InstanceType<Token>
        >
      } catch (cause) {
        try {
          if (implementation !== undefined) await implementation.dispose()
          else if (ownsClient) await client.dispose()
        } catch {
          // Preserve acquisition failure.
        }
        throw cause
      }
    },
    async (store) => {
      await (store as unknown as MongoJobEventStoreImplementation).dispose()
    }
  ) as Layer<InstanceType<Token>, never>

const retentionOf = (config: {
  readonly retention?: JobEventRetention
  readonly eventWriter?: JobEventStoreWriter
}): MongoJobEventStoreOptions =>
  config.eventWriter === undefined
    ? { retention: validateRetention(config.retention) }
    : { retention: validateRetention(config.retention), writer: config.eventWriter }

const clientFromDb =
  (token: AnyJobEventStoreToken, config: MongoJobEventStoreConfig) => async () => {
    const { retention: _retention, eventWriter: _eventWriter, ...base } = config
    return MongoJobStoreClient.fromDb({
      ...base,
      namespace: namespaceFor(token, config.namespace ?? 'default')
    })
  }

const clientFromConfig =
  (token: AnyJobEventStoreToken, config: MongoJobEventStoreConnectionConfig) => () => {
    const { retention: _retention, eventWriter: _eventWriter, ...base } = config
    return MongoJobStoreClient.fromConfig({
      ...base,
      namespace: namespaceFor(token, config.namespace ?? 'default')
    })
  }

export const MongoJobEventStore = Object.freeze({
  layer(config: MongoJobEventStoreConfig) {
    return makeLayer(JobEventStore, clientFromDb(JobEventStore, config), retentionOf(config), false)
  },
  layerFor<Token extends AnyJobEventStoreToken>(token: Token, config: MongoJobEventStoreConfig) {
    return makeLayer(token, clientFromDb(token, config), retentionOf(config), false)
  },
  layerFromConfig(config: MongoJobEventStoreConnectionConfig) {
    return makeLayer(
      JobEventStore,
      clientFromConfig(JobEventStore, config),
      retentionOf(config),
      true
    )
  },
  layerFromConfigFor<Token extends AnyJobEventStoreToken>(
    token: Token,
    config: MongoJobEventStoreConnectionConfig
  ) {
    return makeLayer(token, clientFromConfig(token, config), retentionOf(config), true)
  }
})

export type MongoJobEventStoreInstance = JobEventStoreContract
