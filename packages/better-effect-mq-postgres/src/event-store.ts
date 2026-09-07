// oxlint-disable anti-slop/no-runtime-typeof -- public event-store DTOs are validated at this boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- PostgreSQL rows and public filters are narrowed here.
// oxlint-disable anti-slop/no-chained-type-assertions -- database and Service erasure are confined to checked boundaries.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- PostgreSQL rows are parsed immediately into public event DTOs.
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
  type JobEventStoreActivation,
  type JobEventStoreActivationOptions,
  type JobEventStoreReadiness,
  type JobEventStoreWriter,
  type JobEventStoreOperation,
  type JobIdentity
} from 'better-effect-mq'
import { JobEventWriterRejectedError } from 'better-effect-mq'
import { PostgresClient } from './client'
import {
  normalizePostgresJobStoreConfig,
  normalizePostgresJobStoreConnectionConfig,
  type PoolClient,
  type PostgresJobStoreConfig,
  type PostgresJobStoreConnectionConfig
} from './config'
import { POSTGRES_TABLES, quoteIdentifier } from './schema'

export interface PostgresJobEventStoreConfig extends PostgresJobStoreConfig {
  readonly retention?: JobEventRetention
}

export interface PostgresJobEventStoreConnectionConfig extends PostgresJobStoreConnectionConfig {
  readonly retention?: JobEventRetention
}

type Row = Record<string, unknown>
type Tx = PoolClient & {
  query<Row = unknown>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number | null }>
}
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
const defaultWriter: JobEventStoreWriter = Object.freeze({
  id: 'better-effect-mq-postgres',
  version: 'current',
  canAppend: true
})

const eventTable = (schema: string): string =>
  `${quoteIdentifier(schema)}.${quoteIdentifier(POSTGRES_TABLES.events)}`
const cursorTable = (schema: string): string =>
  `${quoteIdentifier(schema)}.${quoteIdentifier(POSTGRES_TABLES.eventCursors)}`
const activationTable = (schema: string): string =>
  `${quoteIdentifier(schema)}.${quoteIdentifier(POSTGRES_TABLES.eventActivation)}`

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
  if (!isPlainObject(value)) throw new Error('event attributes must be an object')
  const attributes: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
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
    duplicate: row.duplicate == null ? undefined : row.duplicate === true,
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

