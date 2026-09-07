// oxlint-disable anti-slop/no-runtime-typeof -- MongoDB documents and public event options are validated at this persistence boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- MongoDB driver documents are intentionally opaque behind the optional-peer facade.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- event attributes are bounded scalar fields at the storage boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- optional MongoDB driver replies are narrowed at this adapter boundary.
// oxlint-disable anti-slop/no-known-value-widening -- BSON documents intentionally use an adapter-owned open shape.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional BSON fields must be omitted rather than written as undefined.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions follow explicit BSON and public DTO validation.

import { createHash } from 'node:crypto'
import { Layer, type ServiceContract } from 'better-effect'
import { Result } from 'better-result'
import {
  JobEventCursorExpiredError,
  JobEventStore,
  JobEventStoreFailure,
  JobStore,
  jobEventExtension,
  jobEventExtensionVersion,
  jobEventStoreTag,
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
  type JobEventStoreDescriptor,
  type JobEventStoreOperation,
  type JobEventStoreError,
  type JobIdentity
} from 'better-effect-mq'
import { MongoJobStoreClient, assertMongoTransactionTopology } from './client'
import { mongoCollections, namespaceId } from './collections'
import {
  normalizeMongoJobStoreConfig,
  normalizeMongoJobStoreConnectionConfig,
  type MongoJobStoreConfig,
  type MongoJobStoreConnectionConfig,
  type MongoSession
} from './config'
import { MongoJobEventStoreMigrator } from './migrator'

export interface MongoJobEventStoreConfig extends MongoJobStoreConfig {
  readonly retention?: JobEventRetention
}

export interface MongoJobEventStoreConnectionConfig extends MongoJobStoreConnectionConfig {
  readonly retention?: JobEventRetention
}

type Doc = Record<string, unknown>
type Operation<Value> = JobEventStoreOperation<Value, JobEventStoreError>

const MAX = Number.MAX_SAFE_INTEGER
const MAX_LIMIT = 10_000
const MAX_SCAN = 20_000
const POLL_INTERVAL_MS = 250
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

const ok = <Value>(value: Value): Operation<Value> =>
  Result.ok(value) as unknown as Operation<Value>
const fail = <Value>(operation: string, cause: unknown): Operation<Value> => {
  if (JobEventStoreFailure.is(cause) || JobEventCursorExpiredError.is(cause))
    return Result.err(cause) as unknown as Operation<Value>
  return Result.err(
    new JobEventStoreFailure({
      operation,
      message: cause instanceof Error ? cause.message : `MongoDB ${operation} failed`
    })
  ) as unknown as Operation<Value>
}
const failure = (operation: string, message: string): JobEventStoreFailure =>
  new JobEventStoreFailure({ operation, message })

const isObject = (value: unknown): value is Doc =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const integer = (value: unknown, field: string, min = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw failure('read', `${field} is malformed`)
  return value
}

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 40)

const validateRetention = (retention: JobEventRetention | undefined): JobEventRetention => {
  const value = retention ?? {}
  for (const [field, candidate] of Object.entries(value)) {
    if (field !== 'ageMs' && field !== 'count') throw failure('retention', 'unsupported field')
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate <= 0)
      throw failure('retention', `${field} must be positive`)
  }
  return Object.freeze({ ...value })
}

const cursorPrefix = (collectionPrefix: string, namespace: string): string =>
  `mo1_${hash(`${collectionPrefix}\u0000${namespace}`)}_`

const encodeCursor = (prefix: string, value: number): JobEventCursor =>
  `${prefix}${value.toString(36)}` as JobEventCursor

const decodeCursor = (prefix: string, value: unknown): number => {
  if (typeof value !== 'string' || !value.startsWith(prefix))
    throw failure('cursor', 'cursor is not valid for this store')
  const encoded = value.slice(prefix.length)
  if (encoded.length === 0 || !/^[0-9a-z]+$/u.test(encoded))
    throw failure('cursor', 'cursor is malformed')
  const decoded = Number.parseInt(encoded, 36)
  if (!Number.isSafeInteger(decoded) || decoded < 0) throw failure('cursor', 'cursor is malformed')
  return decoded
}

const boundedAttributes = (value: unknown): Readonly<Record<string, string>> => {
  if (!isObject(value)) throw failure('read', 'event attributes are malformed')
  const attributes: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 128 || typeof item !== 'string' || item.length > 128)
      throw failure('read', 'event attributes are malformed')
    attributes[key] = item
  }
  return Object.freeze(attributes)
}

