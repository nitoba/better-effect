// oxlint-disable anti-slop/no-chained-type-assertions -- JobStore's structural Service boundary is the one intentional erasure.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts localize completed Result and Service erasure boundaries.
// oxlint-disable anti-slop/no-runtime-typeof -- persisted SQLite rows and tagged protocol failures are checked at boundaries.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- persisted engine snapshots are parsed and validated by the engine boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- event derivation consumes validated engine results at one persistence boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- event records are erased only after the engine Result boundary.
import { Layer } from 'better-effect'
import type { ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  JobStore,
  JobStoreFailure,
  type AnyQueueControlsRegistry,
  type ControlsReconcileOptions,
  type ControlledClaimRequest,
  type ControlledCancelRequest,
  type ControlledRecoverStalledRequest,
  type ControlledReleaseRequest,
  type ControlledSettleRequest,
  type DurableJobEventInput,
  type DurableJobEventType,
  type JobEventStoreWriter,
  JobEventStore,
  JobEventWriterRejectedError,
  type QueueControlsRecord,
  validateFlowChildReport,
  validateParentEnvelope,
  type AnyJobStoreToken,
  type JobStore as JobStoreNamespace
} from 'better-effect-mq'
import type { JobStoreError, JobStoreOperation } from 'better-effect-mq'
import {
  appendSqliteJobEvent,
  assertSqliteJobEventWriterReady,
  normalizeSqliteJobEventStoreOptions,
  SqliteJobEventStore,
  type SqliteJobEventStoreOptions
} from './event-store'
import { normalizeSqliteJobStoreConfig, type SqliteJobStoreConfig } from './config'
import { SqliteAdapterError, sqliteError } from './errors'
import { SqliteMigrator } from './migrator'
import { SQLITE_TABLES } from './schema'
import { SqliteJobStoreEngine } from './internal/engine'
import { withSqliteTransaction } from './internal/transactions'

type Operation<T> = JobStoreOperation<T, JobStoreError>
type SyncOperation<T> = ResultType<T, JobStoreError>
type EventOptions = ReturnType<typeof normalizeSqliteJobEventStoreOptions>
type StateSnapshot = {
  readonly jobs: readonly [string, Record<string, unknown>][]
  readonly paused: readonly string[]
}

const stateSnapshot = (serialized: string): StateSnapshot => {
  const value = JSON.parse(serialized) as Record<string, unknown>
  return {
    jobs: (value.jobs as readonly [string, Record<string, unknown>][]) ?? [],
    paused: (value.paused as readonly string[]) ?? []
  }
}

const attemptEventType = (attempt: Record<string, unknown>): DurableJobEventType => {
  switch (attempt.outcome) {
    case 'completed':
      return 'job-completed'
    case 'retried':
      return 'job-retry-scheduled'
    case 'failed':
      return 'job-failed'
    case 'cancelled':
      return 'job-cancelled'
    case 'stalled':
      return 'job-stalled-recovered'
    case 'released':
      return 'job-released'
    default:
      throw new Error('unsupported attempt outcome')
  }
}

const transitionEventType = (
  operation: string,
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>
): DurableJobEventType | undefined => {
  switch (operation) {
    case 'cancel':
    case 'cancelControlled':
      return previous?.state === 'active'
        ? previous.cancellationRequestedAt === next.cancellationRequestedAt
          ? undefined
          : 'job-cancel-requested'
        : 'job-cancelled'
    case 'requestCancellation':
      return previous?.cancellationRequestedAt === next.cancellationRequestedAt
        ? undefined
        : 'job-cancel-requested'
    case 'promote':
      return 'job-promoted'
    case 'retry':
      return 'job-admin-retried'
    case 'release':
    case 'releaseControlled':
      return 'job-released'
    case 'recoverStalled':
    case 'recoverStalledControlled':
      return 'job-stalled-recovered'
    default:
      return undefined
  }
}

const eventInput = (
  type: DurableJobEventType,
  record: Record<string, unknown> | undefined,
  recordedAtMs: number,
  context: {
    readonly previous?: Record<string, unknown> | undefined
    readonly attempt?: Record<string, unknown> | undefined
    readonly duplicate?: boolean | undefined
    readonly queue?: string | undefined
  } = {}
): DurableJobEventInput => ({
  type,
  recordedAtMs,
  jobId: record?.id as never,
  queue: (record?.queue ?? context.queue) as never,
  name: record?.name as never,
  version: record?.version as never,
  state: record?.state as never,
  attempt: (context.attempt?.attemptSequence ?? context.attempt?.attempt) as never,
  delivery: (context.attempt?.delivery ??
    (typeof record?.deliveryCount === 'number' && record.deliveryCount > 0
      ? record.deliveryCount
      : undefined)) as never,
  workerId: (record?.leaseOwner ?? context.previous?.leaseOwner) as never,
  outcome: (context.attempt?.outcome ??
    (type === 'job-released' ? 'released' : undefined)) as never,
  failureKind: (() => {
    const failure = record?.failure
    const previousFailure = context.previous?.failure
    const currentKind =
      failure !== null && typeof failure === 'object' && 'kind' in failure
        ? failure.kind
        : undefined
    const previousKind =
      previousFailure !== null && typeof previousFailure === 'object' && 'kind' in previousFailure
        ? previousFailure.kind
        : undefined
    return (currentKind ?? previousKind) as never
  })(),
  duplicate: context.duplicate,
  attributes: Object.freeze({})
})

const eventRecordedAt = (record: Record<string, unknown> | undefined, fallback: number): number =>
  typeof record?.updatedAt === 'number'
    ? record.updatedAt
    : typeof record?.createdAt === 'number'
      ? record.createdAt
      : fallback

