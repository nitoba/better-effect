// oxlint-disable anti-slop/no-runtime-typeof -- Redis and persisted outbox values are untyped boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- Redis replies are validated before use.
// oxlint-disable anti-slop/no-unknown-returns -- callback and Redis replies are narrowed at this boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- Redis hash fields are deliberately structural.
// oxlint-disable anti-slop/no-chained-type-assertions -- assertions stay at validated adapter boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts follow explicit validation.

import { createHash, randomUUID } from 'node:crypto'

import { Layer, type ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  OutboxConflictError,
  OutboxDefinitionError,
  OutboxLeaseLostError,
  OutboxNotFoundError,
  OutboxStoreFailure,
  OutboxStore,
  isOutboxStoreToken,
  makeOutboxId,
  makeOutboxLeaseToken,
  makeOutboxRecord,
  makeOutboxWorkerId,
  makeSerializedOutboxFailure,
  outboxProtocolVersion,
  validateOutboxRecord,
  type AnyOutboxStoreToken,
  type LeasedOutboxRecord,
  type OutboxAppendError,
  type OutboxAppendResult,
  type OutboxAppendStore,
  type OutboxClaimError,
  type OutboxClaimOptions,
  type OutboxCounts,
  type OutboxEffect,
  type OutboxFailureRequest,
  type OutboxHeartbeatRequest,
  type OutboxLeaseRequest,
  type OutboxLeaseError,
  type OutboxListOptions,
  type OutboxOperation,
  type OutboxReadError,
  type OutboxRecoveryError,
  type OutboxRecoveryOptions,
  type OutboxRecord,
  type OutboxRecordInput,
  type OutboxRetryRequest,
  type OutboxSettlementResult,
  type OutboxSettlementError,
  type OutboxState,
  type OutboxStore as OutboxStoreContract,
  type OutboxStoreError,
  type OutboxStoreDescriptor,
  type SerializedOutboxFailure
} from 'better-effect-mq-outbox'

import {
  DEFAULT_NAMESPACE,
  DEFAULT_PREFIX,
  sendRedisCommand,
  type RedisCommandClient,
  type RedisJobStoreConfig,
  type RedisJobStoreConnectionConfig,
  type RedisTransaction
} from './config'
import { RedisClient } from './client'
import { hashReply, numberReply, stringsReply } from './internal/replies'
import {
  encodeKeySegment,
  makeRedisKeyLayout,
  validateNamespace,
  type RedisKeyLayout
} from './keys'

/** Commands a transaction callback may queue; MULTI/EXEC lifecycle stays adapter-owned. */
export interface RedisOutboxTransaction {
  sendCommand(args: readonly string[]): RedisOutboxTransaction
}

export type RedisOutboxClient = RedisClient | RedisCommandClient

export type RedisOutboxAppendOptions = Readonly<{
  namespace?: string
  prefix?: string
  token?: AnyOutboxStoreToken
}>

export type RedisOutboxTransactionCallback<Value, Failure = never> = (
  transaction: RedisOutboxTransaction
) => Value | ResultType<Value, Failure> | PromiseLike<Value | ResultType<Value, Failure>>

type RedisOutboxError = OutboxStoreError
type StoreResult<Value> = OutboxEffect<Value, RedisOutboxError>
type StoredRecord = Readonly<{
  record: OutboxRecord
  orderingSequence: number
}>
type AppendStatus = 'inserted' | 'duplicate'
interface RedisOutboxNamespace {
  readonly namespace: string
  readonly prefix: string
}
interface RedisOutboxAppendReply {
  readonly status: AppendStatus | 'conflict'
  readonly digest: string | undefined
}

const descriptor: OutboxStoreDescriptor = Object.freeze({
  protocolVersion: outboxProtocolVersion,
  adapter: 'redis',
  adapterVersion: '0.1.0'
})

const failed = <Value = never>(error: RedisOutboxError): StoreResult<Value> =>
  Result.err(error) as unknown as StoreResult<Value>

const appendScript = `
local existing = redis.call('EXISTS', KEYS[1])
if existing == 1 then
  local digest = redis.call('HGET', KEYS[1], 'requestDigest')
  if digest ~= ARGV[2] then
    return {'conflict', digest or ''}
  end
  return {'duplicate', digest}
end

local sequence = redis.call('INCR', KEYS[4])
redis.call(
  'HSET', KEYS[1],
  'id', ARGV[1],
  'protocolVersion', ARGV[17],
  'target', ARGV[3],
  'state', ARGV[4],
  'request', ARGV[5],
  'requestDigest', ARGV[2],
  'attemptsMax', ARGV[6],
  'attemptsMade', ARGV[7],
  'runAtMs', ARGV[8],
  'createdAtMs', ARGV[9],
  'updatedAtMs', ARGV[10],
  'publishedAtMs', ARGV[11],
  'leaseOwner', ARGV[12],
  'leaseToken', ARGV[13],
  'leaseExpiresAtMs', ARGV[14],
  'failure', ARGV[15],
  'orderingSequence', sequence
)
redis.call('ZADD', KEYS[2], ARGV[9], ARGV[16])
redis.call('ZADD', KEYS[3], ARGV[8], ARGV[16])
return {'inserted', sequence}
`

