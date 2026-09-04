// oxlint-disable anti-slop/no-runtime-typeof -- BSON documents and protocol request boundaries are validated at this adapter edge.
// oxlint-disable anti-slop/no-unknown-parameters -- driver data and erased reference-store calls are constrained immediately after crossing the boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- decoded MongoDB documents are validated with the protocol constructors.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional persisted protocol fields are intentionally omitted rather than stored as undefined.
// oxlint-disable anti-slop/no-chained-type-assertions -- the reference store's private state is restored only in this compatibility boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are localized to validated BSON and JobStore compatibility boundaries.
// oxlint-disable typescript/await-thenable -- JobStore operations are deliberately sync-or-PromiseLike.
// The durable adapter intentionally delegates DTO validation and transition semantics to the
// protocol reference implementation. MongoDB remains the source of truth: a fresh reference
// reducer is hydrated inside each transaction and its complete resulting snapshot is committed.
// This prevents the adapter from silently drifting from protocol-v1 reducer behavior.
import { randomUUID } from 'node:crypto'
import { Layer } from 'better-effect'
import type { ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  JobStore,
  JobStoreFailure,
  JobStoreWakeAbortedError,
  MemoryJobStore,
  makeJobRecord,
  validateAttemptRecord,
  type AnyJobStoreToken,
  type AttemptRecord,
  type JobRecord,
  type JobStore as JobStoreNamespace,
  type JobStoreDescriptor
} from 'better-effect-mq'
import { MongoQueueChangeStream } from './change-stream'
import {
  metadataEntries,
  metadataFromEntries,
  mongoCollections,
  namespaceId,
  type MongoCollections
} from './collections'
import { MongoJobStoreClient } from './client'
import type { MongoJobStoreConfig, MongoJobStoreConnectionConfig, MongoSession } from './config'
import { MongoJobStoreLayoutError, MongoJobStoreTopologyError } from './errors'
import { MongoJobStoreMigrator } from './migrator'

type Operation<T> = ResultType<T, JobStoreNamespace.Error>
type Reference = JobStoreNamespace.Contract & Record<string, unknown>
type InternalReference = Reference & {
  jobs: Map<string, JobRecord>
  attempts: Map<string, AttemptRecord[]>
  settled: Map<string, { readonly leaseToken: string; readonly outcomeDigest: string }>
  idempotency: Map<string, string>
  generatedJobIds: Set<string>
  issuedLeaseTokens: Set<string>
  paused: Set<string>
  queueWakeVersions: Map<string, number>
  queueWakeGlobals: Map<string, number>
  listOrders: Map<string, readonly JobRecord[]>
  sequence: number
  wakeGlobal: number
  wakeBroadcast: number
}

const descriptor = (notifications: boolean): JobStoreDescriptor =>
  Object.freeze({
    protocolVersion: 1,
    adapter: 'mongodb',
    adapterVersion: '0.1.0',
    layoutVersion: 1,
    capabilities: Object.freeze({
      queueFilteredNotifications: notifications,
      nativeBatchEnqueue: true,
      nativeBatchClaim: true,
      metadataIndex: 'indexed',
      transactionalEnqueue: true,
      durableChangeFeed: false,
      globalConcurrency: false,
      rateLimiting: false
    })
  })

const ok = <T>(value: T): Operation<T> => Result.ok(value) as Operation<T>
const fail = <T>(operation: string, cause: unknown, retryable = false): Operation<T> =>
  Result.err(
    cause instanceof JobStoreFailure
      ? cause
      : new JobStoreFailure({ operation, retryable, message: `MongoDB ${operation} failed` })
  ) as Operation<T>

const number = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new MongoJobStoreLayoutError(`MongoDB document has invalid ${field}`)
  return value
}
const optionalNumber = (value: unknown, field: string): number | undefined =>
  value === undefined || value === null ? undefined : number(value, field)
const string = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0)
    throw new MongoJobStoreLayoutError(`MongoDB document has invalid ${field}`)
  return value
}
const optionalString = (value: unknown, field: string): string | undefined =>
  value === undefined || value === null ? undefined : string(value, field)
const identity = (record: JobRecord): string =>
  JSON.stringify([record.queue, record.name, record.version])

