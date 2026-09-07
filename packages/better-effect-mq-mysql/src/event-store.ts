// oxlint-disable anti-slop/no-runtime-typeof -- public event-store DTOs are validated at this boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- MySQL rows and public filters are narrowed here.
// oxlint-disable anti-slop/no-chained-type-assertions -- database and Service erasure are confined to checked boundaries.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- MySQL rows are parsed immediately into public event DTOs.
// oxlint-disable anti-slop/no-known-value-widening -- normalized SQL rows retain a named adapter-boundary shape.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below follow validated DTOs and driver rows.
// oxlint-disable typescript/no-base-to-string -- persisted outcome values are scalar protocol fields.

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
  type JobEventStoreOperation,
  type JobIdentity
} from 'better-effect-mq'
import { MySqlClient } from './client'
import {
  normalizeMySqlJobStoreConfig,
  normalizeMySqlJobStoreConnectionConfig,
  type PoolConnection,
  type MySqlJobStoreConfig,
  type MySqlJobStoreConnectionConfig
} from './config'
import { MYSQL_TABLES, quoteIdentifier } from './schema'

export interface MySqlJobEventStoreConfig extends MySqlJobStoreConfig {
  readonly retention?: JobEventRetention
}

export interface MySqlJobEventStoreConnectionConfig extends MySqlJobStoreConnectionConfig {
  readonly retention?: JobEventRetention
}

type Row = Record<string, unknown>
type Tx = PoolConnection
type Operation<Value> = JobEventStoreOperation<Value>
type EventResult<Value> = ResultType<Value, JobEventStoreError>

const maxLimit = 10_000
const maxScan = 20_000
const pollIntervalMs = 250
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

const eventTable = (): string => quoteIdentifier(MYSQL_TABLES.events)
const cursorTable = (): string => quoteIdentifier(MYSQL_TABLES.eventCursors)
const eventCursorColumn = quoteIdentifier('cursor')

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 48)

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

const safeNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
  return value
}

const rowBigInt = (value: unknown, field: string): bigint => {
  try {
    if (typeof value === 'bigint') return value
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
    if (typeof value === 'string' && /^[0-9]+$/u.test(value)) return BigInt(value)
  } catch {
    // Fall through to the stable adapter failure below.
  }
  throw new Error(`${field} is not a valid bigint`)
}

const encodeBase36 = (value: bigint): string => value.toString(36)

const decodeBase36 = (value: string): bigint | undefined => {
  if (value.length === 0 || !/^[0-9a-z]+$/u.test(value)) return undefined
  let result = 0n
  for (const character of value) {
    const digit =
      character >= '0' && character <= '9'
        ? character.charCodeAt(0) - 48
        : character.charCodeAt(0) - 87
    result = result * 36n + BigInt(digit)
  }
  return result
}

const validateRetention = (retention: JobEventRetention | undefined): JobEventRetention => {
  if (retention === undefined) return Object.freeze({})
  if (!isPlainObject(retention)) throw new TypeError('retention must be an object')
  for (const [key, value] of Object.entries(retention)) {
    if (key !== 'ageMs' && key !== 'count')
      throw new TypeError('retention contains unsupported fields')
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`retention.${key} must be positive`)
    }
  }
  return Object.freeze({ ...retention })
}