const claimScript = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local claimed = {}
for _, member in ipairs(ids) do
  local recordKey = ARGV[3] .. member
  if redis.call('HGET', recordKey, 'state') == 'pending' then
    local attempts = tonumber(redis.call('HGET', recordKey, 'attemptsMade') or '0')
    local maximum = tonumber(redis.call('HGET', recordKey, 'attemptsMax') or '0')
    if attempts < maximum then
      redis.call(
        'HSET', recordKey,
        'state', 'active',
        'attemptsMade', attempts + 1,
        'updatedAtMs', ARGV[4],
        'leaseOwner', ARGV[5],
        'leaseToken', ARGV[6],
        'leaseExpiresAtMs', ARGV[7],
        'failure', ''
      )
      redis.call('ZREM', KEYS[1], member)
      redis.call('ZADD', KEYS[2], ARGV[7], member)
      table.insert(claimed, member)
    end
  end
end
return claimed
`

const recoverScript = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local recovered = {}
for _, member in ipairs(ids) do
  local recordKey = ARGV[3] .. member
  if redis.call('HGET', recordKey, 'state') == 'active' then
    local attempts = tonumber(redis.call('HGET', recordKey, 'attemptsMade') or '0')
    local maximum = tonumber(redis.call('HGET', recordKey, 'attemptsMax') or '0')
    redis.call('ZREM', KEYS[1], member)
    if attempts >= maximum then
      redis.call('HSET', recordKey, 'state', 'failed', 'updatedAtMs', ARGV[4], 'failure', ARGV[5], 'leaseOwner', '', 'leaseToken', '', 'leaseExpiresAtMs', '')
      redis.call('ZADD', KEYS[3], ARGV[6], member)
    else
      redis.call('HSET', recordKey, 'state', 'pending', 'updatedAtMs', ARGV[4], 'failure', '', 'leaseOwner', '', 'leaseToken', '', 'leaseExpiresAtMs', '')
      redis.call('ZADD', KEYS[2], ARGV[7], member)
    end
    table.insert(recovered, member)
  end
end
return recovered
`

const heartbeatScript = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if redis.call('HGET', KEYS[1], 'state') ~= 'active' then return {'not-active'} end
if redis.call('HGET', KEYS[1], 'leaseToken') ~= ARGV[1] then return {'mismatched-token'} end
local expires = tonumber(redis.call('HGET', KEYS[1], 'leaseExpiresAtMs') or '0')
if expires <= tonumber(ARGV[2]) then return {'expired-lease'} end
redis.call('HSET', KEYS[1], 'leaseExpiresAtMs', ARGV[3], 'updatedAtMs', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
return {'ok'}
`

const settlementScript = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if redis.call('HGET', KEYS[1], 'state') == 'published' and ARGV[1] == 'published' then return {'already-applied'} end
if redis.call('HGET', KEYS[1], 'state') ~= 'active' then return {'not-active'} end
if redis.call('HGET', KEYS[1], 'leaseToken') ~= ARGV[2] then return {'mismatched-token'} end
local expires = tonumber(redis.call('HGET', KEYS[1], 'leaseExpiresAtMs') or '0')
if expires <= tonumber(ARGV[3]) then return {'expired-lease'} end
redis.call('ZREM', KEYS[2], ARGV[4])
if ARGV[1] == 'published' then
  redis.call('HSET', KEYS[1], 'state', 'published', 'publishedAtMs', ARGV[3], 'updatedAtMs', ARGV[3], 'leaseOwner', '', 'leaseToken', '', 'leaseExpiresAtMs', '')
  redis.call('ZADD', KEYS[3], ARGV[3], ARGV[4])
elseif ARGV[1] == 'failed' then
  redis.call('HSET', KEYS[1], 'state', 'failed', 'updatedAtMs', ARGV[3], 'failure', ARGV[5], 'leaseOwner', '', 'leaseToken', '', 'leaseExpiresAtMs', '')
  redis.call('ZADD', KEYS[4], ARGV[6], ARGV[4])
else
  redis.call('HSET', KEYS[1], 'state', 'pending', 'runAtMs', ARGV[6], 'updatedAtMs', ARGV[3], 'failure', ARGV[5], 'leaseOwner', '', 'leaseToken', '', 'leaseExpiresAtMs', '')
  redis.call('ZADD', KEYS[5], ARGV[6], ARGV[4])
end
return {'ok'}
`

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isResult = (value: unknown): value is ResultType<unknown, unknown> =>
  isObject(value) && (value.status === 'ok' || value.status === 'error')

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (isObject(cause) && typeof cause.message === 'string') return cause.message
  return 'unknown Redis failure'
}