const encodeJob = (
  namespace: string,
  record: JobRecord,
  settled: { readonly leaseToken: string; readonly outcomeDigest: string } | undefined
): object =>
  Object.assign(Object.create(null), {
    _id: namespaceId(namespace, record.id),
    namespace,
    id: record.id,
    identity: identity(record),
    queue: record.queue,
    name: record.name,
    version: record.version,
    state: record.state,
    payload: record.payload,
    metadataEntries: metadataEntries(record.metadata),
    priority: record.priority,
    runAtMs: record.runAt,
    orderSequence: record.orderingSequence,
    attemptsMax: record.attemptsMax,
    attemptsMade: record.attemptsMade,
    attemptSequence: record.attemptSequence ?? record.attemptsMade,
    deliveryCount: record.deliveryCount,
    stalledCount: record.stalledCount,
    ...(record.backoff === undefined ? {} : { backoff: record.backoff }),
    ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs }),
    ...(record.idempotencyKey === undefined ? {} : { idempotencyKey: record.idempotencyKey }),
    createdAtMs: record.createdAt,
    updatedAtMs: record.updatedAt,
    ...(record.processedAt === undefined ? {} : { processedAtMs: record.processedAt }),
    ...(record.finishedAt === undefined ? {} : { finishedAtMs: record.finishedAt }),
    ...(record.leaseOwner === undefined ? {} : { leaseOwner: record.leaseOwner }),
    ...(record.leaseToken === undefined ? {} : { leaseToken: record.leaseToken }),
    ...(record.leaseExpiresAt === undefined ? {} : { leaseExpiresAtMs: record.leaseExpiresAt }),
    cancelRequested: record.cancellationRequestedAt !== undefined,
    ...(record.cancellationRequestedAt === undefined
      ? {}
      : { cancellationRequestedAtMs: record.cancellationRequestedAt }),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.failure === undefined ? {} : { failure: record.failure }),
    ledgerCount: record.attemptSequence ?? record.attemptsMade,
    ...(settled === undefined
      ? {}
      : {
          lastSettlementToken: settled.leaseToken,
          lastSettlementDigest: settled.outcomeDigest,
          lastSettlementOutcome: 'settled'
        })
  })

const decodeJob = (document: Record<string, unknown>): JobRecord => {
  const record = makeJobRecord({
    id: string(document.id, 'job.id'),
    name: string(document.name, 'job.name'),
    version: number(document.version, 'job.version'),
    queue: string(document.queue, 'job.queue'),
    state: document.state,
    payload: document.payload,
    metadata: metadataFromEntries(document.metadataEntries),
    priority:
      typeof document.priority === 'number'
        ? document.priority
        : (() => {
            throw new MongoJobStoreLayoutError('MongoDB document has invalid job.priority')
          })(),
    runAt: number(document.runAtMs, 'job.runAtMs'),
    orderingSequence: number(document.orderSequence, 'job.orderSequence'),
    attemptsMax: number(document.attemptsMax, 'job.attemptsMax'),
    attemptsMade: number(document.attemptsMade, 'job.attemptsMade'),
    attemptSequence: number(
      document.attemptSequence ?? document.attemptsMade,
      'job.attemptSequence'
    ),
    deliveryCount: number(document.deliveryCount, 'job.deliveryCount'),
    stalledCount: number(document.stalledCount, 'job.stalledCount'),
    backoff: document.backoff,
    timeoutMs: optionalNumber(document.timeoutMs, 'job.timeoutMs'),
    idempotencyKey: optionalString(document.idempotencyKey, 'job.idempotencyKey'),
    createdAt: number(document.createdAtMs, 'job.createdAtMs'),
    updatedAt: number(document.updatedAtMs, 'job.updatedAtMs'),
    processedAt: optionalNumber(document.processedAtMs, 'job.processedAtMs'),
    finishedAt: optionalNumber(document.finishedAtMs, 'job.finishedAtMs'),
    leaseOwner: optionalString(document.leaseOwner, 'job.leaseOwner') as JobRecord['leaseOwner'],
    leaseToken: optionalString(document.leaseToken, 'job.leaseToken') as JobRecord['leaseToken'],
    leaseExpiresAt: optionalNumber(document.leaseExpiresAtMs, 'job.leaseExpiresAtMs'),
    cancellationRequestedAt: optionalNumber(
      document.cancellationRequestedAtMs,
      'job.cancellationRequestedAtMs'
    ),
    result: document.result as JobRecord['result'],
    failure: document.failure as JobRecord['failure']
  })
  if (Result.isError(record))
    throw new MongoJobStoreLayoutError('MongoDB document violates the JobStore record contract')
  return record.value
}
const encodeAttempt = (
  namespace: string,
  jobId: string,
  sequence: number,
  attempt: AttemptRecord
): object =>
  Object.assign(Object.create(null), {
    _id: namespaceId(namespace, jobId, String(sequence)),
    namespace,
    jobId,
    ledgerSequence: sequence,
    attempt: attempt.attempt,
    attemptSequence: attempt.attemptSequence,
    delivery: attempt.delivery,
    ...(attempt.startedAt === undefined ? {} : { startedAtMs: attempt.startedAt }),
    finishedAtMs: attempt.finishedAt,
    outcome: attempt.outcome,
    ...(attempt.result === undefined ? {} : { result: attempt.result }),
    ...(attempt.failure === undefined ? {} : { failure: attempt.failure }),
    ...(attempt.retryAt === undefined ? {} : { retryAtMs: attempt.retryAt }),
    ...(attempt.retryDelayMs === undefined ? {} : { retryDelayMs: attempt.retryDelayMs })
  })
