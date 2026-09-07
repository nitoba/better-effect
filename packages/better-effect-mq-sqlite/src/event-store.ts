// oxlint-disable anti-slop/no-runtime-typeof -- SQLite rows and public options are validated at this boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- driver rows cross an intentionally structural boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQLite rows are narrowed immediately by the event decoder.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts are confined to validated driver and Service boundaries.
// oxlint-disable anti-slop/no-known-value-widening -- normalized filter records are a named adapter contract.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to validated SQLite rows.
// oxlint-disable typescript/no-base-to-string -- scalar protocol values are normalized at the SQLite row boundary.

import { createHash } from 'node:crypto'
import { Layer } from 'better-effect'
import type { ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  JobEventCursorExpiredError,
  JobEventStore,
  JobEventStoreFailure,
  jobEventExtension,
  jobEventExtensionVersion,
  jobEventStoreTag,
  JobStore,
  makeJobId,
  makeJobName,
  makeQueueName,
  makeWorkerId,
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
  type JobEventStoreActivation,
  type JobEventStoreActivationOptions,
  type JobEventStoreReadiness,
  type JobEventStoreWriter,
  type JobEventStoreOperation,
  type JobIdentity
} from 'better-effect-mq'
import { JobEventWriterRejectedError } from 'better-effect-mq'
import { SqliteMigrator } from './migrator'
import { SqliteSchemaValidationError } from './errors'
import {
  normalizeSqliteJobStoreConfig,
  type SqliteDatabase,
  type SqliteJobStoreConfig
} from './config'
import { SQLITE_TABLES } from './schema'

export interface SqliteJobEventStoreConfig extends SqliteJobStoreConfig {
  readonly retention?: JobEventRetention
  readonly writer?: JobEventStoreWriter
}

export interface SqliteJobEventStoreOptions {
  readonly retention?: JobEventRetention
  readonly writer?: JobEventStoreWriter
}

type Row = Record<string, unknown>
type Operation<Value> = JobEventStoreOperation<Value>
type EventResult<Value> = ResultType<Value, JobEventStoreFailure | JobEventCursorExpiredError>
type EventWaiter = {
  readonly finish: (closed?: boolean) => void
  readonly queues: ReadonlySet<string> | undefined
}

const maxLimit = 10_000
const maxScan = 20_000
const maxSafeInteger = Number.MAX_SAFE_INTEGER
const eventTypes = new Set<DurableJobEventType>([
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
const defaultWriter: JobEventStoreWriter = Object.freeze({
  id: 'better-effect-mq-sqlite',
  version: 'current',
  canAppend: true
})

const waitersByDatabase = new WeakMap<object, Map<string, Set<EventWaiter>>>()

const ok = <Value>(value: Value): EventResult<Value> => Result.ok(value)
const fail = <Value>(
  error: JobEventStoreFailure | JobEventCursorExpiredError
): EventResult<Value> => Result.err(error)
const asOperation = <Value>(result: EventResult<Value>): Operation<Value> =>
  result as unknown as Operation<Value>
const asOperationPromise = <Value>(result: Promise<EventResult<Value>>): Operation<Value> =>
  result as unknown as Operation<Value>

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const hash = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24)

const prefixFor = (namespace: string): string => `sq1_${hash(namespace)}_`
const encodeBase36 = (value: number): string => value.toString(36)
const decodeBase36 = (value: string): number | undefined => {
  if (value.length === 0 || !/^[0-9a-z]+$/u.test(value)) return undefined
  const decoded = Number.parseInt(value, 36)
  return Number.isSafeInteger(decoded) && decoded >= 0 ? decoded : undefined
}

const safeNumber = (value: unknown, field: string): number => {
  const candidate = typeof value === 'bigint' ? Number(value) : Number(value)
  if (!Number.isSafeInteger(candidate) || candidate < 0) throw new Error(`${field} is invalid`)
  return candidate
}

const validateRetention = (
  retention: JobEventRetention | undefined
): Readonly<JobEventRetention> => {
  if (retention === undefined) return Object.freeze({})
  if (!isPlainObject(retention)) throw new TypeError('retention must be an object')
  for (const [field, value] of Object.entries(retention)) {
    if (field !== 'ageMs' && field !== 'count')
      throw new TypeError('retention contains unsupported fields')
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`retention.${field} must be positive`)
    }
  }
  return Object.freeze({ ...retention })
}