const optionalText = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0)
    throw failure('read', `${field} is malformed`)
  return value
}

const optionalInteger = (value: unknown, field: string, min = 0): number | undefined =>
  value === undefined || value === null ? undefined : integer(value, field, min)

const decodeEvent = (
  row: Doc,
  prefix: string
): { readonly event: DurableJobEvent; readonly cursor: number } => {
  const cursor = integer(row.cursor, 'event.cursor', 1)
  const type = row.type
  if (typeof type !== 'string' || !EVENT_TYPES.has(type as DurableJobEventType))
    throw failure('read', 'event.type is unsupported')
  const jobId = optionalText(row.jobId, 'event.jobId')
  const queue = optionalText(row.queue, 'event.queue')
  const name = optionalText(row.name, 'event.name')
  if (jobId !== undefined && Result.isError(makeJobId(jobId)))
    throw failure('read', 'event.jobId is malformed')
  if (queue !== undefined && Result.isError(makeQueueName(queue)))
    throw failure('read', 'event.queue is malformed')
  if (name !== undefined && Result.isError(makeJobName(name)))
    throw failure('read', 'event.name is malformed')
  const state = row.state
  if (
    state !== undefined &&
    state !== null &&
    !['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'].includes(state as string)
  )
    throw failure('read', 'event.state is malformed')
  if (row.duplicate !== undefined && row.duplicate !== null && typeof row.duplicate !== 'boolean')
    throw failure('read', 'event.duplicate is malformed')
  return {
    cursor,
    event: Object.freeze({
      cursor: encodeCursor(prefix, cursor),
      type: type as DurableJobEventType,
      recordedAtMs: integer(row.recordedAtMs, 'event.recordedAtMs'),
      jobId: jobId as DurableJobEvent['jobId'],
      queue: queue as DurableJobEvent['queue'],
      name,
      version: optionalInteger(row.version, 'event.version', 1),
      state: state == null ? undefined : (state as DurableJobEvent['state']),
      attempt: optionalInteger(row.attempt, 'event.attempt', 1),
      delivery: optionalInteger(row.delivery, 'event.delivery', 1),
      workerId: optionalText(row.workerId, 'event.workerId') as DurableJobEvent['workerId'],
      outcome: optionalText(row.outcome, 'event.outcome'),
      failureKind: optionalText(
        row.failureKind,
        'event.failureKind'
      ) as DurableJobEvent['failureKind'],
      duplicate: row.duplicate == null ? undefined : (row.duplicate as boolean),
      attributes: boundedAttributes(row.attributes)
    })
  }
}

const matches = (event: DurableJobEvent, options: JobEventReadOptions): boolean => {
  if (options.queues !== undefined && options.queues.length > 0) {
    if (event.queue === undefined || !options.queues.includes(event.queue)) return false
  }
  if (options.jobs !== undefined && options.jobs.length > 0) {
    if (
      event.queue === undefined ||
      event.name === undefined ||
      event.version === undefined ||
      !options.jobs.some(
        (job: JobIdentity) =>
          job.queue === event.queue && job.name === event.name && job.version === event.version
      )
    )
      return false
  }
  if (options.jobId !== undefined && event.jobId !== options.jobId) return false
  if (
    options.types !== undefined &&
    options.types.length > 0 &&
    !options.types.includes(event.type)
  )
    return false
  return true
}