const decodeAttempt = (document: Record<string, unknown>): AttemptRecord => {
  const attempt = validateAttemptRecord({
    attempt: number(document.attempt, 'attempt.attempt'),
    attemptSequence: optionalNumber(document.attemptSequence, 'attempt.attemptSequence'),
    delivery: number(document.delivery, 'attempt.delivery'),
    startedAt: optionalNumber(document.startedAtMs, 'attempt.startedAtMs'),
    finishedAt: number(document.finishedAtMs, 'attempt.finishedAtMs'),
    outcome: document.outcome,
    result: document.result,
    failure: document.failure,
    retryAt: optionalNumber(document.retryAtMs, 'attempt.retryAtMs'),
    retryDelayMs: optionalNumber(document.retryDelayMs, 'attempt.retryDelayMs')
  })
  if (Result.isError(attempt))
    throw new MongoJobStoreLayoutError(
      'MongoDB attempt document violates the JobStore record contract'
    )
  return attempt.value
}

class MongoJobStoreImplementation {
  private descriptorValue = descriptor(false)
  private readonly collections: MongoCollections
  private readonly waiters = new Set<() => void>()
  private stream: MongoQueueChangeStream | undefined
  private disposed = false
  constructor(private readonly client: MongoJobStoreClient) {
    this.collections = mongoCollections(client.db, client.collectionPrefix)
  }
  get descriptor(): JobStoreDescriptor {
    return this.descriptorValue
  }