const validateAttributes = (value: unknown): Readonly<Record<string, string>> => {
  if (!isPlainObject(value)) throw new Error('event attributes must be an object')
  const attributes: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 128 || typeof item !== 'string' || item.length > 128) {
      throw new Error('event attributes must be bounded strings')
    }
    attributes[key] = item
  }
  return Object.freeze(attributes)
}

type EventFilters = {
  readonly queues?: readonly string[] | undefined
  readonly jobs?: readonly JobIdentity[] | undefined
  readonly jobId?: string | undefined
  readonly types?: readonly DurableJobEventType[] | undefined
}

const matches = (event: DurableJobEvent, options: EventFilters): boolean => {
  if (options.queues !== undefined && options.queues.length > 0) {
    if (event.queue === undefined || !options.queues.includes(event.queue)) return false
  }
  if (options.jobs !== undefined && options.jobs.length > 0) {
    const identities = new Set(
      options.jobs.map((job) => `${job.queue}\u0000${job.name}\u0000${job.version}`)
    )
    if (
      event.queue === undefined ||
      event.name === undefined ||
      event.version === undefined ||
      !identities.has(`${event.queue}\u0000${event.name}\u0000${event.version}`)
    )
      return false
  }
  if (options.jobId !== undefined && event.jobId !== options.jobId) return false
  if (options.types !== undefined && options.types.length > 0) {
    if (!options.types.includes(event.type)) return false
  }
  return true
}

const normalizeReadOptions = (
  input: JobEventReadOptions,
  prefix: string,
  decodeCursor: (value: unknown) => ResultType<number, JobEventStoreFailure>
): {
  readonly after: number
  readonly limit: number
  readonly queues: readonly string[] | undefined
  readonly jobs: readonly JobIdentity[] | undefined
  readonly jobId: string | undefined
  readonly types: readonly DurableJobEventType[] | undefined
} => {
  if (!isPlainObject(input)) throw new Error(`${prefix} must be an object`)
  const options = input as unknown as JobEventReadOptions
  const decoded = options.after === undefined ? Result.ok(0) : decodeCursor(options.after)
  if (Result.isError(decoded)) throw decoded.error
  const limit = options.limit === undefined ? 100 : safeNumber(options.limit, `${prefix}.limit`)
  if (limit < 1 || limit > maxLimit) throw new Error(`${prefix}.limit must be between 1 and 10000`)
  const queues = options.queues?.map((queue) => {
    const checked = makeQueueName(queue)
    if (Result.isError(checked)) throw checked.error
    return checked.value as string
  })
  const jobs = options.jobs?.map((job) => {
    if (!isPlainObject(job)) throw new Error(`${prefix}.jobs contains an invalid identity`)
    const queue = makeQueueName(job.queue)
    const name = makeJobName(job.name)
    if (Result.isError(queue)) throw queue.error
    if (Result.isError(name)) throw name.error
    const version = safeNumber(job.version, `${prefix}.jobs.version`)
    if (version < 1) throw new Error(`${prefix}.jobs.version must be positive`)
    return { queue: queue.value, name: name.value, version }
  })
  const jobId =
    options.jobId === undefined
      ? undefined
      : (() => {
          const checked = makeJobId(options.jobId)
          if (Result.isError(checked)) throw checked.error
          return checked.value as string
        })()
  const types = options.types?.map((type) => {
    if (!eventTypes.has(type)) throw new Error(`${prefix}.types contains an unknown event type`)
    return type
  })
  return { after: decoded.value, limit, queues, jobs, jobId, types }
}