const retryable = (cause: unknown): boolean => {
  const message = messageOf(cause).toUpperCase()
  return [
    'TRYAGAIN',
    'CLUSTERDOWN',
    'READONLY',
    'MOVED',
    'ASK',
    'LOADING',
    'TIMEOUT',
    'CONNECTION',
    'SOCKET',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT'
  ].some((value) => message.includes(value))
}

const storeFailure = (
  operation: string,
  cause: unknown,
  canRetry = retryable(cause)
): OutboxStoreFailure =>
  new OutboxStoreFailure({
    operation,
    retryable: canRetry,
    cause,
    message: `Redis ${operation} failed: ${messageOf(cause)}`
  })

const normalizedNamespace = (
  options: RedisOutboxAppendOptions | undefined
): RedisOutboxNamespace => {
  const namespace = options?.namespace ?? DEFAULT_NAMESPACE
  const prefix = options?.prefix ?? DEFAULT_PREFIX
  const baseLayout = makeRedisKeyLayout(prefix, namespace)
  if (options?.token === undefined)
    return { namespace: baseLayout.namespace, prefix: baseLayout.prefix }
  if (!isOutboxStoreToken(options.token)) {
    throw new OutboxDefinitionError({ field: 'token', message: 'must be an OutboxStore token' })
  }
  const tokenNamespace =
    options.token.serviceTag === OutboxStore.serviceTag
      ? baseLayout.namespace
      : `${baseLayout.namespace}:outbox-${createHash('sha256').update(options.token.serviceTag).digest('hex').slice(0, 32)}`
  return { namespace: tokenNamespace, prefix: baseLayout.prefix }
}

const clientOf = (client: RedisOutboxClient): RedisCommandClient =>
  client instanceof RedisClient ? client.client : client

const layoutOf = (
  client: RedisOutboxClient,
  options: RedisOutboxAppendOptions | undefined
): RedisKeyLayout => {
  if (client instanceof RedisClient) return client.layout
  const normalized = normalizedNamespace(options)
  return makeRedisKeyLayout(normalized.prefix, normalized.namespace)
}

const memberOf = (id: string): string => encodeKeySegment(id)

const recordPrefixOf = (layout: RedisKeyLayout): string => `${layout.base}:outbox-record:`

const recordKeyOf = (layout: RedisKeyLayout, id: string): string => layout.outboxRecord(id)

const json = (value: unknown): string => JSON.stringify(value)
const optionalText = (value: string | undefined): string => value ?? ''
const optionalNumber = (value: number | undefined): string =>
  value === undefined ? '' : String(value)

const appendArgsOf = (record: OutboxRecord): readonly string[] => [
  String(record.id),
  record.requestDigest,
  record.target,
  record.state,
  json(record.request),
  String(record.attemptsMax),
  String(record.attemptsMade),
  String(record.runAtMs),
  String(record.createdAtMs),
  String(record.updatedAtMs),
  optionalNumber(record.publishedAtMs),
  optionalText(record.leaseOwner),
  optionalText(record.leaseToken),
  optionalNumber(record.leaseExpiresAtMs),
  record.failure === undefined ? '' : json(record.failure),
  memberOf(String(record.id)),
  String(record.protocolVersion)
]

const integer = (value: string | undefined, field: string): number => {
  if (value === undefined || value === '' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`invalid ${field}`)
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`unsafe ${field}`)
  return number
}

const optionalInteger = (value: string | undefined, field: string): number | undefined =>
  value === undefined || value === '' ? undefined : integer(value, field)

const parsed = (value: string | undefined, field: string): unknown => {
  if (value === undefined || value === '') return undefined
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw new Error(`invalid ${field}: ${messageOf(cause)}`)
  }
}

const decode = (fields: Record<string, string>): StoredRecord => {
  const checked = validateOutboxRecord({
    id: fields.id,
    protocolVersion: integer(fields.protocolVersion, 'protocolVersion'),
    target: fields.target,
    state: fields.state,
    request: parsed(fields.request, 'request'),
    requestDigest: fields.requestDigest,
    attemptsMax: integer(fields.attemptsMax, 'attemptsMax'),
    attemptsMade: integer(fields.attemptsMade, 'attemptsMade'),
    runAtMs: integer(fields.runAtMs, 'runAtMs'),
    createdAtMs: integer(fields.createdAtMs, 'createdAtMs'),
    updatedAtMs: integer(fields.updatedAtMs, 'updatedAtMs'),
    publishedAtMs: optionalInteger(fields.publishedAtMs, 'publishedAtMs'),
    leaseOwner:
      fields.leaseOwner === undefined || fields.leaseOwner === '' ? undefined : fields.leaseOwner,
    leaseToken:
      fields.leaseToken === undefined || fields.leaseToken === '' ? undefined : fields.leaseToken,
    leaseExpiresAtMs: optionalInteger(fields.leaseExpiresAtMs, 'leaseExpiresAtMs'),
    failure: parsed(fields.failure, 'failure')
  })
  if (Result.isError(checked)) throw checked.error
  return Object.freeze({
    record: checked.value,
    orderingSequence: integer(fields.orderingSequence, 'orderingSequence')
  })
}