/** Append one event in a caller-owned PostgreSQL transaction. */
export const appendPostgresJobEvent = async (
  tx: Tx,
  client: Pick<PostgresClient, 'namespace' | 'schema'>,
  input: DurableJobEventInput
): Promise<void> => {
  await ensureOptionalActivation(tx, client, input.recordedAtMs)
  const counters = cursorTable(client.schema)
  const events = eventTable(client.schema)
  await tx.query(
    `INSERT INTO ${counters} (namespace,next_cursor) VALUES ($1,0) ON CONFLICT (namespace) DO NOTHING`,
    [client.namespace]
  )
  const cursor = await tx.query<Row>(
    `UPDATE ${counters} SET next_cursor=next_cursor+1 WHERE namespace=$1 AND next_cursor < 9007199254740991 RETURNING next_cursor`,
    [client.namespace]
  )
  const nextCursor = cursor.rows[0]?.next_cursor
  if (nextCursor === undefined) throw new Error('event cursor exhausted')
  await tx.query(
    `INSERT INTO ${events} (namespace,cursor,recorded_at_ms,event_type,job_id,queue,name,version,state,attempt,delivery,worker_id,outcome,failure_kind,duplicate,attributes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
    [client.namespace, nextCursor, ...eventInputValues(input)]
  )
}

const ensureActivationTable = async (tx: Tx, schema: string): Promise<void> => {
  await tx.query(
    `CREATE TABLE IF NOT EXISTS ${activationTable(schema)} (
      namespace text PRIMARY KEY,
      activation_state text NOT NULL,
      activation_cursor bigint NOT NULL,
      activation_revision bigint NOT NULL,
      activated_at_ms bigint NOT NULL,
      CONSTRAINT better_effect_mq_job_event_activation_state CHECK (activation_state IN ('optional','required')),
      CONSTRAINT better_effect_mq_job_event_activation_values CHECK (
        namespace <> '' AND activation_cursor BETWEEN 0 AND 9007199254740991
        AND activation_revision BETWEEN 1 AND 9007199254740991
        AND activated_at_ms BETWEEN 0 AND 9007199254740991
      )
    )`
  )
}

const ensureOptionalActivation = async (
  tx: Tx,
  client: Pick<PostgresClient, 'namespace' | 'schema'>,
  now: number
): Promise<void> => {
  await ensureActivationTable(tx, client.schema)
  await tx.query(
    `INSERT INTO ${activationTable(client.schema)}(namespace,activation_state,activation_cursor,activation_revision,activated_at_ms)
     SELECT $1,'optional',COALESCE((SELECT next_cursor FROM ${cursorTable(client.schema)} WHERE namespace=$1),0),1,$2
     WHERE NOT EXISTS (SELECT 1 FROM ${activationTable(client.schema)} WHERE namespace=$1)`,
    [client.namespace, now]
  )
}

const activationFromRow = (
  row: Row | undefined,
  encode: (value: bigint) => JobEventCursor
): JobEventStoreActivation => {
  if (row === undefined)
    return Object.freeze({
      state: 'inactive',
      mode: undefined,
      activationCursor: undefined,
      revision: 0,
      activatedAtMs: undefined
    })
  const state = row.activation_state
  if (state !== 'optional' && state !== 'required') throw new Error('invalid activation state')
  return Object.freeze({
    state,
    mode: state,
    activationCursor: encode(rowBigInt(row.activation_cursor, 'activation_cursor')),
    revision: Number(rowBigInt(row.activation_revision, 'activation_revision')),
    activatedAtMs: Number(rowBigInt(row.activated_at_ms, 'activated_at_ms'))
  })
}

export const assertPostgresJobEventWriterReady = async (
  tx: Tx,
  client: Pick<PostgresClient, 'namespace' | 'schema'>,
  operation: string,
  writer: JobEventStoreWriter,
  eventsAvailable: boolean
): Promise<void> => {
  const available = await tx.query<Row>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2) AS available`,
    [client.schema, POSTGRES_TABLES.eventActivation]
  )
  if (available.rows[0]?.available !== true) return
  const result = await tx.query<Row>(
    `SELECT activation_state,activation_revision FROM ${activationTable(client.schema)} WHERE namespace=$1 FOR UPDATE`,
    [client.namespace]
  )
  const row = result.rows[0]
  if (row?.activation_state === 'required' && (!writer.canAppend || !eventsAvailable)) {
    throw new JobEventWriterRejectedError({
      operation,
      revision: Number(rowBigInt(row.activation_revision, 'activation_revision')),
      writerId: writer.id,
      writerVersion: writer.version
    })
  }
}

type EventWaiter = {
  readonly finish: (result: EventResult<void>) => void
}

class PostgresJobEventStoreImplementation {
  readonly descriptor = descriptor
  private readonly prefix: string
  private readonly retention: JobEventRetention
  private closed = false
  private disposal: Promise<void> | undefined
  private readonly waiters = new Set<EventWaiter>()

  constructor(
    private readonly client: PostgresClient,
    retention: JobEventRetention | undefined,
    private readonly writer: JobEventStoreWriter = defaultWriter
  ) {
    this.prefix = `pg1_${hash(`${client.schema}\u0000${client.namespace}`)}_`
    this.retention = validateRetention(retention)
  }

  private table(): string {
    return eventTable(this.client.schema)
  }