const eventFromRow = (row: Row, prefix: string): DurableJobEvent => {
  const type = row.event_type
  if (typeof type !== 'string' || !eventTypes.has(type as DurableJobEventType)) {
    throw new Error(`${prefix}.event_type is unknown`)
  }
  const jobId = row.job_id == null ? undefined : makeJobId(row.job_id)
  const queue = row.queue == null ? undefined : makeQueueName(row.queue)
  const name = row.name == null ? undefined : makeJobName(row.name)
  if (jobId !== undefined && Result.isError(jobId)) throw jobId.error
  if (queue !== undefined && Result.isError(queue)) throw queue.error
  if (name !== undefined && Result.isError(name)) throw name.error
  const attributes = JSON.parse(typeof row.attributes === 'string' ? row.attributes : '{}')
  const workerId = row.worker_id == null ? undefined : makeWorkerId(row.worker_id)
  if (workerId !== undefined && Result.isError(workerId)) throw workerId.error
  return Object.freeze({
    cursor: `${prefix}${encodeBase36(safeNumber(row.cursor, 'cursor'))}` as JobEventCursor,
    type: type as DurableJobEventType,
    recordedAtMs: safeNumber(row.recorded_at_ms, 'recorded_at_ms'),
    jobId: jobId === undefined ? undefined : jobId.value,
    queue: queue === undefined ? undefined : queue.value,
    name: name === undefined ? undefined : name.value,
    version: row.version == null ? undefined : safeNumber(row.version, 'version'),
    state: row.state == null ? undefined : (row.state as DurableJobEvent['state']),
    attempt: row.attempt == null ? undefined : safeNumber(row.attempt, 'attempt'),
    delivery: row.delivery == null ? undefined : safeNumber(row.delivery, 'delivery'),
    workerId: workerId === undefined ? undefined : workerId.value,
    outcome: row.outcome == null ? undefined : String(row.outcome),
    failureKind:
      row.failure_kind == null ? undefined : (row.failure_kind as DurableJobEvent['failureKind']),
    duplicate: row.duplicate == null ? undefined : Number(row.duplicate) === 1,
    attributes: validateAttributes(attributes)
  })
}

const waitersFor = (database: SqliteDatabase, namespace: string): Set<EventWaiter> => {
  let byNamespace = waitersByDatabase.get(database as object)
  if (byNamespace === undefined) {
    byNamespace = new Map()
    waitersByDatabase.set(database as object, byNamespace)
  }
  let waiters = byNamespace.get(namespace)
  if (waiters === undefined) {
    waiters = new Set()
    byNamespace.set(namespace, waiters)
  }
  return waiters
}

export const notifySqliteJobEventWaiters = (database: SqliteDatabase, namespace: string): void => {
  for (const waiter of waitersFor(database, namespace)) {
    waiter.finish()
  }
}

