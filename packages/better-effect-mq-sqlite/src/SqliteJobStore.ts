// oxlint-disable anti-slop/no-chained-type-assertions -- JobStore's structural Service boundary is the one intentional erasure.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts localize completed Result and Service erasure boundaries.
// oxlint-disable anti-slop/no-runtime-typeof -- persisted SQLite rows and tagged protocol failures are checked at boundaries.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- persisted engine snapshots are parsed and validated by the engine boundary.
import { Layer } from 'better-effect'
import type { ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  JobStore,
  JobStoreFailure,
  type AnyJobStoreToken,
  type JobStore as JobStoreNamespace
} from 'better-effect-mq'
import type { JobStoreError, JobStoreOperation } from 'better-effect-mq'
import { normalizeSqliteJobStoreConfig, type SqliteJobStoreConfig } from './config'
import { SqliteAdapterError, sqliteError } from './errors'
import { SqliteMigrator } from './migrator'
import { SQLITE_TABLES } from './schema'
import { SqliteJobStoreEngine } from './internal/engine'

type Operation<T> = JobStoreOperation<T, JobStoreError>
type SyncOperation<T> = ResultType<T, JobStoreError>

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
    globalConcurrency: false,
    rateLimiting: false
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
  private readonly wakePollers = new Set<ReturnType<typeof setInterval>>()

  constructor(private readonly config: ReturnType<typeof normalizeSqliteJobStoreConfig>) {}

  private execute<T>(
    operation: string,
    mutable: boolean,
    callback: () => SyncOperation<T>
  ): Promise<Operation<T>> {
    const run = async (): Promise<Operation<T>> => {
      if (this.closed) return failed<T>(operation, new SqliteAdapterError('store is closed'))
      try {
        if (mutable) this.config.database.exec('BEGIN IMMEDIATE')
        this.restore()
        const before = mutable ? this.engine.exportState() : undefined
        const result = callback()
        if (mutable && Result.isOk(result)) this.persist(before!)
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
        return failed<T>(operation, sqliteError(operation, cause))
      }
    }
    const result = this.chain.then(run, run)
    this.chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
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
      .prepare(`SELECT id, record_json FROM ${SQLITE_TABLES.jobs} WHERE namespace = ?`)
      .all(this.config.namespace)
      .flatMap((row) =>
        row !== undefined && typeof row.id === 'string' && typeof row.record_json === 'string'
          ? [[row.id, JSON.parse(row.record_json)]]
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
    this.engine.restoreState(JSON.stringify(base))
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
    this.config.database
      .prepare(
        `INSERT INTO ${SQLITE_TABLES.state}(namespace, state_json, updated_at_ms) VALUES(?, ?, ?) ON CONFLICT(namespace) DO UPDATE SET state_json = excluded.state_json, updated_at_ms = excluded.updated_at_ms`
      )
      .run(this.config.namespace, JSON.stringify(metadata), Date.now())
  }

  private writeJob(record: Record<string, unknown>): void {
    const values = [
      this.config.namespace,
      record.id,
      record.queue,
      record.name,
      record.version,
      record.state,
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
        `UPDATE ${SQLITE_TABLES.jobs} SET queue=?, name=?, version=?, state=?, payload=?, metadata=?, record_json=?, priority=?, run_at_ms=?, order_sequence=?, attempts_max=?, attempts_made=?, attempt_sequence=?, delivery_count=?, stalled_count=?, backoff=?, timeout_ms=?, idempotency_key=?, created_at_ms=?, updated_at_ms=?, processed_at_ms=?, finished_at_ms=?, lease_owner=?, lease_token=?, lease_expires_at_ms=?, cancel_requested=?, cancellation_requested_at_ms=?, result=?, failure=? WHERE namespace=? AND id=?`
      )
      .run(...values.slice(2), this.config.namespace, record.id).changes
    if (changed === 0) {
      this.config.database
        .prepare(
          `INSERT INTO ${SQLITE_TABLES.jobs}(namespace,id,queue,name,version,state,payload,metadata,record_json,priority,run_at_ms,order_sequence,attempts_max,attempts_made,attempt_sequence,delivery_count,stalled_count,backoff,timeout_ms,idempotency_key,created_at_ms,updated_at_ms,processed_at_ms,finished_at_ms,lease_owner,lease_token,lease_expires_at_ms,cancel_requested,cancellation_requested_at_ms,result,failure) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
  settle(request: JobStoreNamespace.SettleRequest) {
    return this.execute(
      'settle',
      true,
      () => this.engine.settle(request) as SyncOperation<JobStoreNamespace.SettlementResult>
    )
  }
  release(request: JobStoreNamespace.ReleaseRequest) {
    return this.execute(
      'release',
      true,
      () => this.engine.release(request) as SyncOperation<JobStoreNamespace.ReleaseResult>
    )
  }
  heartbeat(request: JobStoreNamespace.HeartbeatRequest) {
    return this.execute(
      'heartbeat',
      true,
      () => this.engine.heartbeat(request) as SyncOperation<JobStoreNamespace.HeartbeatResult>
    )
  }
  recoverStalled(request: JobStoreNamespace.RecoverStalledRequest) {
    return this.execute(
      'recoverStalled',
      true,
      () =>
        this.engine.recoverStalled(request) as SyncOperation<JobStoreNamespace.RecoverStalledResult>
    )
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
    return this.execute(
      'cancel',
      true,
      () => this.engine.cancel(request) as SyncOperation<JobStoreNamespace.CancelResult>
    )
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

const makeLayer = <Token extends AnyJobStoreToken>(token: Token, config: SqliteJobStoreConfig) => {
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
      return JobStore.of(
        new SqliteJobStoreImplementation(scoped) as never
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
  readonly make: (config: SqliteJobStoreConfig) => JobStoreNamespace.Contract
} = Object.freeze({
  migrate: (options) => SqliteMigrator.migrate(options),
  layer(config: SqliteJobStoreConfig) {
    return makeLayer(JobStore, config)
  },
  layerFor<Token extends AnyJobStoreToken>(token: Token, config: SqliteJobStoreConfig) {
    return makeLayer(token, config)
  },
  make(config: SqliteJobStoreConfig): JobStoreNamespace.Contract {
    const normalized = normalizeSqliteJobStoreConfig(config)
    if (normalized.validateSchema) SqliteMigrator.validate(normalized.database)
    return JobStore.of(new SqliteJobStoreImplementation(normalized) as never)
  }
})