  private counterTable(): string {
    return cursorTable(this.client.schema)
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
    let tx: PoolClient | undefined
    let primary: unknown
    let committed = false
    try {
      tx = await this.client.pool.connect()
      await tx.query('BEGIN')
      const value = await body(tx as Tx)
      await tx.query('COMMIT')
      committed = true
      return ok(value)
    } catch (cause) {
      primary = cause
    } finally {
      if (!committed && tx !== undefined) {
        try {
          await tx.query('ROLLBACK')
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
    return fail(new JobEventStoreFailure({ operation, message: `PostgreSQL ${operation} failed` }))
  }

  private async prune(tx: Tx, now: number): Promise<void> {
    if (this.retention.ageMs !== undefined) {
      const cutoff = now - this.retention.ageMs
      await tx.query(`DELETE FROM ${this.table()} WHERE namespace=$1 AND recorded_at_ms < $2`, [
        this.client.namespace,
        cutoff
      ])
    }
    if (this.retention.count !== undefined) {
      await tx.query(
        `DELETE FROM ${this.table()} WHERE namespace=$1 AND cursor NOT IN (SELECT cursor FROM ${this.table()} WHERE namespace=$1 ORDER BY cursor DESC LIMIT $2)`,
        [this.client.namespace, this.retention.count]
      )
    }
  }

  private async tailSequence(tx: Tx): Promise<bigint> {
    const result = await tx.query<Row>(
      `SELECT next_cursor FROM ${this.counterTable()} WHERE namespace=$1`,
      [this.client.namespace]
    )
    return result.rows[0] === undefined ? 0n : rowBigInt(result.rows[0].next_cursor, 'next_cursor')
  }

  private async readActivation(tx: Tx): Promise<JobEventStoreActivation> {
    await ensureActivationTable(tx, this.client.schema)
    const result = await tx.query<Row>(
      `SELECT activation_state,activation_cursor,activation_revision,activated_at_ms FROM ${activationTable(this.client.schema)} WHERE namespace=$1`,
      [this.client.namespace]
    )
    return activationFromRow(result.rows[0], (value) => this.encode(value))
  }

  activation(): Operation<JobEventStoreActivation> {
    return asOperationPromise(this.withTx('activation', (tx) => this.readActivation(tx)))
  }

  readiness(writer: JobEventStoreWriter = this.writer): Operation<JobEventStoreReadiness> {
    return asOperationPromise(
      this.withTx('readiness', async (tx) => {
        const activation = await this.readActivation(tx)
        const ready = activation.state !== 'required' || writer.canAppend
        return Object.freeze({
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
      })
    )
  }

  activate(options: JobEventStoreActivationOptions): Operation<JobEventStoreActivation> {
    return asOperationPromise(
      this.withTx('activate', async (tx) => {
        if (
          options === null ||
          typeof options !== 'object' ||
          (options.mode !== 'optional' && options.mode !== 'required')
        )
          throw new Error('mode must be optional or required')
        const now = options.now ?? Date.now()
        if (!Number.isSafeInteger(now) || now < 0) throw new Error('now must be a timestamp')
        await ensureActivationTable(tx, this.client.schema)
        const currentResult = await tx.query<Row>(
          `SELECT activation_state,activation_cursor,activation_revision,activated_at_ms FROM ${activationTable(this.client.schema)} WHERE namespace=$1 FOR UPDATE`,
          [this.client.namespace]
        )
        const current = currentResult.rows[0]
        if (current?.activation_state === 'required' && options.mode === 'optional')
          throw new Error('required activation cannot be downgraded')
        if (current === undefined) {
          await tx.query(
            `INSERT INTO ${activationTable(this.client.schema)}(namespace,activation_state,activation_cursor,activation_revision,activated_at_ms) VALUES($1,$2,$3,1,$4)`,
            [this.client.namespace, options.mode, await this.tailSequence(tx), now]
          )
        } else if (current.activation_state === 'optional' && options.mode === 'required') {
          await tx.query(
            `UPDATE ${activationTable(this.client.schema)} SET activation_state='required',activation_revision=activation_revision+1,activated_at_ms=$2 WHERE namespace=$1`,
            [this.client.namespace, now]
          )
        }
        return this.readActivation(tx)
      })
    )
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
      `SELECT MIN(cursor) AS cursor FROM ${this.table()} WHERE namespace=$1`,
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
            `SELECT cursor,recorded_at_ms,event_type,job_id,queue,name,version,state,attempt,delivery,worker_id,outcome,failure_kind,duplicate,attributes FROM ${this.table()} WHERE namespace=$1 AND cursor>$2 ORDER BY cursor ASC LIMIT $3`,
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
        values.push(queues)
        queueClause = ` AND queue = ANY($${values.length}::text[])`
      }
      const rows = await tx.query<Row>(
        `SELECT 1 FROM ${this.table()} WHERE namespace=$1 AND cursor>$2${queueClause} LIMIT 1`,
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
      const waiter: EventWaiter = {
        finish: (result) => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          this.waiters.delete(waiter)
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
      options.signal.addEventListener('abort', onAbort, { once: true })
      const poll = async (): Promise<void> => {
        if (settled) return
        try {
          if (await this.hasEventsAfter(after.value, queues)) {
            waiter.finish(ok(undefined))
            return
          }
          if (!settled) timer = setTimeout(() => void poll(), pollIntervalMs)
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
  acquire: () => Promise<PostgresClient>,
  retention: JobEventRetention,
  ownsClient: boolean,
  writer?: JobEventStoreWriter
): Layer<InstanceType<Token>, never> =>
  Layer.scoped(
    token,
    async () => {
      const client = await acquire()
      let implementation: PostgresJobEventStoreImplementation | undefined
      try {
        if (client.validateSchema) await client.validate()
        implementation = new PostgresJobEventStoreImplementation(client, retention, writer)
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
      await (store as unknown as PostgresJobEventStoreImplementation).dispose()
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
  config: PostgresJobEventStoreConfig
): (() => Promise<PostgresClient>) => {
  const normalized = normalizePostgresJobStoreConfig({
    pool: config.pool,
    namespace: config.namespace,
    schema: config.schema,
    validateSchema: config.validateSchema
  })
  return async () =>
    PostgresClient.fromPool({
      ...normalized,
      namespace: namespaceForEventToken(token, normalized.namespace)
    })
}

const ownedClient = (
  token: AnyJobEventStoreToken,
  config: PostgresJobEventStoreConnectionConfig
): (() => Promise<PostgresClient>) => {
  const normalized = normalizePostgresJobStoreConnectionConfig({
    connectionString: config.connectionString,
    poolConfig: config.poolConfig,
    namespace: config.namespace,
    schema: config.schema,
    validateSchema: config.validateSchema
  })
  return () =>
    PostgresClient.fromConfig({
      ...normalized,
      namespace: namespaceForEventToken(token, normalized.namespace)
    })
}

export const PostgresJobEventStore = Object.freeze({
  layer(config: PostgresJobEventStoreConfig) {
    const retention = normalizedRetention(config)
    return makeStoreLayer(
      JobEventStore,
      borrowedClient(JobEventStore, config),
      retention,
      false,
      config.eventWriter
    )
  },
  layerFor<Token extends AnyJobEventStoreToken>(token: Token, config: PostgresJobEventStoreConfig) {
    const retention = normalizedRetention(config)
    return makeStoreLayer(
      token,
      borrowedClient(token, config),
      retention,
      false,
      config.eventWriter
    )
  },
  layerFromConfig(config: PostgresJobEventStoreConnectionConfig) {
    const retention = normalizedRetention(config)
    return makeStoreLayer(
      JobEventStore,
      ownedClient(JobEventStore, config),
      retention,
      true,
      config.eventWriter
    )
  },
  layerFromConfigFor<Token extends AnyJobEventStoreToken>(
    token: Token,
    config: PostgresJobEventStoreConnectionConfig
  ) {
    const retention = normalizedRetention(config)
    return makeStoreLayer(token, ownedClient(token, config), retention, true, config.eventWriter)
  }
})

export type PostgresJobEventStoreInstance = JobEventStoreContract