const normalizeOptions = (
  value: JobEventReadOptions,
  prefix: string,
  decodeCursor: (value: unknown) => ResultType<bigint, JobEventStoreFailure>
): {
  readonly after: bigint
  readonly limit: number
  readonly queues: readonly string[] | undefined
  readonly jobs: readonly JobIdentity[] | undefined
  readonly jobId: string | undefined
  readonly types: readonly DurableJobEventType[] | undefined
} => {
  const input = value as unknown
  if (!isPlainObject(input)) throw new Error(`${prefix} must be an object`)
  const after = input.after === undefined ? undefined : decodeCursor(input.after)
  if (after !== undefined && Result.isError(after)) throw after.error
  const limit = input.limit === undefined ? 100 : safeNumber(input.limit, `${prefix}.limit`)
  if (limit < 1 || limit > maxLimit) throw new Error(`${prefix}.limit must be between 1 and 10000`)
  if (input.queues !== undefined && !Array.isArray(input.queues)) {
    throw new Error(`${prefix}.queues must be an array`)
  }
  const queues =
    input.queues === undefined
      ? undefined
      : input.queues.map((queue: unknown) => {
          const checked = makeQueueName(queue)
          if (Result.isError(checked)) throw checked.error
          return checked.value as string
        })
  if (input.jobs !== undefined && !Array.isArray(input.jobs)) {
    throw new Error(`${prefix}.jobs must be an array`)
  }
  const jobs =
    input.jobs === undefined
      ? undefined
      : input.jobs.map((job: unknown) => {
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
    input.jobId === undefined
      ? undefined
      : (() => {
          const checked = makeJobId(input.jobId)
          if (Result.isError(checked)) throw checked.error
          return checked.value as string
        })()
  if (input.types !== undefined && !Array.isArray(input.types)) {
    throw new Error(`${prefix}.types must be an array`)
  }
  const types =
    input.types === undefined
      ? undefined
      : input.types.map((type: DurableJobEventType) => {
          if (!eventTypes.has(type))
            throw new Error(`${prefix}.types contains an unknown event type`)
          return type
        })
  return {
    after: after === undefined ? 0n : after.value,
    limit,
    queues,
    jobs,
    jobId,
    types
  }
}

const matches = (event: DurableJobEvent, options: ReturnType<typeof normalizeOptions>): boolean => {
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
  if (options.jobId !== undefined && event.jobId !== options.jobId) return false
  if (
    options.types !== undefined &&
    options.types.length > 0 &&
    !options.types.includes(event.type)
  ) {
    return false
  }
  return true
}

const decodeAttributes = (value: unknown): Readonly<Record<string, string>> => {
  const decoded = typeof value === 'string' ? JSON.parse(value) : value
  if (!isPlainObject(decoded)) throw new Error('event attributes must be an object')
  const attributes: Record<string, string> = {}
  for (const [key, item] of Object.entries(decoded)) {
    if (typeof item !== 'string' || key.length > 128 || item.length > 128) {
      throw new Error('event attributes must be bounded strings')
    }
    attributes[key] = item
  }
  return Object.freeze(attributes)
}

const decodeEvent = (row: Row, prefix: string): DurableJobEvent => {
  const cursor = rowBigInt(row.cursor, `${prefix}.cursor`)
  const jobId = row.job_id == null ? undefined : makeJobId(row.job_id)
  const queue = row.queue == null ? undefined : makeQueueName(row.queue)
  const name = row.name == null ? undefined : makeJobName(row.name)
  if (jobId !== undefined && Result.isError(jobId)) throw jobId.error
  if (queue !== undefined && Result.isError(queue)) throw queue.error
  if (name !== undefined && Result.isError(name)) throw name.error
  const type = row.event_type
  if (typeof type !== 'string' || !eventTypes.has(type as DurableJobEventType)) {
    throw new Error(`${prefix}.event_type is unknown`)
  }
  const version =
    row.version == null ? undefined : safeNumber(Number(row.version), `${prefix}.version`)
  return Object.freeze({
    cursor: `${prefix}${encodeBase36(cursor)}` as JobEventCursor,
    type: type as DurableJobEventType,
    recordedAtMs: safeNumber(Number(row.recorded_at_ms), `${prefix}.recorded_at_ms`),
    jobId: jobId === undefined ? undefined : jobId.value,
    queue: queue === undefined ? undefined : queue.value,
    name: name === undefined ? undefined : name.value,
    version,
    state: row.state == null ? undefined : (row.state as DurableJobEvent['state']),
    attempt: row.attempt == null ? undefined : safeNumber(Number(row.attempt), `${prefix}.attempt`),
    delivery:
      row.delivery == null ? undefined : safeNumber(Number(row.delivery), `${prefix}.delivery`),
    workerId: row.worker_id == null ? undefined : (row.worker_id as DurableJobEvent['workerId']),
    outcome: row.outcome == null ? undefined : String(row.outcome),
    failureKind:
      row.failure_kind == null ? undefined : (row.failure_kind as DurableJobEvent['failureKind']),
    duplicate:
      row.duplicate == null
        ? undefined
        : row.duplicate === true || row.duplicate === 1 || row.duplicate === '1',
    attributes: decodeAttributes(row.attributes)
  })
}

const eventInputValues = (input: DurableJobEventInput): readonly unknown[] => [
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
  input.duplicate ?? null,
  JSON.stringify(input.attributes)
]

/** Append one event in a caller-owned MySQL transaction. */
export const appendMySqlJobEvent = async (
  tx: Tx,
  client: Pick<MySqlClient, 'namespace'>,
  input: DurableJobEventInput
): Promise<void> => {
  const counters = cursorTable()
  const events = eventTable()
  await tx.query(
    `INSERT INTO ${counters} (namespace,next_cursor) VALUES (?,0) ON DUPLICATE KEY UPDATE namespace=VALUES(namespace)`,
    [client.namespace]
  )
  await tx.query(
    `UPDATE ${counters} SET next_cursor=next_cursor+1 WHERE namespace=? AND next_cursor < 9007199254740991`,
    [client.namespace]
  )
  const cursor = await tx.query<Row>(
    `SELECT next_cursor FROM ${counters} WHERE namespace=? FOR UPDATE`,
    [client.namespace]
  )
  const nextCursor = cursor.rows[0]?.next_cursor
  if (nextCursor === undefined) throw new Error('event cursor exhausted')
  await tx.query(
    `INSERT INTO ${events} (namespace,${eventCursorColumn},recorded_at_ms,event_type,job_id,queue,name,version,state,attempt,delivery,worker_id,outcome,failure_kind,duplicate,attributes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [client.namespace, nextCursor, ...eventInputValues(input)]
  )
  markMySqlJobEventWake(tx, client.namespace)
}

const eventWakeWaiters = new Map<string, Set<() => void>>()
const pendingEventWakes = new WeakMap<object, Set<string>>()

const markMySqlJobEventWake = (tx: Tx, namespace: string): void => {
  const namespaces = pendingEventWakes.get(tx) ?? new Set<string>()
  namespaces.add(namespace)
  pendingEventWakes.set(tx, namespaces)
}

export const flushMySqlJobEventWakes = (tx: Tx): void => {
  const namespaces = pendingEventWakes.get(tx)
  if (namespaces === undefined) return
  pendingEventWakes.delete(tx)
  for (const namespace of namespaces) {
    for (const wake of eventWakeWaiters.get(namespace) ?? []) wake()
  }
}

type EventWaiter = {
  readonly finish: (result: EventResult<void>) => void
}

class MySqlJobEventStoreImplementation {
  readonly descriptor = descriptor
  private readonly prefix: string
  private readonly retention: JobEventRetention
  private closed = false
  private disposal: Promise<void> | undefined
  private readonly waiters = new Set<EventWaiter>()

  constructor(
    private readonly client: MySqlClient,
    retention: JobEventRetention | undefined
  ) {
    this.prefix = `mysql1_${hash(client.namespace)}_`
    this.retention = validateRetention(retention)
  }

  private table(): string {
    return eventTable()
  }

  private counterTable(): string {
    return cursorTable()
  }

  private encode(cursor: bigint): JobEventCursor {
    return `${this.prefix}${encodeBase36(cursor)}` as JobEventCursor
  }

  private decode(value: unknown): ResultType<bigint, JobEventStoreFailure> {
    if (typeof value !== 'string' || !value.startsWith(this.prefix)) {
      return Result.err(
        new JobEventStoreFailure({
          operation: 'cursor',
          message: 'cursor is not valid for this store'
        })
      )
    }
    const cursor = decodeBase36(value.slice(this.prefix.length))
    return cursor === undefined
      ? Result.err(
          new JobEventStoreFailure({ operation: 'cursor', message: 'cursor is malformed' })
        )
      : Result.ok(cursor)
  }

  private async withTx<Value>(
    operation: string,
    body: (tx: Tx) => Promise<Value>
  ): Promise<EventResult<Value>> {
    if (this.closed)
      return fail(new JobEventStoreFailure({ operation, message: 'store is closed' }))
    let tx: PoolConnection | undefined
    let primary: unknown
    let committed = false
    try {
      tx = await this.client.pool.getConnection()
      await tx.beginTransaction()
      const value = await body(tx)
      await tx.commit()
      committed = true
      return ok(value)
    } catch (cause) {
      primary = cause
    } finally {
      if (!committed && tx !== undefined) {
        try {
          await tx.rollback()
        } catch {
          // Preserve the operation failure as the primary diagnostic.
        }
      }
      try {
        tx?.release()
      } catch {
        // Pool cleanup cannot replace the operation failure.
      }
    }
    if (JobEventCursorExpiredError.is(primary)) return fail(primary)
    if (JobEventStoreFailure.is(primary)) return fail(primary)
    return fail(new JobEventStoreFailure({ operation, message: `MySQL ${operation} failed` }))
  }

  private async prune(tx: Tx, now: number): Promise<void> {
    if (this.retention.ageMs !== undefined) {
      const cutoff = now - this.retention.ageMs
      await tx.query(`DELETE FROM ${this.table()} WHERE namespace=? AND recorded_at_ms < ?`, [
        this.client.namespace,
        cutoff
      ])
    }
    if (this.retention.count !== undefined) {
      await tx.query(
        `DELETE FROM ${this.table()} WHERE namespace=? AND ${eventCursorColumn} NOT IN (SELECT ${eventCursorColumn} FROM (SELECT ${eventCursorColumn} FROM ${this.table()} WHERE namespace=? ORDER BY ${eventCursorColumn} DESC LIMIT ?) AS retained)`,
        [this.client.namespace, this.client.namespace, this.retention.count]
      )
    }
  }

  private async tailSequence(tx: Tx): Promise<bigint> {
    const result = await tx.query<Row>(
      `SELECT next_cursor FROM ${this.counterTable()} WHERE namespace=?`,
      [this.client.namespace]
    )
    return result.rows[0] === undefined ? 0n : rowBigInt(result.rows[0].next_cursor, 'next_cursor')
  }

  private async assertReadable(tx: Tx, after: bigint): Promise<void> {
    const tail = await this.tailSequence(tx)
    if (after > tail) {
      throw new JobEventStoreFailure({
        operation: 'cursor',
        message: 'cursor is ahead of the store tail'
      })
    }
    const first = await tx.query<Row>(
      `SELECT MIN(${eventCursorColumn}) AS ${eventCursorColumn} FROM ${this.table()} WHERE namespace=?`,
      [this.client.namespace]
    )
    const firstCursor = first.rows[0]?.cursor
    if (firstCursor === null || firstCursor === undefined) {
      if (after < tail) {
        throw new JobEventCursorExpiredError({
          cursor: this.encode(after),
          oldestAvailableCursor: this.encode(tail)
        })
      }
      return
    }
    const oldest = rowBigInt(firstCursor, 'cursor')
    if (after < oldest - 1n) {
      throw new JobEventCursorExpiredError({
        cursor: this.encode(after),
        oldestAvailableCursor: this.encode(oldest - 1n)
      })
    }
  }

  tailCursor(): Operation<JobEventCursor> {
    return asOperationPromise(
      this.withTx('tailCursor', async (tx) => {
        await this.prune(tx, Date.now())
        return this.encode(await this.tailSequence(tx))
      })
    )
  }

  read(options: JobEventReadOptions): Operation<JobEventPage> {
    try {
      const normalized = normalizeOptions(options, 'read', (value) => this.decode(value))
      return asOperationPromise(
        this.withTx('read', async (tx) => {
          await this.prune(tx, Date.now())
          await this.assertReadable(tx, normalized.after)
          const rows = await tx.query<Row>(
            `SELECT ${eventCursorColumn},recorded_at_ms,event_type,job_id,queue,name,version,state,attempt,delivery,worker_id,outcome,failure_kind,duplicate,attributes FROM ${this.table()} WHERE namespace=? AND ${eventCursorColumn}>? ORDER BY ${eventCursorColumn} ASC LIMIT ?`,
            [
              this.client.namespace,
              normalized.after,
              Math.min(maxScan, normalized.limit + maxLimit)
            ]
          )
          const events: DurableJobEvent[] = []
          let examined: bigint | undefined
          for (const row of rows.rows) {
            const event = decodeEvent(row, this.prefix)
            examined = rowBigInt(row.cursor, 'cursor')
            if (matches(event, normalized)) events.push(event)
            if (events.length >= normalized.limit) break
          }
          return Object.freeze({
            events: Object.freeze(events),
            nextCursor: examined === undefined ? undefined : this.encode(examined)
          })
        })
      )
    } catch (cause) {
      return asOperation(
        fail(
          new JobEventStoreFailure({
            operation: 'read',
            message: cause instanceof Error ? cause.message : 'invalid read options'
          })
        )
      )
    }
  }

  private async hasEventsAfter(
    after: bigint,
    queues: readonly string[] | undefined
  ): Promise<boolean> {
    const result = await this.withTx('awaitEvents', async (tx) => {
      await this.prune(tx, Date.now())
      await this.assertReadable(tx, after)
      const values: unknown[] = [this.client.namespace, after]
      let queueClause = ''
      if (queues !== undefined && queues.length > 0) {
        queueClause = ` AND queue IN (${queues.map(() => '?').join(',')})`
        values.push(...queues)
      }
      const rows = await tx.query<Row>(
        `SELECT 1 FROM ${this.table()} WHERE namespace=? AND ${eventCursorColumn}>?${queueClause} LIMIT 1`,
        values
      )
      return rows.rows.length > 0
    })
    if (Result.isError(result)) throw result.error
    return result.value
  }

  awaitEvents(options: {
    readonly after: JobEventCursor
    readonly queues?: readonly import('better-effect-mq').QueueName[]
    readonly signal: AbortSignal
  }): Operation<void> {
    if (options === null || typeof options !== 'object') {
      return asOperation(
        fail(
          new JobEventStoreFailure({
            operation: 'awaitEvents',
            message: 'options must be an object'
          })
        )
      )
    }
    const after = this.decode(options.after)
    if (Result.isError(after)) return asOperation(fail(after.error))
    if (
      options === null ||
      typeof options !== 'object' ||
      options.signal === undefined ||
      typeof options.signal.addEventListener !== 'function'
    ) {
      return asOperation(
        fail(
          new JobEventStoreFailure({
            operation: 'awaitEvents',
            message: 'signal must be an AbortSignal'
          })
        )
      )
    }
    let queues: readonly string[] | undefined
    try {
      queues = options.queues?.map((queue) => {
        const checked = makeQueueName(queue)
        if (Result.isError(checked)) throw checked.error
        return checked.value as string
      })
    } catch (cause) {
      return asOperation(
        fail(
          new JobEventStoreFailure({
            operation: 'awaitEvents',
            message: cause instanceof Error ? cause.message : 'invalid queue filter'
          })
        )
      )
    }
    if (options.signal.aborted) {
      return asOperation(
        fail(new JobEventStoreFailure({ operation: 'awaitEvents', message: 'wait was aborted' }))
      )
    }
    return new Promise<EventResult<void>>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let poll: (() => Promise<void>) | undefined
      const wake = (): void => {
        void poll?.()
      }
      const waiter: EventWaiter = {
        finish: (result) => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          this.waiters.delete(waiter)
          const wakes = eventWakeWaiters.get(this.client.namespace)
          wakes?.delete(wake)
          if (wakes?.size === 0) eventWakeWaiters.delete(this.client.namespace)
          try {
            options.signal.removeEventListener('abort', onAbort)
          } catch {
            // Detachment is best effort after settlement.
          }
          resolve(result)
        }
      }
      const onAbort = (): void => {
        waiter.finish(
          fail(new JobEventStoreFailure({ operation: 'awaitEvents', message: 'wait was aborted' }))
        )
      }
      this.waiters.add(waiter)
      const wakes = eventWakeWaiters.get(this.client.namespace) ?? new Set<() => void>()
      wakes.add(wake)
      eventWakeWaiters.set(this.client.namespace, wakes)
      options.signal.addEventListener('abort', onAbort, { once: true })
      poll = async (): Promise<void> => {
        if (settled) return
        try {
          if (await this.hasEventsAfter(after.value, queues)) {
            waiter.finish(ok(undefined))
            return
          }
          if (!settled) timer = setTimeout(() => void poll?.(), pollIntervalMs)
        } catch (cause) {
          waiter.finish(
            fail(
              JobEventCursorExpiredError.is(cause) || JobEventStoreFailure.is(cause)
                ? cause
                : new JobEventStoreFailure({ operation: 'awaitEvents', message: 'poll failed' })
            )
          )
        }
      }
      void poll()
    }) as unknown as Operation<void>
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = (async () => {
      for (const waiter of this.waiters) {
        waiter.finish(
          fail(new JobEventStoreFailure({ operation: 'awaitEvents', message: 'store is closed' }))
        )
      }
      if (this.client.ownsPool) await this.client.dispose()
    })()
    return this.disposal
  }
}

const makeStoreLayer = <Token extends AnyJobEventStoreToken>(
  token: Token,
  acquire: () => Promise<MySqlClient>,
  retention: JobEventRetention,
  ownsClient: boolean
): Layer<InstanceType<Token>, never> =>
  Layer.scoped(
    token,
    async () => {
      const client = await acquire()
      let implementation: MySqlJobEventStoreImplementation | undefined
      try {
        if (client.validateSchema) await client.validate()
        implementation = new MySqlJobEventStoreImplementation(client, retention)
        return JobEventStore.of(implementation as never) as unknown as ServiceContract<
          InstanceType<Token>
        >
      } catch (cause) {
        try {
          if (implementation !== undefined) await implementation.dispose()
          else if (ownsClient) await client.dispose()
        } catch {
          // Preserve the acquisition failure.
        }
        throw cause
      }
    },
    async (store) => {
      await (store as unknown as MySqlJobEventStoreImplementation).dispose()
    }
  ) as Layer<InstanceType<Token>, never>

const normalizedRetention = (config: {
  readonly retention?: JobEventRetention
}): JobEventRetention => validateRetention(config.retention)

const namespaceForEventToken = (token: AnyJobEventStoreToken, namespace: string): string => {
  if (token.serviceTag === jobEventStoreTag) return namespace
  const suffix = token.serviceTag.slice(`${jobEventStoreTag}/`.length)
  return `${namespace}:store-${hash(`${JobStore.serviceTag}/${suffix}`)}`
}

const borrowedClient = (
  token: AnyJobEventStoreToken,
  config: MySqlJobEventStoreConfig
): (() => Promise<MySqlClient>) => {
  const normalized = normalizeMySqlJobStoreConfig({
    pool: config.pool,
    namespace: config.namespace,
    validateSchema: config.validateSchema
  })
  return async () =>
    MySqlClient.fromPool({
      ...normalized,
      namespace: namespaceForEventToken(token, normalized.namespace)
    })
}

const ownedClient = (
  token: AnyJobEventStoreToken,
  config: MySqlJobEventStoreConnectionConfig
): (() => Promise<MySqlClient>) => {
  const normalized = normalizeMySqlJobStoreConnectionConfig({
    uri: config.uri,
    poolConfig: config.poolConfig,
    namespace: config.namespace,
    validateSchema: config.validateSchema
  })
  return () =>
    MySqlClient.fromConfig({
      ...normalized,
      namespace: namespaceForEventToken(token, normalized.namespace)
    })
}

export const MySqlJobEventStore = Object.freeze({
  layer(config: MySqlJobEventStoreConfig) {
    const retention = normalizedRetention(config)
    return makeStoreLayer(JobEventStore, borrowedClient(JobEventStore, config), retention, false)
  },
  layerFor<Token extends AnyJobEventStoreToken>(token: Token, config: MySqlJobEventStoreConfig) {
    const retention = normalizedRetention(config)
    return makeStoreLayer(token, borrowedClient(token, config), retention, false)
  },
  layerFromConfig(config: MySqlJobEventStoreConnectionConfig) {
    const retention = normalizedRetention(config)
    return makeStoreLayer(JobEventStore, ownedClient(JobEventStore, config), retention, true)
  },
  layerFromConfigFor<Token extends AnyJobEventStoreToken>(
    token: Token,
    config: MySqlJobEventStoreConnectionConfig
  ) {
    const retention = normalizedRetention(config)
    return makeStoreLayer(token, ownedClient(token, config), retention, true)
  }
})

export type MySqlJobEventStoreInstance = JobEventStoreContract
