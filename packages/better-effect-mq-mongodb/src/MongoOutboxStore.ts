// oxlint-disable anti-slop/no-runtime-typeof -- MongoDB documents and public requests are validated at this persistence boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- BSON filters, updates, and driver replies are opaque adapter values.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- field-based BSON documents are decoded through OutboxRecord validation.
// oxlint-disable anti-slop/no-chained-type-assertions -- validated documents restore the public outbox types.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions are limited to validated driver boundaries.
// oxlint-disable anti-slop/no-known-value-widening -- list filters are fixed MongoDB field envelopes.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional connection fields are added only when supplied.

import { randomUUID } from 'node:crypto'
import { Layer, type ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  makeOutboxId,
  makeOutboxLeaseToken,
  makeOutboxRecord,
  makeOutboxWorkerId,
  makeSerializedOutboxFailure,
  OutboxDefinitionError,
  OutboxLeaseLostError,
  OutboxNotFoundError,
  OutboxStore,
  OutboxStoreFailure,
  outboxProtocolVersion,
  type OutboxAppendError,
  type OutboxAppendResult,
  type OutboxAppendStore,
  type OutboxClaimError,
  type OutboxClaimOptions,
  type OutboxCounts,
  type OutboxFailureRequest,
  type OutboxHeartbeatRequest,
  type OutboxLeaseError,
  type OutboxLeaseRequest,
  type OutboxListOptions,
  type OutboxOperation,
  type OutboxReadError,
  type OutboxRecoveryError,
  type OutboxRecoveryOptions,
  type OutboxRecord,
  type OutboxRecordInput,
  type OutboxRetryRequest,
  type OutboxSettlementError,
  type OutboxSettlementResult,
  type OutboxState,
  type OutboxStore as OutboxStoreContract,
  type OutboxStoreError,
  type LeasedOutboxRecord,
  type SerializedOutboxFailure
} from 'better-effect-mq-outbox'

import { MongoOutbox, decodeMongoOutboxRecord, namespaceForOutboxToken } from './MongoOutbox'
import {
  normalizeMongoJobStoreConfig,
  normalizeMongoJobStoreConnectionConfig,
  type MongoJobStoreConfig,
  type MongoJobStoreConnectionConfig,
  type MongoSession
} from './config'
import { mongoCollections, namespaceId, type MongoCollections } from './collections'
import { MongoJobStoreClient } from './client'
import { MongoJobStoreTopologyError } from './errors'
import { MongoJobStoreMigrator } from './migrator'

type Doc = Record<string, unknown>
interface OutboxListFilter {
  readonly namespace: string
  state?: { readonly $in: readonly OutboxState[] }
  target?: string
}
type StoreResult<Value> = OutboxEffect<Value>
type OutboxEffect<Value> = import('better-effect-mq-outbox').OutboxEffect<Value>
type OperationResult<Value, Error extends OutboxStoreError> = OutboxOperation<Value, Error>

const succeeded = <Value>(value: Value): StoreResult<Value> =>
  Result.ok(value) as unknown as StoreResult<Value>
const failed = <Value, Error extends OutboxStoreError>(
  error: Error
): OperationResult<Value, Error> => Result.err(error) as unknown as OperationResult<Value, Error>

const taggedErrors = new Set([
  'OutboxDefinitionError',
  'OutboxConflictError',
  'OutboxStoreFailure',
  'OutboxNotFoundError',
  'OutboxLeaseLostError',
  'OutboxProtocolMismatchError'
])

const isOutboxError = (value: unknown): value is OutboxStoreError =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { readonly _tag?: unknown })._tag === 'string' &&
  taggedErrors.has((value as { readonly _tag: string })._tag)

const retryable = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false
  const error = cause as { readonly code?: unknown; readonly errorLabels?: unknown }
  return (
    error.code === 91 ||
    error.code === 10107 ||
    (Array.isArray(error.errorLabels) &&
      error.errorLabels.some(
        (label) =>
          label === 'TransientTransactionError' || label === 'UnknownTransactionCommitResult'
      ))
  )
}

