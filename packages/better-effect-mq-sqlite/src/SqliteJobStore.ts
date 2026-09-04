// oxlint-disable anti-slop/no-chained-type-assertions -- JobStore's structural Service boundary is the one intentional erasure.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts localize completed Result and Service erasure boundaries.
// oxlint-disable anti-slop/no-runtime-typeof -- persisted SQLite rows and tagged protocol failures are checked at boundaries.
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
        const result = callback()
        if (mutable && Result.isOk(result)) this.persist()
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
    const row = this.config.database
      .prepare(`SELECT state_json FROM ${SQLITE_TABLES.state} WHERE namespace = ?`)
      .get(this.config.namespace)
    this.engine.restoreState(
      row != null && typeof row.state_json === 'string' ? row.state_json : undefined
    )
  }

  private persist(): void {
    const state = this.engine.exportState()
    this.config.database
      .prepare(
        `INSERT INTO ${SQLITE_TABLES.state}(namespace, state_json, updated_at_ms) VALUES(?, ?, ?) ON CONFLICT(namespace) DO UPDATE SET state_json = excluded.state_json, updated_at_ms = excluded.updated_at_ms`
      )
      .run(this.config.namespace, state, Date.now())
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
      return this.engine.awaitWake(request)
    } catch (cause) {
      return failed('awaitWake', sqliteError('awaitWake', cause))
    }
  }

  async dispose(): Promise<void> {
    this.closed = true
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