const readStored = async (
  client: RedisCommandClient,
  layout: RedisKeyLayout,
  id: string
): Promise<StoredRecord | undefined> => {
  const fields = hashReply(
    await sendRedisCommand(client, ['HGETALL', recordKeyOf(layout, id)], layout.base)
  )
  if (Object.keys(fields).length === 0) return undefined
  return decode(fields)
}

const readExistingDigest = async (
  client: RedisCommandClient,
  layout: RedisKeyLayout,
  id: string
): Promise<string | undefined> => {
  const key = recordKeyOf(layout, id)
  const exists = numberReply(await sendRedisCommand(client, ['EXISTS', key], layout.base), 'exists')
  if (exists === 0) return undefined
  const digest = await sendRedisCommand(client, ['HGET', key, 'requestDigest'], layout.base)
  if (typeof digest !== 'string' || digest.length === 0)
    throw new Error('existing outbox record has no digest')
  return digest
}

const validateLease = (
  request: OutboxLeaseRequest | OutboxHeartbeatRequest
): ResultType<
  OutboxLeaseRequest & Partial<Pick<OutboxHeartbeatRequest, 'leaseDurationMs'>>,
  OutboxDefinitionError
> => {
  if (!isObject(request))
    return Result.err(new OutboxDefinitionError({ field: 'request', message: 'must be an object' }))
  const candidate = request as unknown as OutboxLeaseRequest &
    Partial<Pick<OutboxHeartbeatRequest, 'leaseDurationMs'>>
  const id = makeOutboxId(candidate.id)
  const token = makeOutboxLeaseToken(candidate.leaseToken)
  const nowMs = candidate.nowMs
  if (Result.isError(id)) return id
  if (Result.isError(token)) return token
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    return Result.err(
      new OutboxDefinitionError({ field: 'nowMs', message: 'must be a non-negative safe integer' })
    )
  if ('leaseDurationMs' in candidate) {
    const duration = candidate.leaseDurationMs
    if (!Number.isSafeInteger(duration) || duration < 1)
      return Result.err(
        new OutboxDefinitionError({
          field: 'leaseDurationMs',
          message: 'must be a positive safe integer'
        })
      )
    if (nowMs > Number.MAX_SAFE_INTEGER - duration)
      return Result.err(
        new OutboxDefinitionError({
          field: 'leaseDurationMs',
          message: 'lease expiry exceeds safe integer range'
        })
      )
    return Result.ok({ id: id.value, leaseToken: token.value, nowMs, leaseDurationMs: duration })
  }
  return Result.ok({ id: id.value, leaseToken: token.value, nowMs })
}

const queueAppend = (
  transaction: RedisTransaction,
  layout: RedisKeyLayout,
  record: OutboxRecord
): void => {
  transaction.sendCommand([
    'EVAL',
    appendScript,
    '4',
    recordKeyOf(layout, String(record.id)),
    layout.outboxAll,
    layout.outboxState(record.state),
    layout.outboxSequence,
    ...appendArgsOf(record)
  ])
}

const discard = async (transaction: RedisTransaction): Promise<void> => {
  if (typeof transaction.discard === 'function') await transaction.discard()
}

const replyStatus = (value: unknown): string => {
  if (!Array.isArray(value) || typeof value[0] !== 'string')
    throw new Error('malformed Redis reply')
  return value[0]
}

const appendReply = (value: unknown): RedisOutboxAppendReply => {
  const status = replyStatus(value)
  if (status !== 'inserted' && status !== 'duplicate' && status !== 'conflict') {
    throw new Error('unknown append reply')
  }
  const digest = Array.isArray(value) && typeof value[1] === 'string' ? value[1] : undefined
  if (status === 'conflict' && digest === undefined) throw new Error('conflict reply has no digest')
  return { status, digest }
}

const managed = async <Value, Failure>(
  client: RedisOutboxClient,
  record: OutboxRecord,
  callback: RedisOutboxTransactionCallback<Value, Failure>,
  options?: RedisOutboxAppendOptions
): Promise<
  ResultType<{ readonly value: Value; readonly append: AppendStatus }, Failure | RedisOutboxError>