const mongoFailure = (operation: string, cause: unknown): OutboxStoreFailure =>
  new OutboxStoreFailure({
    operation,
    retryable: retryable(cause),
    message: `MongoDB ${operation} failed`
  })

const invalid = <Value>(field: string, message: string): ResultType<Value, OutboxDefinitionError> =>
  Result.err(new OutboxDefinitionError({ field, message }))

const positive = (value: unknown, field: string): ResultType<number, OutboxDefinitionError> =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Result.ok(value)
    : invalid(field, 'must be a positive safe integer')

const timestamp = (value: unknown, field: string): ResultType<number, OutboxDefinitionError> =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Result.ok(value)
    : invalid(field, 'must be a non-negative safe integer')

const validateClaim = (
  value: OutboxClaimOptions
): ResultType<OutboxClaimOptions, OutboxDefinitionError> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return invalid('options', 'must be an object')
  const owner = makeOutboxWorkerId(value.owner)
  const limit = positive(value.limit, 'limit')
  const leaseDurationMs = positive(value.leaseDurationMs, 'leaseDurationMs')
  const nowMs = timestamp(value.nowMs, 'nowMs')
  if (Result.isError(owner)) return owner
  if (Result.isError(limit)) return limit
  if (Result.isError(leaseDurationMs)) return leaseDurationMs
  if (Result.isError(nowMs)) return nowMs
  if (nowMs.value > Number.MAX_SAFE_INTEGER - leaseDurationMs.value)
    return invalid('leaseDurationMs', 'lease expiry exceeds safe integer range')
  return Result.ok({
    owner: owner.value,
    limit: limit.value,
    leaseDurationMs: leaseDurationMs.value,
    nowMs: nowMs.value
  })
}

const validateLease = (
  value: OutboxLeaseRequest | OutboxHeartbeatRequest
): ResultType<
  OutboxLeaseRequest & Partial<Pick<OutboxHeartbeatRequest, 'leaseDurationMs'>>,
  OutboxDefinitionError
> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return invalid('request', 'must be an object')
  const id = makeOutboxId(value.id)
  const leaseToken = makeOutboxLeaseToken(value.leaseToken)
  const nowMs = timestamp(value.nowMs, 'nowMs')
  if (Result.isError(id)) return id
  if (Result.isError(leaseToken)) return leaseToken
  if (Result.isError(nowMs)) return nowMs
  if ('leaseDurationMs' in value) {
    const duration = positive(value.leaseDurationMs, 'leaseDurationMs')
    if (Result.isError(duration)) return duration
    if (nowMs.value > Number.MAX_SAFE_INTEGER - duration.value)
      return invalid('leaseDurationMs', 'lease expiry exceeds safe integer range')
    return Result.ok({
      id: id.value,
      leaseToken: leaseToken.value,
      nowMs: nowMs.value,
      leaseDurationMs: duration.value
    })
  }
  return Result.ok({ id: id.value, leaseToken: leaseToken.value, nowMs: nowMs.value })
}

const validateFailure = (
  value: SerializedOutboxFailure
): ResultType<SerializedOutboxFailure, OutboxDefinitionError> => {
  try {
    return makeSerializedOutboxFailure(value)
  } catch {
    return invalid('failure', 'is invalid')
  }
}

const validateStates = (
  value: OutboxListOptions['state']
): ResultType<readonly OutboxState[] | undefined, OutboxDefinitionError> => {
  if (value === undefined) return Result.ok(undefined)
  const states = typeof value === 'string' ? [value] : value
  if (!Array.isArray(states) || states.length === 0) return invalid('state', 'must not be empty')
  if (
    states.some(
      (state) =>
        state !== 'pending' && state !== 'active' && state !== 'published' && state !== 'failed'
    )
  )
    return invalid('state', 'contains an unsupported state')
  return Result.ok(Object.freeze([...new Set(states)] as OutboxState[]))
}

const findOneResult = (value: unknown): Doc | undefined => {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object') return undefined
  if ('value' in value) {
    const document = (value as { readonly value?: unknown }).value
    return document === null || typeof document !== 'object' ? undefined : (document as Doc)
  }
  return value as Doc
}

