// oxlint-disable anti-slop/no-runtime-typeof -- MongoDB data and public requests are validated at this persistence boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- BSON driver replies are narrowed before use.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- BSON documents use field-based storage by design.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional protocol fields must be omitted from BSON.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- checked BSON and protocol values cross an erased optional-peer boundary.
// oxlint-disable anti-slop/no-known-value-widening -- BSON query documents are intentionally open at this adapter boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- public DTO and Service erasure is restored only after boundary validation.
import { randomUUID } from 'node:crypto'
import { Layer, type ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  InvalidJobTransitionError,
  JobDefinitionError,
  JobNotFoundError,
  JobStore,
  JobStoreFailure,
  JobStoreWakeAbortedError,
  LeaseLostError,
  SettlementConflictError,
  UnsupportedJobStoreOperationError,
  makeJobId,
  makeJobName,
  makeJobRecord,
  makeLeaseToken,
  makeQueueName,
  makeWorkerId,
  recoverStalledWithPolicy,
  reduceJob,
  validateAttemptRecord,
  type AnyJobStoreToken,
  type AttemptRecord,
  type JobRecord,
  type JobTransition,
  type ActiveJobSnapshot,
  type JobIdRequest,
  type LostLease,
  type JobStore as J,
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

type Doc = Record<string, unknown>
type Op<T> = ResultType<T, any>
type TxBody<T> = (session: MongoSession) => Promise<T>
class MongoDuplicateConflict extends Error {}
const MAX = Number.MAX_SAFE_INTEGER
const states = new Set(['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'])
const tagged = new Set([
  'JobStoreFailure',
  'JobDefinitionError',
  'JobNotFoundError',
  'LeaseLostError',
  'SettlementConflictError',
  'InvalidJobTransitionError',
  'JobNotRetryableError',
  'JobNotCancellableError',
  'JobNotPromotableError',
  'UnsupportedJobStoreOperationError'
])
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
const ok = <T>(value: T): Op<T> => Result.ok(value) as Op<T>
const isTagged = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  typeof (cause as { _tag?: unknown })._tag === 'string' &&
  tagged.has((cause as { _tag: string })._tag)
const retryable = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false
  const value = cause as { errorLabels?: unknown; code?: unknown; name?: unknown }
  return (
    (Array.isArray(value.errorLabels) &&
      value.errorLabels.some(
        (label) =>
          label === 'TransientTransactionError' || label === 'UnknownTransactionCommitResult'
      )) ||
    value.code === 91 ||
    value.code === 10107 ||
    value.name === 'MongoNetworkError'
  )
}
const fail = <T>(operation: string, cause: unknown): Op<T> =>
  Result.err(
    isTagged(cause)
      ? cause
      : new JobStoreFailure({
          operation,
          retryable: retryable(cause),
          message: `MongoDB ${operation} failed`
        })
  ) as Op<T>
const integer = (value: unknown, field: string, min = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new MongoJobStoreLayoutError(`MongoDB document has invalid ${field}`)
  return value
}
const inputNumber = (value: unknown, field: string, min = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new JobDefinitionError({
      field,
      message: min === 0 ? 'must be a non-negative safe integer' : 'must be a positive safe integer'
    })
  return value
}
const docText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0)
    throw new MongoJobStoreLayoutError(`MongoDB document has invalid ${field}`)
  return value
}
const optionalNumber = (value: unknown, field: string): number | undefined =>
  value == null ? undefined : integer(value, field)
const optionalText = (value: unknown, field: string): string | undefined =>
  value == null ? undefined : docText(value, field)
const identity = (queue: string, name: string, version: number): string =>
  JSON.stringify([queue, name, version])
const id = (namespace: string, jobId: string): string => namespaceId(namespace, jobId)
const isRequeue = (before: JobRecord, after: JobRecord): boolean =>
  (after.state === 'waiting' || after.state === 'delayed') &&
  (before.state === 'active' ||
    before.state === 'failed' ||
    before.state === 'cancelled' ||
    before.state === 'delayed')