> => {
  const checked = validateOutboxRecord(record)
  if (Result.isError(checked))
    return Result.err(checked.error) as ResultType<never, Failure | RedisOutboxError>
  if (
    checked.value.state !== 'pending' ||
    checked.value.attemptsMade !== 0 ||
    checked.value.publishedAtMs !== undefined ||
    checked.value.leaseOwner !== undefined ||
    checked.value.leaseToken !== undefined ||
    checked.value.leaseExpiresAtMs !== undefined ||
    checked.value.failure !== undefined
  ) {
    return Result.err(
      new OutboxDefinitionError({
        field: 'record',
        message: 'transaction append requires an initial pending record'
      })
    ) as ResultType<never, Failure | RedisOutboxError>
  }
  let layout: RedisKeyLayout
  let redis: RedisCommandClient
  try {
    layout = layoutOf(client, options)
    redis = clientOf(client)
  } catch (cause) {
    return Result.err(
      cause instanceof OutboxDefinitionError ? cause : storeFailure('transaction', cause, false)
    ) as ResultType<never, Failure | RedisOutboxError>
  }

  try {
    const existingDigest = await readExistingDigest(redis, layout, String(checked.value.id))
    if (existingDigest !== undefined && existingDigest !== checked.value.requestDigest) {
      return Result.err(
        new OutboxConflictError({
          id: checked.value.id,
          existingDigest,
          incomingDigest: checked.value.requestDigest
        })
      ) as ResultType<never, Failure | RedisOutboxError>
    }
  } catch (cause) {
    return Result.err(storeFailure('transaction preflight', cause)) as ResultType<
      never,
      Failure | RedisOutboxError
    >
  }

  if (typeof redis.multi !== 'function') {
    return Result.err(
      new OutboxDefinitionError({
        field: 'client',
        message: 'must expose multi() for Redis outbox transactions'
      })
    ) as ResultType<never, Failure | RedisOutboxError>
  }

  let transaction: RedisTransaction
  try {
    transaction = redis.multi()
  } catch (cause) {
    return Result.err(storeFailure('multi', cause)) as ResultType<never, Failure | RedisOutboxError>
  }

  let callbackResult: Value | ResultType<Value, Failure>
  let executing = false
  try {
    callbackResult = await callback(transaction)
  } catch (cause) {
    try {
      await discard(transaction)
    } catch {
      /* preserve the callback failure */
    }
    return Result.err(cause as Failure) as ResultType<never, Failure | RedisOutboxError>
  }
  if (isResult(callbackResult) && Result.isError(callbackResult as ResultType<Value, Failure>)) {
    try {
      await discard(transaction)
    } catch {
      /* preserve the callback failure */
    }
    return callbackResult as ResultType<never, Failure | RedisOutboxError>
  }

  try {
    queueAppend(transaction, layout, checked.value)
    executing = true
    const replies = await transaction.exec()
    if (replies === null) {
      try {
        await discard(transaction)
      } catch {
        /* preserve the Redis abort failure */
      }
      return Result.err(
        storeFailure('transaction', new Error('Redis transaction was aborted'), true)
      ) as ResultType<never, Failure | RedisOutboxError>
    }
    const append = appendReply(replies[replies.length - 1])
    const status = append.status
    if (status === 'conflict') {
      return Result.err(
        new OutboxConflictError({
          id: checked.value.id,
          existingDigest: append.digest!,
          incomingDigest: checked.value.requestDigest
        })
      ) as ResultType<never, Failure | RedisOutboxError>
    }
    const callbackValue = isResult(callbackResult)
      ? Result.isOk(callbackResult as ResultType<Value, Failure>)
        ? (callbackResult as ResultType<Value, Failure> & { readonly value: Value }).value
        : (callbackResult as Value)
      : (callbackResult as Value)
    return Result.ok({ value: callbackValue, append: status }) as ResultType<
      { readonly value: Value; readonly append: AppendStatus },
      Failure | RedisOutboxError
    >
  } catch (cause) {
    if (!executing)
      try {
        await discard(transaction)
      } catch {
        /* preserve the queueing failure */
      }
    return Result.err(storeFailure('transaction', cause)) as ResultType<
      never,
      Failure | RedisOutboxError
    >
  }
}

const asRecord = (input: OutboxRecordInput): ResultType<OutboxRecord, OutboxDefinitionError> =>
  makeOutboxRecord(input)

const transaction = async <Value, Failure = never>(
  client: RedisOutboxClient,
  record: OutboxRecord,
  callback: RedisOutboxTransactionCallback<Value, Failure>,
  options?: RedisOutboxAppendOptions
): Promise<ResultType<Value, Failure | RedisOutboxError>> => {
  const result = await managed(client, record, callback, options)
  if (Result.isError(result)) return result as ResultType<Value, Failure | RedisOutboxError>
  return Result.ok(result.value.value) as ResultType<Value, Failure | RedisOutboxError>
}