const expiredFailure = (nowMs: number): SerializedOutboxFailure =>
  makeSerializedOutboxFailure({
    kind: 'store-permanent',
    message: 'Outbox lease expired after the attempt limit was reached',
    retryable: false,
    recordedAtMs: nowMs
  }).unwrap()

const asLeased = (record: OutboxRecord): LeasedOutboxRecord => {
  if (
    record.state !== 'active' ||
    record.leaseOwner === undefined ||
    record.leaseToken === undefined ||
    record.leaseExpiresAtMs === undefined
  )
    throw new OutboxStoreFailure({
      operation: 'claim',
      retryable: false,
      message: 'MongoDB returned an active outbox record without a lease'
    })
  return record as LeasedOutboxRecord
}

class MongoOutboxStoreImplementation implements OutboxStoreContract, OutboxAppendStore {
  readonly descriptor = Object.freeze({
    protocolVersion: outboxProtocolVersion,
    adapter: 'mongodb',
    adapterVersion: '0.1.0'
  })
  private readonly collections: MongoCollections
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly client: MongoJobStoreClient) {
    this.collections = mongoCollections(client.db, client.collectionPrefix)
  }

  async start(): Promise<void> {
    const hello = await this.client.db.admin().command({ hello: 1 })
    if (
      typeof hello.logicalSessionTimeoutMinutes !== 'number' ||
      (typeof hello.setName !== 'string' && hello.msg !== 'isdbgrid')
    )
      throw new MongoJobStoreTopologyError(
        'standalone',
        'MongoDB OutboxStore requires a replica set or a transaction-capable mongos deployment'
      )
    if (this.client.validateLayout)
      await MongoJobStoreMigrator.validate(this.client.db, this.client.collectionPrefix)
  }

  private async withTransaction<Value>(
    operation: string,
    body: (session: MongoSession) => Promise<Value>
  ): Promise<OutboxOperation<Value>> {
    if (this.closed) return failed(mongoFailure(operation, new Error('store is closed'))) as never
    const session = this.client.client.startSession()
    let value: Value | undefined
    try {
      await session.withTransaction(
        async () => {
          value = await body(session)
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
      )
      return succeeded(value as Value)
    } catch (cause) {
      return failed(isOutboxError(cause) ? cause : mongoFailure(operation, cause)) as never
    } finally {
      try {
        await session.endSession()
      } catch {
        /* preserve the operation result when session cleanup fails */
      }
    }
  }

  private async read(id: string, session: MongoSession): Promise<OutboxRecord | undefined> {
    const document = await this.collections.outbox.findOne(
      { _id: namespaceId(this.client.namespace, id) },
      { session }
    )
    return document === null ? undefined : decodeMongoOutboxRecord(document)
  }

  private ensureLease(
    record: OutboxRecord | undefined,
    id: string,
    leaseToken: string,
    nowMs: number
  ): LeasedOutboxRecord {
    if (record === undefined) throw new OutboxNotFoundError({ id })
    if (record.state !== 'active')
      throw new OutboxLeaseLostError({ id, leaseToken, reason: 'not-active' })
    if (record.leaseToken === undefined)
      throw new OutboxLeaseLostError({ id, leaseToken, reason: 'missing-token' })
    if (record.leaseToken !== leaseToken)
      throw new OutboxLeaseLostError({ id, leaseToken, reason: 'mismatched-token' })
    if (record.leaseExpiresAtMs === undefined || record.leaseExpiresAtMs <= nowMs)
      throw new OutboxLeaseLostError({ id, leaseToken, reason: 'expired-lease' })
    return record as LeasedOutboxRecord
  }

  private async recoverExpired(
    session: MongoSession,
    nowMs: number,
    limit: number
  ): Promise<OutboxRecord[]> {
    const recovered: OutboxRecord[] = []
    for (let count = 0; count < limit; count += 1) {
      const current = await this.collections.outbox.findOneAndUpdate(
        {
          namespace: this.client.namespace,
          state: 'active',
          leaseExpiresAtMs: { $lte: nowMs }
        },
        {
          $set: {
            state: 'pending',
            updatedAtMs: nowMs
          },
          $max: { runAtMs: nowMs },
          $unset: { leaseOwner: '', leaseToken: '', leaseExpiresAtMs: '' }
        },
        {
          sort: { leaseExpiresAtMs: 1, id: 1 },
          returnDocument: 'after',
          session
        }
      )
      const document = findOneResult(current)
      if (document === undefined) break
      const before = decodeMongoOutboxRecord(document)
      if (before.attemptsMade >= before.attemptsMax) {
        const terminal = await this.collections.outbox.findOneAndUpdate(
          { _id: document._id, state: 'pending' },
          { $set: { state: 'failed', failure: expiredFailure(nowMs) } },
          { returnDocument: 'after', session }
        )
        const terminalDocument = findOneResult(terminal)
        if (terminalDocument === undefined) throw new Error('recovered outbox record disappeared')
        recovered.push(decodeMongoOutboxRecord(terminalDocument))
      } else {
        recovered.push(before)
      }
    }
    return recovered
  }

  append(input: OutboxRecordInput): OutboxOperation<OutboxAppendResult, OutboxAppendError> {
    try {
      const created = makeOutboxRecord(input)
      if (Result.isError(created)) return failed(created.error) as never
      return this.withTransaction('append', async (session) => {
        const result = await MongoOutbox.appendIn(session, created.value, {
          db: this.client.db,
          namespace: this.client.namespace,
          collectionPrefix: this.client.collectionPrefix
        })
        if (Result.isError(result)) throw result.error
        return result.value
      }) as never
    } catch (cause) {
      return failed(isOutboxError(cause) ? cause : mongoFailure('append', cause)) as never
    }
  }

  claim(
    options: OutboxClaimOptions
  ): OutboxOperation<readonly LeasedOutboxRecord[], OutboxClaimError> {
    const checked = validateClaim(options)
    if (Result.isError(checked)) return failed(checked.error) as never
    return this.withTransaction('claim', async (session) => {
      await this.recoverExpired(session, checked.value.nowMs, checked.value.limit)
      const leased: LeasedOutboxRecord[] = []
      for (let count = 0; count < checked.value.limit; count += 1) {
        const token = makeOutboxLeaseToken(`mongodb-lease-${randomUUID()}`)
        if (Result.isError(token)) throw token.error
        const result = await this.collections.outbox.findOneAndUpdate(
          {
            namespace: this.client.namespace,
            state: 'pending',
            runAtMs: { $lte: checked.value.nowMs },
            $expr: { $lt: ['$attemptsMade', '$attemptsMax'] }
          },
          {
            $set: {
              state: 'active',
              leaseOwner: checked.value.owner,
              leaseToken: token.value,
              leaseExpiresAtMs: checked.value.nowMs + checked.value.leaseDurationMs,
              updatedAtMs: checked.value.nowMs
            },
            $inc: { attemptsMade: 1 }
          },
          {
            sort: { runAtMs: 1, createdAtMs: 1, id: 1 },
            returnDocument: 'after',
            session
          }
        )
        const document = findOneResult(result)
        if (document === undefined) break
        leased.push(asLeased(decodeMongoOutboxRecord(document)))
      }
      return Object.freeze(leased)
    }) as never
  }

  heartbeat(
    request: OutboxHeartbeatRequest
  ): OutboxOperation<LeasedOutboxRecord, OutboxLeaseError> {
    const checked = validateLease(request)
    if (Result.isError(checked) || checked.value.leaseDurationMs === undefined)
      return failed(
        Result.isError(checked)
          ? checked.error
          : new OutboxDefinitionError({ field: 'leaseDurationMs', message: 'is required' })
      ) as never
    const leaseDurationMs = checked.value.leaseDurationMs
    return this.withTransaction('heartbeat', async (session) => {
      const current = await this.read(String(checked.value.id), session)
      const active = this.ensureLease(
        current,
        String(checked.value.id),
        checked.value.leaseToken,
        checked.value.nowMs
      )
      const result = await this.collections.outbox.findOneAndUpdate(
        {
          _id: namespaceId(this.client.namespace, active.id),
          state: 'active',
          leaseToken: checked.value.leaseToken,
          leaseExpiresAtMs: { $gt: checked.value.nowMs }
        },
        {
          $set: {
            leaseExpiresAtMs: checked.value.nowMs + leaseDurationMs,
            updatedAtMs: checked.value.nowMs
          }
        },
        { returnDocument: 'after', session }
      )
      const document = findOneResult(result)
      if (document === undefined)
        throw new OutboxLeaseLostError({
          id: active.id,
          leaseToken: checked.value.leaseToken,
          reason: 'expired-lease'
        })
      return asLeased(decodeMongoOutboxRecord(document))
    }) as never
  }

  markPublished(
    request: OutboxLeaseRequest
  ): OutboxOperation<OutboxSettlementResult, OutboxSettlementError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return failed(checked.error) as never
    return this.withTransaction('markPublished', async (session) => {
      const current = await this.read(String(checked.value.id), session)
      if (current?.state === 'published')
        return { record: current, status: 'already-applied' as const }
      const active = this.ensureLease(
        current,
        String(checked.value.id),
        checked.value.leaseToken,
        checked.value.nowMs
      )
      const result = await this.collections.outbox.findOneAndUpdate(
        {
          _id: namespaceId(this.client.namespace, active.id),
          state: 'active',
          leaseToken: checked.value.leaseToken,
          leaseExpiresAtMs: { $gt: checked.value.nowMs }
        },
        {
          $set: {
            state: 'published',
            publishedAtMs: checked.value.nowMs,
            updatedAtMs: checked.value.nowMs
          },
          $unset: { leaseOwner: '', leaseToken: '', leaseExpiresAtMs: '' }
        },
        { returnDocument: 'after', session }
      )
      const document = findOneResult(result)
      if (document === undefined)
        throw new OutboxLeaseLostError({
          id: active.id,
          leaseToken: checked.value.leaseToken,
          reason: 'expired-lease'
        })
      return { record: decodeMongoOutboxRecord(document), status: 'applied' as const }
    }) as never
  }

  markRetry(request: OutboxRetryRequest): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return failed(checked.error) as never
    const runAtMs = timestamp(request.runAtMs, 'runAtMs')
    const failure = validateFailure(request.failure)
    if (Result.isError(runAtMs)) return failed(runAtMs.error) as never
    if (Result.isError(failure)) return failed(failure.error) as never
    return this.requeue(
      'markRetry',
      checked.value,
      'pending',
      runAtMs.value,
      failure.value
    ) as never
  }

  markFailed(request: OutboxFailureRequest): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return failed(checked.error) as never
    const failure = validateFailure(request.failure)
    if (Result.isError(failure)) return failed(failure.error) as never
    return this.requeue('markFailed', checked.value, 'failed', undefined, failure.value) as never
  }

  private requeue(
    operation: string,
    request: OutboxLeaseRequest,
    state: 'pending' | 'failed',
    runAtMs: number | undefined,
    failure: SerializedOutboxFailure
  ): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    return this.withTransaction(operation, async (session) => {
      const current = await this.read(String(request.id), session)
      const active = this.ensureLease(
        current,
        String(request.id),
        request.leaseToken,
        request.nowMs
      )
      const result = await this.collections.outbox.findOneAndUpdate(
        {
          _id: namespaceId(this.client.namespace, active.id),
          state: 'active',
          leaseToken: request.leaseToken,
          leaseExpiresAtMs: { $gt: request.nowMs }
        },
        {
          $set: {
            state,
            runAtMs: runAtMs ?? active.runAtMs,
            updatedAtMs: request.nowMs,
            failure
          },
          $unset: { leaseOwner: '', leaseToken: '', leaseExpiresAtMs: '' }
        },
        { returnDocument: 'after', session }
      )
      const document = findOneResult(result)
      if (document === undefined)
        throw new OutboxLeaseLostError({
          id: active.id,
          leaseToken: request.leaseToken,
          reason: 'expired-lease'
        })
      return decodeMongoOutboxRecord(document)
    }) as never
  }

  release(request: OutboxLeaseRequest): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    const checked = validateLease(request)
    if (Result.isError(checked)) return failed(checked.error) as never
    return this.withTransaction('release', async (session) => {
      const current = await this.read(String(checked.value.id), session)
      const active = this.ensureLease(
        current,
        String(checked.value.id),
        checked.value.leaseToken,
        checked.value.nowMs
      )
      const result = await this.collections.outbox.findOneAndUpdate(
        {
          _id: namespaceId(this.client.namespace, active.id),
          state: 'active',
          leaseToken: checked.value.leaseToken,
          leaseExpiresAtMs: { $gt: checked.value.nowMs }
        },
        {
          $set: { state: 'pending', updatedAtMs: checked.value.nowMs },
          $unset: { leaseOwner: '', leaseToken: '', leaseExpiresAtMs: '' }
        },
        { returnDocument: 'after', session }
      )
      const document = findOneResult(result)
      if (document === undefined)
        throw new OutboxLeaseLostError({
          id: active.id,
          leaseToken: checked.value.leaseToken,
          reason: 'expired-lease'
        })
      return decodeMongoOutboxRecord(document)
    }) as never
  }

  recoverStalled(
    options: OutboxRecoveryOptions
  ): OutboxOperation<readonly OutboxRecord[], OutboxRecoveryError> {
    const maxCount = positive(options.maxCount, 'maxCount')
    const nowMs = timestamp(options.nowMs, 'nowMs')
    if (Result.isError(maxCount)) return failed(maxCount.error) as never
    if (Result.isError(nowMs)) return failed(nowMs.error) as never
    return this.withTransaction('recoverStalled', (session) =>
      this.recoverExpired(session, nowMs.value, maxCount.value)
    ) as never
  }

  get(
    id: import('better-effect-mq-outbox').OutboxId
  ): OutboxOperation<OutboxRecord | undefined, OutboxReadError> {
    const checked = makeOutboxId(id)
    if (Result.isError(checked)) return failed(checked.error) as never
    return this.withTransaction('get', (session) =>
      this.read(String(checked.value), session)
    ) as never
  }

  list(options: OutboxListOptions = {}): OutboxOperation<readonly OutboxRecord[], OutboxReadError> {
    const states = validateStates(options.state)
    const limit = options.limit === undefined ? Result.ok(100) : positive(options.limit, 'limit')
    if (Result.isError(states)) return failed(states.error) as never
    if (Result.isError(limit)) return failed(limit.error) as never
    if (
      options.target !== undefined &&
      (typeof options.target !== 'string' ||
        options.target.length === 0 ||
        options.target.includes('\u0000'))
    )
      return failed(
        new OutboxDefinitionError({
          field: 'target',
          message: 'must be a non-empty string without NUL'
        })
      ) as never
    return this.withTransaction('list', async (session) => {
      const filter: OutboxListFilter = { namespace: this.client.namespace }
      if (states.value !== undefined) filter.state = { $in: states.value }
      if (options.target !== undefined) filter.target = options.target
      const documents = await this.collections.outbox
        .find(filter, { sort: { createdAtMs: 1, id: 1 }, limit: limit.value, session })
        .toArray()
      return Object.freeze(documents.map(decodeMongoOutboxRecord))
    }) as never
  }

  counts(): OutboxOperation<OutboxCounts, OutboxReadError> {
    return this.withTransaction('counts', async (session) => {
      const rows = await this.collections.outbox
        .aggregate(
          [
            { $match: { namespace: this.client.namespace } },
            { $group: { _id: '$state', count: { $sum: 1 } } }
          ],
          { session }
        )
        .toArray()
      const counts = { pending: 0, active: 0, published: 0, failed: 0, total: 0 }
      for (const row of rows) {
        const state = row._id
        const count = row.count
        if (
          state !== 'pending' &&
          state !== 'active' &&
          state !== 'published' &&
          state !== 'failed'
        )
          throw new OutboxStoreFailure({
            operation: 'counts',
            retryable: false,
            message: 'MongoDB returned an unsupported outbox state'
          })
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
          throw new OutboxStoreFailure({
            operation: 'counts',
            retryable: false,
            message: 'MongoDB returned an invalid outbox count'
          })
        counts[state] += count
        counts.total += count
      }
      return Object.freeze(counts)
    }) as never
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = this.client.ownsClient ? this.client.dispose() : Promise.resolve()
    return this.disposal
  }
}