const canonical = (value: unknown): string => {
  const seen = new Set<object>()
  const visit = (node: unknown): string => {
    if (node === null || typeof node !== 'object') {
      const json = JSON.stringify(node)
      if (json === undefined)
        throw new JobDefinitionError({ field: 'outcome', message: 'must be JSON data' })
      return json
    }
    if (seen.has(node))
      throw new JobDefinitionError({ field: 'outcome', message: 'must not contain cycles' })
    seen.add(node)
    try {
      if (Array.isArray(node)) return `[${node.map(visit).join(',')}]`
      return `{${Object.keys(node)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit((node as Record<string, unknown>)[key])}`)
        .join(',')}}`
    } finally {
      seen.delete(node)
    }
  }
  return visit(value)
}
const encodeJob = (
  namespace: string,
  record: JobRecord,
  settlement?: { token: string; digest: string }
): Doc => ({
  _id: id(namespace, record.id),
  namespace,
  id: record.id,
  identity: identity(record.queue, record.name, record.version),
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
  ...(settlement === undefined
    ? {}
    : {
        lastSettlementToken: settlement.token,
        lastSettlementDigest: settlement.digest,
        lastSettlementOutcome: 'settled'
      })
})
const decodeJob = (document: Doc): JobRecord => {
  const record = makeJobRecord({
    id: docText(document.id, 'job.id'),
    name: docText(document.name, 'job.name'),
    version: integer(document.version, 'job.version', 1),
    queue: docText(document.queue, 'job.queue'),
    state: document.state,
    payload: document.payload,
    metadata: metadataFromEntries(document.metadataEntries),
    priority:
      typeof document.priority === 'number'
        ? document.priority
        : (() => {
            throw new MongoJobStoreLayoutError('MongoDB document has invalid job.priority')
          })(),
    runAt: integer(document.runAtMs, 'job.runAtMs'),
    orderingSequence: integer(document.orderSequence, 'job.orderSequence', 1),
    attemptsMax: integer(document.attemptsMax, 'job.attemptsMax', 1),
    attemptsMade: integer(document.attemptsMade, 'job.attemptsMade'),
    attemptSequence: integer(
      document.attemptSequence ?? document.attemptsMade,
      'job.attemptSequence'
    ),
    deliveryCount: integer(document.deliveryCount, 'job.deliveryCount'),
    stalledCount: integer(document.stalledCount, 'job.stalledCount'),
    backoff: document.backoff as JobRecord['backoff'],
    timeoutMs: optionalNumber(document.timeoutMs, 'job.timeoutMs'),
    idempotencyKey: optionalText(document.idempotencyKey, 'job.idempotencyKey'),
    createdAt: integer(document.createdAtMs, 'job.createdAtMs'),
    updatedAt: integer(document.updatedAtMs, 'job.updatedAtMs'),
    processedAt: optionalNumber(document.processedAtMs, 'job.processedAtMs'),
    finishedAt: optionalNumber(document.finishedAtMs, 'job.finishedAtMs'),
    leaseOwner: optionalText(document.leaseOwner, 'job.leaseOwner') as JobRecord['leaseOwner'],
    leaseToken: optionalText(document.leaseToken, 'job.leaseToken') as JobRecord['leaseToken'],
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
  attempt: AttemptRecord,
  workerId?: string
): Doc => ({
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
  ...(workerId === undefined ? {} : { workerId }),
  ...(attempt.retryAt === undefined ? {} : { retryAtMs: attempt.retryAt }),
  ...(attempt.retryDelayMs === undefined ? {} : { retryDelayMs: attempt.retryDelayMs })
})
const decodeAttempt = (document: Doc): AttemptRecord => {
  const attempt = validateAttemptRecord({
    attempt: integer(document.attempt, 'attempt.attempt', 1),
    attemptSequence: optionalNumber(document.attemptSequence, 'attempt.attemptSequence'),
    delivery: integer(document.delivery, 'attempt.delivery', 1),
    startedAt: optionalNumber(document.startedAtMs, 'attempt.startedAtMs'),
    finishedAt: integer(document.finishedAtMs, 'attempt.finishedAtMs'),
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
  private readonly waiters = new Set<(cause?: unknown) => void>()
  private stream: MongoQueueChangeStream | undefined
  private disposed = false
  private disposal: Promise<void> | undefined
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
  private async transaction<T>(operation: string, body: TxBody<T>): Promise<Op<T>> {
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
      if (cause instanceof MongoDuplicateConflict) return Result.err(cause) as Op<T>
      return fail(operation, cause)
    } finally {
      try {
        await session.endSession()
      } catch {
        /* primary operation result is retained */
      }
    }
  }
  private async sequence(session: MongoSession): Promise<number> {
    const result = await this.collections.counters.findOneAndUpdate(
      {
        _id: namespaceId(this.client.namespace, 'job-order-sequence'),
        $or: [{ value: { $lt: MAX } }, { value: { $exists: false } }]
      },
      {
        $setOnInsert: { namespace: this.client.namespace, name: 'job-order-sequence' },
        $inc: { value: 1 }
      },
      { upsert: true, returnDocument: 'after', session }
    )
    const value = this.findOneResult(result)
    return integer(value?.value, 'counter.value', 1)
  }
  private async notify(queue: string, now: number, session: MongoSession): Promise<void> {
    const result = await this.collections.queues.findOneAndUpdate(
      {
        _id: namespaceId(this.client.namespace, queue),
        $or: [{ wakeVersion: { $lt: MAX } }, { wakeVersion: { $exists: false } }]
      },
      {
        $setOnInsert: { namespace: this.client.namespace, queue, paused: false },
        $set: { updatedAtMs: now },
        $inc: { wakeVersion: 1 }
      },
      { upsert: true, returnDocument: 'after', session }
    )
    const value = this.findOneResult(result)
    integer(value?.wakeVersion, 'queue.wakeVersion', 1)
  }
  private async readJob(
    jobId: string,
    session?: MongoSession
  ): Promise<{ record: JobRecord; doc: Doc } | undefined> {
    const document = await this.collections.jobs.findOne(
      { _id: id(this.client.namespace, jobId) },
      session === undefined ? undefined : { session }
    )
    return document === null ? undefined : { record: decodeJob(document), doc: document }
  }
  private async save(
    record: JobRecord,
    session: MongoSession,
    expected?: JobRecord,
    settlement?: { token: string; digest: string }
  ): Promise<boolean> {
    const filter: Doc = { _id: id(this.client.namespace, record.id) }
    if (expected !== undefined)
      Object.assign(filter, {
        state: expected.state,
        updatedAtMs: expected.updatedAt,
        orderSequence: expected.orderingSequence,
        attemptSequence: expected.attemptSequence ?? expected.attemptsMade,
        ...(expected.leaseToken === undefined ? {} : { leaseToken: expected.leaseToken })
      })
    const encoded = encodeJob(this.client.namespace, record, settlement)
    delete encoded._id
    const unset: Doc = Object.create(null)
    for (const field of [
      'backoff',
      'timeoutMs',
      'idempotencyKey',
      'processedAtMs',
      'finishedAtMs',
      'leaseOwner',
      'leaseToken',
      'leaseExpiresAtMs',
      'cancellationRequestedAtMs',
      'result',
      'failure',
      'lastSettlementToken',
      'lastSettlementDigest',
      'lastSettlementOutcome'
    ] as const)
      if (!(field in encoded)) unset[field] = ''
    const result = await this.collections.jobs.updateOne(
      filter,
      Object.keys(unset).length === 0 ? { $set: encoded } : { $set: encoded, $unset: unset },
      { session }
    )
    return result.matchedCount === 1
  }
  private async transition(
    operation: string,
    request: { jobId: string; now: number },
    command: (record: JobRecord) => ResultType<JobTransition, any>
  ): Promise<Op<JobTransition>> {
    return this.transaction(operation, async (session) => {
      const found = await this.readJob(request.jobId, session)
      if (found === undefined) throw new JobNotFoundError({ jobId: request.jobId as never })
      const reduced = command(found.record)
      if (Result.isError(reduced)) throw reduced.error
      let transition = reduced.value
      if (isRequeue(found.record, transition.record)) {
        const orderingSequence = await this.sequence(session)
        const changed = makeJobRecord({ ...transition.record, orderingSequence })
        if (Result.isError(changed)) throw changed.error
        transition = { ...transition, record: changed.value }
      }
      if (!(await this.save(transition.record, session, found.record)))
        throw new JobStoreFailure({
          operation,
          retryable: true,
          message: 'MongoDB conditional transition conflicted'
        })
      if (transition.attempt !== undefined)
        await this.collections.attempts.insertOne(
          encodeAttempt(
            this.client.namespace,
            transition.record.id,
            transition.record.attemptSequence ?? transition.record.attemptsMade,
            transition.attempt,
            found.record.leaseOwner
          ),
          { session }
        )
      await this.notify(transition.record.queue, request.now, session)
      return transition
    })
  }
  async enqueue(request: J.EnqueueRequest): Promise<Op<J.EnqueueResult>> {
    const all = await this.enqueueMany([request])
    return Result.isError(all) ? (all as Op<J.EnqueueResult>) : ok(all.value[0]!)
  }
  async enqueueMany(requests: readonly J.EnqueueRequest[]): Promise<Op<J.EnqueueManyResult>> {
    try {
      if (!Array.isArray(requests))
        throw new JobDefinitionError({ field: 'requests', message: 'must be an array' })
      const normalized = requests.map((request) => this.newJob(request))
      if (normalized.length === 0) return ok(Object.freeze([]))
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await this.transaction('enqueue', async (session) => {
          const output: J.EnqueueResult[] = []
          for (const input of normalized) {
            const explicit = input.explicit
            const existing = explicit
              ? await this.readJob(input.record.id, session)
              : input.record.idempotencyKey === undefined
                ? undefined
                : await this.collections.jobs.findOne(
                    {
                      namespace: this.client.namespace,
                      queue: input.record.queue,
                      name: input.record.name,
                      version: input.record.version,
                      idempotencyKey: input.record.idempotencyKey
                    },
                    { session }
                  )
            if (existing !== undefined && existing !== null) {
              output.push({
                job: explicit ? existing.record : decodeJob(existing as Doc),
                duplicate: true
              })
              continue
            }
            const sequence = await this.sequence(session)
            const changed = makeJobRecord({ ...input.record, orderingSequence: sequence })
            if (Result.isError(changed)) throw changed.error
            try {
              await this.collections.jobs.insertOne(
                encodeJob(this.client.namespace, changed.value),
                {
                  session
                }
              )
              await this.notify(changed.value.queue, changed.value.updatedAt, session)
              output.push({ job: changed.value, duplicate: false })
            } catch (cause) {
              // A duplicate write aborts a MongoDB transaction. Retry from a
              // fresh snapshot so the committed winner becomes observable.
              if (this.duplicate(cause)) throw new MongoDuplicateConflict()
              throw cause
            }
          }
          return Object.freeze(output)
        })
        if (!Result.isError(result) || !(result.error instanceof MongoDuplicateConflict))
          return result
      }
      return fail(
        'enqueue',
        new JobStoreFailure({
          operation: 'enqueue',
          retryable: true,
          message: 'MongoDB duplicate enqueue contention did not settle after retries'
        })
      )
    } catch (cause) {
      return fail('enqueue', cause)
    }
  }
  private newJob(request: J.EnqueueRequest): { record: JobRecord; explicit: boolean } {
    if (request === null || typeof request !== 'object')
      throw new JobDefinitionError({ field: 'request', message: 'must be an object' })
    const raw = request as unknown as Doc
    const source = raw.job ?? raw.identity
    if (
      (raw.job !== undefined && raw.identity !== undefined) ||
      source === undefined ||
      typeof source !== 'object' ||
      source === null
    )
      throw new JobDefinitionError({
        field: 'identity',
        message: 'must provide exactly one identity'
      })
    const ident = source as Doc
    const queue = makeQueueName(ident.queue)
    const name = makeJobName(ident.name)
    if (Result.isError(queue)) throw queue.error
    if (Result.isError(name)) throw name.error
    const version = inputNumber(ident.version, 'identity.version', 1)
    const now = inputNumber(raw.now, 'now')
    const runAt = inputNumber(raw.runAt, 'runAt')
    const attemptsMax = inputNumber(raw.attemptsMax, 'attemptsMax', 1)
    const explicit = raw.id !== undefined
    const jobId = explicit ? makeJobId(raw.id) : makeJobId(randomUUID())
    if (Result.isError(jobId)) throw jobId.error
    const record = makeJobRecord({
      id: jobId.value,
      queue: queue.value,
      name: name.value,
      version,
      state: runAt <= now ? 'waiting' : 'delayed',
      payload: raw.payload as never,
      metadata: (raw.metadata ?? {}) as never,
      priority:
        raw.priority === undefined
          ? 0
          : (() => {
              if (typeof raw.priority !== 'number' || !Number.isSafeInteger(raw.priority))
                throw new JobDefinitionError({
                  field: 'priority',
                  message: 'must be a safe integer'
                })
              return raw.priority
            })(),
      runAt,
      orderingSequence: 1,
      attemptsMax,
      attemptsMade: 0,
      attemptSequence: 0,
      deliveryCount: 0,
      stalledCount: 0,
      backoff: raw.backoff as never,
      timeoutMs: raw.timeoutMs as never,
      idempotencyKey: raw.idempotencyKey as never,
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
    return { record: record.value, explicit }
  }
  private duplicate(cause: unknown): boolean {
    return (
      typeof cause === 'object' &&
      cause !== null &&
      ((cause as { code?: unknown }).code === 11000 ||
        (cause as { codeName?: unknown }).codeName === 'DuplicateKey')
    )
  }
  async claim(request: J.ClaimRequest): Promise<Op<J.ClaimResult>> {
    try {
      const raw = request as unknown as Doc
      const queue = makeQueueName(raw.queue)
      const worker = makeWorkerId(raw.workerId)
      if (Result.isError(queue)) throw queue.error
      if (Result.isError(worker)) throw worker.error
      const now = inputNumber(raw.now, 'now')
      const limit = inputNumber(raw.limit, 'limit', 1)
      const duration = inputNumber(raw.leaseDurationMs, 'leaseDurationMs', 1)
      if (now > MAX - duration)
        throw new JobDefinitionError({
          field: 'leaseDurationMs',
          message: 'lease expiry exceeds safe integer range'
        })
      if (!Array.isArray(raw.accepted))
        throw new JobDefinitionError({ field: 'accepted', message: 'must be an array' })
      const accepted = raw.accepted.map((value) => {
        if (value === null || typeof value !== 'object')
          throw new JobDefinitionError({ field: 'accepted', message: 'contains invalid identity' })
        const item = value as Doc
        const name = makeJobName(item.name)
        if (Result.isError(name)) throw name.error
        return identity(queue.value, name.value, inputNumber(item.version, 'accepted.version', 1))
      })
      const result = await this.transaction('claim', async (session) => {
        const control = await this.collections.queues.findOne(
          { _id: namespaceId(this.client.namespace, queue.value) },
          { session }
        )
        const baseline = control === null ? 0 : integer(control.wakeVersion, 'queue.wakeVersion')
        if (control?.paused === true)
          return {
            jobs: Object.freeze([]),
            wakeToken: this.wakeTokenFor({ [queue.value]: baseline }),
            nextRunAt: undefined
          }
        // Write the queue control document under the observed version. This
        // turns a racing pause/resume into a transaction conflict instead of
        // permitting a post-pause claim from an earlier snapshot.
        if (control !== null) {
          const guarded = await this.collections.queues.updateOne(
            {
              _id: namespaceId(this.client.namespace, queue.value),
              paused: false,
              wakeVersion: baseline
            },
            { $set: { updatedAtMs: now } },
            { session }
          )
          if (guarded.matchedCount !== 1)
            throw new JobStoreFailure({
              operation: 'claim',
              retryable: true,
              message: 'MongoDB queue control changed during claim'
            })
        }
        const jobs: JobRecord[] = []
        for (let index = 0; index < limit; index += 1) {
          const leaseToken = randomUUID()
          const value = await this.collections.jobs.findOneAndUpdate(
            {
              namespace: this.client.namespace,
              queue: queue.value,
              identity: { $in: accepted },
              state: { $in: ['waiting', 'delayed'] },
              runAtMs: { $lte: now }
            },
            {
              $set: {
                state: 'active',
                leaseOwner: worker.value,
                leaseToken,
                leaseExpiresAtMs: now + duration,
                updatedAtMs: now
              },
              $inc: { deliveryCount: 1 }
            },
            {
              sort: { priority: -1, runAtMs: 1, orderSequence: 1, id: 1 },
              returnDocument: 'after',
              session
            }
          )
          const document = this.findOneResult(value)
          if (document === undefined) break
          jobs.push(decodeJob(document))
        }
        const earliest = await this.collections.jobs.findOne(
          {
            namespace: this.client.namespace,
            queue: queue.value,
            identity: { $in: accepted },
            state: { $in: ['waiting', 'delayed'] },
            runAtMs: { $gt: now }
          },
          { sort: { runAtMs: 1 }, session }
        )
        return {
          jobs: Object.freeze(jobs as ActiveJobSnapshot[]),
          wakeToken: this.wakeTokenFor({ [queue.value]: baseline }),
          nextRunAt: earliest === null ? undefined : integer(earliest.runAtMs, 'job.runAtMs')
        }
      })
      return result
    } catch (cause) {
      return fail('claim', cause)
    }
  }
  private findOneResult(value: unknown): Doc | undefined {
    if (value === null) return undefined
    if (
      typeof value === 'object' &&
      value !== null &&
      'lastErrorObject' in value &&
      'value' in value
    )
      return (value as { value?: Doc | null }).value ?? undefined
    return value as Doc
  }
  async settle(request: J.SettleRequest): Promise<Op<J.SettlementResult>> {
    try {
      const jobId = makeJobId(request.jobId)
      const token = makeLeaseToken(request.leaseToken)
      if (Result.isError(jobId)) throw jobId.error
      if (Result.isError(token)) throw token.error
      const digest = canonical(request.outcome)
      return this.transaction('settle', async (session) => {
        const found = await this.readJob(jobId.value, session)
        if (found === undefined) throw new JobNotFoundError({ jobId: jobId.value })
        if (found.record.state !== 'active') {
          if (found.doc.lastSettlementToken === token.value) {
            if (found.doc.lastSettlementDigest !== digest)
              throw new SettlementConflictError({ jobId: jobId.value, leaseToken: token.value })
            const last = await this.collections.attempts.findOne(
              {
                namespace: this.client.namespace,
                jobId: jobId.value,
                ledgerSequence: found.record.attemptSequence ?? found.record.attemptsMade
              },
              { session }
            )
            if (last === null)
              throw new MongoJobStoreLayoutError('settlement ledger entry is missing')
            return { record: found.record, attempt: decodeAttempt(last), status: 'already-applied' }
          }
          throw new LeaseLostError({
            jobId: jobId.value,
            leaseToken: token.value,
            reason: 'missing-lease'
          })
        }
        const reduced = reduceJob(
          found.record,
          request.startedAt === undefined
            ? {
                type: 'settle',
                jobId: jobId.value,
                leaseToken: token.value,
                outcome: request.outcome,
                now: request.now
              }
            : {
                type: 'settle',
                jobId: jobId.value,
                leaseToken: token.value,
                outcome: request.outcome,
                now: request.now,
                startedAt: request.startedAt
              }
        )
        if (Result.isError(reduced) || reduced.value.attempt === undefined)
          throw Result.isError(reduced)
            ? reduced.error
            : new JobDefinitionError({
                field: 'attempt',
                message: 'settlement did not record an attempt'
              })
        let next = reduced.value.record
        if (isRequeue(found.record, next)) {
          const sequence = await this.sequence(session)
          const changed = makeJobRecord({ ...next, orderingSequence: sequence })
          if (Result.isError(changed)) throw changed.error
          next = changed.value
        }
        const ledger = next.attemptSequence ?? next.attemptsMade
        await this.collections.attempts.insertOne(
          encodeAttempt(
            this.client.namespace,
            jobId.value,
            ledger,
            reduced.value.attempt,
            found.record.leaseOwner
          ),
          { session }
        )
        if (!(await this.save(next, session, found.record, { token: token.value, digest })))
          throw new LeaseLostError({
            jobId: jobId.value,
            leaseToken: token.value,
            reason: 'mismatched-token'
          })
        await this.notify(next.queue, request.now, session)
        return { record: next, attempt: reduced.value.attempt, status: 'applied' }
      })
    } catch (cause) {
      return fail('settle', cause)
    }
  }
  async release(request: J.ReleaseRequest): Promise<Op<J.ReleaseResult>> {
    return this.fenced('release', request, (record) =>
      reduceJob(record, { type: 'release', ...request })
    )
  }
  private async fenced(
    operation: string,
    request: J.ReleaseRequest,
    command: (record: JobRecord) => ResultType<JobTransition, any>
  ): Promise<Op<JobTransition>> {
    const jobId = makeJobId(request.jobId)
    if (Result.isError(jobId)) return fail(operation, jobId.error)
    return this.transition(operation, { jobId: jobId.value, now: request.now }, command)
  }
  async heartbeat(request: J.HeartbeatRequest): Promise<Op<J.HeartbeatResult>> {
    try {
      const now = inputNumber(request.now, 'now')
      const duration = inputNumber(request.leaseDurationMs, 'leaseDurationMs', 1)
      if (now > MAX - duration)
        throw new JobDefinitionError({
          field: 'leaseDurationMs',
          message: 'lease expiry exceeds safe integer range'
        })
      const renewed: ActiveJobSnapshot[] = []
      const lost: LostLease[] = []
      const cancellationRequested: string[] = []
      for (const lease of request.leases) {
        const value = await this.collections.jobs.findOneAndUpdate(
          {
            _id: id(this.client.namespace, lease.jobId),
            state: 'active',
            leaseToken: lease.leaseToken,
            leaseExpiresAtMs: { $gt: now },
            cancelRequested: false
          },
          { $set: { leaseExpiresAtMs: now + duration, updatedAtMs: now } },
          { returnDocument: 'after' }
        )
        const document = this.findOneResult(value)
        if (document !== undefined) {
          renewed.push(decodeJob(document) as ActiveJobSnapshot)
          continue
        }
        const found = await this.readJob(lease.jobId)
        if (
          found?.record.cancellationRequestedAt !== undefined &&
          found.record.leaseToken === lease.leaseToken &&
          found.record.leaseExpiresAt !== undefined &&
          found.record.leaseExpiresAt > now
        )
          cancellationRequested.push(lease.jobId)
        else
          lost.push({
            jobId: lease.jobId,
            leaseToken: lease.leaseToken,
            reason:
              found?.record.leaseToken !== lease.leaseToken
                ? 'mismatched-token'
                : found?.record.leaseExpiresAt !== undefined && found.record.leaseExpiresAt <= now
                  ? 'expired-lease'
                  : 'missing-lease'
          })
      }
      return ok({
        renewed: Object.freeze(renewed),
        lost: Object.freeze(lost),
        cancellationRequested: Object.freeze(cancellationRequested as never[])
      })
    } catch (cause) {
      return fail('heartbeat', cause)
    }
  }
  async recoverStalled(request: J.RecoverStalledRequest): Promise<Op<J.RecoverStalledResult>> {
    try {
      const now = inputNumber(request.now, 'now')
      const maximum = inputNumber(request.maxStalledCount, 'maxStalledCount')
      const limit = request.limit === undefined ? 1_000 : inputNumber(request.limit, 'limit', 1)
      const candidates = await this.collections.jobs
        .find(
          { namespace: this.client.namespace, state: 'active', leaseExpiresAtMs: { $lte: now } },
          { sort: { leaseExpiresAtMs: 1 }, limit }
        )
        .toArray()
      const transitions: JobTransition[] = []
      for (const candidate of candidates) {
        const current = decodeJob(candidate)
        const result = await this.transaction('recoverStalled', async (session) => {
          const found = await this.readJob(current.id, session)
          if (
            found === undefined ||
            found.record.state !== 'active' ||
            found.record.leaseExpiresAt === undefined ||
            found.record.leaseExpiresAt > now
          )
            return undefined
          const reduced = recoverStalledWithPolicy(
            found.record,
            { type: 'recover-stalled', jobId: found.record.id, now },
            found.record.stalledCount >= maximum
          )
          if (Result.isError(reduced)) throw reduced.error
          let next = reduced.value.record
          if (isRequeue(found.record, next)) {
            const sequence = await this.sequence(session)
            const changed = makeJobRecord({ ...next, orderingSequence: sequence })
            if (Result.isError(changed)) throw changed.error
            next = changed.value
          }
          if (!(await this.save(next, session, found.record))) return undefined
          if (reduced.value.attempt !== undefined)
            await this.collections.attempts.insertOne(
              encodeAttempt(
                this.client.namespace,
                next.id,
                next.attemptSequence ?? next.attemptsMade,
                reduced.value.attempt,
                found.record.leaseOwner
              ),
              { session }
            )
          await this.notify(next.queue, now, session)
          return { ...reduced.value, record: next }
        })
        if (Result.isError(result)) return result as Op<J.RecoverStalledResult>
        if (result.value !== undefined) transitions.push(result.value)
      }
      return ok({ transitions: Object.freeze(transitions), recovered: transitions.length })
    } catch (cause) {
      return fail('recoverStalled', cause)
    }
  }
  async retry(request: J.RetryRequest) {
    const job = makeJobId(request.jobId)
    return Result.isError(job)
      ? fail<J.RetryResult>('retry', job.error)
      : this.transition('retry', { jobId: job.value, now: request.now }, (record) =>
          reduceJob(record, { type: 'retry', ...request, jobId: job.value })
        )
  }
  async cancel(request: J.CancelRequest) {
    return this.simple('cancel', request, 'cancel')
  }
  async requestCancellation(request: J.RequestCancellationRequest) {
    return this.simple('requestCancellation', request, 'request-cancellation')
  }
  async promote(request: J.PromoteRequest) {
    return this.simple('promote', request, 'promote')
  }
  private async simple(
    operation: string,
    request: JobIdRequest,
    type: 'cancel' | 'request-cancellation' | 'promote'
  ) {
    const job = makeJobId(request.jobId)
    return Result.isError(job)
      ? fail(operation, job.error)
      : this.transition(operation, { jobId: job.value, now: request.now }, (record) =>
          reduceJob(record, { type, jobId: job.value, now: request.now } as never)
        )
  }
  async remove(request: J.RemoveRequest): Promise<Op<J.RemoveResult>> {
    try {
      const job = makeJobId(request.jobId)
      if (Result.isError(job)) throw job.error
      return this.transaction('remove', async (session) => {
        const found = await this.readJob(job.value, session)
        if (found === undefined) throw new JobNotFoundError({ jobId: job.value })
        if (
          found.record.state === 'active' ||
          (request.expectedState !== undefined && request.expectedState !== found.record.state)
        )
          throw new InvalidJobTransitionError({
            jobId: job.value,
            from: found.record.state,
            operation: 'remove'
          })
        const removed = await this.collections.jobs.deleteOne(
          {
            _id: id(this.client.namespace, job.value),
            state: found.record.state,
            updatedAtMs: found.record.updatedAt
          },
          { session }
        )
        if (removed.deletedCount !== 1)
          throw new JobStoreFailure({
            operation: 'remove',
            retryable: true,
            message: 'MongoDB conditional removal conflicted'
          })
        await this.collections.attempts.deleteMany(
          { namespace: this.client.namespace, jobId: job.value },
          { session }
        )
        return { job: found.record, removed: true }
      })
    } catch (cause) {
      return fail('remove', cause)
    }
  }
  async pause(request: J.PauseQueueRequest): Promise<Op<J.QueuePauseResult>> {
    return this.pauseState(request, true)
  }
  async resume(request: J.PauseQueueRequest): Promise<Op<J.QueuePauseResult>> {
    return this.pauseState(request, false)
  }
  private async pauseState(
    request: J.PauseQueueRequest,
    paused: boolean
  ): Promise<Op<J.QueuePauseResult>> {
    try {
      const queue = makeQueueName(request.queue)
      if (Result.isError(queue)) throw queue.error
      return this.transaction(paused ? 'pause' : 'resume', async (session) => {
        await this.collections.queues.findOneAndUpdate(
          { _id: namespaceId(this.client.namespace, queue.value) },
          {
            $setOnInsert: { namespace: this.client.namespace, queue: queue.value },
            $set: { paused, updatedAtMs: request.now },
            $inc: { wakeVersion: 1 }
          },
          { upsert: true, session }
        )
        return { queue: queue.value, paused }
      })
    } catch (cause) {
      return fail(paused ? 'pause' : 'resume', cause)
    }
  }
  async pausedQueues(): Promise<Op<readonly string[]>> {
    try {
      const rows = await this.collections.queues
        .find({ namespace: this.client.namespace, paused: true })
        .toArray()
      return ok(Object.freeze(rows.map((row) => makeQueueName(row.queue).unwrap())))
    } catch (cause) {
      return fail('pausedQueues', cause)
    }
  }
  async getJob(request: J.GetJobRequest): Promise<Op<JobRecord | undefined>> {
    try {
      const job = makeJobId(request.jobId)
      if (Result.isError(job)) throw job.error
      return ok((await this.readJob(job.value))?.record)
    } catch (cause) {
      return fail('getJob', cause)
    }
  }
  async getAttempts(request: J.GetAttemptsRequest): Promise<Op<readonly AttemptRecord[]>> {
    try {
      const job = makeJobId(request.jobId)
      if (Result.isError(job)) throw job.error
      const rows = await this.collections.attempts
        .find(
          { namespace: this.client.namespace, jobId: job.value },
          { sort: { ledgerSequence: 1 } }
        )
        .toArray()
      return ok(Object.freeze(rows.map(decodeAttempt)))
    } catch (cause) {
      return fail('getAttempts', cause)
    }
  }
  async counts(request?: J.CountsRequest): Promise<Op<J.JobCounts>> {
    try {
      const filter: Doc = { namespace: this.client.namespace }
      if (request?.queue !== undefined) filter.queue = request.queue
      if (request?.name !== undefined) filter.name = request.name
      const rows = await this.collections.jobs
        .aggregate([{ $match: filter }, { $group: { _id: '$state', value: { $sum: 1 } } }])
        .toArray()
      const output: Record<string, number> = {
        total: 0,
        waiting: 0,
        delayed: 0,
        active: 0,
        completed: 0,
        failed: 0,
        cancelled: 0
      }
      for (const row of rows) {
        const state = docText(row._id, 'count.state')
        if (!states.has(state))
          throw new MongoJobStoreLayoutError('MongoDB count has invalid state')
        const value = integer(row.value, 'count.value')
        output[state] = value
        output.total = (output.total ?? 0) + value
      }
      return ok(Object.freeze(output) as J.JobCounts)
    } catch (cause) {
      return fail('counts', cause)
    }
  }
  async list(request: J.ListJobsRequest): Promise<Op<J.ListJobsResult>> {
    try {
      const raw = request as unknown as Doc
      const allowed = new Set([
        'queue',
        'name',
        'version',
        'state',
        'metadata',
        'orderBy',
        'order',
        'limit',
        'cursor'
      ])
      for (const key of Object.keys(raw))
        if (!allowed.has(key))
          throw new UnsupportedJobStoreOperationError({ operation: `list.${key}` })
      const limit = inputNumber(raw.limit, 'limit', 1)
      const orderBy = raw.orderBy === undefined ? 'enqueuedAt' : raw.orderBy
      const order = raw.order === undefined ? 'asc' : raw.order
      if (
        (orderBy !== 'enqueuedAt' && orderBy !== 'runAt' && orderBy !== 'finishedAt') ||
        (order !== 'asc' && order !== 'desc')
      )
        throw new UnsupportedJobStoreOperationError({ operation: 'list.order' })
      const field =
        orderBy === 'enqueuedAt' ? 'createdAtMs' : orderBy === 'runAt' ? 'runAtMs' : 'finishedAtMs'
      const filter: Doc = { namespace: this.client.namespace }
      for (const key of ['queue', 'name', 'version'] as const)
        if (raw[key] !== undefined) filter[key] = raw[key]
      if (raw.state !== undefined)
        filter.state = Array.isArray(raw.state) ? { $in: raw.state } : raw.state
      if (raw.metadata !== undefined) {
        if (
          raw.metadata === null ||
          typeof raw.metadata !== 'object' ||
          Array.isArray(raw.metadata)
        )
          throw new JobDefinitionError({ field: 'metadata', message: 'must be an object' })
        filter.metadataEntries = metadataEntries(raw.metadata as Record<string, string>)
      }
      const signature = JSON.stringify([
        raw.queue ?? null,
        raw.name ?? null,
        raw.version ?? null,
        raw.state ?? '*',
        raw.metadata ?? null,
        orderBy,
        order
      ])
      if (raw.cursor !== undefined) {
        const cursor = raw.cursor as J.JobListCursor
        if (
          cursor?.version !== 1 ||
          cursor.filterSignature !== signature ||
          cursor.orderBy !== orderBy ||
          cursor.order !== order
        )
          throw new UnsupportedJobStoreOperationError({ operation: 'list.cursor-options' })
        const direction = order === 'asc' ? 1 : -1
        filter.$or = [
          { [field]: { [direction === 1 ? '$gt' : '$lt']: cursor.value } },
          {
            [field]: cursor.value,
            orderSequence: { [direction === 1 ? '$gt' : '$lt']: cursor.orderingSequence }
          },
          {
            [field]: cursor.value,
            orderSequence: cursor.orderingSequence,
            id: { [direction === 1 ? '$gt' : '$lt']: cursor.id }
          }
        ]
      }
      const direction = order === 'asc' ? 1 : -1
      const rows = await this.collections.jobs
        .find(filter, {
          sort: { [field]: direction, orderSequence: direction, id: direction },
          limit: limit + 1
        })
        .toArray()
      const page = rows.slice(0, limit).map(decodeJob)
      const last = page.at(-1)
      const nextCursor =
        rows.length > limit && last !== undefined
          ? {
              version: 1 as const,
              orderBy,
              order,
              ordering:
                orderBy === 'enqueuedAt'
                  ? ('createdAt,orderingSequence,id' as const)
                  : orderBy === 'runAt'
                    ? ('runAt,orderingSequence,id' as const)
                    : ('finishedAt,orderingSequence,id' as const),
              direction: order,
              filterSignature: signature,
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
      return ok({ jobs: Object.freeze(page), nextCursor })
    } catch (cause) {
      return fail('list', cause)
    }
  }
  private wakeTokenFor(versions: Record<string, number>): J.WakeToken {
    return `mongodb-wake-v1-${encodeURIComponent(JSON.stringify({ version: 1, queues: versions }))}` as J.WakeToken
  }
  private async wakeVersions(): Promise<Record<string, number>> {
    const rows = await this.collections.queues.find({ namespace: this.client.namespace }).toArray()
    const result: Record<string, number> = Object.create(null)
    for (const row of rows)
      result[docText(row.queue, 'queue.queue')] = integer(row.wakeVersion, 'queue.wakeVersion')
    return result
  }
  async wakeToken(): Promise<J.WakeToken> {
    return this.wakeTokenFor(await this.wakeVersions())
  }
  async awaitWake(request: J.AwaitWakeRequest): Promise<Op<void>> {
    try {
      if (request.signal.aborted) return Result.err(new JobStoreWakeAbortedError()) as Op<void>
      const prefix = 'mongodb-wake-v1-'
      if (typeof request.wakeToken !== 'string' || !request.wakeToken.startsWith(prefix))
        throw new JobStoreFailure({
          operation: 'awaitWake',
          retryable: false,
          message: 'wakeToken was not created by this MongoDB store'
        })
      const decoded = JSON.parse(decodeURIComponent(request.wakeToken.slice(prefix.length))) as {
        version?: unknown
        queues?: unknown
      }
      if (
        decoded.version !== 1 ||
        decoded.queues === null ||
        typeof decoded.queues !== 'object' ||
        Array.isArray(decoded.queues)
      )
        throw new Error('invalid wake token')
      const baseline = decoded.queues as Record<string, number>
      const changed = async (): Promise<boolean> => {
        const current = await this.wakeVersions()
        const queues = request.queues.length === 0 ? Object.keys(current) : request.queues
        return queues.some((queue: string) => (current[queue] ?? 0) > (baseline[queue] ?? 0))
      }
      if (await changed()) return ok(undefined)
      return await new Promise<Op<void>>((resolve) => {
        let settled = false
        const finish = (result: Op<void>) => {
          if (settled) return
          settled = true
          clearInterval(timer)
          request.signal.removeEventListener('abort', abort)
          this.waiters.delete(wake)
          resolve(result)
        }
        const check = () => {
          void changed().then(
            (value) => {
              if (value) finish(ok(undefined))
            },
            (cause) => finish(fail('awaitWake', cause))
          )
        }
        const wake = (cause?: unknown) => {
          if (cause !== undefined) {
            finish(fail('awaitWake', cause))
            return
          }
          check()
        }
        const abort = () => finish(Result.err(new JobStoreWakeAbortedError()) as Op<void>)
        const timer = setInterval(check, 100)
        this.waiters.add(wake)
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
  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = this.disposeResources()
    return this.disposal
  }
  private async disposeResources(): Promise<void> {
    const failures: unknown[] = []
    for (const waiter of this.waiters) waiter(new Error('store is disposed'))
    try {
      await this.stream?.close()
    } catch (cause) {
      failures.push(cause)
    }
    try {
      if (this.client.ownsClient) await this.client.dispose()
    } catch (cause) {
      failures.push(cause)
    }
    if (failures.length > 0)
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'MongoDB cleanup failed')
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
      try {
        const store = new MongoJobStoreImplementation(client)
        await store.start()
        return JobStore.of(store as never) as unknown as ServiceContract<InstanceType<T>>
      } catch (cause) {
        if (client.ownsClient) await client.dispose()
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