const inputDocument = (namespace: string, cursor: number, input: DurableJobEventInput): Doc => ({
  _id: namespaceId(namespace, 'event', String(cursor)),
  namespace,
  cursor,
  recordedAtMs: input.recordedAtMs,
  type: input.type,
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

const counterId = (namespace: string): string => namespaceId(namespace, 'job-event-sequence')

/** Append one event in a caller-owned MongoDB transaction. */
export const appendMongoJobEvent = async (
  session: MongoSession,
  client: Pick<MongoJobStoreClient, 'db' | 'namespace' | 'collectionPrefix'>,
  input: DurableJobEventInput
): Promise<JobEventCursor> => {
  const collections = mongoCollections(client.db, client.collectionPrefix)
  const result = await collections.counters.findOneAndUpdate(
    {
      _id: counterId(client.namespace),
      $or: [{ value: { $lt: MAX } }, { value: { $exists: false } }]
    },
    {
      $setOnInsert: { namespace: client.namespace, name: 'job-event-sequence' },
      $inc: { value: 1 }
    },
    { upsert: true, returnDocument: 'after', session }
  )
  const row =
    result !== null && typeof result === 'object' && 'value' in result
      ? (result as { readonly value?: unknown }).value
      : result
  const cursor = integer(
    row === null || row === undefined ? undefined : (row as Doc).value,
    'event.cursor',
    1
  )
  await collections.events.insertOne(inputDocument(client.namespace, cursor, input), { session })
  return encodeCursor(cursorPrefix(client.collectionPrefix, client.namespace), cursor)
}

type Waiter = {
  readonly after: number
  readonly queues: readonly string[]
  readonly signal: AbortSignal
  readonly resolve: (result: Operation<void>) => void
  readonly onAbort: () => void
  timer: ReturnType<typeof setTimeout> | undefined
  settled: boolean
}

class MongoJobEventStoreImplementation {
  readonly descriptor = descriptor
  private readonly prefix: string
  private readonly retention: JobEventRetention
  private readonly collections
  private readonly waiters = new Set<Waiter>()
  private stream: import('./config').MongoChangeStream | undefined
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly client: MongoJobStoreClient,
    retention: JobEventRetention | undefined
  ) {
    this.prefix = cursorPrefix(client.collectionPrefix, client.namespace)
    this.retention = validateRetention(retention)
    this.collections = mongoCollections(client.db, client.collectionPrefix)
  }

  async start(): Promise<void> {
    if (this.client.notifications !== 'auto' || this.client.db.watch === undefined) return
    try {
      this.stream = this.client.db.watch(
        [
          {
            $match: {
              operationType: 'insert',
              'ns.coll': `${this.client.collectionPrefix}_job_events`,
              'fullDocument.namespace': this.client.namespace
            }
          }
        ],
        { fullDocument: 'default' }
      )
      this.stream.on('change', () => this.checkWaiters())
      this.stream.on('error', () => this.checkWaiters())
      this.stream.on('close', () => this.checkWaiters())
    } catch {
      this.stream = undefined
    }
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
          { sort: { cursor: -1 }, skip: this.retention.count - 1, limit: 1 }
        )
        .toArray()
      const threshold = rows[0]?.cursor
      if (typeof threshold === 'number')
        await this.collections.events.deleteMany({
          namespace: this.client.namespace,
          cursor: { $lt: threshold }
        })
    }
  }

  private async tailSequence(): Promise<number> {
    const row = await this.collections.counters.findOne({ _id: counterId(this.client.namespace) })
    return row === null ? 0 : integer(row.value, 'event counter', 0)
  }

  private async assertReadable(after: number): Promise<void> {
    const tail = await this.tailSequence()
    if (after > tail) throw failure('cursor', 'cursor is ahead of the store tail')
    const first = await this.collections.events
      .find({ namespace: this.client.namespace }, { sort: { cursor: 1 }, limit: 1 })
      .toArray()
    const oldest = first[0]?.cursor
    if (oldest === undefined) {
      if (after < tail)
        throw new JobEventCursorExpiredError({
          cursor: encodeCursor(this.prefix, after),
          oldestAvailableCursor: encodeCursor(this.prefix, tail)
        })
      return
    }
    const firstCursor = integer(oldest, 'event.cursor', 1)
    if (after < firstCursor - 1)
      throw new JobEventCursorExpiredError({
        cursor: encodeCursor(this.prefix, after),
        oldestAvailableCursor: encodeCursor(this.prefix, firstCursor - 1)
      })
  }

  tailCursor(): Operation<JobEventCursor> {
    return this.run('tailCursor', async () => {
      await this.prune(Date.now())
      return encodeCursor(this.prefix, await this.tailSequence())
    })
  }

  read(options: JobEventReadOptions): Operation<JobEventPage> {
    return this.run('read', async () => {
      if (options === null || typeof options !== 'object')
        throw failure('read', 'options must be an object')
      const limit = options.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT)
        throw failure('read', 'limit must be between 1 and 10000')
      const after = decodeCursor(this.prefix, options.after ?? encodeCursor(this.prefix, 0))
      await this.prune(Date.now())
      await this.assertReadable(after)
      const events: DurableJobEvent[] = []
      let examined: number | undefined
      let cursor = after
      let scanned = 0
      while (scanned < MAX_SCAN) {
        const batchSize = Math.min(512, MAX_SCAN - scanned)
        const rows = await this.collections.events
          .find(
            { namespace: this.client.namespace, cursor: { $gt: cursor } },
            { sort: { cursor: 1 }, limit: batchSize }
          )
          .toArray()
        if (rows.length === 0) break
        for (const row of rows) {
          const decoded = decodeEvent(row, this.prefix)
          examined = decoded.cursor
          cursor = decoded.cursor
          scanned += 1
          if (matches(decoded.event, options)) events.push(decoded.event)
          if (events.length >= limit || scanned >= MAX_SCAN) break
        }
        if (events.length >= limit || rows.length < batchSize) break
      }
      return Object.freeze({
        events: Object.freeze(events),
        nextCursor: examined === undefined ? undefined : encodeCursor(this.prefix, examined)
      })
    })
  }

  private async hasMatching(after: number, queues: readonly string[]): Promise<boolean> {
    const result = await this.read({
      after: encodeCursor(this.prefix, after),
      limit: 1,
      ...(queues.length === 0 ? {} : { queues: queues as never[] })
    })
    if (Result.isError(result)) throw result.error
    return result.value.events.length > 0
  }

  awaitEvents(options: {
    readonly after: JobEventCursor
    readonly queues?: readonly import('better-effect-mq').QueueName[]
    readonly signal: AbortSignal
  }): Operation<void> {
    return this.wait<void>('awaitEvents', async () => {
      if (options === null || typeof options !== 'object' || options.signal === undefined)
        throw failure('awaitEvents', 'options must include an AbortSignal')
      if (typeof options.signal.addEventListener !== 'function')
        throw failure('awaitEvents', 'signal must be an AbortSignal')
      if (options.signal.aborted) throw failure('awaitEvents', 'wait was aborted')
      const after = decodeCursor(this.prefix, options.after)
      await this.prune(Date.now())
      await this.assertReadable(after)
      const queues = (options.queues ?? []).map((queue) => String(queue))
      if (await this.hasMatching(after, queues)) return ok(undefined)
      return new Promise<Operation<void>>((resolve) => {
        const waiter: Waiter = {
          after,
          queues,
          signal: options.signal,
          resolve,
          timer: undefined,
          settled: false,
          onAbort: () => this.finish(waiter, fail('awaitEvents', 'wait was aborted'))
        }
        this.waiters.add(waiter)
        options.signal.addEventListener('abort', waiter.onAbort, { once: true })
        waiter.timer = setTimeout(() => this.checkWaiter(waiter), POLL_INTERVAL_MS)
      }) as unknown as Operation<void>
    })
  }

  private run<Value>(operation: string, body: () => Promise<Value>): Operation<Value> {
    if (this.closed) return fail(operation, failure(operation, 'store is closed'))
    return body().then(ok, (cause) => fail(operation, cause)) as unknown as Operation<Value>
  }

  private wait<Value>(operation: string, body: () => Promise<Operation<Value>>): Operation<Value> {
    if (this.closed) return fail(operation, failure(operation, 'store is closed'))
    return body().then(
      (result) => result,
      (cause) => fail(operation, cause)
    ) as unknown as Operation<Value>
  }

  private checkWaiters(): void {
    for (const waiter of this.waiters) void this.checkWaiter(waiter)
  }

  private async checkWaiter(waiter: Waiter): Promise<void> {
    if (waiter.settled) return
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer)
      waiter.timer = undefined
    }
    try {
      if (waiter.signal.aborted) {
        this.finish(waiter, fail('awaitEvents', 'wait was aborted'))
        return
      }
      if (await this.hasMatching(waiter.after, waiter.queues)) {
        this.finish(waiter, ok(undefined))
        return
      }
      if (!waiter.settled)
        waiter.timer = setTimeout(() => this.checkWaiter(waiter), POLL_INTERVAL_MS)
    } catch (cause) {
      this.finish(waiter, fail('awaitEvents', cause))
    }
  }

  private finish(waiter: Waiter, result: Operation<void>): void {
    if (waiter.settled) return
    waiter.settled = true
    this.waiters.delete(waiter)
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    try {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    } catch {
      // Detachment is best effort after the result has been fixed.
    }
    waiter.resolve(result)
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = (async () => {
      for (const waiter of this.waiters) this.finish(waiter, fail('awaitEvents', 'store is closed'))
      await this.stream?.close()
      if (this.client.ownsClient) await this.client.dispose()
    })()
    return this.disposal
  }
}