const appendEvent = (
  database: SqliteDatabase,
  namespace: string,
  input: DurableJobEventInput,
  retention: Readonly<JobEventRetention>
): void => {
  if (!Number.isSafeInteger(input.recordedAtMs) || input.recordedAtMs < 0) {
    throw new TypeError('event recordedAtMs must be a non-negative safe integer')
  }
  const attributes = validateAttributes(input.attributes)
  ensureOptionalActivation(database, namespace, input.recordedAtMs)
  database
    .prepare(
      `INSERT INTO ${SQLITE_TABLES.eventCursors}(namespace,next_cursor) VALUES(?,0) ON CONFLICT(namespace) DO NOTHING`
    )
    .run(namespace)
  const updated = database
    .prepare(
      `UPDATE ${SQLITE_TABLES.eventCursors} SET next_cursor = next_cursor + 1 WHERE namespace = ? AND next_cursor < ?`
    )
    .run(namespace, maxSafeInteger)
  if (updated.changes !== 1) throw new Error('event cursor exhausted')
  const cursor = database
    .prepare(`SELECT next_cursor FROM ${SQLITE_TABLES.eventCursors} WHERE namespace = ?`)
    .get(namespace)?.next_cursor
  const sequence = safeNumber(cursor, 'event cursor')
  database
    .prepare(
      `INSERT INTO ${SQLITE_TABLES.events}(namespace,cursor,recorded_at_ms,event_type,job_id,queue,name,version,state,attempt,delivery,worker_id,outcome,failure_kind,duplicate,attributes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      namespace,
      sequence,
      input.recordedAtMs,
      input.type,
      input.jobId ?? null,
      input.queue ?? null,
      input.name ?? null,
      input.version ?? null,
      input.state ?? null,
      input.attempt ?? null,
      input.delivery ?? null,
      input.workerId ?? null,
      input.outcome ?? null,
      input.failureKind ?? null,
      input.duplicate === undefined ? null : input.duplicate ? 1 : 0,
      JSON.stringify(attributes)
    )
  if (retention.ageMs !== undefined) {
    database
      .prepare(`DELETE FROM ${SQLITE_TABLES.events} WHERE namespace = ? AND recorded_at_ms < ?`)
      .run(namespace, input.recordedAtMs - retention.ageMs)
  }
  if (retention.count !== undefined) {
    database
      .prepare(
        `DELETE FROM ${SQLITE_TABLES.events} WHERE namespace = ? AND cursor NOT IN (SELECT cursor FROM ${SQLITE_TABLES.events} WHERE namespace = ? ORDER BY cursor DESC LIMIT ?)`
      )
      .run(namespace, namespace, retention.count)
  }
  notifySqliteJobEventWaiters(database, namespace)
}

export const appendSqliteJobEvent = (
  database: SqliteDatabase,
  namespace: string,
  input: DurableJobEventInput,
  retention: Readonly<JobEventRetention>
): void => appendEvent(database, namespace, input, retention)

const ensureActivationTable = (database: SqliteDatabase): void => {
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${SQLITE_TABLES.eventActivation} (
      namespace TEXT PRIMARY KEY NOT NULL,
      activation_state TEXT NOT NULL,
      activation_cursor INTEGER NOT NULL,
      activation_revision INTEGER NOT NULL,
      activated_at_ms INTEGER NOT NULL,
      CHECK (activation_state IN ('optional', 'required')),
      CHECK (activation_cursor BETWEEN 0 AND 9007199254740991),
      CHECK (activation_revision >= 1 AND activation_revision <= 9007199254740991),
      CHECK (activated_at_ms BETWEEN 0 AND 9007199254740991)
    )`
  )
}

const activationRow = (database: SqliteDatabase, namespace: string): Row | undefined | null =>
  database
    .prepare(
      `SELECT activation_state,activation_cursor,activation_revision,activated_at_ms FROM ${SQLITE_TABLES.eventActivation} WHERE namespace = ?`
    )
    .get(namespace)

const activationFromRow = (
  row: Row | undefined | null,
  prefix: string,
  encode: (value: number) => JobEventCursor
): JobEventStoreActivation => {
  if (row === undefined || row === null) {
    return Object.freeze({
      state: 'inactive',
      mode: undefined,
      activationCursor: undefined,
      revision: 0,
      activatedAtMs: undefined
    })
  }
  const state = row.activation_state
  if (state !== 'optional' && state !== 'required')
    throw new Error(`${prefix}.activation_state is invalid`)
  return Object.freeze({
    state,
    mode: state,
    activationCursor: encode(safeNumber(row.activation_cursor, 'activation_cursor')),
    revision: safeNumber(row.activation_revision, 'activation_revision'),
    activatedAtMs: safeNumber(row.activated_at_ms, 'activated_at_ms')
  })
}

const ensureOptionalActivation = (
  database: SqliteDatabase,
  namespace: string,
  now: number
): void => {
  ensureActivationTable(database)
  database
    .prepare(
      `INSERT INTO ${SQLITE_TABLES.eventActivation}(namespace,activation_state,activation_cursor,activation_revision,activated_at_ms)
       SELECT ?, 'optional', COALESCE((SELECT next_cursor FROM ${SQLITE_TABLES.eventCursors} WHERE namespace = ?), 0), 1, ?
       WHERE NOT EXISTS (SELECT 1 FROM ${SQLITE_TABLES.eventActivation} WHERE namespace = ?)`
    )
    .run(namespace, namespace, now, namespace)
}