const append = async (
  client: RedisOutboxClient,
  input: OutboxRecordInput,
  options?: RedisOutboxAppendOptions
): Promise<ResultType<OutboxAppendResult, OutboxAppendError | OutboxStoreFailure>> => {
  const checked = asRecord(input)
  if (Result.isError(checked)) return checked
  const result = await managed(client, checked.value, () => undefined, options)
  if (Result.isError(result))
    return result as ResultType<never, OutboxAppendError | OutboxStoreFailure>
  try {
    const layout = layoutOf(client, options)
    const persisted = await readStored(clientOf(client), layout, String(checked.value.id))
    if (persisted === undefined)
      return Result.err(storeFailure('append', new Error('appended record is missing'), false))
    return Result.ok({ record: persisted.record, duplicate: result.value.append === 'duplicate' })
  } catch (cause) {
    return Result.err(storeFailure('append', cause, false))
  }
}

const operationResult = <Value>(
  promise: Promise<ResultType<Value, RedisOutboxError>>
): OutboxOperation<Value, RedisOutboxError> => promise as never

class RedisOutboxStoreImplementation implements OutboxStoreContract, OutboxAppendStore {
  readonly descriptor = descriptor
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly redis: RedisClient) {}

  private guard<Value, Failure extends OutboxStoreError>(
    operation: string,
    work: () => Promise<Value>
  ): OutboxOperation<Value, Failure> {
    if (this.closed)
      return failed(storeFailure(operation, new Error('store is closed'), false)) as never
    return operationResult(
      (async () => {
        try {
          return Result.ok(await work()) as ResultType<Value, Failure>
        } catch (cause) {
          return Result.err(storeFailure(operation, cause)) as ResultType<Value, Failure>
        }
      })()
    ) as OutboxOperation<Value, Failure>
  }

  append(input: OutboxRecordInput): OutboxOperation<OutboxAppendResult, OutboxAppendError> {
    return operationResult(
      append(this.redis, input, { namespace: this.redis.namespace, prefix: this.redis.prefix })
    ) as never
  }

  claim(
    options: OutboxClaimOptions
  ): OutboxOperation<readonly LeasedOutboxRecord[], OutboxClaimError> {
    return this.guard('claim', async () => {
      const owner = makeOutboxWorkerId(options.owner)
      const limit = options.limit
      const leaseDurationMs = options.leaseDurationMs
      if (
        Result.isError(owner) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        !Number.isSafeInteger(leaseDurationMs) ||
        leaseDurationMs < 1 ||
        !Number.isSafeInteger(options.nowMs) ||
        options.nowMs < 0
      )
        throw new OutboxDefinitionError({
          field: 'options',
          message: 'contains invalid claim values'
        })
      const token = makeOutboxLeaseToken(`redis-${randomUUID()}`)
      if (Result.isError(token)) throw token.error
      const expiresAtMs = options.nowMs + leaseDurationMs
      if (!Number.isSafeInteger(expiresAtMs))
        throw new OutboxDefinitionError({
          field: 'leaseDurationMs',
          message: 'lease expiry exceeds safe integer range'
        })
      const recovered = await this.recoverStalled({ maxCount: limit, nowMs: options.nowMs })
      if (Result.isError(recovered)) throw recovered.error
      const reply = await sendRedisCommand(
        this.redis.client,
        [
          'EVAL',
          claimScript,
          '2',
          this.redis.layout.outboxState('pending'),
          this.redis.layout.outboxState('active'),
          String(options.nowMs),
          String(limit),
          recordPrefixOf(this.redis.layout),
          String(options.nowMs),
          owner.value,
          token.value,
          String(expiresAtMs)
        ],
        this.redis.layout.base
      )
      const members = stringsReply(reply)
      const leased: LeasedOutboxRecord[] = []
      for (const member of members) {
        const id = decodeMember(member)
        const stored = await readStored(this.redis.client, this.redis.layout, id)
        if (stored === undefined || stored.record.state !== 'active')
          throw new Error('claimed record is missing')
        leased.push(stored.record as LeasedOutboxRecord)
      }
      return Object.freeze(leased)
    }) as never
  }

  heartbeat(
    request: OutboxHeartbeatRequest
  ): OutboxOperation<LeasedOutboxRecord, OutboxLeaseError> {
    return this.guard('heartbeat', async () => {
      const checked = validateLease(request)
      if (Result.isError(checked) || checked.value.leaseDurationMs === undefined)
        throw Result.isError(checked)
          ? checked.error
          : new OutboxDefinitionError({ field: 'leaseDurationMs', message: 'is required' })
      const id = String(checked.value.id)
      const token = checked.value.leaseToken
      const expiresAtMs = checked.value.nowMs + checked.value.leaseDurationMs
      const reply = await sendRedisCommand(
        this.redis.client,
        [
          'EVAL',
          heartbeatScript,
          '2',
          recordKeyOf(this.redis.layout, id),
          this.redis.layout.outboxState('active'),
          token,
          String(checked.value.nowMs),
          String(expiresAtMs),
          memberOf(id)
        ],
        this.redis.layout.base
      )
      const status = replyStatus(reply)
      if (status !== 'ok') throw leaseError(status, id, token)
      const stored = await readStored(this.redis.client, this.redis.layout, id)
      if (stored === undefined) throw new OutboxNotFoundError({ id })
      return stored.record as LeasedOutboxRecord
    }) as never
  }

  markPublished(
    request: OutboxLeaseRequest
  ): OutboxOperation<OutboxSettlementResult, OutboxSettlementError> {
    return this.settle('published', request) as never
  }

  markRetry(request: OutboxRetryRequest): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    return this.settle('pending', request, request.failure, request.runAtMs) as never
  }

  markFailed(request: OutboxFailureRequest): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    return this.settle('failed', request, request.failure) as never
  }

  release(request: OutboxLeaseRequest): OutboxOperation<OutboxRecord, OutboxSettlementError> {
    return this.settle('pending', request) as never
  }

  recoverStalled(
    options: OutboxRecoveryOptions
  ): OutboxOperation<readonly OutboxRecord[], OutboxRecoveryError> {
    return this.guard('recoverStalled', async () => {
      if (
        !Number.isSafeInteger(options.maxCount) ||
        options.maxCount < 1 ||
        !Number.isSafeInteger(options.nowMs) ||
        options.nowMs < 0
      )
        throw new OutboxDefinitionError({
          field: 'options',
          message: 'contains invalid recovery values'
        })
      const failure = makeSerializedOutboxFailure({
        kind: 'store-permanent',
        message: 'Outbox lease expired after the attempt limit was reached',
        retryable: false,
        recordedAtMs: options.nowMs
      })
      if (Result.isError(failure)) throw failure.error
      const reply = await sendRedisCommand(
        this.redis.client,
        [
          'EVAL',
          recoverScript,
          '3',
          this.redis.layout.outboxState('active'),
          this.redis.layout.outboxState('pending'),
          this.redis.layout.outboxState('failed'),
          String(options.nowMs),
          String(options.maxCount),
          recordPrefixOf(this.redis.layout),
          String(options.nowMs),
          json(failure.value),
          String(options.nowMs),
          String(options.nowMs),
          String(options.nowMs)
        ],
        this.redis.layout.base
      )
      const recovered: OutboxRecord[] = []
      for (const member of stringsReply(reply)) {
        const stored = await readStored(this.redis.client, this.redis.layout, decodeMember(member))
        if (stored !== undefined) recovered.push(stored.record)
      }
      return Object.freeze(recovered)
    }) as never
  }

  get(
    id: import('better-effect-mq-outbox').OutboxId
  ): OutboxOperation<OutboxRecord | undefined, OutboxReadError> {
    return this.guard('get', async () => {
      const checked = makeOutboxId(id)
      if (Result.isError(checked)) throw checked.error
      const stored = await readStored(this.redis.client, this.redis.layout, String(checked.value))
      return stored?.record
    }) as never
  }

  list(options: OutboxListOptions = {}): OutboxOperation<readonly OutboxRecord[], OutboxReadError> {
    return this.guard('list', async () => {
      const limit = options.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new OutboxDefinitionError({
          field: 'limit',
          message: 'must be a positive safe integer'
        })
      const members = stringsReply(
        await sendRedisCommand(
          this.redis.client,
          ['ZRANGE', this.redis.layout.outboxAll, '0', '-1'],
          this.redis.layout.base
        )
      )
      const states =
        options.state === undefined
          ? undefined
          : new Set<OutboxState>(
              typeof options.state === 'string' ? [options.state] : options.state
            )
      const records: OutboxRecord[] = []
      for (const member of members) {
        if (records.length >= limit) break
        const stored = await readStored(this.redis.client, this.redis.layout, decodeMember(member))
        if (stored === undefined) continue
        if (states !== undefined && !states.has(stored.record.state)) continue
        if (options.target !== undefined && options.target !== stored.record.target) continue
        records.push(stored.record)
      }
      return Object.freeze(records)
    }) as never
  }

  counts(): OutboxOperation<OutboxCounts, OutboxReadError> {
    return this.guard('counts', async () => {
      const counts = await Promise.all(
        (['pending', 'active', 'published', 'failed'] as const).map(async (state) =>
          numberReply(
            await sendRedisCommand(
              this.redis.client,
              ['ZCARD', this.redis.layout.outboxState(state)],
              this.redis.layout.base
            ),
            state
          )
        )
      )
      const pending = counts[0]!
      const active = counts[1]!
      const published = counts[2]!
      const failed = counts[3]!
      return Object.freeze({
        pending,
        active,
        published,
        failed,
        total: pending + active + published + failed
      })
    }) as never
  }

  private settle(
    state: 'published' | 'pending' | 'failed',
    request: OutboxLeaseRequest,
    failure?: SerializedOutboxFailure,
    runAtMs?: number
  ): OutboxOperation<OutboxRecord | OutboxSettlementResult, RedisOutboxError> {
    return this.guard(`mark${state}`, async () => {
      const checked = validateLease(request)
      if (Result.isError(checked)) throw checked.error
      const id = String(checked.value.id)
      const token = checked.value.leaseToken
      const failureValue = failure === undefined ? '' : json(failure)
      const score = runAtMs ?? checked.value.nowMs
      const reply = await sendRedisCommand(
        this.redis.client,
        [
          'EVAL',
          settlementScript,
          '5',
          recordKeyOf(this.redis.layout, id),
          this.redis.layout.outboxState('active'),
          this.redis.layout.outboxState('published'),
          this.redis.layout.outboxState('failed'),
          this.redis.layout.outboxState('pending'),
          state,
          token,
          String(checked.value.nowMs),
          memberOf(id),
          failureValue,
          String(score),
          String(checked.value.nowMs)
        ],
        this.redis.layout.base
      )
      const status = replyStatus(reply)
      if (status === 'already-applied') {
        const persisted = await readStored(this.redis.client, this.redis.layout, id)
        if (persisted === undefined) throw new OutboxNotFoundError({ id })
        return { record: persisted.record, status: 'already-applied' as const }
      }
      if (status !== 'ok') throw leaseError(status, id, token)
      const persisted = await readStored(this.redis.client, this.redis.layout, id)
      if (persisted === undefined) throw new OutboxNotFoundError({ id })
      return state === 'published'
        ? { record: persisted.record, status: 'applied' as const }
        : persisted.record
    }) as never
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = this.redis.dispose()
    return this.disposal
  }
}