export type MongoOutboxStoreConfig = MongoJobStoreConfig
export type MongoOutboxStoreConnectionConfig = MongoJobStoreConnectionConfig
export type MongoOutboxStoreContract = OutboxStoreContract &
  OutboxAppendStore & {
    readonly dispose: () => Promise<void>
  }

const namespaceFor = (
  token: import('better-effect-mq-outbox').AnyOutboxStoreToken,
  namespace: string
) => namespaceForOutboxToken(token, namespace)

const layer = <Token extends import('better-effect-mq-outbox').AnyOutboxStoreToken>(
  token: Token,
  acquire: () => Promise<MongoJobStoreClient>
): Layer<InstanceType<Token>, never> =>
  Layer.scoped(
    token,
    async () => {
      const client = await acquire()
      let store: MongoOutboxStoreImplementation | undefined
      try {
        store = new MongoOutboxStoreImplementation(client)
        await store.start()
        return token.of(store as never) as unknown as ServiceContract<InstanceType<Token>>
      } catch (cause) {
        try {
          if (store !== undefined) await store.dispose()
          else if (client.ownsClient) await client.dispose()
        } catch {
          /* preserve acquisition failure */
        }
        throw cause
      }
    },
    async (store) => {
      await (store as unknown as MongoOutboxStoreImplementation).dispose()
    }
  )