export const assertSqliteJobEventWriterReady = (
  database: SqliteDatabase,
  namespace: string,
  operation: string,
  writer: JobEventStoreWriter
): void => {
  ensureActivationTable(database)
  const row = activationRow(database, namespace)
  if (row?.activation_state === 'required' && !writer.canAppend) {
    throw new JobEventWriterRejectedError({
      operation,
      revision: safeNumber(row.activation_revision, 'activation_revision'),
      writerId: writer.id,
      writerVersion: writer.version
    })
  }
}

class SqliteJobEventStoreImplementation {
  readonly descriptor = descriptor
  private readonly prefix: string
  private readonly retention: Readonly<JobEventRetention>
  private readonly pollIntervalMs: number
  private readonly writer: JobEventStoreWriter
  private closed = false

  constructor(
    private readonly database: SqliteDatabase,
    private readonly namespace: string,
    retention: JobEventRetention | undefined,
    pollIntervalMs: number,
    writer: JobEventStoreWriter = defaultWriter
  ) {
    this.prefix = prefixFor(namespace)
    this.retention = validateRetention(retention)
    this.pollIntervalMs = pollIntervalMs
    this.writer = writer
  }

  private decode(value: unknown): ResultType<number, JobEventStoreFailure> {
    if (typeof value !== 'string' || !value.startsWith(this.prefix)) {
      return Result.err(
        new JobEventStoreFailure({
          operation: 'cursor',
          message: 'cursor is not valid for this store'
        })
      )
    }
    const sequence = decodeBase36(value.slice(this.prefix.length))
    return sequence === undefined
      ? Result.err(
          new JobEventStoreFailure({ operation: 'cursor', message: 'cursor is malformed' })
        )
      : Result.ok(sequence)
  }

  private tail(): number {
    return safeNumber(
      this.database
        .prepare(`SELECT next_cursor FROM ${SQLITE_TABLES.eventCursors} WHERE namespace = ?`)
        .get(this.namespace)?.next_cursor ?? 0,
      'event cursor'
    )
  }

  private prune(now: number): void {
    if (this.retention.ageMs !== undefined) {
      this.database
        .prepare(`DELETE FROM ${SQLITE_TABLES.events} WHERE namespace = ? AND recorded_at_ms < ?`)
        .run(this.namespace, now - this.retention.ageMs)
    }
    if (this.retention.count !== undefined) {
      this.database
        .prepare(
          `DELETE FROM ${SQLITE_TABLES.events} WHERE namespace = ? AND cursor NOT IN (SELECT cursor FROM ${SQLITE_TABLES.events} WHERE namespace = ? ORDER BY cursor DESC LIMIT ?)`
        )
        .run(this.namespace, this.namespace, this.retention.count)
    }
  }

  private assertReadable(after: number): void {
    const tail = this.tail()
    if (after > tail)
      throw new JobEventStoreFailure({
        operation: 'cursor',
        message: 'cursor is ahead of the store tail'
      })
    const first = this.database
      .prepare(`SELECT MIN(cursor) AS cursor FROM ${SQLITE_TABLES.events} WHERE namespace = ?`)
      .get(this.namespace)?.cursor
    if (first == null) {
      if (after < tail) {
        throw new JobEventCursorExpiredError({
          cursor: this.encode(after),
          oldestAvailableCursor: this.encode(tail)
        })
      }
      return
    }
    const oldest = safeNumber(first, 'oldest event cursor')
    if (after < oldest - 1) {
      throw new JobEventCursorExpiredError({
        cursor: this.encode(after),
        oldestAvailableCursor: this.encode(oldest - 1)
      })
    }
  }

  private encode(value: number): JobEventCursor {
    return `${this.prefix}${encodeBase36(value)}` as JobEventCursor
  }

  private readActivation(): JobEventStoreActivation {
    ensureActivationTable(this.database)
    return activationFromRow(activationRow(this.database, this.namespace), this.prefix, (value) =>
      this.encode(value)
    )
  }