const terminalFlowReport = (
  attempt: import('better-effect-mq').AttemptRecord | undefined,
  parent: string | undefined,
  jobId: string
):
  | {
      readonly report: import('better-effect-mq').FlowChildReport
      readonly id: string
      readonly flowName: string
      readonly parentStoreKey: string
    }
  | undefined => {
  const outcome =
    attempt?.outcome === 'completed'
      ? 'completed'
      : attempt?.outcome === 'failed'
        ? 'failed'
        : attempt?.outcome === 'cancelled'
          ? 'cancelled'
          : attempt?.outcome === 'stalled' && attempt.failure?.retryable === false
            ? 'failed'
            : undefined
  if (attempt === undefined || outcome === undefined) return undefined
  if (parent === undefined || parent === null) return undefined
  const parsed = typeof parent === 'string' ? JSON.parse(parent) : parent
  const envelope = validateParentEnvelope(parsed)
  if (Result.isError(envelope)) throw envelope.error
  const report = validateFlowChildReport({
    flowId: envelope.value.flowId,
    childKey: envelope.value.childKey,
    outcome,
    result: attempt.outcome === 'completed' ? attempt.result : undefined,
    failure: attempt.outcome === 'completed' ? undefined : attempt.failure
  })
  if (Result.isError(report)) throw report.error
  return {
    report: report.value,
    id: `flow-report/${jobId}/${attempt.attemptSequence ?? attempt.attempt}`,
    flowName: envelope.value.flowName,
    parentStoreKey: envelope.value.parentStoreKey
  }
}

const descriptor = Object.freeze({
  protocolVersion: 1 as const,
  adapter: 'sqlite',
  adapterVersion: '0.1.0',
  layoutVersion: 1,
  capabilities: Object.freeze({
    queueFilteredNotifications: true,
    nativeBatchEnqueue: true,
    nativeBatchClaim: true,
    metadataIndex: 'residual' as const,
    transactionalEnqueue: false,
    durableChangeFeed: false,
    globalConcurrency: true,
    rateLimiting: true
  })
})

const failed = <T>(operation: string, cause: unknown): Operation<T> =>
  Result.err(
    cause instanceof JobStoreFailure ||
      (cause !== null && typeof cause === 'object' && '_tag' in cause)
      ? cause
      : new JobStoreFailure({ operation, retryable: false, message: `SQLite ${operation} failed` })
  ) as unknown as Operation<T>

class SqliteJobStoreImplementation {
  readonly descriptor = descriptor
  private readonly engine = new SqliteJobStoreEngine()
  private chain: Promise<void> = Promise.resolve()
  private closed = false
  private flowReportsEnabled: boolean | undefined
  private readonly wakePollers = new Set<ReturnType<typeof setInterval>>()

  private readonly eventOptions: EventOptions | undefined
  private readonly eventWriter: JobEventStoreWriter

  constructor(
    private readonly config: ReturnType<typeof normalizeSqliteJobStoreConfig>,
    eventOptions?: SqliteJobEventStoreOptions
  ) {
    this.eventOptions =
      eventOptions === undefined ? undefined : normalizeSqliteJobEventStoreOptions(eventOptions)
    this.eventWriter = eventOptions?.writer ?? {
      id: 'better-effect-mq-sqlite',
      version: 'current',
      canAppend: eventOptions !== undefined
    }
  }