const borrowedClient = (
  token: import('better-effect-mq-outbox').AnyOutboxStoreToken,
  config: MongoOutboxStoreConfig
) => {
  const normalized = normalizeMongoJobStoreConfig(config)
  const { eventWriter: _eventWriter, ...base } = normalized
  return () =>
    Promise.resolve(
      MongoJobStoreClient.fromDb({
        ...base,
        ...(normalized.eventWriter === undefined ? {} : { eventWriter: normalized.eventWriter }),
        namespace: namespaceFor(token, normalized.namespace)
      })
    )
}

const ownedClient = (
  token: import('better-effect-mq-outbox').AnyOutboxStoreToken,
  config: MongoOutboxStoreConnectionConfig
) => {
  const normalized = normalizeMongoJobStoreConnectionConfig(config)
  const baseConnection = {
    uri: normalized.uri,
    database: normalized.database,
    namespace: namespaceFor(token, normalized.namespace),
    collectionPrefix: normalized.collectionPrefix,
    validateLayout: normalized.validateLayout as boolean,
    notifications: normalized.notifications as 'auto' | 'poll'
  }
  const connection: MongoJobStoreConnectionConfig =
    normalized.clientOptions === undefined
      ? baseConnection
      : { ...baseConnection, clientOptions: normalized.clientOptions }
  return () => MongoJobStoreClient.fromConfig(connection)
}

export const MongoOutboxStore = Object.freeze({
  layer(config: MongoOutboxStoreConfig) {
    return layer(OutboxStore, borrowedClient(OutboxStore, config))
  },
  layerFor<Token extends import('better-effect-mq-outbox').AnyOutboxStoreToken>(
    token: Token,
    config: MongoOutboxStoreConfig
  ) {
    return layer(token, borrowedClient(token, config))
  },
  layerFromConfig(config: MongoOutboxStoreConnectionConfig) {
    return layer(OutboxStore, ownedClient(OutboxStore, config))
  },
  layerFromConfigFor<Token extends import('better-effect-mq-outbox').AnyOutboxStoreToken>(
    token: Token,
    config: MongoOutboxStoreConnectionConfig
  ) {
    return layer(token, ownedClient(token, config))
  }
})