  activation(): Operation<JobEventStoreActivation> {
    if (this.closed)
      return asOperation(
        fail(new JobEventStoreFailure({ operation: 'activation', message: 'store is closed' }))
      )
    try {
      return asOperation(ok(this.readActivation()))
    } catch {
      return asOperation(
        fail(
          new JobEventStoreFailure({
            operation: 'activation',
            message: 'SQLite activation read failed'
          })
        )
      )
    }
  }

  readiness(writer: JobEventStoreWriter = this.writer): Operation<JobEventStoreReadiness> {
    try {
      const activation = this.readActivation()
      const ready = activation.state !== 'required' || writer.canAppend
      return asOperation(
        ok({
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
      )
    } catch {
      return asOperation(
        fail(
          new JobEventStoreFailure({
            operation: 'readiness',
            message: 'SQLite activation read failed'
          })
        )
      )
    }
  }

  activate(options: JobEventStoreActivationOptions): Operation<JobEventStoreActivation> {
    if (this.closed)
      return asOperation(
        fail(new JobEventStoreFailure({ operation: 'activate', message: 'store is closed' }))
      )
    try {
      if (
        options === null ||
        typeof options !== 'object' ||
        (options.mode !== 'optional' && options.mode !== 'required')
      )
        throw new Error('mode must be optional or required')
      const now = options.now ?? Date.now()
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('now must be a timestamp')
      this.database.exec('BEGIN IMMEDIATE')
      try {
        ensureActivationTable(this.database)
        const current = activationRow(this.database, this.namespace)
        if (current?.activation_state === 'required' && options.mode === 'optional')
          throw new Error('required activation cannot be downgraded')
        if (current === undefined || current === null) {
          this.database
            .prepare(
              `INSERT INTO ${SQLITE_TABLES.eventActivation}(namespace,activation_state,activation_cursor,activation_revision,activated_at_ms) VALUES(?,?,?,?,?)`
            )
            .run(this.namespace, options.mode, this.tail(), 1, now)
        } else if (current.activation_state === 'optional' && options.mode === 'required') {
          this.database
            .prepare(
              `UPDATE ${SQLITE_TABLES.eventActivation} SET activation_state='required',activation_revision=activation_revision+1,activated_at_ms=? WHERE namespace=?`
            )
            .run(now, this.namespace)
        }
        const result = this.readActivation()
        this.database.exec('COMMIT')
        return asOperation(ok(result))
      } catch (cause) {
        try {
          this.database.exec('ROLLBACK')
        } catch {
          /* preserve activation error */
        }
        throw cause
      }
    } catch (cause) {
      return asOperation(
        fail(
          new JobEventStoreFailure({
            operation: 'activate',
            message: cause instanceof Error ? cause.message : 'SQLite activation failed'
          })
        )
      )
    }
  }

  tailCursor(): Operation<JobEventCursor> {
    if (this.closed)
      return asOperation(
        fail(new JobEventStoreFailure({ operation: 'tailCursor', message: 'store is closed' }))
      )
    try {
      this.prune(Date.now())
      return asOperation(ok(this.encode(this.tail())))
    } catch {
      return asOperation(
        fail(
          new JobEventStoreFailure({ operation: 'tailCursor', message: 'SQLite tailCursor failed' })
        )
      )
    }
  }

  read(options: JobEventReadOptions): Operation<JobEventPage> {
    if (this.closed)
      return asOperation(
        fail(new JobEventStoreFailure({ operation: 'read', message: 'store is closed' }))
      )
    try {
      const normalized = normalizeReadOptions(options, 'read', (value) => this.decode(value))
      this.prune(Date.now())
      this.assertReadable(normalized.after)
      const values: unknown[] = [this.namespace, normalized.after]
      const rows = this.database
        .prepare(
          `SELECT cursor,recorded_at_ms,event_type,job_id,queue,name,version,state,attempt,delivery,worker_id,outcome,failure_kind,duplicate,attributes FROM ${SQLITE_TABLES.events} WHERE namespace = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?`
        )
        .all(...values, Math.min(maxScan, normalized.limit + maxLimit)) as readonly Row[]
      const events: DurableJobEvent[] = []
      let examined: number | undefined
      for (const row of rows) {
        const event = eventFromRow(row, this.prefix)
        examined = safeNumber(row.cursor, 'event cursor')
        if (matches(event, normalized)) events.push(event)
        if (events.length >= normalized.limit) break
      }
      return asOperation(
        ok(
          Object.freeze({
            events: Object.freeze(events),
            nextCursor: examined === undefined ? undefined : this.encode(examined)
          })
        )
      )
    } catch (cause) {
      return asOperation(
        fail(
          JobEventCursorExpiredError.is(cause) || JobEventStoreFailure.is(cause)
            ? cause
            : new JobEventStoreFailure({
                operation: 'read',
                message: cause instanceof Error ? cause.message : 'SQLite read failed'
              })
        )
      )
    }
  }

  awaitEvents(options: {
    readonly after: JobEventCursor
    readonly queues?: readonly import('better-effect-mq').QueueName[]
    readonly signal: AbortSignal
  }): Operation<void> {
    if (this.closed)
      return asOperation(
        fail(new JobEventStoreFailure({ operation: 'awaitEvents', message: 'store is closed' }))
      )
    let after: number
    try {
      const decoded = this.decode(options?.after)
      if (Result.isError(decoded)) return asOperation(fail(decoded.error))
      after = decoded.value
      this.prune(Date.now())
      this.assertReadable(after)
      if (options.signal === undefined || typeof options.signal.addEventListener !== 'function')
        throw new Error('signal must be an AbortSignal')
      if (options.signal.aborted) throw new Error('wait was aborted')
    } catch (cause) {
      return asOperation(
        fail(
          JobEventCursorExpiredError.is(cause) || JobEventStoreFailure.is(cause)
            ? cause
            : new JobEventStoreFailure({
                operation: 'awaitEvents',
                message: cause instanceof Error ? cause.message : 'invalid awaitEvents options'
              })
        )
      )
    }
    const queues =
      options.queues === undefined || options.queues.length === 0
        ? undefined
        : new Set(options.queues.map(String))
    const hasRelevant = (): boolean => {
      this.prune(Date.now())
      this.assertReadable(after)
      const rows = this.database
        .prepare(
          `SELECT cursor,recorded_at_ms,event_type,job_id,queue,name,version,state,attempt,delivery,worker_id,outcome,failure_kind,duplicate,attributes FROM ${SQLITE_TABLES.events} WHERE namespace = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?`
        )
        .all(this.namespace, after, maxScan) as readonly Row[]
      return rows.some((row) =>
        matches(eventFromRow(row, this.prefix), queues === undefined ? {} : { queues: [...queues] })
      )
    }
    try {
      if (hasRelevant()) return asOperation(ok(undefined))
    } catch (cause) {
      return asOperation(
        fail(
          JobEventCursorExpiredError.is(cause) || JobEventStoreFailure.is(cause)
            ? cause
            : new JobEventStoreFailure({
                operation: 'awaitEvents',
                message: 'SQLite event polling failed'
              })
        )
      )
    }
    return asOperationPromise(
      new Promise<EventResult<void>>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const waiters = waitersFor(this.database, this.namespace)
        const waiter: EventWaiter = {
          queues,
          finish: (closed = false) => {
            if (settled) return
            if (closed) {
              settle(
                fail(
                  new JobEventStoreFailure({ operation: 'awaitEvents', message: 'store is closed' })
                )
              )
              return
            }
            try {
              if (hasRelevant()) settle(ok(undefined))
            } catch (cause) {
              settle(
                fail(
                  JobEventCursorExpiredError.is(cause) || JobEventStoreFailure.is(cause)
                    ? cause
                    : new JobEventStoreFailure({
                        operation: 'awaitEvents',
                        message: 'SQLite event polling failed'
                      })
                )
              )
            }
          }
        }
        const onAbort = (): void =>
          settle(
            fail(
              new JobEventStoreFailure({ operation: 'awaitEvents', message: 'wait was aborted' })
            )
          )
        const settle = (result: EventResult<void>): void => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          waiters.delete(waiter)
          options.signal.removeEventListener('abort', onAbort)
          resolve(result)
        }
        waiters.add(waiter)
        options.signal.addEventListener('abort', onAbort, { once: true })
        const poll = (): void => {
          if (settled) return
          try {
            if (hasRelevant()) return settle(ok(undefined))
            timer = setTimeout(poll, this.pollIntervalMs)
          } catch (cause) {
            settle(
              fail(
                JobEventCursorExpiredError.is(cause) || JobEventStoreFailure.is(cause)
                  ? cause
                  : new JobEventStoreFailure({
                      operation: 'awaitEvents',
                      message: 'SQLite event polling failed'
                    })
              )
            )
          }
        }
        timer = setTimeout(poll, this.pollIntervalMs)
      })
    )
  }

  dispose(): void {
    this.closed = true
    const waiters = waitersFor(this.database, this.namespace)
    for (const waiter of waiters) waiter.finish(true)
  }
}