  private execute<T>(
    operation: string,
    mutable: boolean,
    callback: () => SyncOperation<T>
  ): Promise<Operation<T>> {
    const run = async (): Promise<Operation<T>> => {
      if (this.closed) return failed<T>(operation, new SqliteAdapterError('store is closed'))
      try {
        if (mutable) this.config.database.exec('BEGIN IMMEDIATE')
        if (mutable) {
          assertSqliteJobEventWriterReady(
            this.config.database,
            this.config.namespace,
            operation,
            this.eventWriter
          )
        }
        this.restore()
        const before = mutable ? this.engine.exportState() : undefined
        const result = callback()
        if (mutable && Result.isOk(result)) {
          this.persist(before!)
          if (this.eventOptions !== undefined && this.eventWriter.canAppend) {
            this.appendEvents(operation, result.value, before!)
          }
        }
        if (mutable) this.config.database.exec(Result.isOk(result) ? 'COMMIT' : 'ROLLBACK')
        return result as Operation<T>
      } catch (cause) {
        if (mutable) {
          try {
            this.config.database.exec('ROLLBACK')
          } catch {
            /* primary error wins */
          }
        }
        if (JobEventWriterRejectedError.is(cause)) return Result.err(cause) as Operation<T>
        return failed<T>(operation, sqliteError(operation, cause))
      }
    }
    const result = this.chain.then(
      () => (mutable ? withSqliteTransaction(this.config.database, run) : run()),
      () => (mutable ? withSqliteTransaction(this.config.database, run) : run())
    )
    this.chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private appendEvents(operation: string, value: unknown, beforeSerialized: string): void {
    const options = this.eventOptions
    if (options === undefined) return
    const before = stateSnapshot(beforeSerialized)
    const previousJobs = new Map(before.jobs)
    const recordedAtMs = Date.now()
    const append = (event: DurableJobEventInput): void =>
      appendSqliteJobEvent(this.config.database, this.config.namespace, event, options.retention)
    const result = value as Record<string, unknown>
    if (operation === 'enqueue' && result.duplicate !== true) {
      append(
        eventInput(
          'job-enqueued',
          result.job as Record<string, unknown>,
          eventRecordedAt(result.job as Record<string, unknown>, recordedAtMs),
          {
            duplicate: false
          }
        )
      )
      return
    }
    if (operation === 'enqueueMany' && Array.isArray(value)) {
      for (const item of value) {
        if (item?.duplicate !== true) {
          append(
            eventInput(
              'job-enqueued',
              item.job as Record<string, unknown>,
              eventRecordedAt(item.job as Record<string, unknown>, recordedAtMs),
              { duplicate: false }
            )
          )
        }
      }
      return
    }
    if (operation === 'claim' || operation === 'claimControlled') {
      for (const job of (result.jobs as readonly Record<string, unknown>[]) ?? []) {
        append(eventInput('job-claimed', job, eventRecordedAt(job, recordedAtMs)))
      }
      return
    }
    if (operation === 'settle' || operation === 'settleControlled') {
      if (result.status === 'applied') {
        const attempt = result.attempt as Record<string, unknown>
        const record = result.record as Record<string, unknown>
        append(
          eventInput(attemptEventType(attempt), record, eventRecordedAt(record, recordedAtMs), {
            previous: previousJobs.get(String(record.id)),
            attempt
          })
        )
      }
      return
    }
    if (operation === 'recoverStalled' || operation === 'recoverStalledControlled') {
      for (const transition of (result.transitions as readonly Record<string, unknown>[]) ?? []) {
        const record = transition.record as Record<string, unknown>
        append(
          eventInput('job-stalled-recovered', record, eventRecordedAt(record, recordedAtMs), {
            previous: previousJobs.get(String(record.id)),
            attempt: transition.attempt as Record<string, unknown> | undefined
          })
        )
      }
      return
    }
    if (operation === 'remove') {
      const job = result.job as Record<string, unknown>
      append(eventInput('job-removed', job, eventRecordedAt(job, recordedAtMs)))
      return
    }
    if (operation === 'pause' || operation === 'resume') {
      const queue = typeof result.queue === 'string' ? result.queue : undefined
      const wasPaused = queue !== undefined && before.paused.includes(queue)
      const paused = result.paused === true
      if (queue !== undefined && wasPaused !== paused) {
        append(
          eventInput(paused ? 'queue-paused' : 'queue-resumed', undefined, recordedAtMs, { queue })
        )
      }
      return
    }
    if (result.record !== undefined) {
      const record = result.record as Record<string, unknown>
      const type = transitionEventType(operation, previousJobs.get(String(record.id)), record)
      if (type !== undefined) {
        append(
          eventInput(type, record, eventRecordedAt(record, recordedAtMs), {
            previous: previousJobs.get(String(record.id))
          })
        )
      }
      return
    }
    if (result.id !== undefined && result.state !== undefined) {
      const record = result
      const type = transitionEventType(operation, previousJobs.get(String(record.id)), record)
      if (type !== undefined)
        append(
          eventInput(type, record, eventRecordedAt(record, recordedAtMs), {
            previous: previousJobs.get(String(record.id))
          })
        )
    }
  }

  private restore(): void {
    const metadata = this.config.database
      .prepare(`SELECT state_json FROM ${SQLITE_TABLES.state} WHERE namespace = ?`)
      .get(this.config.namespace)
    const base = JSON.parse(this.engine.exportState()) as Record<string, unknown>
    if (metadata != null && typeof metadata.state_json === 'string') {
      const parsed = JSON.parse(metadata.state_json)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(base, parsed)
      } else throw new SqliteAdapterError('persisted SQLite metadata is invalid')
    }
    const jobs = this.config.database
      .prepare(
        `SELECT id, dispatch_key, record_json FROM ${SQLITE_TABLES.jobs} WHERE namespace = ? AND state <> 'waiting-children'`
      )
      .all(this.config.namespace)
      .flatMap((row) =>
        row !== undefined && typeof row.id === 'string' && typeof row.record_json === 'string'
          ? [
              [
                row.id,
                (() => {
                  const parsed: unknown = JSON.parse(row.record_json)
                  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    return parsed
                  }
                  const record = parsed as Record<string, unknown>
                  if (record.dispatchKey === undefined && typeof row.dispatch_key === 'string')
                    record.dispatchKey = row.dispatch_key
                  return record
                })()
              ]
            ]
          : []
      )
    const attempts = this.config.database
      .prepare(
        `SELECT job_id, attempt_json FROM ${SQLITE_TABLES.attempts} WHERE namespace = ? ORDER BY ledger_sequence`
      )
      .all(this.config.namespace)
      .reduce(
        (entries, row) => {
          if (
            row === undefined ||
            typeof row.job_id !== 'string' ||
            typeof row.attempt_json !== 'string'
          ) {
            throw new SqliteAdapterError('persisted SQLite attempt is invalid')
          }
          const found = entries.find(([id]) => id === row.job_id)
          if (found === undefined) entries.push([row.job_id, [JSON.parse(row.attempt_json)]])
          else found[1].push(JSON.parse(row.attempt_json))
          return entries
        },
        [] as [string, unknown[]][]
      )
    const queues = this.config.database
      .prepare(
        `SELECT queue, paused, wake_version FROM ${SQLITE_TABLES.queues} WHERE namespace = ?`
      )
      .all(this.config.namespace)
    base.jobs = jobs
    base.attempts = attempts
    base.paused = queues.flatMap((row) =>
      row !== undefined && typeof row.queue === 'string' && Number(row.paused) === 1
        ? [row.queue]
        : []
    )
    base.queueWakeVersions = queues.flatMap((row) =>
      row !== undefined &&
      typeof row.queue === 'string' &&
      Number.isSafeInteger(Number(row.wake_version))
        ? [[row.queue, Number(row.wake_version)]]
        : []
    )
    base.controls = this.config.database
      .prepare(
        `SELECT queue, control_group, enabled, revision, global_concurrency, per_key_concurrency, rate_limit_max, rate_limit_duration_ms, created_at_ms, updated_at_ms FROM ${SQLITE_TABLES.controls} WHERE namespace = ?`
      )
      .all(this.config.namespace)
      .flatMap((row) =>
        typeof row?.queue === 'string' && typeof row.control_group === 'string'
          ? [
              [
                row.queue,
                {
                  queue: row.queue,
                  group: row.control_group,
                  enabled: Number(row.enabled) === 1,
                  revision: Number(row.revision),
                  globalConcurrency:
                    row.global_concurrency == null ? undefined : Number(row.global_concurrency),
                  perKeyConcurrency:
                    row.per_key_concurrency == null ? undefined : Number(row.per_key_concurrency),
                  rateLimit:
                    row.rate_limit_max == null || row.rate_limit_duration_ms == null
                      ? undefined
                      : {
                          max: Number(row.rate_limit_max),
                          durationMs: Number(row.rate_limit_duration_ms)
                        },
                  createdAtMs: Number(row.created_at_ms),
                  updatedAtMs: Number(row.updated_at_ms)
                }
              ]
            ]
          : []
      )
    base.controlledPermits = this.config.database
      .prepare(
        `SELECT job_id, lease_token, dispatch_key FROM ${SQLITE_TABLES.permits} WHERE namespace = ?`
      )
      .all(this.config.namespace)
      .flatMap((row) =>
        typeof row?.job_id === 'string' &&
        typeof row.lease_token === 'string' &&
        typeof row.dispatch_key === 'string'
          ? [[row.job_id, { leaseToken: row.lease_token, dispatchKey: row.dispatch_key }]]
          : []
      )
    base.rateWindows = this.config.database
      .prepare(
        `SELECT queue, started_at_ms, claim_count FROM ${SQLITE_TABLES.rateWindows} WHERE namespace = ?`
      )
      .all(this.config.namespace)
      .flatMap((row) =>
        typeof row?.queue === 'string'
          ? [
              [
                row.queue,
                { startedAtMs: Number(row.started_at_ms), count: Number(row.claim_count) }
              ]
            ]
          : []
      )
    base.rotations = this.config.database
      .prepare(
        `SELECT queue, cursor_sequence FROM ${SQLITE_TABLES.controlCursors} WHERE namespace = ?`
      )
      .all(this.config.namespace)
      .flatMap((row) =>
        typeof row?.queue === 'string' ? [[row.queue, Number(row.cursor_sequence)]] : []
      )
    this.engine.restoreState(JSON.stringify(base))
  }

  private flowReportsAvailable(): boolean {
    if (this.flowReportsEnabled !== undefined) return this.flowReportsEnabled
    try {
      const outbox = this.config.database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(SQLITE_TABLES.flowOutbox)
      const columns = this.config.database.prepare(`PRAGMA table_info(${SQLITE_TABLES.jobs})`).all()
      this.flowReportsEnabled =
        outbox !== undefined && outbox !== null && columns.some((row) => row?.name === 'parent')
    } catch {
      this.flowReportsEnabled = false
    }
    return this.flowReportsEnabled
  }

  private parentFor(jobId: string): string | undefined {
    if (!this.flowReportsAvailable()) return undefined
    const parent = this.config.database
      .prepare(`SELECT parent FROM ${SQLITE_TABLES.jobs} WHERE namespace = ? AND id = ?`)
      .get(this.config.namespace, jobId)?.parent
    return typeof parent === 'string' ? parent : undefined
  }

  private appendTerminalReport(
    parent: string | undefined,
    attempt: import('better-effect-mq').AttemptRecord | undefined,
    jobId: string,
    now: number
  ): void {
    const normalized = terminalFlowReport(attempt, parent, jobId)
    if (normalized === undefined) return
    this.config.database
      .prepare(
        `INSERT INTO ${SQLITE_TABLES.flowOutbox}(namespace, id, flow_name, parent_store_key, report_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, id) DO NOTHING`
      )
      .run(
        this.config.namespace,
        normalized.id,
        normalized.flowName,
        normalized.parentStoreKey,
        JSON.stringify(normalized.report),
        now
      )
  }

  private persist(previous: string): void {
    const before = JSON.parse(previous) as Record<string, unknown>
    const after = JSON.parse(this.engine.exportState()) as Record<string, unknown>
    const beforeJobs = new Map(before.jobs as [string, Record<string, unknown>][])
    const afterJobs = new Map(after.jobs as [string, Record<string, unknown>][])
    for (const [id] of beforeJobs) {
      if (!afterJobs.has(id)) {
        this.config.database
          .prepare(`DELETE FROM ${SQLITE_TABLES.jobs} WHERE namespace = ? AND id = ?`)
          .run(this.config.namespace, id)
      }
    }
    for (const [id, record] of afterJobs) {
      if (JSON.stringify(record) === JSON.stringify(beforeJobs.get(id))) continue
      this.writeJob(record)
    }
    this.persistAttempts(
      before.attempts as [string, unknown[]][],
      after.attempts as [string, unknown[]][]
    )
    this.persistQueues(before, after)
    const metadata = { ...after }
    delete metadata.jobs
    delete metadata.attempts
    delete metadata.paused
    delete metadata.queueWakeVersions
    delete metadata.controls
    delete metadata.controlledPermits
    delete metadata.rateWindows
    delete metadata.rotations
    this.config.database
      .prepare(
        `INSERT INTO ${SQLITE_TABLES.state}(namespace, state_json, updated_at_ms) VALUES(?, ?, ?) ON CONFLICT(namespace) DO UPDATE SET state_json = excluded.state_json, updated_at_ms = excluded.updated_at_ms`
      )
      .run(this.config.namespace, JSON.stringify(metadata), Date.now())
    this.persistControlledPermits(after)
    this.persistRateWindows(after)
    this.persistControls(after)
  }

  private writeJob(record: Record<string, unknown>): void {
    const values = [
      this.config.namespace,
      record.id,
      record.queue,
      record.name,
      record.version,
      record.state,
      record.dispatchKey ?? null,
      JSON.stringify(record.payload),
      JSON.stringify(record.metadata),
      JSON.stringify(record),
      record.priority,
      record.runAt,
      record.orderingSequence,
      record.attemptsMax,
      record.attemptsMade,
      record.attemptSequence,
      record.deliveryCount,
      record.stalledCount,
      record.backoff === undefined ? null : JSON.stringify(record.backoff),
      record.timeoutMs ?? null,
      record.idempotencyKey ?? null,
      record.createdAt,
      record.updatedAt,
      record.processedAt ?? null,
      record.finishedAt ?? null,
      record.leaseOwner ?? null,
      record.leaseToken ?? null,
      record.leaseExpiresAt ?? null,
      record.cancellationRequestedAt === undefined ? 0 : 1,
      record.cancellationRequestedAt ?? null,
      record.result === undefined ? null : JSON.stringify(record.result),
      record.failure === undefined ? null : JSON.stringify(record.failure)
    ]
    const changed = this.config.database
      .prepare(
        `UPDATE ${SQLITE_TABLES.jobs} SET queue=?, name=?, version=?, state=?, dispatch_key=?, payload=?, metadata=?, record_json=?, priority=?, run_at_ms=?, order_sequence=?, attempts_max=?, attempts_made=?, attempt_sequence=?, delivery_count=?, stalled_count=?, backoff=?, timeout_ms=?, idempotency_key=?, created_at_ms=?, updated_at_ms=?, processed_at_ms=?, finished_at_ms=?, lease_owner=?, lease_token=?, lease_expires_at_ms=?, cancel_requested=?, cancellation_requested_at_ms=?, result=?, failure=? WHERE namespace=? AND id=?`
      )
      .run(...values.slice(2), this.config.namespace, record.id).changes
    if (changed === 0) {
      this.config.database
        .prepare(
          `INSERT INTO ${SQLITE_TABLES.jobs}(namespace,id,queue,name,version,state,dispatch_key,payload,metadata,record_json,priority,run_at_ms,order_sequence,attempts_max,attempts_made,attempt_sequence,delivery_count,stalled_count,backoff,timeout_ms,idempotency_key,created_at_ms,updated_at_ms,processed_at_ms,finished_at_ms,lease_owner,lease_token,lease_expires_at_ms,cancel_requested,cancellation_requested_at_ms,result,failure) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...values)
    }
  }

  private persistAttempts(before: [string, unknown[]][], after: [string, unknown[]][]): void {
    const previous = new Map(before)
    for (const [jobId, attempts] of after) {
      const old = previous.get(jobId) ?? []
      const prefix = old.every(
        (attempt, index) => JSON.stringify(attempt) === JSON.stringify(attempts[index])
      )
      if (!prefix) {
        this.config.database
          .prepare(`DELETE FROM ${SQLITE_TABLES.attempts} WHERE namespace=? AND job_id=?`)
          .run(this.config.namespace, jobId)
      }
      const start = prefix ? old.length : 0
      for (const attempt of attempts.slice(start)) {
        const value = attempt as Record<string, unknown>
        this.config.database
          .prepare(
            `INSERT INTO ${SQLITE_TABLES.attempts}(namespace,job_id,attempt_sequence,attempt,delivery,started_at_ms,finished_at_ms,outcome,result,failure,worker_id,retry_at_ms,retry_delay_ms,attempt_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            this.config.namespace,
            jobId,
            value.attemptSequence ?? value.attempt,
            value.attempt,
            value.delivery,
            value.startedAt ?? null,
            value.finishedAt,
            value.outcome,
            value.result === undefined ? null : JSON.stringify(value.result),
            value.failure === undefined ? null : JSON.stringify(value.failure),
            null,
            value.retryAt ?? null,
            value.retryDelayMs ?? null,
            JSON.stringify(value)
          )
      }
      previous.delete(jobId)
    }
    for (const [jobId] of previous) {
      this.config.database
        .prepare(`DELETE FROM ${SQLITE_TABLES.attempts} WHERE namespace=? AND job_id=?`)
        .run(this.config.namespace, jobId)
    }
  }

  private persistQueues(before: Record<string, unknown>, after: Record<string, unknown>): void {
    const queues = new Set<string>()
    for (const input of [before, after]) {
      for (const queue of input.paused as string[]) queues.add(queue)
      for (const [queue] of input.queueWakeVersions as [string, number][]) queues.add(queue)
    }
    const paused = new Set(after.paused as string[])
    const versions = new Map(after.queueWakeVersions as [string, number][])
    for (const queue of queues) {
      this.config.database
        .prepare(
          `INSERT INTO ${SQLITE_TABLES.queues}(namespace,queue,paused,wake_version,updated_at_ms) VALUES(?,?,?,?,?) ON CONFLICT(namespace,queue) DO UPDATE SET paused=excluded.paused,wake_version=excluded.wake_version,updated_at_ms=excluded.updated_at_ms`
        )
        .run(
          this.config.namespace,
          queue,
          paused.has(queue) ? 1 : 0,
          versions.get(queue) ?? 0,
          Date.now()
        )
    }
  }

  private persistControls(after: Record<string, unknown>): void {
    this.config.database
      .prepare(`DELETE FROM ${SQLITE_TABLES.controlCursors} WHERE namespace = ?`)
      .run(this.config.namespace)
    this.config.database
      .prepare(`DELETE FROM ${SQLITE_TABLES.controls} WHERE namespace = ?`)
      .run(this.config.namespace)
    for (const entry of (after.controls as readonly [string, QueueControlsRecord][]) ?? []) {
      const record = entry[1]
      this.config.database
        .prepare(
          `INSERT INTO ${SQLITE_TABLES.controls}(namespace,queue,control_group,enabled,revision,global_concurrency,per_key_concurrency,rate_limit_max,rate_limit_duration_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          this.config.namespace,
          record.queue,
          record.group,
          record.enabled ? 1 : 0,
          record.revision,
          record.globalConcurrency ?? null,
          record.perKeyConcurrency ?? null,
          record.rateLimit?.max ?? null,
          record.rateLimit?.durationMs ?? null,
          record.createdAtMs,
          record.updatedAtMs
        )
    }
    this.persistControlCursors(after)
  }

  private persistControlledPermits(after: Record<string, unknown>): void {
    this.config.database
      .prepare(`DELETE FROM ${SQLITE_TABLES.permits} WHERE namespace = ?`)
      .run(this.config.namespace)
    const jobs = new Map(after.jobs as readonly [string, Record<string, unknown>][])
    for (const entry of (after.controlledPermits as readonly [
      string,
      { readonly leaseToken: string; readonly dispatchKey: string }
    ][]) ?? []) {
      const job = jobs.get(entry[0])
      if (job === undefined) continue
      this.config.database
        .prepare(
          `INSERT INTO ${SQLITE_TABLES.permits}(namespace,job_id,queue,dispatch_key,lease_token,acquired_at_ms) VALUES(?,?,?,?,?,?)`
        )
        .run(
          this.config.namespace,
          entry[0],
          job.queue,
          entry[1].dispatchKey,
          entry[1].leaseToken,
          job.updatedAt
        )
    }
  }

  private persistRateWindows(after: Record<string, unknown>): void {
    this.config.database
      .prepare(`DELETE FROM ${SQLITE_TABLES.rateWindows} WHERE namespace = ?`)
      .run(this.config.namespace)
    for (const entry of (after.rateWindows as readonly [
      string,
      { readonly startedAtMs: number; readonly count: number }
    ][]) ?? []) {
      this.config.database
        .prepare(
          `INSERT INTO ${SQLITE_TABLES.rateWindows}(namespace,queue,started_at_ms,claim_count,updated_at_ms) VALUES(?,?,?,?,?)`
        )
        .run(this.config.namespace, entry[0], entry[1].startedAtMs, entry[1].count, Date.now())
    }
  }

  private persistControlCursors(after: Record<string, unknown>): void {
    this.config.database
      .prepare(`DELETE FROM ${SQLITE_TABLES.controlCursors} WHERE namespace = ?`)
      .run(this.config.namespace)
    for (const entry of (after.rotations as readonly [string, number][]) ?? []) {
      this.config.database
        .prepare(
          `INSERT INTO ${SQLITE_TABLES.controlCursors}(namespace,queue,cursor_sequence,updated_at_ms) VALUES(?,?,?,?)`
        )
        .run(this.config.namespace, entry[0], entry[1], Date.now())
    }
  }

  enqueue(request: JobStoreNamespace.EnqueueRequest) {
    return this.execute(
      'enqueue',
      true,
      () => this.engine.enqueue(request) as SyncOperation<JobStoreNamespace.EnqueueResult>
    )
  }
  enqueueMany(requests: readonly JobStoreNamespace.EnqueueRequest[]) {
    return this.execute(
      'enqueueMany',
      true,
      () => this.engine.enqueueMany(requests) as SyncOperation<JobStoreNamespace.EnqueueManyResult>
    )
  }
  claim(request: JobStoreNamespace.ClaimRequest) {
    return this.execute(
      'claim',
      true,
      () => this.engine.claim(request) as SyncOperation<JobStoreNamespace.ClaimResult>
    )
  }
  getControls(request: { readonly queue: import('better-effect-mq').QueueName }) {
    return this.execute(
      'getControls',
      false,
      () => this.engine.getControls(request) as SyncOperation<QueueControlsRecord | undefined>
    )
  }
  get(queue: import('better-effect-mq').QueueName) {
    return this.getControls({ queue })
  }
  reconcile(registry: AnyQueueControlsRegistry, options?: ControlsReconcileOptions) {
    return this.execute(
      'reconcile',
      true,
      () =>
        this.engine.reconcile(registry, options) as SyncOperation<
          import('better-effect-mq').ControlsReconcileReport
        >
    )
  }
  claimControlled(request: ControlledClaimRequest) {
    return this.execute(
      'claimControlled',
      true,
      () =>
        this.engine.claimControlled(request) as SyncOperation<
          import('better-effect-mq').ControlledClaimResult
        >
    )
  }
  settleControlled(request: ControlledSettleRequest) {
    return this.execute('settleControlled', true, () => {
      const parent = this.parentFor(request.jobId)
      const result = this.engine.settleControlled(request) as SyncOperation<
        import('better-effect-mq').ControlledSettlementResult
      >
      if (Result.isOk(result))
        this.appendTerminalReport(parent, result.value.attempt, request.jobId, request.now)
      return result
    })
  }
  releaseControlled(request: ControlledReleaseRequest) {
    return this.execute(
      'releaseControlled',
      true,
      () =>
        this.engine.releaseControlled(request) as SyncOperation<
          import('better-effect-mq').ReleaseResult
        >
    )
  }
  recoverStalledControlled(request: ControlledRecoverStalledRequest) {
    return this.execute('recoverStalledControlled', true, () => {
      const result = this.engine.recoverStalledControlled(request) as SyncOperation<
        import('better-effect-mq').RecoverStalledResult
      >
      if (Result.isOk(result)) {
        for (const transition of result.value.transitions) {
          const parent = this.parentFor(transition.record.id)
          this.appendTerminalReport(parent, transition.attempt, transition.record.id, request.now)
        }
      }
      return result
    })
  }
  cancelControlled(request: ControlledCancelRequest) {
    return this.execute('cancelControlled', true, () => {
      const parent = this.parentFor(request.jobId)
      const result = this.engine.cancelControlled(request) as SyncOperation<
        import('better-effect-mq').CancelResult
      >
      if (Result.isOk(result))
        this.appendTerminalReport(parent, result.value.attempt, request.jobId, request.now)
      return result
    })
  }
  settle(request: JobStoreNamespace.SettleRequest) {
    return this.execute('settle', true, () => {
      const parent = this.parentFor(request.jobId)
      const result = this.engine.settle(
        request
      ) as SyncOperation<JobStoreNamespace.SettlementResult>
      if (Result.isOk(result))
        this.appendTerminalReport(parent, result.value.attempt, request.jobId, request.now)
      return result
    })
  }
  release(request: JobStoreNamespace.ReleaseRequest) {
    return this.execute('release', true, () => {
      const parent = this.parentFor(request.jobId)
      const result = this.engine.release(request) as SyncOperation<JobStoreNamespace.ReleaseResult>
      if (Result.isOk(result))
        this.appendTerminalReport(parent, result.value.attempt, request.jobId, request.now)
      return result
    })
  }
  heartbeat(request: JobStoreNamespace.HeartbeatRequest) {
    return this.execute(
      'heartbeat',
      true,
      () => this.engine.heartbeat(request) as SyncOperation<JobStoreNamespace.HeartbeatResult>
    )
  }
  recoverStalled(request: JobStoreNamespace.RecoverStalledRequest) {
    return this.execute('recoverStalled', true, () => {
      const result = this.engine.recoverStalled(
        request
      ) as SyncOperation<JobStoreNamespace.RecoverStalledResult>
      if (Result.isOk(result)) {
        for (const transition of result.value.transitions) {
          const parent = this.parentFor(transition.record.id)
          this.appendTerminalReport(parent, transition.attempt, transition.record.id, request.now)
        }
      }
      return result
    })
  }
  getJob(request: JobStoreNamespace.GetJobRequest) {
    return this.execute(
      'getJob',
      false,
      () =>
        this.engine.getJob(request) as SyncOperation<
          import('better-effect-mq').JobRecord | undefined
        >
    )
  }
  getAttempts(request: JobStoreNamespace.GetAttemptsRequest) {
    return this.execute(
      'getAttempts',
      false,
      () =>
        this.engine.getAttempts(request) as SyncOperation<
          readonly import('better-effect-mq').AttemptRecord[]
        >
    )
  }
  list(request: JobStoreNamespace.ListJobsRequest) {
    return this.execute(
      'list',
      false,
      () => this.engine.list(request) as SyncOperation<JobStoreNamespace.ListJobsResult>
    )
  }
  counts(request?: JobStoreNamespace.CountsRequest) {
    return this.execute(
      'counts',
      false,
      () => this.engine.counts(request) as SyncOperation<JobStoreNamespace.JobCounts>
    )
  }
  retry(request: JobStoreNamespace.RetryRequest) {
    return this.execute(
      'retry',
      true,
      () => this.engine.retry(request) as SyncOperation<JobStoreNamespace.RetryResult>
    )
  }
  cancel(request: JobStoreNamespace.CancelRequest) {
    return this.execute('cancel', true, () => {
      const parent = this.parentFor(request.jobId)
      const result = this.engine.cancel(request) as SyncOperation<JobStoreNamespace.CancelResult>
      if (Result.isOk(result))
        this.appendTerminalReport(parent, result.value.attempt, request.jobId, request.now)
      return result
    })
  }
  requestCancellation(request: JobStoreNamespace.RequestCancellationRequest) {
    return this.execute(
      'requestCancellation',
      true,
      () =>
        this.engine.requestCancellation(
          request
        ) as SyncOperation<JobStoreNamespace.RequestCancellationResult>
    )
  }
  promote(request: JobStoreNamespace.PromoteRequest) {
    return this.execute(
      'promote',
      true,
      () => this.engine.promote(request) as SyncOperation<JobStoreNamespace.PromoteResult>
    )
  }
  remove(request: JobStoreNamespace.RemoveRequest) {
    return this.execute(
      'remove',
      true,
      () => this.engine.remove(request) as SyncOperation<JobStoreNamespace.RemoveResult>
    )
  }
  pause(request: JobStoreNamespace.PauseQueueRequest) {
    return this.execute(
      'pause',
      true,
      () => this.engine.pause(request) as SyncOperation<JobStoreNamespace.QueuePauseResult>
    )
  }
  resume(request: JobStoreNamespace.PauseQueueRequest) {
    return this.execute(
      'resume',
      true,
      () => this.engine.resume(request) as SyncOperation<JobStoreNamespace.QueuePauseResult>
    )
  }
  pausedQueues() {
    return this.execute(
      'pausedQueues',
      false,
      () =>
        this.engine.pausedQueues() as SyncOperation<readonly import('better-effect-mq').QueueName[]>
    )
  }

  awaitWake(request: JobStoreNamespace.AwaitWakeRequest): Operation<void> {
    if (this.closed) return failed('awaitWake', new SqliteAdapterError('store is closed'))
    try {
      // Waiting is intentionally outside the FIFO coordinator. A later writer must
      // be able to commit and notify this in-process waiter.
      this.restore()
      const waiting = this.engine.awaitWake(request)
      if (typeof (waiting as PromiseLike<unknown>).then !== 'function') return waiting
      return new Promise<SyncOperation<void>>((resolve) => {
        let settled = false
        const finish = (result: SyncOperation<void>): void => {
          if (settled) return
          settled = true
          clearInterval(poller)
          this.wakePollers.delete(poller)
          resolve(result)
        }
        const poller = setInterval(() => {
          if (settled) return
          try {
            this.restore()
            this.engine.refreshWakeWaiters()
          } catch (cause) {
            this.engine.closeWakeWaiters()
            finish(failed('awaitWake', sqliteError('awaitWake', cause)) as SyncOperation<void>)
          }
        }, this.config.pollIntervalMs)
        this.wakePollers.add(poller)
        Promise.resolve(waiting).then(
          (result) => finish(result as SyncOperation<void>),
          (cause) => finish(failed('awaitWake', cause) as SyncOperation<void>)
        )
      }) as unknown as Operation<void>
    } catch (cause) {
      return failed('awaitWake', sqliteError('awaitWake', cause))
    }
  }

  async dispose(): Promise<void> {
    this.closed = true
    for (const poller of this.wakePollers) clearInterval(poller)
    this.wakePollers.clear()
    this.engine.closeWakeWaiters()
    await this.chain
  }
}

const namespaceFor = (token: AnyJobStoreToken, namespace: string): string =>
  token.serviceTag === JobStore.serviceTag
    ? namespace
    : `${namespace}:${encodeURIComponent(token.serviceTag)}`

const eventLayoutAvailable = (
  database: ReturnType<typeof normalizeSqliteJobStoreConfig>['database']
): boolean => {
  try {
    const row = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(SQLITE_TABLES.events)
    return row !== undefined && row !== null
  } catch {
    return false
  }
}

const makeLayer = <Token extends AnyJobStoreToken>(
  token: Token,
  config: SqliteJobStoreConfig,
  eventOptions?: SqliteJobEventStoreOptions
) => {
  const normalized = normalizeSqliteJobStoreConfig(config)
  return Layer.scoped(
    token,
    () => {
      const scoped = Object.freeze({
        ...normalized,
        namespace: namespaceFor(token, normalized.namespace)
      })
      if (scoped.configurePragmas) {
        scoped.database.exec(
          `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${scoped.busyTimeoutMs};`
        )
      }
      if (scoped.validateSchema) SqliteMigrator.validate(scoped.database)
      const activeEventOptions =
        eventOptions ?? (eventLayoutAvailable(scoped.database) ? {} : undefined)
      return JobStore.of(
        new SqliteJobStoreImplementation(scoped, activeEventOptions) as never
      ) as unknown as ServiceContract<InstanceType<Token>>
    },
    async (store) => (store as unknown as SqliteJobStoreImplementation).dispose()
  )
}

export const SqliteJobStore: {
  readonly migrate: typeof SqliteMigrator.migrate
  readonly layer: (config: SqliteJobStoreConfig) => Layer<JobStoreNamespace.Instance, never>
  readonly layerFor: <Token extends AnyJobStoreToken>(
    token: Token,
    config: SqliteJobStoreConfig
  ) => Layer<InstanceType<Token>, never>
  readonly layerWithEvents: (
    config: SqliteJobStoreConfig,
    options?: SqliteJobEventStoreOptions
  ) => Layer<JobStoreNamespace.Instance | import('better-effect-mq').JobEventStore.Instance, never>
  readonly layerWithEventsFor: <Token extends AnyJobStoreToken>(
    token: Token,
    config: SqliteJobStoreConfig,
    options?: SqliteJobEventStoreOptions
  ) => Layer<InstanceType<Token> | import('better-effect-mq').JobEventStore.Instance<Token>, never>
  readonly make: (config: SqliteJobStoreConfig) => JobStoreNamespace.Contract
} = Object.freeze({
  migrate: (options) => SqliteMigrator.migrate(options),
  layer(config: SqliteJobStoreConfig) {
    return makeLayer(JobStore, config)
  },
  layerFor<Token extends AnyJobStoreToken>(token: Token, config: SqliteJobStoreConfig) {
    return makeLayer(token, config)
  },
  layerWithEvents(config: SqliteJobStoreConfig, options?: SqliteJobEventStoreOptions) {
    return Layer.merge(
      makeLayer(JobStore, config, options ?? {}),
      SqliteJobEventStore.layer({ ...config, ...options })
    ) as Layer<
      JobStoreNamespace.Instance | import('better-effect-mq').JobEventStore.Instance,
      never
    >
  },
  layerWithEventsFor<Token extends AnyJobStoreToken>(
    token: Token,
    config: SqliteJobStoreConfig,
    options?: SqliteJobEventStoreOptions
  ) {
    const eventToken = JobEventStore.for(token)
    return Layer.merge(
      makeLayer(token, config, options ?? {}) as Layer.Any,
      SqliteJobEventStore.layerFor(eventToken as never, { ...config, ...options }) as Layer.Any
    ) as unknown as Layer<InstanceType<Token> | InstanceType<typeof eventToken>, never>
  },
  make(config: SqliteJobStoreConfig): JobStoreNamespace.Contract {
    const normalized = normalizeSqliteJobStoreConfig(config)
    if (normalized.validateSchema) SqliteMigrator.validate(normalized.database)
    const eventOptions = eventLayoutAvailable(normalized.database) ? {} : undefined
    return JobStore.of(new SqliteJobStoreImplementation(normalized, eventOptions) as never)
  }
})