const namespaceForEventToken = (token: AnyJobEventStoreToken, namespace: string): string => {
  if (token.serviceTag === jobEventStoreTag) return namespace
  const suffix = token.serviceTag.slice(`${jobEventStoreTag}/`.length)
  return `${namespace}:store-${hash(`${JobStore.serviceTag}/${suffix}`)}`
}

const makeLayer = <Token extends AnyJobEventStoreToken>(
  token: Token,
  acquire: () => Promise<MongoJobStoreClient>,
  retention: JobEventRetention,
  ownsClient: boolean
): Layer<InstanceType<Token>, never> =>
  Layer.scoped(
    token,
    async () => {
      const client = await acquire()
      let implementation: MongoJobEventStoreImplementation | undefined
      try {
        await assertMongoTransactionTopology(client.db)
        if (client.validateLayout)
          await MongoJobEventStoreMigrator.validate(client.db, client.collectionPrefix)
        implementation = new MongoJobEventStoreImplementation(client, retention)
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

const retentionOf = (config: { readonly retention?: JobEventRetention }): JobEventRetention =>
  validateRetention(config.retention)

const normalizedJobStoreConfig = (config: MongoJobEventStoreConfig) =>
  normalizeMongoJobStoreConfig({
    db: config.db,
    ...(config.namespace === undefined ? {} : { namespace: config.namespace }),
    ...(config.collectionPrefix === undefined ? {} : { collectionPrefix: config.collectionPrefix }),
    ...(config.validateLayout === undefined ? {} : { validateLayout: config.validateLayout }),
    ...(config.notifications === undefined ? {} : { notifications: config.notifications })
  })

const normalizedConnectionConfig = (config: MongoJobEventStoreConnectionConfig) =>
  normalizeMongoJobStoreConnectionConfig({
    uri: config.uri,
    database: config.database,
    ...(config.namespace === undefined ? {} : { namespace: config.namespace }),
    ...(config.collectionPrefix === undefined ? {} : { collectionPrefix: config.collectionPrefix }),
    ...(config.validateLayout === undefined ? {} : { validateLayout: config.validateLayout }),
    ...(config.notifications === undefined ? {} : { notifications: config.notifications }),
    ...(config.clientOptions === undefined ? {} : { clientOptions: config.clientOptions })
  })

export const MongoJobEventStore = Object.freeze({
  migrate(options: import('./migrator').MongoMigrationOptions) {
    return MongoJobEventStoreMigrator.migrate(options)
  },
  layer(config: MongoJobEventStoreConfig) {
    const normalized = normalizedJobStoreConfig(config)
    return makeLayer(
      JobEventStore,
      async () => MongoJobStoreClient.fromDb(normalized),
      retentionOf(config),
      false
    )
  },
  layerFor<Token extends AnyJobEventStoreToken>(token: Token, config: MongoJobEventStoreConfig) {
    const normalized = normalizedJobStoreConfig({
      ...config,
      namespace: namespaceForEventToken(token, config.namespace ?? 'default')
    })
    return makeLayer(
      token,
      async () => MongoJobStoreClient.fromDb(normalized),
      retentionOf(config),
      false
    )
  },
  layerFromConfig(config: MongoJobEventStoreConnectionConfig) {
    const normalized = normalizedConnectionConfig(config)
    return makeLayer(
      JobEventStore,
      () =>
        MongoJobStoreClient.fromConfig({
          ...normalized,
          namespace: normalized.namespace
        } as unknown as MongoJobStoreConnectionConfig),
      retentionOf(config),
      true
    )
  },
  layerFromConfigFor<Token extends AnyJobEventStoreToken>(
    token: Token,
    config: MongoJobEventStoreConnectionConfig
  ) {
    const normalized = normalizedConnectionConfig(config)
    return makeLayer(
      token,
      () =>
        MongoJobStoreClient.fromConfig({
          ...normalized,
          namespace: namespaceForEventToken(token, normalized.namespace)
        } as unknown as MongoJobStoreConnectionConfig),
      retentionOf(config),
      true
    )
  }
})

export type MongoJobEventStoreInstance = JobEventStoreContract