const namespaceFor = (token: AnyJobEventStoreToken, namespace: string): string => {
  if (token.serviceTag === jobEventStoreTag) return namespace
  const suffix = token.serviceTag.slice(`${jobEventStoreTag}/`.length)
  return `${namespace}:${encodeURIComponent(`${JobStore.serviceTag}/${suffix}`)}`
}

const makeLayer = <Token extends AnyJobEventStoreToken>(
  token: Token,
  config: SqliteJobEventStoreConfig
): Layer<InstanceType<Token>, never> => {
  const { retention: _retention, writer: _writer, ...storeConfig } = config
  const normalized = normalizeSqliteJobStoreConfig(storeConfig)
  const retention = validateRetention(config.retention)
  return Layer.scoped(
    token,
    () => {
      const scoped = { ...normalized, namespace: namespaceFor(token, normalized.namespace) }
      if (scoped.configurePragmas)
        scoped.database.exec(
          `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${scoped.busyTimeoutMs};`
        )
      const schema = scoped.validateSchema ? SqliteMigrator.validate(scoped.database) : undefined
      if (schema !== undefined && schema.version !== 6) {
        throw new SqliteSchemaValidationError('JobEventStore requires SQLite migration 6')
      }
      return JobEventStore.of(
        new SqliteJobEventStoreImplementation(
          scoped.database,
          scoped.namespace,
          retention,
          scoped.pollIntervalMs,
          config.writer
        ) as never
      ) as unknown as ServiceContract<InstanceType<Token>>
    },
    (store) => (store as unknown as SqliteJobEventStoreImplementation).dispose()
  )
}