  async start(): Promise<void> {
    await this.verifyTopology()
    if (this.client.validateLayout)
      await MongoJobStoreMigrator.validate(this.client.db, this.client.collectionPrefix)
    if (this.client.notifications === 'auto') {
      this.stream = new MongoQueueChangeStream(this.client.db, this.client.namespace, () =>
        this.wake()
      )
      this.descriptorValue = descriptor(this.stream.start())
    }
  }
  private async verifyTopology(): Promise<void> {
    const hello = await this.client.db.admin().command({ hello: 1 })
    const sessions = typeof hello.logicalSessionTimeoutMinutes === 'number'
    const replicaSet = typeof hello.setName === 'string'
    const mongos = hello.msg === 'isdbgrid'
    if (!sessions || (!replicaSet && !mongos)) {
      throw new MongoJobStoreTopologyError(
        'standalone',
        'MongoDB JobStore requires a replica set (a single-node replica set is sufficient for development) or a transaction-capable mongos deployment'
      )
    }
  }
  private async snapshot(ids: string[], session?: MongoSession): Promise<InternalReference> {
    const options = session === undefined ? undefined : { session }
    const values = await Promise.all([
      this.collections.jobs.find({ namespace: this.client.namespace }, options).toArray(),
      this.collections.attempts.find({ namespace: this.client.namespace }, options).toArray(),
      this.collections.queues.find({ namespace: this.client.namespace }, options).toArray(),
      this.collections.counters.find({ namespace: this.client.namespace }, options).toArray()
    ])
    let idIndex = 0
    const reference = MemoryJobStore.make({
      idGenerator: () => ids[idIndex++] ?? (ids[idIndex - 1] = randomUUID())
    }) as InternalReference
    for (const document of values[0]) {
      const record = decodeJob(document)
      reference.jobs.set(record.id, record)
      reference.generatedJobIds.add(record.id)
      if (record.idempotencyKey !== undefined)
        reference.idempotency.set(`${identity(record)}\u0000${record.idempotencyKey}`, record.id)
      const token = optionalString(document.lastSettlementToken, 'job.lastSettlementToken')
      const digest = optionalString(document.lastSettlementDigest, 'job.lastSettlementDigest')
      if (token !== undefined && digest !== undefined) {
        reference.settled.set(record.id, { leaseToken: token, outcomeDigest: digest })
        reference.issuedLeaseTokens.add(token)
      }
      if (record.leaseToken !== undefined) reference.issuedLeaseTokens.add(record.leaseToken)
    }
    for (const document of values[1]) {
      const jobId = string(document.jobId, 'attempt.jobId')
      const entries = reference.attempts.get(jobId) ?? []
      entries.push(decodeAttempt(document))
      reference.attempts.set(jobId, entries)
    }
    let wakeGlobal = 0
    for (const document of values[2]) {
      const queue = string(document.queue, 'queue.queue')
      const version = number(document.wakeVersion, 'queue.wakeVersion')
      if (document.paused === true) reference.paused.add(queue)
      reference.queueWakeVersions.set(queue, version)
      wakeGlobal += version
      reference.queueWakeGlobals.set(queue, wakeGlobal)
    }
    reference.wakeGlobal = wakeGlobal
    const counter = values[3].find(
      (item) => item._id === namespaceId(this.client.namespace, 'job-order-sequence')
    )
    const maximum = Math.max(0, ...[...reference.jobs.values()].map((job) => job.orderingSequence))
    reference.sequence = number(counter?.value ?? maximum + 1, 'counter.value')
    reference.listOrders.clear()
    return reference
  }
  private async persist(
    reference: InternalReference,
    session: MongoSession,
    updatedAtMs: number
  ): Promise<void> {
    const options = { session }
    await this.collections.jobs.deleteMany({ namespace: this.client.namespace }, options)
    const jobs = [...reference.jobs.values()].map((job) =>
      encodeJob(this.client.namespace, job, reference.settled.get(job.id))
    )
    if (jobs.length > 0) await this.collections.jobs.insertMany(jobs, options)
    await this.collections.attempts.deleteMany({ namespace: this.client.namespace }, options)
    const attempts: object[] = []
    for (const [jobId, rows] of reference.attempts)
      rows.forEach((row, index) =>
        attempts.push(encodeAttempt(this.client.namespace, jobId, index + 1, row))
      )
    if (attempts.length > 0) await this.collections.attempts.insertMany(attempts, options)
    await this.collections.queues.deleteMany({ namespace: this.client.namespace }, options)
    const queues = [...reference.queueWakeVersions.entries()].map(([queue, wakeVersion]) => ({
      _id: namespaceId(this.client.namespace, queue),
      namespace: this.client.namespace,
      queue,
      paused: reference.paused.has(queue),
      wakeVersion,
      updatedAtMs
    }))
    if (queues.length > 0) await this.collections.queues.insertMany(queues, options)
    await this.collections.counters.updateOne(
      { _id: namespaceId(this.client.namespace, 'job-order-sequence') },
      {
        $set: {
          namespace: this.client.namespace,
          name: 'job-order-sequence',
          value: reference.sequence
        }
      },
      { ...options, upsert: true }
    )
  }
  private async invoke<T>(operation: string, request: unknown): Promise<Operation<T>> {
    if (this.disposed) return fail(operation, new Error('store is disposed'))
    const session = this.client.client.startSession()
    const generated: string[] = []
    try {
      const revisionId = namespaceId(this.client.namespace, 'state-revision')
      await this.collections.counters.updateOne(
        { _id: revisionId },
        { $setOnInsert: { namespace: this.client.namespace, name: 'state-revision', value: 0 } },
        { upsert: true }
      )
      let result: Operation<T> | undefined
      await session.withTransaction(
        async () => {
          const state = await this.collections.counters.findOne({ _id: revisionId }, { session })
          const revision = number(state?.value, 'state revision')
          const reference = await this.snapshot(generated, session)
          const member = reference[operation]
          if (typeof member !== 'function')
            throw new Error(`unsupported JobStore operation ${operation}`)
          result = await (member as (value: unknown) => Operation<T>).call(reference, request)
          if (Result.isError(result)) return
          const now =
            request !== null &&
            typeof request === 'object' &&
            typeof (request as { now?: unknown }).now === 'number'
              ? (request as { now: number }).now
              : 0
          await this.persist(reference, session, now)
          const bumped = await this.collections.counters.updateOne(
            { _id: revisionId, value: revision },
            { $inc: { value: 1 } },
            { session }
          )
          if (bumped.matchedCount !== 1) throw new Error('MongoDB namespace revision conflict')
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
      )
      this.wake()
      return result ?? fail(operation, new Error('transaction produced no result'))
    } catch (cause) {
      return fail(operation, cause, true)
    } finally {
      await session.endSession()
    }
  }
  private async read<T>(operation: string, request: unknown): Promise<Operation<T>> {
    try {
      const reference = await this.snapshot([])
      const member = reference[operation]
      return typeof member === 'function'
        ? await (member as (value: unknown) => Operation<T>).call(reference, request)
        : fail(operation, new Error('unsupported operation'))
    } catch (cause) {
      return fail(operation, cause, true)
    }
  }
  enqueue(request: JobStoreNamespace.EnqueueRequest) {
    return this.invoke<JobStoreNamespace.EnqueueResult>('enqueue', request)
  }
  enqueueMany(request: readonly JobStoreNamespace.EnqueueRequest[]) {
    return this.invoke<JobStoreNamespace.EnqueueManyResult>('enqueueMany', request)
  }
  claim(request: JobStoreNamespace.ClaimRequest) {
    return this.invoke<JobStoreNamespace.ClaimResult>('claim', request)
  }
  settle(request: JobStoreNamespace.SettleRequest) {
    return this.invoke<JobStoreNamespace.SettlementResult>('settle', request)
  }
  release(request: JobStoreNamespace.ReleaseRequest) {
    return this.invoke<JobStoreNamespace.ReleaseResult>('release', request)
  }
  heartbeat(request: JobStoreNamespace.HeartbeatRequest) {
    return this.invoke<JobStoreNamespace.HeartbeatResult>('heartbeat', request)
  }
  recoverStalled(request: JobStoreNamespace.RecoverStalledRequest) {
    return this.invoke<JobStoreNamespace.RecoverStalledResult>('recoverStalled', request)
  }
  retry(request: JobStoreNamespace.RetryRequest) {
    return this.invoke<JobStoreNamespace.RetryResult>('retry', request)
  }
  cancel(request: JobStoreNamespace.CancelRequest) {
    return this.invoke<JobStoreNamespace.CancelResult>('cancel', request)
  }
  requestCancellation(request: JobStoreNamespace.RequestCancellationRequest) {
    return this.invoke<JobStoreNamespace.RequestCancellationResult>('requestCancellation', request)
  }
  promote(request: JobStoreNamespace.PromoteRequest) {
    return this.invoke<JobStoreNamespace.PromoteResult>('promote', request)
  }
  remove(request: JobStoreNamespace.RemoveRequest) {
    return this.invoke<JobStoreNamespace.RemoveResult>('remove', request)
  }
  pause(request: JobStoreNamespace.PauseQueueRequest) {
    return this.invoke<JobStoreNamespace.QueuePauseResult>('pause', request)
  }
  resume(request: JobStoreNamespace.PauseQueueRequest) {
    return this.invoke<JobStoreNamespace.QueuePauseResult>('resume', request)
  }
  getJob(request: JobStoreNamespace.GetJobRequest) {
    return this.read<JobRecord | undefined>('getJob', request)
  }
  getAttempts(request: JobStoreNamespace.GetAttemptsRequest) {
    return this.read<readonly AttemptRecord[]>('getAttempts', request)
  }
  list(request: JobStoreNamespace.ListJobsRequest) {
    return this.read<JobStoreNamespace.ListJobsResult>('list', request)
  }
  counts(request?: JobStoreNamespace.CountsRequest) {
    return this.read<JobStoreNamespace.JobCounts>('counts', request)
  }
  pausedQueues() {
    return this.read<readonly import('better-effect-mq').QueueName[]>('pausedQueues', undefined)
  }
  async awaitWake(request: JobStoreNamespace.AwaitWakeRequest): Promise<Operation<void>> {
    if (
      request === null ||
      typeof request !== 'object' ||
      !Array.isArray(request.queues) ||
      typeof request.wakeToken !== 'string' ||
      !(request.signal instanceof AbortSignal)
    )
      return fail('awaitWake', new Error('invalid wake request'))
    if (request.signal.aborted) return Result.err(new JobStoreWakeAbortedError()) as Operation<void>
    let baseline: Record<string, number>
    let globalBaseline: number | undefined
    try {
      if (request.wakeToken.startsWith('memory-wake-v1-')) {
        const memory = JSON.parse(
          decodeURIComponent(request.wakeToken.slice('memory-wake-v1-'.length))
        ) as {
          readonly global?: unknown
          readonly queue?: unknown
          readonly queueVersion?: unknown
        }
        globalBaseline = number(memory.global, 'wakeToken.global')
        baseline =
          typeof memory.queue === 'string'
            ? { [memory.queue]: number(memory.queueVersion, 'wakeToken.queueVersion') }
            : (Object.create(null) as Record<string, number>)
      } else
        baseline = JSON.parse(
          decodeURIComponent(request.wakeToken.replace(/^mongodb-wake-v1-/u, ''))
        ) as Record<string, number>
    } catch {
      return fail('awaitWake', new Error('wakeToken could not be decoded'))
    }
    const changed = async (): Promise<boolean> => {
      const rows = await this.collections.queues
        .find({ namespace: this.client.namespace })
        .toArray()
      if (globalBaseline !== undefined && request.queues.length === 0)
        return (
          rows.reduce((total, row) => total + number(row.wakeVersion, 'wakeVersion'), 0) >
          globalBaseline
        )
      const wanted = request.queues.length === 0 ? rows.map((row) => row.queue) : request.queues
      return wanted.some((queue: unknown) => {
        if (typeof queue !== 'string') return false
        return (
          number(rows.find((row) => row.queue === queue)?.wakeVersion ?? 0, 'wakeVersion') >
          (baseline[queue] ?? 0)
        )
      })
    }
    if (await changed()) return ok(undefined)
    return new Promise((resolve) => {
      const timer = setInterval(async () => {
        if (request.signal.aborted)
          finish(Result.err(new JobStoreWakeAbortedError()) as Operation<void>)
        else if (await changed()) finish(ok(undefined))
      }, 100)
      const onAbort = () => finish(Result.err(new JobStoreWakeAbortedError()) as Operation<void>)
      const wake = () => {
        void changed().then((value) => {
          if (value) finish(ok(undefined))
        })
      }
      const finish = (value: Operation<void>) => {
        clearInterval(timer)
        request.signal.removeEventListener('abort', onAbort)
        this.waiters.delete(wake)
        resolve(value)
      }
      this.waiters.add(wake)
      request.signal.addEventListener('abort', onAbort, { once: true })
      void changed().then((value) => {
        if (value) finish(ok(undefined))
      })
    })
  }
  private wake(): void {
    for (const waiter of this.waiters) waiter()
  }
  async wakeToken(): Promise<import('better-effect-mq').WakeToken> {
    const rows = await this.collections.queues.find({ namespace: this.client.namespace }).toArray()
    return `mongodb-wake-v1-${encodeURIComponent(JSON.stringify(Object.fromEntries(rows.map((row) => [row.queue, row.wakeVersion]))))}` as import('better-effect-mq').WakeToken
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.stream?.close()
    if (this.client.ownsClient) await this.client.dispose()
  }
}

const namespaceFor = (token: AnyJobStoreToken, namespace: string): string =>
  token.serviceTag === JobStore.serviceTag ? namespace : `${namespace}:store-${token.serviceTag}`
const layer = <T extends AnyJobStoreToken>(
  token: T,
  acquire: () => Promise<MongoJobStoreClient>
): Layer<InstanceType<T>, never> =>
  Layer.scoped(
    token,
    async () => {
      const client = await acquire()
      const store = new MongoJobStoreImplementation(client)
      await store.start()
      return JobStore.of(store as never) as unknown as ServiceContract<InstanceType<T>>
    },
    async (store) => {
      await (store as unknown as MongoJobStoreImplementation).dispose()
    }
  ) as Layer<InstanceType<T>, never>

export const MongoJobStore = Object.freeze({
  migrate(options: import('./migrator').MongoMigrationOptions) {
    return MongoJobStoreMigrator.migrate(options)
  },
  layer(config: MongoJobStoreConfig) {
    return layer(JobStore, async () => MongoJobStoreClient.fromDb(config))
  },
  layerFor<T extends AnyJobStoreToken>(token: T, config: MongoJobStoreConfig) {
    return layer(token, async () =>
      MongoJobStoreClient.fromDb({
        ...config,
        namespace: namespaceFor(token, config.namespace ?? 'default')
      })
    )
  },
  layerFromConfig(config: MongoJobStoreConnectionConfig) {
    return layer(JobStore, () => MongoJobStoreClient.fromConfig(config))
  },
  layerFromConfigFor<T extends AnyJobStoreToken>(token: T, config: MongoJobStoreConnectionConfig) {
    return layer(token, () =>
      MongoJobStoreClient.fromConfig({
        ...config,
        namespace: namespaceFor(token, config.namespace ?? 'default')
      })
    )
  }
})
