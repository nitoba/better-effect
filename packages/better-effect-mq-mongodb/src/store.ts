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
  makeJobRecord,
  validateAttemptRecord,
  reduceJob,
  recoverStalledWithPolicy,
  makeJobId,
  makeLeaseToken,
  makeQueueName,
  makeJobName,
  makeWorkerId,
  JobNotFoundError,
  LeaseLostError,
  SettlementConflictError,
  InvalidJobTransitionError,
  JobDefinitionError,
  type AnyJobStoreToken,
  type AttemptRecord,
  type JobRecord,
  type JobTransition,
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
type MongoFilter = Record<string, unknown>
type MongoUpdateFields = Readonly<Record<string, unknown>>
const namespaceFilter = (namespace: string): MongoFilter =>
  Object.assign(Object.create(null), { namespace }) as MongoFilter

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
    if (
      typeof hello.logicalSessionTimeoutMinutes !== 'number' ||
      (typeof hello.setName !== 'string' && hello.msg !== 'isdbgrid')
    )
      throw new MongoJobStoreTopologyError(
        'standalone',
        'MongoDB JobStore requires a replica set (a single-node replica set is sufficient for development) or a transaction-capable mongos deployment'
      )
  }
  private async withTx<T>(
    operation: string,
    body: (session: MongoSession) => Promise<T>
  ): Promise<Operation<T>> {
    if (this.disposed) return fail(operation, new Error('store is disposed'))
    const session = this.client.client.startSession()
    try {
      let value: T | undefined
      await session.withTransaction(
        async () => {
          value = await body(session)
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
      )
      return ok(value as T)
    } catch (cause) {
      return fail(operation, cause, true)
    } finally {
      await session.endSession()
    }
  }
  private opts(session?: MongoSession): object | undefined {
    return session === undefined ? undefined : { session }
  }
  private document(value: unknown): Record<string, unknown> | undefined {
    if (value === null || value === undefined) return undefined
    if (typeof value !== 'object' || Array.isArray(value))
      throw new MongoJobStoreLayoutError('MongoDB command returned an invalid document')
    const raw = value as Record<string, unknown>
    if ('value' in raw)
      return raw.value === null ? undefined : (raw.value as Record<string, unknown>)
    return raw
  }
  private async job(id: string, session?: MongoSession): Promise<JobRecord | undefined> {
    const doc = await this.collections.jobs.findOne(
      { namespace: this.client.namespace, id },
      this.opts(session)
    )
    return doc === null ? undefined : decodeJob(doc)
  }
  private async nextSequence(session: MongoSession): Promise<number> {
    const doc = this.document(
      await this.collections.counters.findOneAndUpdate(
        { _id: namespaceId(this.client.namespace, 'job-order-sequence') },
        {
          $setOnInsert: { namespace: this.client.namespace, name: 'job-order-sequence', value: 0 },
          $inc: { value: 1 }
        },
        { session, upsert: true, returnDocument: 'after', includeResultMetadata: false }
      )
    )
    const value = number(doc?.value, 'counter.value')
    if (value >= Number.MAX_SAFE_INTEGER)
      throw new JobDefinitionError({
        field: 'orderingSequence',
        message: 'cannot exceed safe integer range'
      })
    return value
  }
  private async notify(queue: string, now: number, session: MongoSession): Promise<void> {
    const doc = this.document(
      await this.collections.queues.findOneAndUpdate(
        {
          _id: namespaceId(this.client.namespace, queue),
          wakeVersion: { $lt: Number.MAX_SAFE_INTEGER }
        },
        {
          $setOnInsert: { namespace: this.client.namespace, queue, paused: false },
          $set: { updatedAtMs: now },
          $inc: { wakeVersion: 1 }
        },
        { session, upsert: true, returnDocument: 'after', includeResultMetadata: false }
      )
    )
    number(doc?.wakeVersion, 'queue.wakeVersion')
  }
  private async wakeSnapshot(session?: MongoSession): Promise<Record<string, number>> {
    const rows = await this.collections.queues
      .find({ namespace: this.client.namespace }, this.opts(session))
      .toArray()
    const out: Record<string, number> = Object.create(null)
    for (const row of rows)
      out[string(row.queue, 'queue.queue')] = number(row.wakeVersion, 'queue.wakeVersion')
    return out
  }
  private async save(
    record: JobRecord,
    before: JobRecord,
    session: MongoSession,
    tokenFenced = false,
    extra: MongoUpdateFields = {}
  ): Promise<boolean> {
    const { _id: _ignored, ...fields } = encodeJob(
      this.client.namespace,
      record,
      undefined
    ) as Record<string, unknown>
    const result = await this.collections.jobs.updateOne(
      {
        namespace: this.client.namespace,
        id: before.id,
        state: before.state,
        updatedAtMs: before.updatedAt,
        attemptSequence: before.attemptSequence ?? before.attemptsMade,
        ...(tokenFenced ? { leaseToken: before.leaseToken } : {})
      },
      { $set: { ...fields, ...extra } },
      { session }
    )
    return result.matchedCount === 1
  }
  private id(value: unknown): string {
    const result = makeJobId(value)
    if (Result.isError(result)) throw result.error
    return result.value
  }
  private now(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0)
      throw new JobDefinitionError({ field: 'now', message: 'must be a non-negative safe integer' })
    return value as number
  }
  private async transition(
    operation: string,
    request: { jobId: string; now: number },
    command: (record: JobRecord) => ResultType<JobTransition, JobStoreNamespace.Error>,
    tokenFenced = false
  ): Promise<Operation<JobTransition>> {
    return this.withTx(operation, async (session) => {
      const before = await this.job(request.jobId, session)
      if (before === undefined) throw new JobNotFoundError({ jobId: request.jobId as never })
      const changed = command(before)
      if (Result.isError(changed)) throw changed.error
      let transition = changed.value
      if (
        (transition.record.state === 'waiting' || transition.record.state === 'delayed') &&
        before.state !== transition.record.state
      ) {
        const rebuilt = makeJobRecord({
          ...transition.record,
          orderingSequence: await this.nextSequence(session)
        })
        if (Result.isError(rebuilt)) throw rebuilt.error
        transition = { ...transition, record: rebuilt.value }
      }
      if (!(await this.save(transition.record, before, session, tokenFenced)))
        throw new LeaseLostError({ jobId: before.id, reason: 'mismatched-token' })
      if (transition.attempt !== undefined)
        await this.collections.attempts.insertOne(
          encodeAttempt(
            this.client.namespace,
            before.id,
            transition.attempt.attemptSequence ?? transition.attempt.attempt,
            transition.attempt
          ),
          { session }
        )
      await this.notify(before.queue, request.now, session)
      return transition
    })
  }
  async enqueue(request: JobStoreNamespace.EnqueueRequest) {
    const many = await this.enqueueMany([request])
    return Result.isError(many)
      ? (many as Operation<JobStoreNamespace.EnqueueResult>)
      : ok(many.value[0]!)
  }
  async enqueueMany(
    requests: readonly JobStoreNamespace.EnqueueRequest[]
  ): Promise<Operation<JobStoreNamespace.EnqueueManyResult>> {
    if (!Array.isArray(requests))
      return fail(
        'enqueue',
        new JobDefinitionError({ field: 'requests', message: 'must be an array' })
      )
    return this.withTx('enqueue', async (session) => {
      const out: JobStoreNamespace.EnqueueResult[] = []
      for (const request of requests) {
        if (request === null || typeof request !== 'object')
          throw new JobDefinitionError({ field: 'request', message: 'must be an object' })
        const raw = request as Record<string, unknown>
        const identityInput = raw.job ?? raw.identity
        if (
          (raw.job === undefined) === (raw.identity === undefined) ||
          identityInput === null ||
          typeof identityInput !== 'object'
        )
          throw new JobDefinitionError({
            field: 'identity',
            message: 'must provide exactly one identity'
          })
        const identityInputRecord = identityInput as Record<string, unknown>
        const queue = makeQueueName(identityInputRecord.queue)
        const name = makeJobName(identityInputRecord.name)
        if (Result.isError(queue)) throw queue.error
        if (Result.isError(name)) throw name.error
        const version = number(identityInputRecord.version, 'job.version')
        const now = this.now(raw.now)
        const runAt = this.now(raw.runAt)
        const attemptsMax = number(raw.attemptsMax, 'attemptsMax')
        if (attemptsMax < 1)
          throw new JobDefinitionError({ field: 'attemptsMax', message: 'must be positive' })
        const explicit = raw.id === undefined ? undefined : this.id(raw.id)
        const idempotencyKey =
          raw.idempotencyKey === undefined
            ? undefined
            : string(raw.idempotencyKey, 'idempotencyKey')
        const prior =
          explicit === undefined
            ? idempotencyKey === undefined
              ? null
              : await this.collections.jobs.findOne(
                  {
                    namespace: this.client.namespace,
                    identity: JSON.stringify([queue.value, name.value, version]),
                    idempotencyKey
                  },
                  { session }
                )
            : await this.collections.jobs.findOne(
                { namespace: this.client.namespace, id: explicit },
                { session }
              )
        if (prior !== null) {
          out.push({ job: decodeJob(prior), duplicate: true })
          continue
        }
        const record = makeJobRecord({
          id: explicit ?? randomUUID(),
          queue: queue.value,
          name: name.value,
          version,
          state: runAt <= now ? 'waiting' : 'delayed',
          payload: raw.payload,
          metadata: raw.metadata === undefined ? {} : raw.metadata,
          priority: raw.priority === undefined ? 0 : raw.priority,
          runAt,
          orderingSequence: await this.nextSequence(session),
          attemptsMax,
          attemptsMade: 0,
          attemptSequence: 0,
          deliveryCount: 0,
          stalledCount: 0,
          backoff: raw.backoff as JobRecord['backoff'],
          timeoutMs: raw.timeoutMs as number | undefined,
          idempotencyKey,
          createdAt: now,
          updatedAt: now,
          processedAt: undefined,
          finishedAt: undefined,
          leaseOwner: undefined,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          cancellationRequestedAt: undefined,
          result: undefined,
          failure: undefined
        })
        if (Result.isError(record)) throw record.error
        try {
          await this.collections.jobs.insertOne(
            encodeJob(this.client.namespace, record.value, undefined),
            { session }
          )
          await this.notify(queue.value, now, session)
          out.push({ job: record.value, duplicate: false })
        } catch (cause) {
          const duplicate =
            explicit === undefined
              ? await this.collections.jobs.findOne(
                  {
                    namespace: this.client.namespace,
                    identity: identity(record.value),
                    idempotencyKey
                  },
                  { session }
                )
              : await this.collections.jobs.findOne(
                  { namespace: this.client.namespace, id: record.value.id },
                  { session }
                )
          if (duplicate === null) throw cause
          out.push({ job: decodeJob(duplicate), duplicate: true })
        }
      }
      return Object.freeze(out)
    })
  }
  async claim(
    request: JobStoreNamespace.ClaimRequest
  ): Promise<Operation<JobStoreNamespace.ClaimResult>> {
    try {
      const queue = makeQueueName(request.queue)
      const worker = makeWorkerId(request.workerId)
      if (Result.isError(queue)) throw queue.error
      if (Result.isError(worker)) throw worker.error
      const now = this.now(request.now)
      const limit = number(request.limit, 'limit')
      const duration = number(request.leaseDurationMs, 'leaseDurationMs')
      if (limit < 1 || duration < 1 || !Array.isArray(request.accepted))
        throw new JobDefinitionError({ field: 'claim', message: 'contains invalid fields' })
      const accepted = request.accepted.map((item: unknown) => {
        const value = item as Record<string, unknown>
        const name = makeJobName(value.name)
        if (Result.isError(name)) throw name.error
        return { name: name.value, version: number(value.version, 'accepted.version') }
      })
      return this.withTx('claim', async (session) => {
        const control = this.document(
          await this.collections.queues.findOneAndUpdate(
            { _id: namespaceId(this.client.namespace, queue.value) },
            {
              $setOnInsert: {
                namespace: this.client.namespace,
                queue: queue.value,
                paused: false,
                wakeVersion: 0,
                updatedAtMs: now
              }
            },
            { session, upsert: true, returnDocument: 'after', includeResultMetadata: false }
          )
        )
        if (control?.paused === true)
          return {
            jobs: Object.freeze([]),
            wakeToken: await this.wakeToken(),
            nextRunAt: undefined
          }
        const filter = {
          namespace: this.client.namespace,
          queue: queue.value,
          state: { $in: ['waiting', 'delayed'] },
          runAtMs: { $lte: now },
          $or: accepted
        }
        const candidates = await this.collections.jobs
          .find(filter, {
            session,
            sort: { priority: -1, runAtMs: 1, orderSequence: 1, id: 1 },
            limit: limit * 4
          })
          .toArray()
        const jobs: JobRecord[] = []
        for (const document of candidates) {
          if (jobs.length >= limit) break
          const before = decodeJob(document)
          const changed = reduceJob(before, {
            type: 'claim',
            jobId: before.id,
            workerId: worker.value,
            leaseToken: randomUUID() as never,
            leaseExpiresAt: now + duration,
            now
          })
          if (Result.isError(changed)) continue
          if (await this.save(changed.value.record, before, session)) {
            await this.collections.jobs.updateOne(
              { namespace: this.client.namespace, id: before.id },
              {
                $unset: {
                  lastSettlementToken: '',
                  lastSettlementDigest: '',
                  lastSettlementOutcome: ''
                }
              },
              { session }
            )
            jobs.push(changed.value.record)
          }
        }
        const future = await this.collections.jobs
          .find(
            {
              namespace: this.client.namespace,
              queue: queue.value,
              state: 'delayed',
              runAtMs: { $gt: now },
              $or: accepted
            },
            { session, sort: { runAtMs: 1 }, limit: 1 }
          )
          .toArray()
        return {
          jobs: Object.freeze(jobs),
          wakeToken:
            `mongodb-wake-v1-${encodeURIComponent(JSON.stringify(await this.wakeSnapshot(session)))}` as import('better-effect-mq').WakeToken,
          nextRunAt: future[0] === undefined ? undefined : number(future[0].runAtMs, 'runAtMs')
        }
      })
    } catch (cause) {
      return fail('claim', cause)
    }
  }
  async settle(
    request: JobStoreNamespace.SettleRequest
  ): Promise<Operation<JobStoreNamespace.SettlementResult>> {
    try {
      const jobId = this.id(request.jobId)
      const lease = makeLeaseToken(request.leaseToken)
      if (Result.isError(lease)) throw lease.error
      const now = this.now(request.now)
      const digest = JSON.stringify(request.outcome)
      return this.withTx('settle', async (session) => {
        const document = await this.collections.jobs.findOne(
          { namespace: this.client.namespace, id: jobId },
          { session }
        )
        if (document === null) throw new JobNotFoundError({ jobId: jobId as never })
        const before = decodeJob(document)
        const settledToken = optionalString(document.lastSettlementToken, 'lastSettlementToken')
        const settledDigest = optionalString(document.lastSettlementDigest, 'lastSettlementDigest')
        if (settledToken === lease.value && settledDigest !== undefined && settledDigest !== digest)
          throw new SettlementConflictError({ jobId: jobId as never, leaseToken: lease.value })
        if (before.state !== 'active') {
          if (settledToken === lease.value && settledDigest === digest) {
            const attempt = await this.collections.attempts.findOne(
              {
                namespace: this.client.namespace,
                jobId,
                ledgerSequence: document.lastSettlementAttemptSequence
              },
              { session }
            )
            if (attempt !== null)
              return {
                record: before,
                attempt: decodeAttempt(attempt),
                status: 'already-applied' as const
              }
          }
          throw new LeaseLostError({
            jobId: jobId as never,
            leaseToken: lease.value,
            reason: 'missing-lease'
          })
        }
        const changed = reduceJob(before, {
          type: 'settle',
          jobId: jobId as never,
          leaseToken: lease.value,
          outcome: request.outcome,
          now,
          ...(request.startedAt === undefined ? {} : { startedAt: request.startedAt })
        })
        if (Result.isError(changed) || changed.value.attempt === undefined)
          throw Result.isError(changed)
            ? changed.error
            : new JobStoreFailure({
                operation: 'settle',
                retryable: false,
                message: 'settlement did not create an attempt'
              })
        let transition = changed.value
        if (transition.record.state === 'waiting' || transition.record.state === 'delayed') {
          const record = makeJobRecord({
            ...transition.record,
            orderingSequence: await this.nextSequence(session)
          })
          if (Result.isError(record)) throw record.error
          transition = { ...transition, record: record.value }
        }
        const attempt = transition.attempt!
        const attemptSequence = attempt.attemptSequence ?? attempt.attempt
        if (
          !(await this.save(transition.record, before, session, true, {
            lastSettlementToken: lease.value,
            lastSettlementDigest: digest,
            lastSettlementOutcome: 'settled',
            lastSettlementAttemptSequence: attemptSequence
          }))
        )
          throw new LeaseLostError({
            jobId: jobId as never,
            leaseToken: lease.value,
            reason: 'mismatched-token'
          })
        await this.collections.attempts.insertOne(
          encodeAttempt(this.client.namespace, jobId, attemptSequence, attempt),
          { session }
        )
        await this.notify(before.queue, now, session)
        return { record: transition.record, attempt, status: 'applied' as const }
      })
    } catch (cause) {
      return fail('settle', cause)
    }
  }
  async release(request: JobStoreNamespace.ReleaseRequest) {
    try {
      const id = this.id(request.jobId)
      const token = makeLeaseToken(request.leaseToken)
      if (Result.isError(token)) throw token.error
      const now = this.now(request.now)
      return this.transition(
        'release',
        { jobId: id, now },
        (job) =>
          reduceJob(job, { type: 'release', jobId: id as never, leaseToken: token.value, now }),
        true
      )
    } catch (cause) {
      return fail('release', cause)
    }
  }
  async heartbeat(
    request: JobStoreNamespace.HeartbeatRequest
  ): Promise<Operation<JobStoreNamespace.HeartbeatResult>> {
    try {
      const now = this.now(request.now)
      const duration = number(request.leaseDurationMs, 'leaseDurationMs')
      if (duration < 1 || !Array.isArray(request.leases))
        throw new JobDefinitionError({ field: 'heartbeat', message: 'contains invalid fields' })
      return this.withTx('heartbeat', async (session) => {
        const renewed: JobRecord[] = []
        const lost: JobStoreNamespace.LostLease[] = []
        const cancellationRequested: never[] = []
        for (const item of request.leases) {
          const id = this.id(item.jobId)
          const token = makeLeaseToken(item.leaseToken)
          if (Result.isError(token)) throw token.error
          const before = await this.job(id, session)
          if (before === undefined || before.state !== 'active') {
            lost.push({ jobId: id as never, leaseToken: token.value, reason: 'missing-lease' })
            continue
          }
          if (before.leaseToken !== token.value) {
            lost.push({ jobId: id as never, leaseToken: token.value, reason: 'mismatched-token' })
            continue
          }
          if (before.leaseExpiresAt === undefined || now >= before.leaseExpiresAt) {
            lost.push({ jobId: id as never, leaseToken: token.value, reason: 'expired-lease' })
            continue
          }
          if (before.cancellationRequestedAt !== undefined) {
            cancellationRequested.push(id as never)
            continue
          }
          const changed = makeJobRecord({
            ...before,
            leaseExpiresAt: now + duration,
            updatedAt: now
          })
          if (Result.isError(changed)) throw changed.error
          if (await this.save(changed.value, before, session, true)) renewed.push(changed.value)
          else
            lost.push({ jobId: id as never, leaseToken: token.value, reason: 'mismatched-token' })
        }
        return {
          renewed: Object.freeze(renewed) as never,
          lost: Object.freeze(lost),
          cancellationRequested: Object.freeze(cancellationRequested)
        }
      })
    } catch (cause) {
      return fail('heartbeat', cause)
    }
  }
  async recoverStalled(
    request: JobStoreNamespace.RecoverStalledRequest
  ): Promise<Operation<JobStoreNamespace.RecoverStalledResult>> {
    try {
      const now = this.now(request.now)
      const maximum = number(request.maxStalledCount, 'maxStalledCount')
      const limit = request.limit === undefined ? 10000 : number(request.limit, 'limit')
      return this.withTx('recoverStalled', async (session) => {
        const rows = await this.collections.jobs
          .find(
            { namespace: this.client.namespace, state: 'active', leaseExpiresAtMs: { $lte: now } },
            { session, sort: { leaseExpiresAtMs: 1, id: 1 }, limit }
          )
          .toArray()
        const transitions: JobTransition[] = []
        for (const row of rows) {
          const before = decodeJob(row)
          const changed = recoverStalledWithPolicy(
            before as never,
            { type: 'recover-stalled', jobId: before.id, now } as never,
            before.stalledCount >= maximum
          ) as ResultType<JobTransition, JobStoreNamespace.Error>
          if (Result.isError(changed)) throw changed.error
          if (await this.save(changed.value.record, before, session, true)) {
            if (changed.value.attempt !== undefined)
              await this.collections.attempts.insertOne(
                encodeAttempt(
                  this.client.namespace,
                  before.id,
                  changed.value.attempt.attemptSequence ?? changed.value.attempt.attempt,
                  changed.value.attempt
                ),
                { session }
              )
            await this.notify(before.queue, now, session)
            transitions.push(changed.value)
          }
        }
        return { transitions: Object.freeze(transitions), recovered: transitions.length }
      })
    } catch (cause) {
      return fail('recoverStalled', cause)
    }
  }
  async retry(request: JobStoreNamespace.RetryRequest) {
    try {
      const id = this.id(request.jobId)
      const now = this.now(request.now)
      const runAt = this.now(request.runAt)
      return this.transition('retry', { jobId: id, now }, (job) =>
        reduceJob(job, { type: 'retry', jobId: id as never, runAt, now })
      )
    } catch (cause) {
      return fail('retry', cause)
    }
  }
  async cancel(request: JobStoreNamespace.CancelRequest) {
    try {
      const id = this.id(request.jobId)
      const now = this.now(request.now)
      return this.transition('cancel', { jobId: id, now }, (job) =>
        reduceJob(job, { type: 'cancel', jobId: id as never, now })
      )
    } catch (cause) {
      return fail('cancel', cause)
    }
  }
  async requestCancellation(request: JobStoreNamespace.RequestCancellationRequest) {
    try {
      const id = this.id(request.jobId)
      const now = this.now(request.now)
      return this.transition('requestCancellation', { jobId: id, now }, (job) =>
        reduceJob(job, { type: 'request-cancellation', jobId: id as never, now })
      )
    } catch (cause) {
      return fail('requestCancellation', cause)
    }
  }
  async promote(request: JobStoreNamespace.PromoteRequest) {
    try {
      const id = this.id(request.jobId)
      const now = this.now(request.now)
      return this.transition('promote', { jobId: id, now }, (job) =>
        reduceJob(job, { type: 'promote', jobId: id as never, now })
      )
    } catch (cause) {
      return fail('promote', cause)
    }
  }
  async remove(
    request: JobStoreNamespace.RemoveRequest
  ): Promise<Operation<JobStoreNamespace.RemoveResult>> {
    try {
      const id = this.id(request.jobId)
      const now = this.now(request.now)
      return this.withTx('remove', async (session) => {
        const job = await this.job(id, session)
        if (job === undefined) throw new JobNotFoundError({ jobId: id as never })
        if (
          job.state === 'active' ||
          (request.expectedState !== undefined && request.expectedState !== job.state)
        )
          throw new InvalidJobTransitionError({
            jobId: id as never,
            from: job.state,
            operation: 'remove'
          })
        const deleted = await this.collections.jobs.deleteOne(
          { namespace: this.client.namespace, id, state: job.state, updatedAtMs: job.updatedAt },
          { session }
        )
        if (deleted.deletedCount !== 1)
          throw new JobStoreFailure({
            operation: 'remove',
            retryable: true,
            message: 'MongoDB remove conflicted'
          })
        await this.notify(job.queue, now, session)
        return { job, removed: true }
      })
    } catch (cause) {
      return fail('remove', cause)
    }
  }
  private async pauseResume(
    request: JobStoreNamespace.PauseQueueRequest,
    paused: boolean
  ): Promise<Operation<JobStoreNamespace.QueuePauseResult>> {
    try {
      const queue = makeQueueName(request.queue)
      if (Result.isError(queue)) throw queue.error
      const now = this.now(request.now)
      return this.withTx(paused ? 'pause' : 'resume', async (session) => {
        const result = this.document(
          await this.collections.queues.findOneAndUpdate(
            {
              _id: namespaceId(this.client.namespace, queue.value),
              wakeVersion: { $lt: Number.MAX_SAFE_INTEGER }
            },
            {
              $set: {
                namespace: this.client.namespace,
                queue: queue.value,
                paused,
                updatedAtMs: now
              },
              $inc: { wakeVersion: 1 }
            },
            { session, upsert: true, returnDocument: 'after', includeResultMetadata: false }
          )
        )
        number(result?.wakeVersion, 'queue.wakeVersion')
        return { queue: queue.value, paused }
      })
    } catch (cause) {
      return fail(paused ? 'pause' : 'resume', cause)
    }
  }
  pause(request: JobStoreNamespace.PauseQueueRequest) {
    return this.pauseResume(request, true)
  }
  resume(request: JobStoreNamespace.PauseQueueRequest) {
    return this.pauseResume(request, false)
  }
  async getJob(request: JobStoreNamespace.GetJobRequest) {
    try {
      return ok(await this.job(this.id(request.jobId)))
    } catch (cause) {
      return fail('getJob', cause)
    }
  }
  async getAttempts(request: JobStoreNamespace.GetAttemptsRequest) {
    try {
      const rows = await this.collections.attempts
        .find(
          { namespace: this.client.namespace, jobId: this.id(request.jobId) },
          { sort: { ledgerSequence: 1 } }
        )
        .toArray()
      return ok(Object.freeze(rows.map(decodeAttempt)))
    } catch (cause) {
      return fail('getAttempts', cause)
    }
  }
  async counts(
    request: JobStoreNamespace.CountsRequest = {}
  ): Promise<Operation<JobStoreNamespace.JobCounts>> {
    try {
      const filter = namespaceFilter(this.client.namespace)
      if (request.queue !== undefined) filter.queue = request.queue
      if (request.name !== undefined) filter.name = request.name
      const rows = await this.collections.jobs.find(filter).toArray()
      const out = {
        total: rows.length,
        waiting: 0,
        delayed: 0,
        active: 0,
        completed: 0,
        failed: 0,
        cancelled: 0
      }
      for (const row of rows) out[decodeJob(row).state] += 1
      return ok(out)
    } catch (cause) {
      return fail('counts', cause)
    }
  }
  async pausedQueues() {
    try {
      const rows = await this.collections.queues
        .find({ namespace: this.client.namespace, paused: true }, { sort: { queue: 1 } })
        .toArray()
      const queues = rows.map((row) => makeQueueName(row.queue))
      const error = queues.find(Result.isError)
      if (error !== undefined && Result.isError(error)) throw error.error
      return ok(
        Object.freeze(
          queues.map((value) => (value as { value: import('better-effect-mq').QueueName }).value)
        )
      )
    } catch (cause) {
      return fail('pausedQueues', cause)
    }
  }
  async list(
    request: JobStoreNamespace.ListJobsRequest
  ): Promise<Operation<JobStoreNamespace.ListJobsResult>> {
    try {
      const filter = namespaceFilter(this.client.namespace)
      if (request.queue !== undefined) filter.queue = request.queue
      if (request.name !== undefined) filter.name = request.name
      if (request.version !== undefined) filter.version = request.version
      if (request.state !== undefined)
        filter.state = { $in: Array.isArray(request.state) ? request.state : [request.state] }
      if (request.metadata !== undefined)
        filter.metadataEntries = {
          $all: Object.entries(request.metadata).map(([key, value]) => ({
            $elemMatch: { key, value }
          }))
        }
      const orderBy = request.orderBy ?? 'enqueuedAt'
      const order = request.order ?? 'asc'
      const limit = number(request.limit, 'limit')
      const column =
        orderBy === 'enqueuedAt' ? 'createdAtMs' : orderBy === 'runAt' ? 'runAtMs' : 'finishedAtMs'
      const direction = order === 'asc' ? 1 : -1
      const rows = await this.collections.jobs
        .find(filter, {
          sort: { [column]: direction, orderSequence: direction, id: direction },
          limit: limit + 1
        })
        .toArray()
      const jobs = rows.slice(0, limit).map(decodeJob)
      const last = jobs.at(-1)
      return ok({
        jobs: Object.freeze(jobs),
        nextCursor:
          rows.length > limit && last !== undefined
            ? {
                version: 1,
                orderBy,
                order,
                direction: order,
                ordering:
                  orderBy === 'enqueuedAt'
                    ? 'createdAt,orderingSequence,id'
                    : `${orderBy},orderingSequence,id`,
                filterSignature: '',
                value:
                  orderBy === 'enqueuedAt'
                    ? last.createdAt
                    : orderBy === 'runAt'
                      ? last.runAt
                      : (last.finishedAt ?? null),
                createdAt: last.createdAt,
                orderingSequence: last.orderingSequence,
                id: last.id
              }
            : undefined
      })
    } catch (cause) {
      return fail('list', cause)
    }
  }
  async awaitWake(request: JobStoreNamespace.AwaitWakeRequest): Promise<Operation<void>> {
    if (request.signal.aborted) return Result.err(new JobStoreWakeAbortedError()) as Operation<void>
    try {
      const token = request.wakeToken
      if (typeof token !== 'string' || !token.startsWith('mongodb-wake-v1-'))
        throw new JobStoreFailure({
          operation: 'awaitWake',
          retryable: false,
          message: 'wakeToken was not created by this MongoDB store'
        })
      const baseline = JSON.parse(
        decodeURIComponent(token.slice('mongodb-wake-v1-'.length))
      ) as Record<string, number>
      const changed = async () => {
        const current = await this.wakeSnapshot()
        const queues = request.queues.length === 0 ? Object.keys(current) : request.queues
        return queues.some(
          (queue: unknown) =>
            typeof queue === 'string' && (current[queue] ?? 0) > (baseline[queue] ?? 0)
        )
      }
      if (await changed()) return ok(undefined)
      return await new Promise((resolve) => {
        let done = false
        const finish = (result: Operation<void>) => {
          if (done) return
          done = true
          clearInterval(timer)
          request.signal.removeEventListener('abort', abort)
          this.waiters.delete(check)
          resolve(result)
        }
        const check = () => {
          void changed()
            .then((yes) => {
              if (yes) finish(ok(undefined))
            })
            .catch((cause) => finish(fail('awaitWake', cause)))
        }
        const abort = () => finish(Result.err(new JobStoreWakeAbortedError()) as Operation<void>)
        const timer = setInterval(check, 250)
        this.waiters.add(check)
        request.signal.addEventListener('abort', abort, { once: true })
        check()
      })
    } catch (cause) {
      return fail('awaitWake', cause)
    }
  }
  private wake(): void {
    for (const waiter of this.waiters) waiter()
  }
  async wakeToken(): Promise<import('better-effect-mq').WakeToken> {
    return `mongodb-wake-v1-${encodeURIComponent(JSON.stringify(await this.wakeSnapshot()))}` as import('better-effect-mq').WakeToken
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
      try {
        await store.start()
        return JobStore.of(store as never) as unknown as ServiceContract<InstanceType<T>>
      } catch (cause) {
        await store.dispose()
        throw cause
      }
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