export const SqliteJobEventStore = Object.freeze({
  layer(config: SqliteJobEventStoreConfig) {
    return makeLayer(JobEventStore, config)
  },
  layerFor<Token extends AnyJobEventStoreToken>(token: Token, config: SqliteJobEventStoreConfig) {
    return makeLayer(token, config)
  },
  make(config: SqliteJobEventStoreConfig): JobEventStoreContract {
    const { retention: _retention, writer: _writer, ...storeConfig } = config
    const normalized = normalizeSqliteJobStoreConfig(storeConfig)
    const schema = normalized.validateSchema
      ? SqliteMigrator.validate(normalized.database)
      : undefined
    if (schema !== undefined && schema.version !== 6) {
      throw new SqliteSchemaValidationError('JobEventStore requires SQLite migration 6')
    }
    return JobEventStore.of(
      new SqliteJobEventStoreImplementation(
        normalized.database,
        normalized.namespace,
        config.retention,
        normalized.pollIntervalMs,
        config.writer
      ) as never
    ) as never
  }
})

export type SqliteJobEventStoreInstance = JobEventStoreContract

export const normalizeSqliteJobEventStoreOptions = (
  options: SqliteJobEventStoreOptions | undefined
): {
  readonly retention: Readonly<JobEventRetention>
  readonly writer: JobEventStoreWriter | undefined
} => Object.freeze({ retention: validateRetention(options?.retention), writer: options?.writer })