const decodeMember = (member: string): string => {
  if (member.startsWith('~')) return Buffer.from(member.slice(1), 'base64url').toString('utf8')
  return member
}

const leaseError = (status: string, id: string, token: string): Error => {
  if (status === 'missing') return new OutboxNotFoundError({ id })
  return new OutboxLeaseLostError({
    id,
    leaseToken: token,
    reason:
      status === 'expired-lease'
        ? 'expired-lease'
        : status === 'mismatched-token'
          ? 'mismatched-token'
          : 'not-active'
  })
}

const makeLayer = <Token extends AnyOutboxStoreToken>(
  token: Token,
  acquire: () => Promise<RedisClient>
): Layer<InstanceType<Token>, never> =>
  Layer.scoped(
    token,
    async () => {
      const client = await acquire()
      let implementation: RedisOutboxStoreImplementation | undefined
      try {
        await client.initialize()
        implementation = new RedisOutboxStoreImplementation(client)
        return OutboxStore.of(implementation as never) as unknown as ServiceContract<
          InstanceType<Token>
        >
      } catch (cause) {
        try {
          await (implementation?.dispose() ?? client.dispose())
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Redis outbox acquisition cleanup failed')
        }
        throw cause
      }
    },
    async (store) => {
      await (store as unknown as RedisOutboxStoreImplementation).dispose()
    }
  )

const namespaceForToken = (token: AnyOutboxStoreToken, namespace: string): string =>
  token.serviceTag === OutboxStore.serviceTag
    ? namespace
    : `${namespace}:outbox-${createHash('sha256').update(token.serviceTag).digest('hex').slice(0, 32)}`

export const RedisOutbox = Object.freeze({
  transaction,
  append
})

export const RedisOutboxStore = Object.freeze({
  layer(config: RedisJobStoreConfig) {
    return makeLayer(OutboxStore, async () => RedisClient.fromClients(config))
  },
  layerFor<Token extends AnyOutboxStoreToken>(token: Token, config: RedisJobStoreConfig) {
    const namespace = validateNamespace(config.namespace ?? DEFAULT_NAMESPACE)
    return makeLayer(token, async () =>
      RedisClient.fromClients({ ...config, namespace: namespaceForToken(token, namespace) })
    )
  },
  layerFromConfig(config: RedisJobStoreConnectionConfig) {
    return makeLayer(OutboxStore, async () => RedisClient.fromConfig(config))
  },
  layerFromConfigFor<Token extends AnyOutboxStoreToken>(
    token: Token,
    config: RedisJobStoreConnectionConfig
  ) {
    const namespace = validateNamespace(config.namespace ?? DEFAULT_NAMESPACE)
    return makeLayer(token, async () =>
      RedisClient.fromConfig({ ...config, namespace: namespaceForToken(token, namespace) })
    )
  }
})

export type RedisOutboxStoreConfig = RedisJobStoreConfig
export type RedisOutboxStoreConnectionConfig = RedisJobStoreConnectionConfig
export type RedisOutboxStoreContract = OutboxStoreContract & OutboxAppendStore
