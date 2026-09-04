// oxlint-disable anti-slop/no-unknown-parameters -- persistence rows and public DTOs are validated at this boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL rows are narrowed by protocol decoders.
// oxlint-disable anti-slop/no-unknown-returns -- JSON values are validated immediately after decoding.
// oxlint-disable anti-slop/no-runtime-typeof -- driver JSON representations are normalized here.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional protocol fields are encoded at one boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- database JSON is narrowed by protocol validators.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to validated row/Service boundaries.

import { createHash, randomUUID } from 'node:crypto'
import { Result, type Result as ResultType } from 'better-result'
import { Layer } from 'better-effect'
import type { ServiceContract } from 'better-effect'
import {
  JobStore,
  JobStoreWakeAbortedError,
  type AnyJobStoreToken,
  type JobStore as JobStoreNamespace,
  type JobStoreDescriptor
} from 'better-effect-mq'
import {
  makeJobRecord,
  reduceJob,
  validateAttemptRecord,
  type AttemptRecord,
  type JobRecord,
  type JobTransition,
  validateSerializedJobFailure
} from 'better-effect-mq'
import {
  InvalidJobTransitionError,
  JobDefinitionError,
  JobNotFoundError,
  LeaseLostError,
  SettlementConflictError,
  makeJobId,
  makeJobName,
  makeLeaseToken,
  makeQueueName,
  makeWorkerId,
  JobStoreFailure,
  UnsupportedJobStoreOperationError,
  type JobListCursor,
  type JobListOrder,
  type JobListOrderBy,
  recoverStalledWithPolicy
} from 'better-effect-mq'
import { PostgresClient } from './client'
import { hasUnpairedSurrogate } from './internal/text'
import { quoteIdentifier, POSTGRES_TABLES } from './schema'
import {
  normalizePostgresJobStoreConfig,
  normalizePostgresJobStoreConnectionConfig,
  type PostgresJobStoreConfig,
  type PostgresJobStoreConnectionConfig,
  type Pool,
  type PoolClient
} from './config'

/** Build the immutable descriptor after the optional LISTEN channel is ready. */
const postgresDescriptor = (queueFilteredNotifications: boolean): JobStoreDescriptor =>
  Object.freeze({
    protocolVersion: 1,
    adapter: 'postgres',
    adapterVersion: '0.1.0',
    layoutVersion: 1,
    capabilities: Object.freeze({
      queueFilteredNotifications,
      nativeBatchEnqueue: true,
      nativeBatchClaim: true,
      metadataIndex: 'indexed',
      transactionalEnqueue: true,
      durableChangeFeed: false,
      globalConcurrency: false,
      rateLimiting: false
    })
  })
const maxRetries = 3

type Row = Record<string, unknown>
type StoreResult<T> = ResultType<T, any>
type Tx = PoolClient & {
  query<Row = unknown>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: readonly Row[]; rowCount: number | null }>
}

const ok = <T>(value: T): StoreResult<T> => Result.ok(value) as unknown as StoreResult<T>
const failure = (operation: string, _cause: unknown, retryable = false): JobStoreFailure =>
  new JobStoreFailure({
    operation,
    retryable,
    message: `PostgreSQL ${operation} failed`
  })
const taggedJobErrorTags = new Set([
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
const isTaggedJobError = (cause: unknown): boolean => {
  try {
    return (
      typeof cause === 'object' &&
      cause !== null &&
      typeof (cause as { readonly _tag?: unknown })._tag === 'string' &&
      taggedJobErrorTags.has((cause as { readonly _tag: string })._tag)
    )
  } catch {
    return false
  }
}
const fail = <T>(operation: string, cause: unknown): StoreResult<T> => {
  if (isTaggedJobError(cause)) return Result.err(cause) as StoreResult<T>
  return Result.err(failure(operation, cause, isRetryable(cause))) as unknown as StoreResult<T>
}
const postgresErrorCode = (cause: unknown): unknown => {
  try {
    return typeof cause === 'object' && cause !== null
      ? (cause as { code?: unknown }).code
      : undefined
  } catch {
    return undefined
  }
}
const isRetryable = (cause: unknown): boolean => {
  const code = postgresErrorCode(cause)
  return code === '40001' || code === '40P01'
}
const releaseError = (cause: unknown): Error | undefined =>
  cause instanceof Error && typeof postgresErrorCode(cause) === 'string' ? cause : undefined
const releaseCleanupError = (cause: unknown, message: string): Error | undefined =>
  cause === undefined ? undefined : cause instanceof Error ? cause : new Error(message, { cause })
const aggregateCleanup = (primary: unknown, cleanup: unknown, message: string): unknown =>
  cleanup === undefined ? primary : new AggregateError([primary, cleanup], message)
const json = (value: unknown): string => JSON.stringify(value)
const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (typeof value !== 'object' || value === null) return value
  const output = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (child !== undefined) output[key] = canonicalizeJson(child)
  }
  return output
}
const canonicalJson = (value: unknown): string => JSON.stringify(canonicalizeJson(value))
const parseJson = (value: unknown): unknown => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  const snapshot = snapshotDataGraph(parsed, 'json', false)
  if (Result.isError(snapshot)) throw snapshot.error
  return snapshot.value
}
const optionalJson = (value: unknown): unknown => (value == null ? undefined : parseJson(value))
const definition = <T>(field: string, message: string): StoreResult<T> =>
  Result.err(new JobDefinitionError({ field, message })) as StoreResult<T>
const validateDto = <T>(
  value: T,
  field: string,
  required: readonly string[] = [],
  allowed?: readonly string[]
): StoreResult<T> => {
  if (typeof value !== 'object' || value === null) return definition(field, 'must be an object')
  try {
    if (Array.isArray(value)) return definition(field, 'must be an object')
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      return definition(field, 'must be a plain object')
    const allowedKeys = allowed === undefined ? undefined : new Set(allowed)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || (allowedKeys !== undefined && !allowedKeys.has(key)))
        return definition(field, 'contains unsupported fields')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor))
        return definition(field, 'contains an accessor field')
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key))
        return definition(`${field}.${key}`, 'is required')
    }
  } catch {
    return definition(field, 'could not read fields')
  }
  const snapshot = Object.create(null) as Record<string, unknown>
  try {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor))
        return definition(field, 'contains an accessor field')
      snapshot[key] = descriptor.value
    }
    return ok(Object.freeze(snapshot) as T)
  } catch {
    return definition(field, 'could not read fields')
  }
}

const firstUnsupportedField = (value: unknown, allowed: readonly string[]): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    if (Array.isArray(value)) return undefined
    const keys = new Set(allowed)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !keys.has(key)) return typeof key === 'string' ? key : 'symbol'
    }
  } catch {
    return 'request'
  }
  return undefined
}

const text = (value: unknown, field: string): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    hasUnpairedSurrogate(value)
  )
    throw new JobDefinitionError({
      field,
      message: 'must be a non-empty well-formed string without NUL'
    })
  return value
}
const safeNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new JobDefinitionError({ field, message: 'must be a non-negative safe integer' })
  }
  return value
}

const snapshotDataGraph = (
  value: unknown,
  field: string,
  allowUndefined = true
): StoreResult<unknown> => {
  const ancestors = new Set<object>()
  const visit = (current: unknown, path: string): StoreResult<unknown> => {
    if (current === null) return ok(null)
    if (current === undefined)
      return allowUndefined ? ok(undefined) : definition(path, 'must contain data values')
    if (typeof current !== 'object') {
      if (typeof current === 'string') {
        if (current.includes('\u0000')) return definition(path, 'must not contain NUL characters')
        if (hasUnpairedSurrogate(current))
          return definition(path, 'must contain well-formed Unicode scalar values')
      }
      return typeof current === 'function' ||
        typeof current === 'symbol' ||
        typeof current === 'bigint' ||
        (typeof current === 'number' && !Number.isFinite(current))
        ? definition(path, 'must contain data values')
        : ok(current)
    }
    if (ancestors.has(current)) return definition(path, 'must not contain cycles')
    ancestors.add(current)
    try {
      const isArray = Array.isArray(current)
      const prototype = Object.getPrototypeOf(current)
      const validPrototype = isArray
        ? prototype === Array.prototype
        : prototype === Object.prototype || prototype === null
      if (!validPrototype) return definition(path, 'must contain plain objects')
      const lengthDescriptor = isArray
        ? Object.getOwnPropertyDescriptor(current, 'length')
        : undefined
      const length = lengthDescriptor?.value
      if (
        isArray &&
        (lengthDescriptor === undefined ||
          !('value' in lengthDescriptor) ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > 4_294_967_295)
      )
        return definition(path, 'must contain a valid array')
      const ownKeys = Reflect.ownKeys(current)
      if (isArray) {
        let indexCount = 0
        for (const key of ownKeys) {
          if (key === 'length') continue
          const index = Number(key)
          if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= length)
            return definition(path, 'contains an unsupported array field')
          indexCount += 1
        }
        if (indexCount !== length) return definition(path, 'must not contain sparse arrays')
      }
      const output = isArray ? Array.from({ length }) : Object.create(null)
      for (const key of ownKeys) {
        if (typeof key !== 'string') return definition(path, 'contains an unsupported field')
        if (key.includes('\u0000')) return definition(path, 'must not contain NUL characters')
        if (hasUnpairedSurrogate(key))
          return definition(path, 'must contain well-formed Unicode scalar values')
        if (isArray && key === 'length') continue
        if (isArray) {
          const index = Number(key)
          if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= length)
            return definition(path, 'contains an unsupported array field')
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor === undefined || !('value' in descriptor))
          return definition(`${path}.${key}`, 'must be a data property')
        const child = visit(descriptor.value, `${path}.${key}`)
        if (Result.isError(child)) return child
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: descriptor.enumerable === true,
          value: child.value,
          writable: true
        })
      }
      return ok(Object.freeze(output))
    } catch {
      return definition(path, 'could not read fields')
    } finally {
      ancestors.delete(current)
    }
  }
  return visit(value, field)
}

const validateDataGraph = (
  value: unknown,
  field: string,
  allowUndefined = true
): StoreResult<void> => {
  const snapshot = snapshotDataGraph(value, field, allowUndefined)
  return Result.isError(snapshot) ? (snapshot as StoreResult<void>) : ok(undefined)
}

const validateMetadata = (
  value: unknown,
  field: string
): StoreResult<Readonly<Record<string, string>>> => {
  if (typeof value !== 'object' || value === null) return definition(field, 'must be an object')
  let graph: StoreResult<unknown>
  try {
    if (Array.isArray(value)) return definition(field, 'must be an object')
    graph = snapshotDataGraph(value, field, false)
  } catch {
    return definition(field, 'could not read fields')
  }
  if (Result.isError(graph)) return graph as StoreResult<Readonly<Record<string, string>>>
  const snapshot = graph.value
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot))
    return definition(field, 'must be an object')
  try {
    for (const key of Reflect.ownKeys(snapshot)) {
      if (typeof key !== 'string') return definition(field, 'keys must be strings')
      const descriptor = Object.getOwnPropertyDescriptor(snapshot, key)
      if (descriptor === undefined || !('value' in descriptor))
        return definition(field, 'contains an accessor field')
      if (typeof descriptor.value !== 'string')
        return definition(`${field}.${key}`, 'must be a string')
    }
    return ok(snapshot as Readonly<Record<string, string>>)
  } catch {
    return definition(field, 'could not read fields')
  }
}

const validateSettlementOutcome = (value: unknown): StoreResult<Record<string, unknown>> => {
  const base = validateDto(
    value,
    'outcome',
    ['type'],
    ['type', 'result', 'runAt', 'retryDelayMs', 'failure']
  )
  if (Result.isError(base)) return base as StoreResult<Record<string, unknown>>
  const graph = validateDataGraph(base.value, 'outcome')
  if (Result.isError(graph)) return graph as StoreResult<Record<string, unknown>>
  const baseInput = base.value as Record<string, unknown>
  const type = baseInput.type
  const allowed =
    type === 'complete'
      ? ['type', 'result']
      : type === 'retry'
        ? ['type', 'runAt', 'retryDelayMs', 'failure']
        : type === 'fail'
          ? ['type', 'failure']
          : type === 'cancelled'
            ? ['type', 'failure']
            : undefined
  if (allowed === undefined) return definition('outcome.type', 'unsupported settlement outcome')
  const required =
    type === 'retry' || type === 'fail'
      ? ['type', ...(type === 'retry' ? ['runAt'] : ['failure'])]
      : ['type']
  const checked = validateDto(base.value, 'outcome', required, allowed)
  if (Result.isError(checked)) return checked as StoreResult<Record<string, unknown>>
  const input = checked.value as Record<string, unknown>
  const output = Object.assign(Object.create(null), input) as Record<string, unknown>
  if (input.result !== undefined) {
    const result = snapshotDataGraph(input.result, 'outcome.result', false)
    if (Result.isError(result)) return result as StoreResult<Record<string, unknown>>
    output.result = result.value
  }
  if (input.failure !== undefined) {
    const failure = snapshotDataGraph(input.failure, 'outcome.failure', false)
    if (Result.isError(failure)) return failure as StoreResult<Record<string, unknown>>
    const checkedFailure = validateSerializedJobFailure(failure.value)
    if (Result.isError(checkedFailure))
      return checkedFailure as StoreResult<Record<string, unknown>>
    output.failure = checkedFailure.value
  }
  if (type === 'retry') {
    try {
      safeNumber(input.runAt, 'outcome.runAt')
      if (input.retryDelayMs !== undefined) safeNumber(input.retryDelayMs, 'outcome.retryDelayMs')
    } catch (cause) {
      return fail('request', cause)
    }
  }
  return ok(Object.freeze(output))
}

const normalizeJobId = (request: unknown): StoreResult<string> => {
  const checked = validateDto(request, 'request', ['jobId'], ['jobId'])
  if (Result.isError(checked)) return checked as StoreResult<string>
  const input = checked.value as { jobId: unknown }
  try {
    const jobId = makeJobId(input.jobId)
    if (Result.isError(jobId)) return jobId as StoreResult<string>
    if (jobId.value.includes('\u0000')) return definition('jobId', 'must not contain NUL')
    return ok(jobId.value)
  } catch (cause) {
    return fail('request', cause)
  }
}

const normalizeIdentity = (
  value: unknown,
  field: string
): StoreResult<{ readonly queue: string; readonly name: string; readonly version: number }> => {
  const checked = validateDto(
    value,
    field,
    ['queue', 'name', 'version'],
    ['queue', 'name', 'version']
  )
  if (Result.isError(checked))
    return checked as StoreResult<{ queue: string; name: string; version: number }>
  const graph = validateDataGraph(checked.value, field, false)
  if (Result.isError(graph))
    return graph as StoreResult<{ queue: string; name: string; version: number }>
  try {
    const input = checked.value as { queue: unknown; name: unknown; version: unknown }
    const queue = makeQueueName(input.queue)
    const name = makeJobName(input.name)
    const version = safeNumber(input.version, `${field}.version`)
    if (Result.isError(queue))
      return queue as StoreResult<{ queue: string; name: string; version: number }>
    if (Result.isError(name))
      return name as StoreResult<{ queue: string; name: string; version: number }>
    if (queue.value.includes('\u0000')) return definition(`${field}.queue`, 'must not contain NUL')
    if (name.value.includes('\u0000')) return definition(`${field}.name`, 'must not contain NUL')
    if (version < 1) return definition(`${field}.version`, 'must be positive')
    return ok(Object.freeze({ queue: queue.value, name: name.value, version }))
  } catch (cause) {
    return fail('request', cause)
  }
}

const validateEnqueueRequest = (
  request: unknown,
  field: string
): StoreResult<Record<string, unknown>> => {
  const allowed = [
    'id',
    'idempotencyKey',
    'payload',
    'metadata',
    'priority',
    'runAt',
    'attemptsMax',
    'backoff',
    'timeoutMs',
    'now',
    'job',
    'identity'
  ] as const
  const checked = validateDto(request, field, ['payload', 'runAt', 'attemptsMax', 'now'], allowed)
  if (Result.isError(checked)) return checked as StoreResult<Record<string, unknown>>
  const graph = validateDataGraph(checked.value, field)
  if (Result.isError(graph)) return graph as StoreResult<Record<string, unknown>>
  try {
    const input = checked.value as Record<string, unknown>
    const hasJob = Object.prototype.hasOwnProperty.call(input, 'job')
    const hasIdentity = Object.prototype.hasOwnProperty.call(input, 'identity')
    if (hasJob === hasIdentity)
      return definition(`${field}.identity`, 'must provide exactly one of job or identity')
    const identity = normalizeIdentity(input.job ?? input.identity, `${field}.identity`)
    if (Result.isError(identity)) return identity as StoreResult<Record<string, unknown>>
    const id = makeJobId(input.id === undefined ? 'postgres-validation-id' : input.id)
    if (Result.isError(id)) return id as StoreResult<Record<string, unknown>>
    const now = safeNumber(input.now, `${field}.now`)
    const runAt = safeNumber(input.runAt, `${field}.runAt`)
    const attemptsMax = safeNumber(input.attemptsMax, `${field}.attemptsMax`)
    if (attemptsMax < 1) return definition(`${field}.attemptsMax`, 'must be positive')
    const payload = snapshotDataGraph(input.payload, `${field}.payload`, false)
    if (Result.isError(payload)) return payload as StoreResult<Record<string, unknown>>
    let metadata: Readonly<Record<string, string>> = {}
    if (input.metadata !== undefined) {
      const checkedMetadata = validateMetadata(input.metadata, `${field}.metadata`)
      if (Result.isError(checkedMetadata))
        return checkedMetadata as StoreResult<Record<string, unknown>>
      metadata = checkedMetadata.value
    }
    let backoff: JobRecord['backoff']
    if (input.backoff !== undefined) {
      const checkedBackoff = snapshotDataGraph(input.backoff, `${field}.backoff`, false)
      if (Result.isError(checkedBackoff))
        return checkedBackoff as StoreResult<Record<string, unknown>>
      // SAFETY: the graph snapshot is validated structurally by makeJobRecord below.
      backoff = checkedBackoff.value as JobRecord['backoff']
    }
    const record = makeJobRecord({
      id: id.value,
      name: identity.value.name,
      version: identity.value.version,
      queue: identity.value.queue,
      state: runAt <= now ? 'waiting' : 'delayed',
      payload: payload.value,
      metadata,
      priority: input.priority === undefined ? 0 : input.priority,
      runAt,
      orderingSequence: 0,
      attemptsMax,
      attemptsMade: 0,
      attemptSequence: 0,
      deliveryCount: 0,
      stalledCount: 0,
      backoff,
      timeoutMs: input.timeoutMs,
      idempotencyKey: input.idempotencyKey,
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
    if (Result.isError(record)) return record as StoreResult<Record<string, unknown>>
    const output = Object.assign(Object.create(null), input, {
      [hasJob ? 'job' : 'identity']: identity.value,
      payload: record.value.payload,
      metadata: record.value.metadata,
      priority: record.value.priority,
      runAt: record.value.runAt,
      attemptsMax: record.value.attemptsMax,
      backoff: record.value.backoff,
      timeoutMs: record.value.timeoutMs,
      idempotencyKey: record.value.idempotencyKey,
      now
    }) as Record<string, unknown>
    if (input.id !== undefined) output.id = id.value
    return ok(Object.freeze(output))
  } catch (cause) {
    return fail('request', cause)
  }
}

const normalizeJobIdRequest = (
  request: unknown,
  allowed: readonly string[] = ['jobId', 'now']
): StoreResult<{ readonly jobId: string; readonly now: number; readonly runAt?: unknown }> => {
  const checked = validateDto(request, 'request', ['jobId', 'now'], allowed)
  if (Result.isError(checked))
    return checked as StoreResult<{ jobId: string; now: number; runAt?: unknown }>
  const input = checked.value as Record<string, unknown>
  try {
    const jobId = makeJobId(input.jobId)
    const now = safeNumber(input.now, 'now')
    if (Result.isError(jobId))
      return jobId as StoreResult<{ jobId: string; now: number; runAt?: unknown }>
    if (jobId.value.includes('\u0000')) return definition('jobId', 'must not contain NUL')
    return ok({
      jobId: jobId.value,
      now,
      ...(Object.prototype.hasOwnProperty.call(input, 'runAt') ? { runAt: input.runAt } : {})
    })
  } catch (cause) {
    return fail('request', cause)
  }
}
const cursorOrdering = (orderBy: JobListOrderBy): JobListCursor['ordering'] =>
  orderBy === 'enqueuedAt'
    ? 'createdAt,orderingSequence,id'
    : `${orderBy === 'runAt' ? 'runAt' : 'finishedAt'},orderingSequence,id`
const listValue = (row: Row, orderBy: JobListOrderBy): number | null =>
  orderBy === 'enqueuedAt'
    ? integer(row.created_at_ms, 'created_at_ms')
    : orderBy === 'runAt'
      ? integer(row.run_at_ms, 'run_at_ms')
      : (optionalInteger(row.finished_at_ms, 'finished_at_ms') ?? null)
const listSignature = (
  request: JobStoreNamespace.ListJobsRequest,
  orderBy: JobListOrderBy,
  direction: JobListOrder
): string =>
  JSON.stringify([
    request.queue ?? null,
    request.name ?? null,
    request.version ?? null,
    request.state === undefined
      ? '*'
      : Array.isArray(request.state)
        ? [...new Set(request.state as readonly string[])].sort((left, right) =>
            left.localeCompare(right)
          )
        : [request.state],
    request.metadata === undefined
      ? null
      : Object.entries(request.metadata).sort(([left], [right]) => left.localeCompare(right)),
    orderBy,
    direction
  ])
const optionalString = (value: unknown): string | undefined => {
  if (value == null) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    hasUnpairedSurrogate(value)
  )
    throw new Error('invalid nullable string')
  return value
}

type WakeBaseline = Readonly<Record<string, number>>

const wakeTokenPrefix = 'postgres-wake-v1-'

const makeWakeToken = (baseline: WakeBaseline): import('better-effect-mq').WakeToken =>
  `${wakeTokenPrefix}${encodeURIComponent(JSON.stringify({ version: 1, queues: baseline }))}` as import('better-effect-mq').WakeToken

const parseWakeToken = (value: unknown): StoreResult<WakeBaseline> => {
  if (typeof value !== 'string' || !value.startsWith(wakeTokenPrefix)) {
    return Result.err(
      new JobStoreFailure({
        operation: 'awaitWake',
        retryable: false,
        message: 'wakeToken was not created by this PostgreSQL store'
      })
    ) as StoreResult<WakeBaseline>
  }
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(value.slice(wakeTokenPrefix.length)))
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new Error()
    const version = (decoded as { version?: unknown }).version
    const queues = (decoded as { queues?: unknown }).queues
    if (version !== 1 || typeof queues !== 'object' || queues === null || Array.isArray(queues))
      throw new Error()
    const baseline = Object.create(null) as Record<string, number>
    for (const [queue, wakeVersion] of Object.entries(queues)) {
      if (
        queue.length === 0 ||
        queue.includes('\u0000') ||
        hasUnpairedSurrogate(queue) ||
        typeof wakeVersion !== 'number' ||
        !Number.isSafeInteger(wakeVersion) ||
        wakeVersion < 0
      )
        throw new Error()
      baseline[queue] = wakeVersion
    }
    return ok(Object.freeze(baseline))
  } catch {
    return Result.err(
      new JobStoreFailure({
        operation: 'awaitWake',
        retryable: false,
        message: 'wakeToken could not be decoded'
      })
    ) as StoreResult<WakeBaseline>
  }
}
const integer = (value: unknown, field: string): number => {
  const n =
    typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new Error(`unsafe ${field}`)
  return n
}
const optionalInteger = (value: unknown, field: string): number | undefined =>
  value == null ? undefined : integer(value, field)
const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 48)

type EventClient = PoolClient & {
  on?: (event: string, listener: (value: unknown) => void) => unknown
  removeListener?: (event: string, listener: (value: unknown) => void) => unknown
}

type WakeWaiter = {
  readonly queues: readonly string[]
  readonly baseline: WakeBaseline
  readonly signal: AbortSignal
  readonly resolve: (result: StoreResult<void>) => void
  readonly onAbort: () => void
  timer?: ReturnType<typeof setInterval>
  settled: boolean
}

const validJobStates = new Set(['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'])
const listenerReservations = new WeakMap<Pool, number>()

const reserveListener = (pool: Pool, max: number): boolean => {
  const active = listenerReservations.get(pool) ?? 0
  if (active >= max - 1) return false
  listenerReservations.set(pool, active + 1)
  return true
}

const releaseListenerReservation = (pool: Pool): void => {
  const active = listenerReservations.get(pool) ?? 0
  if (active <= 1) listenerReservations.delete(pool)
  else listenerReservations.set(pool, active - 1)
}

const columnNames = [
  'id',
  'name',
  'version',
  'queue',
  'state',
  'payload',
  'metadata',
  'priority',
  'run_at_ms',
  'sequence',
  'attempts_max',
  'attempts_made',
  'attempt_sequence',
  'delivery_count',
  'stalled_count',
  'backoff',
  'timeout_ms',
  'idempotency_key',
  'created_at_ms',
  'updated_at_ms',
  'processed_at_ms',
  'finished_at_ms',
  'lease_owner',
  'lease_token',
  'lease_expires_at_ms',
  'cancel_requested',
  'cancellation_requested_at_ms',
  'result',
  'failure'
] as const

const decodeJob = (row: Row): JobRecord => {
  const record = makeJobRecord({
    id: row.id,
    name: row.name,
    version: integer(row.version, 'version'),
    queue: row.queue,
    state: row.state,
    payload: parseJson(row.payload),
    metadata: parseJson(row.metadata),
    priority: integer(row.priority, 'priority'),
    runAt: integer(row.run_at_ms, 'run_at_ms'),
    orderingSequence: integer(row.sequence, 'sequence'),
    attemptsMax: integer(row.attempts_max, 'attempts_max'),
    attemptsMade: integer(row.attempts_made, 'attempts_made'),
    attemptSequence: integer(row.attempt_sequence, 'attempt_sequence'),
    deliveryCount: integer(row.delivery_count, 'delivery_count'),
    stalledCount: integer(row.stalled_count, 'stalled_count'),
    backoff: optionalJson(row.backoff),
    timeoutMs: optionalInteger(row.timeout_ms, 'timeout_ms'),
    idempotencyKey: optionalString(row.idempotency_key),
    createdAt: integer(row.created_at_ms, 'created_at_ms'),
    updatedAt: integer(row.updated_at_ms, 'updated_at_ms'),
    processedAt: optionalInteger(row.processed_at_ms, 'processed_at_ms'),
    finishedAt: optionalInteger(row.finished_at_ms, 'finished_at_ms'),
    leaseOwner: optionalString(row.lease_owner) as JobRecord['leaseOwner'],
    leaseToken: optionalString(row.lease_token) as JobRecord['leaseToken'],
    leaseExpiresAt: optionalInteger(row.lease_expires_at_ms, 'lease_expires_at_ms'),
    cancellationRequestedAt: optionalInteger(
      row.cancellation_requested_at_ms,
      'cancellation_requested_at_ms'
    ),
    result: optionalJson(row.result) as JobRecord['result'],
    failure: optionalJson(row.failure) as JobRecord['failure']
  })
  if (Result.isError(record)) throw record.error
  return record.value
}

const decodeAttempt = (row: Row | undefined): AttemptRecord | undefined => {
  if (row === undefined) return undefined
  const attempt = validateAttemptRecord({
    attempt: integer(row.attempt, 'attempt'),
    attemptSequence: optionalInteger(row.attempt_sequence, 'attempt_sequence'),
    delivery: integer(row.delivery, 'delivery'),
    startedAt: optionalInteger(row.started_at_ms, 'started_at_ms'),
    finishedAt: optionalInteger(row.finished_at_ms, 'finished_at_ms'),
    outcome: row.outcome,
    result: optionalJson(row.result),
    failure: optionalJson(row.failure),
    retryAt: optionalInteger(row.retry_at_ms, 'retry_at_ms'),
    retryDelayMs: optionalInteger(row.retry_delay_ms, 'retry_delay_ms')
  })
  if (Result.isError(attempt)) throw attempt.error
  return attempt.value
}

const isRequeue = (previous: JobRecord, next: JobRecord): boolean =>
  (next.state === 'waiting' || next.state === 'delayed') &&
  (previous.state === 'active' ||
    previous.state === 'failed' ||
    previous.state === 'cancelled' ||
    previous.state === 'delayed')

const encodeRecord = (r: JobRecord): unknown[] => [
  r.id,
  r.name,
  r.version,
  r.queue,
  r.state,
  json(r.payload),
  json(r.metadata),
  r.priority,
  r.runAt,
  r.orderingSequence,
  r.attemptsMax,
  r.attemptsMade,
  r.attemptSequence ?? r.attemptsMade,
  r.deliveryCount,
  r.stalledCount,
  r.backoff === undefined ? null : json(r.backoff),
  r.timeoutMs ?? null,
  r.idempotencyKey ?? null,
  r.createdAt,
  r.updatedAt,
  r.processedAt ?? null,
  r.finishedAt ?? null,
  r.leaseOwner ?? null,
  r.leaseToken ?? null,
  r.leaseExpiresAt ?? null,
  r.cancellationRequestedAt !== undefined,
  r.cancellationRequestedAt ?? null,
  r.result === undefined ? null : json(r.result),
  r.failure === undefined ? null : json(r.failure)
]

class PostgresJobStoreImplementation {
  private descriptorValue = postgresDescriptor(false)
  private readonly channel: string
  private closed = false
  private listener:
    | {
        readonly client: EventClient
        readonly handler: (value: unknown) => void
        readonly errorHandler: (value: unknown) => void
      }
    | undefined
  private listenerReservationHeld = false
  private readonly waiters = new Set<WakeWaiter>()
  private disposal: Promise<void> | undefined
  constructor(private readonly client: PostgresClient) {
    this.channel = `mq_${hash(`${client.schema}:${client.namespace}`)}_wake`
  }
  get descriptor(): JobStoreDescriptor {
    return this.descriptorValue
  }
  async start(): Promise<void> {
    let poolMax: unknown
    try {
      poolMax = (
        this.client.pool as {
          readonly options?: { readonly max?: unknown }
        }
      ).options?.max
    } catch {
      return
    }
    // A dedicated listener consumes one pool slot. If capacity is not exposed,
    // polling is safer than risking a deadlock in a wrapped one-connection pool.
    if (poolMax === undefined) return
    const max =
      typeof poolMax === 'number'
        ? poolMax
        : typeof poolMax === 'string'
          ? Number(poolMax)
          : Number.NaN
    if (!Number.isSafeInteger(max) || max <= 1) return
    if (!reserveListener(this.client.pool, max)) return
    this.listenerReservationHeld = true
    let connection: EventClient | undefined
    try {
      connection = (await this.client.pool.connect()) as EventClient
      if (typeof connection.on !== 'function' || typeof connection.removeListener !== 'function') {
        try {
          connection.release()
        } catch {
          /* polling remains authoritative when event methods are unavailable */
        }
        this.releaseListenerReservation()
        return
      }
      await connection.query(`LISTEN ${quoteIdentifier(this.channel)}`)
      const handler = (value: unknown): void => {
        const payload =
          typeof value === 'object' && value !== null && 'payload' in value
            ? (value as { payload?: unknown }).payload
            : undefined
        this.wakeWaiters(typeof payload === 'string' ? payload : undefined)
      }
      const errorHandler = (cause: unknown): void => {
        if (this.listener?.client !== connection) return
        this.listener = undefined
        this.releaseListenerReservation()
        this.wakeWaiters(undefined)
        const error =
          cause instanceof Error
            ? cause
            : new Error('PostgreSQL LISTEN connection failed', { cause })
        try {
          connection?.removeListener?.('notification', handler)
        } catch {
          /* polling remains authoritative after a listener failure */
        }
        try {
          connection?.removeListener?.('error', errorHandler)
        } catch {
          /* polling remains authoritative after a listener failure */
        }
        try {
          connection?.release(error)
        } catch {
          /* polling remains authoritative after a listener failure */
        }
      }
      connection.on('notification', handler)
      connection.on('error', errorHandler)
      this.listener = { client: connection, handler, errorHandler }
      this.descriptorValue = postgresDescriptor(true)
    } catch (cause) {
      const error =
        cause instanceof Error ? cause : new Error('PostgreSQL LISTEN setup failed', { cause })
      try {
        connection?.release(error)
      } catch {
        /* polling remains authoritative after a listener failure */
      }
      this.releaseListenerReservation()
    }
  }
  private releaseListenerReservation(): void {
    if (!this.listenerReservationHeld) return
    this.listenerReservationHeld = false
    releaseListenerReservation(this.client.pool)
  }
  private table(name: string): string {
    return `${quoteIdentifier(this.client.schema)}.${quoteIdentifier(name)}`
  }
  private async withTx<T>(
    operation: string,
    body: (tx: Tx) => Promise<T>
  ): Promise<StoreResult<T>> {
    if (this.closed) return fail(operation, new Error('store is closed'))
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      let tx: PoolClient | undefined
      let value: T | undefined
      let primary: unknown
      let cleanup: unknown
      let committed = false
      let failed = false
      try {
        tx = await this.client.pool.connect()
        await tx.query('BEGIN')
        value = await body(tx as Tx)
        await tx.query('COMMIT')
        committed = true
      } catch (cause) {
        failed = true
        primary = cause
      }
      if (!committed && tx !== undefined) {
        try {
          await tx.query('ROLLBACK')
        } catch (cause) {
          cleanup = cause
        }
      }
      if (tx !== undefined) {
        try {
          tx.release(
            cleanup === undefined
              ? releaseError(primary)
              : releaseCleanupError(cleanup, 'PostgreSQL transaction cleanup failed')
          )
        } catch (cause) {
          cleanup = cleanup === undefined ? cause : new AggregateError([cleanup, cause])
        }
      }
      if (failed) {
        if (!committed && cleanup === undefined && isRetryable(primary) && attempt + 1 < maxRetries)
          continue
        // Rollback/release are cleanup diagnostics. Never replace a tagged
        // domain failure with an AggregateError that changes the public error.
        return fail(operation, primary)
      }
      if (cleanup !== undefined) return fail(operation, cleanup)
      return ok(value as T)
    }
    return fail(operation, new Error('retry budget exhausted'))
  }
  private async notify(tx: Tx, queue: string, now: number): Promise<void> {
    const result = await tx.query<Row>(
      `INSERT INTO ${this.table(POSTGRES_TABLES.queues)} (namespace,queue,wake_version,updated_at_ms) VALUES ($1,$2,1,$3) ON CONFLICT (namespace,queue) DO UPDATE SET wake_version=${this.table(POSTGRES_TABLES.queues)}.wake_version+1,updated_at_ms=EXCLUDED.updated_at_ms WHERE ${this.table(POSTGRES_TABLES.queues)}.wake_version < 9007199254740991 RETURNING wake_version`,
      [this.client.namespace, queue, now]
    )
    if (result.rows[0] === undefined) {
      throw new JobDefinitionError({
        field: 'wakeVersion',
        message: 'cannot exceed safe integer range'
      })
    }
    integer(result.rows[0].wake_version, 'wake_version')
    await this.emitNotification(tx, queue)
  }
  private async emitNotification(tx: Tx, queue: string): Promise<void> {
    try {
      await tx.query('SAVEPOINT better_effect_mq_notify')
      await tx.query('SELECT pg_notify($1,$2)', [this.channel, queue])
      await tx.query('RELEASE SAVEPOINT better_effect_mq_notify')
    } catch {
      try {
        await tx.query('ROLLBACK TO SAVEPOINT better_effect_mq_notify')
        await tx.query('RELEASE SAVEPOINT better_effect_mq_notify')
      } catch {
        /* notification remains an optimization; polling is authoritative */
      }
    }
  }
  private async wakeSnapshot(source?: Tx): Promise<WakeBaseline> {
    const connection = source ?? ((await this.client.pool.connect()) as Tx)
    try {
      const result = await connection.query<Row>(
        `SELECT queue,wake_version FROM ${this.table(POSTGRES_TABLES.queues)} WHERE namespace=$1`,
        [this.client.namespace]
      )
      const baseline = Object.create(null) as Record<string, number>
      for (const row of result.rows) {
        const queue = text(row.queue, 'queue')
        baseline[queue] = integer(row.wake_version, 'wake_version')
      }
      return Object.freeze(baseline)
    } finally {
      if (source === undefined) connection.release()
    }
  }
  private async hasRelevantWake(
    baseline: WakeBaseline,
    queues: readonly string[]
  ): Promise<boolean> {
    const current = await this.wakeSnapshot()
    const candidates = queues.length === 0 ? Object.keys(current) : queues
    return candidates.some((queue) => (current[queue] ?? 0) > (baseline[queue] ?? 0))
  }
  private wakeWaiters(queue: string | undefined): void {
    for (const waiter of this.waiters) {
      if (queue !== undefined && waiter.queues.length > 0 && !waiter.queues.includes(queue))
        continue
      void this.checkWaiter(waiter)
    }
  }
  private async checkWaiter(waiter: WakeWaiter): Promise<void> {
    if (waiter.settled) return
    try {
      if (waiter.signal.aborted) {
        this.finishWaiter(waiter, Result.err(new JobStoreWakeAbortedError()) as StoreResult<void>)
        return
      }
      if (await this.hasRelevantWake(waiter.baseline, waiter.queues))
        this.finishWaiter(waiter, ok(undefined))
    } catch (cause) {
      this.finishWaiter(waiter, fail('awaitWake', cause))
    }
  }
  private finishWaiter(waiter: WakeWaiter, result: StoreResult<void>): void {
    if (waiter.settled) return
    waiter.settled = true
    this.waiters.delete(waiter)
    if (waiter.timer !== undefined) clearInterval(waiter.timer)
    try {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    } catch {
      /* the waiter is already detached from the store */
    }
    waiter.resolve(result)
  }
  private async row(tx: Tx, id: string, lock = false): Promise<JobRecord | undefined> {
    const result = await tx.query<Row>(
      `SELECT ${columnNames.join(',')},last_settlement_token,last_settlement_outcome,last_settlement_attempt_sequence FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`,
      [this.client.namespace, id]
    )
    const found = result.rows[0]
    return found === undefined ? undefined : decodeJob(found)
  }
  private async clearSettlement(tx: Tx, id: string): Promise<void> {
    await tx.query(
      `UPDATE ${this.table(POSTGRES_TABLES.jobs)} SET last_settlement_token=NULL,last_settlement_outcome=NULL,last_settlement_attempt_sequence=NULL WHERE namespace=$1 AND id=$2`,
      [this.client.namespace, id]
    )
  }
  private async nextSequence(tx: Tx): Promise<number> {
    const result = await tx.query<Row>(
      `SELECT nextval(pg_get_serial_sequence($1,$2)) AS sequence`,
      [`${quoteIdentifier(this.client.schema)}.${POSTGRES_TABLES.jobs}`, 'sequence']
    )
    const sequence = integer(result.rows[0]?.sequence, 'sequence')
    if (sequence > Number.MAX_SAFE_INTEGER - 1)
      throw new JobDefinitionError({
        field: 'orderingSequence',
        message: 'cannot exceed safe integer range'
      })
    return sequence
  }
  private async prepareTransition(
    tx: Tx,
    previous: JobRecord,
    transition: JobTransition
  ): Promise<JobTransition> {
    if (!isRequeue(previous, transition.record)) return transition
    const orderingSequence = await this.nextSequence(tx)
    const record = makeJobRecord({ ...transition.record, orderingSequence })
    if (Result.isError(record)) throw record.error
    return { ...transition, record: record.value }
  }
  private async save(tx: Tx, record: JobRecord, expected?: JobRecord): Promise<boolean> {
    const writable = columnNames.filter((c) => c !== 'id')
    const encoded = encodeRecord(record)
    const sets = writable.map((c, i) => `${c}=$${i + 2}`).join(',')
    const values = writable.map((c) => encoded[columnNames.indexOf(c)])
    const idParameter = writable.length + 2
    const guards =
      expected === undefined
        ? ''
        : ` AND state=$${idParameter + 1} AND updated_at_ms=$${idParameter + 2} AND sequence=$${idParameter + 3} AND attempt_sequence=$${idParameter + 4}`
    const result = await tx.query(
      `UPDATE ${this.table(POSTGRES_TABLES.jobs)} SET ${sets} WHERE namespace=$1 AND id=$${idParameter}${guards}`,
      [
        this.client.namespace,
        ...values,
        record.id,
        ...(expected === undefined
          ? []
          : [
              expected.state,
              expected.updatedAt,
              expected.orderingSequence,
              expected.attemptSequence ?? expected.attemptsMade
            ])
      ]
    )
    return result.rowCount === 1
  }
  private async transition(
    operation: string,
    request: { jobId: string; now: number },
    command: (record: JobRecord) => ResultType<JobTransition, any>
  ): Promise<StoreResult<JobTransition>> {
    return this.withTx(operation, async (tx) => {
      const current = await this.row(tx, request.jobId, true)
      if (current === undefined) throw new JobNotFoundError({ jobId: request.jobId as never })
      const next = command(current)
      if (Result.isError(next)) throw next.error
      const transition = await this.prepareTransition(tx, current, next.value as JobTransition)
      await this.save(tx, transition.record)
      if (operation === 'retry') await this.clearSettlement(tx, transition.record.id)
      if (transition.attempt !== undefined)
        await this.insertAttempt(tx, transition.attempt, transition.record.id, current.leaseOwner)
      await this.notify(tx, transition.record.queue, request.now)
      return transition
    })
  }
  private async insertAttempt(
    tx: Tx,
    a: AttemptRecord,
    jobId: string,
    workerId?: string
  ): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.table(POSTGRES_TABLES.attempts)} (namespace,job_id,attempt_sequence,attempt,delivery,started_at_ms,finished_at_ms,outcome,result,failure,worker_id,retry_at_ms,retry_delay_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`,
      [
        this.client.namespace,
        jobId,
        a.attemptSequence ?? a.attempt,
        a.attempt,
        a.delivery,
        a.startedAt ?? null,
        a.finishedAt,
        a.outcome,
        a.result === undefined ? null : json(a.result),
        a.failure === undefined ? null : json(a.failure),
        workerId ?? null,
        a.retryAt ?? null,
        a.retryDelayMs ?? null
      ]
    )
  }
  async enqueue(
    request: JobStoreNamespace.EnqueueRequest
  ): Promise<StoreResult<JobStoreNamespace.EnqueueResult>> {
    const checked = validateEnqueueRequest(request, 'request')
    if (Result.isError(checked)) return checked as StoreResult<JobStoreNamespace.EnqueueResult>
    const many = await this.enqueueMany([checked.value as JobStoreNamespace.EnqueueRequest])
    return Result.isError(many) ? many : ok(many.value[0]!)
  }
  async enqueueMany(
    requests: readonly JobStoreNamespace.EnqueueRequest[]
  ): Promise<StoreResult<JobStoreNamespace.EnqueueManyResult>> {
    if (typeof requests !== 'object' || requests === null) {
      return definition('requests', 'must be an array')
    }
    try {
      if (!Array.isArray(requests)) return definition('requests', 'must be an array')
    } catch {
      return definition('requests', 'must be an array')
    }
    const requestGraph = snapshotDataGraph(requests, 'requests')
    if (Result.isError(requestGraph))
      return requestGraph as StoreResult<JobStoreNamespace.EnqueueManyResult>
    const requestSnapshot = requestGraph.value as readonly unknown[]
    const validated: Record<string, unknown>[] = []
    for (const [index, request] of requestSnapshot.entries()) {
      const checked = validateEnqueueRequest(request, `requests[${index}]`)
      if (Result.isError(checked))
        return checked as StoreResult<JobStoreNamespace.EnqueueManyResult>
      validated.push(checked.value)
    }
    return this.withTx('enqueue', async (tx) => {
      const out: JobStoreNamespace.EnqueueResult[] = []
      for (const [index, input] of validated.entries()) {
        const hasJob = Object.prototype.hasOwnProperty.call(input, 'job')
        const identity = hasJob
          ? (input.job as { queue: string; name: string; version: number })
          : input.identity
        const normalizedIdentity = normalizeIdentity(
          identity,
          `requests[${index}].${hasJob ? 'job' : 'identity'}`
        )
        if (Result.isError(normalizedIdentity)) throw normalizedIdentity.error
        const explicitId = input.id === undefined ? undefined : makeJobId(input.id)
        if (explicitId !== undefined && Result.isError(explicitId)) throw explicitId.error
        const explicit =
          explicitId === undefined
            ? undefined
            : (
                await tx.query<Row>(
                  `SELECT ${columnNames.join(',')} FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND id=$2 FOR UPDATE`,
                  [this.client.namespace, explicitId.value]
                )
              ).rows[0]
        if (explicit !== undefined) {
          out.push({ job: decodeJob(explicit), duplicate: true })
          continue
        }
        const dedupeKey = explicitId === undefined ? input.idempotencyKey : undefined
        const existing =
          dedupeKey === undefined
            ? undefined
            : (
                await tx.query<Row>(
                  `SELECT ${columnNames.join(',')} FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND queue=$2 AND name=$3 AND version=$4 AND dedupe_key=$5 FOR UPDATE`,
                  [
                    this.client.namespace,
                    normalizedIdentity.value.queue,
                    normalizedIdentity.value.name,
                    normalizedIdentity.value.version,
                    dedupeKey
                  ]
                )
              ).rows[0]
        if (existing !== undefined) {
          out.push({ job: decodeJob(existing), duplicate: true })
          continue
        }
        const id = explicitId?.value ?? (randomUUID() as never)
        const created = await tx.query<Row>(
          `INSERT INTO ${this.table(POSTGRES_TABLES.jobs)} (namespace,id,queue,name,version,state,payload,metadata,priority,run_at_ms,attempts_max,attempts_made,delivery_count,stalled_count,created_at_ms,updated_at_ms,backoff,timeout_ms,idempotency_key,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,0,0,0,$12,$12,$13::jsonb,$14,$15,$16) ON CONFLICT DO NOTHING RETURNING ${columnNames.join(',')}`,
          [
            this.client.namespace,
            id,
            normalizedIdentity.value.queue,
            normalizedIdentity.value.name,
            normalizedIdentity.value.version,
            (input.runAt as number) <= (input.now as number) ? 'waiting' : 'delayed',
            json(input.payload),
            json(input.metadata === undefined ? {} : input.metadata),
            input.priority === undefined ? 0 : input.priority,
            input.runAt,
            input.attemptsMax,
            input.now,
            input.backoff === undefined ? null : json(input.backoff),
            input.timeoutMs ?? null,
            input.idempotencyKey ?? null,
            dedupeKey ?? null
          ]
        )
        let createdRow = created.rows[0]
        if (createdRow === undefined) {
          if (explicitId === undefined && dedupeKey === undefined)
            throw new JobStoreFailure({
              operation: 'enqueue',
              retryable: false,
              message: 'generated job ID collided'
            })
          const conflict =
            explicitId !== undefined
              ? (
                  await tx.query<Row>(
                    `SELECT ${columnNames.join(',')} FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND id=$2 FOR UPDATE`,
                    [this.client.namespace, explicitId.value]
                  )
                ).rows[0]
              : (
                  await tx.query<Row>(
                    `SELECT ${columnNames.join(',')} FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND queue=$2 AND name=$3 AND version=$4 AND dedupe_key=$5 FOR UPDATE`,
                    [
                      this.client.namespace,
                      normalizedIdentity.value.queue,
                      normalizedIdentity.value.name,
                      normalizedIdentity.value.version,
                      dedupeKey
                    ]
                  )
                ).rows[0]
          createdRow = conflict
          if (createdRow === undefined) throw new Error('enqueue conflict row is missing')
          out.push({ job: decodeJob(createdRow), duplicate: true })
          continue
        }
        const record = decodeJob(createdRow)
        out.push({ job: record, duplicate: false })
        await this.notify(tx, record.queue, input.now as number)
      }
      return Object.freeze(out)
    }) as Promise<StoreResult<JobStoreNamespace.EnqueueManyResult>>
  }
  async claim(
    request: JobStoreNamespace.ClaimRequest
  ): Promise<StoreResult<JobStoreNamespace.ClaimResult>> {
    const checked = validateDto(
      request,
      'request',
      ['queue', 'accepted', 'limit', 'workerId', 'leaseDurationMs', 'now'],
      ['queue', 'accepted', 'limit', 'workerId', 'leaseDurationMs', 'now']
    )
    if (Result.isError(checked)) return checked as StoreResult<JobStoreNamespace.ClaimResult>
    request = checked.value
    try {
      const queue = makeQueueName(request.queue)
      const workerId = makeWorkerId(request.workerId)
      const limit = safeNumber(request.limit, 'limit')
      const leaseDuration = safeNumber(request.leaseDurationMs, 'leaseDurationMs')
      const now = safeNumber(request.now, 'now')
      if (Result.isError(queue)) return queue as StoreResult<JobStoreNamespace.ClaimResult>
      if (Result.isError(workerId)) return workerId as StoreResult<JobStoreNamespace.ClaimResult>
      if (queue.value.includes('\u0000')) return definition('queue', 'must not contain NUL')
      if (workerId.value.includes('\u0000')) return definition('workerId', 'must not contain NUL')
      if (limit < 1) return definition('limit', 'must be positive')
      if (leaseDuration < 1) return definition('leaseDurationMs', 'must be positive')
      if (now > Number.MAX_SAFE_INTEGER - leaseDuration)
        return definition('leaseDurationMs', 'lease expiry exceeds safe integer range')
      if (!Array.isArray(request.accepted)) return definition('accepted', 'must be an array')
      const acceptedGraph = snapshotDataGraph(request.accepted, 'accepted')
      if (Result.isError(acceptedGraph))
        return acceptedGraph as StoreResult<JobStoreNamespace.ClaimResult>
      const acceptedSnapshot = acceptedGraph.value as readonly unknown[]
      const accepted = acceptedSnapshot.map((identity: unknown) => {
        const normalized = normalizeIdentity(identity, 'accepted')
        if (Result.isError(normalized)) throw normalized.error
        return normalized.value
      })
      return this.withTx('claim', async (tx) => {
        // Serialize claim with queue wake mutations so the returned baseline
        // cannot race an enqueue or pause committed between the checks.
        await tx.query(
          `INSERT INTO ${this.table(POSTGRES_TABLES.queues)} (namespace,queue,updated_at_ms) VALUES ($1,$2,$3) ON CONFLICT (namespace,queue) DO NOTHING`,
          [this.client.namespace, queue.value, now]
        )
        const queueState = await tx.query<Row>(
          `SELECT paused,wake_version FROM ${this.table(POSTGRES_TABLES.queues)} WHERE namespace=$1 AND queue=$2 FOR UPDATE`,
          [this.client.namespace, queue.value]
        )
        const queueRow = queueState.rows[0]
        if (queueRow?.paused === true) {
          return {
            jobs: Object.freeze([]),
            wakeToken: makeWakeToken(await this.wakeSnapshot(tx)),
            nextRunAt: undefined
          }
        }
        const rows = await tx.query<Row>(
          `SELECT ${columnNames.join(',')} FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND queue=$2 AND state IN ('waiting','delayed') AND run_at_ms <= $3 AND (queue,name,version) IN (SELECT queue,name,version FROM jsonb_to_recordset($4::jsonb) AS x(queue text,name text,version bigint)) ORDER BY priority DESC,run_at_ms,sequence,id COLLATE "C" LIMIT $5 FOR UPDATE SKIP LOCKED`,
          [this.client.namespace, queue.value, now, json(accepted), limit]
        )
        const jobs: JobRecord[] = []
        for (const raw of rows.rows) {
          const current = decodeJob(raw)
          const token = randomUUID() as never
          const changed = reduceJob(current, {
            type: 'claim',
            jobId: current.id,
            workerId: workerId.value,
            leaseToken: token,
            leaseExpiresAt: now + leaseDuration,
            now
          })
          if (Result.isError(changed)) throw changed.error
          const saved = await this.save(tx, changed.value.record, current)
          if (!saved) continue
          await this.clearSettlement(tx, changed.value.record.id)
          jobs.push(changed.value.record)
        }
        const due = await tx.query<Row>(
          `SELECT MIN(run_at_ms) AS run_at_ms FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND queue=$2 AND state='delayed' AND run_at_ms > $3 AND (queue,name,version) IN (SELECT queue,name,version FROM jsonb_to_recordset($4::jsonb) AS x(queue text,name text,version bigint))`,
          [this.client.namespace, queue.value, now, json(accepted)]
        )
        const nextRunAt =
          due.rows[0]?.run_at_ms == null ? undefined : integer(due.rows[0].run_at_ms, 'run_at_ms')
        return {
          jobs: Object.freeze(jobs),
          wakeToken: makeWakeToken(await this.wakeSnapshot(tx)),
          nextRunAt
        }
      }) as Promise<StoreResult<JobStoreNamespace.ClaimResult>>
    } catch (cause) {
      return fail('claim', cause)
    }
  }
  async settle(
    request: JobStoreNamespace.SettleRequest
  ): Promise<StoreResult<JobStoreNamespace.SettlementResult>> {
    const checked = validateDto(
      request,
      'request',
      ['jobId', 'leaseToken', 'outcome', 'now'],
      ['jobId', 'leaseToken', 'outcome', 'now', 'startedAt']
    )
    if (Result.isError(checked)) return checked as StoreResult<JobStoreNamespace.SettlementResult>
    request = checked.value
    try {
      const jobId = makeJobId(request.jobId)
      const leaseToken = makeLeaseToken(request.leaseToken)
      const now = safeNumber(request.now, 'now')
      if (Result.isError(jobId)) return jobId as StoreResult<JobStoreNamespace.SettlementResult>
      if (Result.isError(leaseToken))
        return leaseToken as StoreResult<JobStoreNamespace.SettlementResult>
      if (jobId.value.includes('\u0000')) return definition('jobId', 'must not contain NUL')
      if (leaseToken.value.includes('\u0000'))
        return definition('leaseToken', 'must not contain NUL')
      const outcome = validateSettlementOutcome(request.outcome)
      if (Result.isError(outcome)) return outcome as StoreResult<JobStoreNamespace.SettlementResult>
      const settlementOutcome = outcome.value as typeof request.outcome
      return this.withTx('settle', async (tx) => {
        const raw = await tx.query<Row>(
          `SELECT ${columnNames.join(',')},last_settlement_token,last_settlement_outcome,last_settlement_attempt_sequence FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND id=$2 FOR UPDATE`,
          [this.client.namespace, jobId.value]
        )
        const source = raw.rows[0]
        if (source === undefined) throw new JobNotFoundError({ jobId: jobId.value })
        const current = decodeJob(source)
        const previousToken = optionalString(source.last_settlement_token)
        const previousOutcome = optionalString(source.last_settlement_outcome)
        const previousAttemptSequence = optionalInteger(
          source.last_settlement_attempt_sequence,
          'last_settlement_attempt_sequence'
        )
        const canonicalOutcome = canonicalJson(settlementOutcome)
        if (
          previousToken === leaseToken.value &&
          previousOutcome !== undefined &&
          canonicalJson(parseJson(previousOutcome)) !== canonicalOutcome
        ) {
          throw new SettlementConflictError({
            jobId: jobId.value,
            leaseToken: leaseToken.value
          })
        }
        if (current.state !== 'active') {
          if (
            previousToken === leaseToken.value &&
            previousOutcome !== undefined &&
            previousAttemptSequence !== undefined &&
            canonicalJson(parseJson(previousOutcome)) === canonicalOutcome
          ) {
            const attemptRow = await tx.query<Row>(
              `SELECT attempt,attempt_sequence,delivery,started_at_ms,finished_at_ms,outcome,result,failure,retry_at_ms,retry_delay_ms FROM ${this.table(POSTGRES_TABLES.attempts)} WHERE namespace=$1 AND job_id=$2 AND attempt_sequence=$3 LIMIT 1`,
              [this.client.namespace, current.id, previousAttemptSequence]
            )
            const attempt = decodeAttempt(attemptRow.rows[0])
            if (attempt !== undefined)
              return { record: current, attempt, status: 'already-applied' }
          }
          throw new LeaseLostError({
            jobId: current.id,
            reason: 'missing-lease',
            leaseToken: leaseToken.value
          })
        }
        if (previousToken !== undefined) {
          if (
            previousToken !== leaseToken.value ||
            previousOutcome === undefined ||
            previousAttemptSequence === undefined ||
            canonicalJson(parseJson(previousOutcome)) !== canonicalOutcome
          ) {
            throw new SettlementConflictError({
              jobId: jobId.value,
              leaseToken: leaseToken.value
            })
          }
          const attemptRow = await tx.query<Row>(
            `SELECT attempt,attempt_sequence,delivery,started_at_ms,finished_at_ms,outcome,result,failure,retry_at_ms,retry_delay_ms FROM ${this.table(POSTGRES_TABLES.attempts)} WHERE namespace=$1 AND job_id=$2 AND attempt_sequence=$3 LIMIT 1`,
            [this.client.namespace, current.id, previousAttemptSequence]
          )
          const attempt = decodeAttempt(attemptRow.rows[0])
          if (attempt === undefined)
            throw new JobStoreFailure({
              operation: 'settle',
              retryable: false,
              message: 'settlement attempt is missing'
            })
          return { record: current, attempt, status: 'already-applied' }
        }
        const next = reduceJob(current, {
          type: 'settle',
          jobId: current.id,
          leaseToken: leaseToken.value,
          outcome: settlementOutcome,
          now,
          ...(request.startedAt === undefined ? {} : { startedAt: request.startedAt })
        })
        if (Result.isError(next)) throw next.error
        if (next.value.attempt === undefined)
          throw new JobDefinitionError({
            field: 'attempt',
            message: 'settlement did not record an attempt'
          })
        const transition = await this.prepareTransition(tx, current, next.value)
        await this.save(tx, transition.record)
        await this.insertAttempt(tx, transition.attempt!, current.id, current.leaseOwner)
        await tx.query(
          `UPDATE ${this.table(POSTGRES_TABLES.jobs)} SET last_settlement_token=$3,last_settlement_outcome=$4,last_settlement_attempt_sequence=$5 WHERE namespace=$1 AND id=$2`,
          [
            this.client.namespace,
            current.id,
            leaseToken.value,
            canonicalOutcome,
            transition.attempt!.attemptSequence ?? transition.attempt!.attempt
          ]
        )
        await this.notify(tx, current.queue, now)
        return { record: transition.record, attempt: transition.attempt!, status: 'applied' }
      }) as Promise<StoreResult<JobStoreNamespace.SettlementResult>>
    } catch (cause) {
      return fail('settle', cause)
    }
  }
  async release(request: JobStoreNamespace.ReleaseRequest): Promise<StoreResult<JobTransition>> {
    const checked = validateDto(
      request,
      'request',
      ['jobId', 'leaseToken', 'now'],
      ['jobId', 'leaseToken', 'now']
    )
    if (Result.isError(checked)) return checked as StoreResult<JobTransition>
    request = checked.value
    try {
      const jobId = makeJobId(request.jobId)
      const leaseToken = makeLeaseToken(request.leaseToken)
      const now = safeNumber(request.now, 'now')
      if (Result.isError(jobId)) return jobId as StoreResult<JobTransition>
      if (Result.isError(leaseToken)) return leaseToken as StoreResult<JobTransition>
      if (jobId.value.includes('\u0000')) return definition('jobId', 'must not contain NUL')
      if (leaseToken.value.includes('\u0000'))
        return definition('leaseToken', 'must not contain NUL')
      return this.transition('release', { jobId: jobId.value, now }, (r) => {
        if (r.state !== 'active')
          return Result.err(
            new LeaseLostError({
              jobId: r.id,
              reason: 'missing-lease',
              leaseToken: leaseToken.value
            })
          ) as ResultType<JobTransition, any>
        return reduceJob(r, {
          type: 'release',
          jobId: r.id,
          leaseToken: leaseToken.value,
          now
        })
      })
    } catch (cause) {
      return fail('release', cause)
    }
  }
  async heartbeat(
    request: JobStoreNamespace.HeartbeatRequest
  ): Promise<StoreResult<JobStoreNamespace.HeartbeatResult>> {
    const checked = validateDto(
      request,
      'request',
      ['leases', 'leaseDurationMs', 'now'],
      ['leases', 'leaseDurationMs', 'now']
    )
    if (Result.isError(checked)) return checked as StoreResult<JobStoreNamespace.HeartbeatResult>
    request = checked.value
    try {
      const now = safeNumber(request.now, 'now')
      const duration = safeNumber(request.leaseDurationMs, 'leaseDurationMs')
      if (duration < 1) return definition('leaseDurationMs', 'must be positive')
      if (now > Number.MAX_SAFE_INTEGER - duration)
        return definition('leaseDurationMs', 'lease expiry exceeds safe integer range')
      if (!Array.isArray(request.leases)) return definition('leases', 'must be an array')
      const leasesGraph = snapshotDataGraph(request.leases, 'leases')
      if (Result.isError(leasesGraph))
        return leasesGraph as StoreResult<JobStoreNamespace.HeartbeatResult>
      const leasesSnapshot = leasesGraph.value as readonly unknown[]
      const seen = new Set<string>()
      const leases = leasesSnapshot.map((lease: unknown, index: number) => {
        const fields = validateDto(
          lease,
          `leases[${index}]`,
          ['jobId', 'leaseToken'],
          ['jobId', 'leaseToken']
        )
        if (Result.isError(fields)) throw fields.error
        const raw = fields.value as { jobId: unknown; leaseToken: unknown }
        const jobId = makeJobId(raw.jobId)
        const leaseToken = makeLeaseToken(raw.leaseToken)
        if (Result.isError(jobId)) throw jobId.error
        if (Result.isError(leaseToken)) throw leaseToken.error
        if (jobId.value.includes('\u0000'))
          throw new JobDefinitionError({
            field: `leases[${index}].jobId`,
            message: 'must not contain NUL'
          })
        if (leaseToken.value.includes('\u0000'))
          throw new JobDefinitionError({
            field: `leases[${index}].leaseToken`,
            message: 'must not contain NUL'
          })
        if (seen.has(jobId.value))
          throw new JobDefinitionError({
            field: 'leases',
            message: 'must not contain duplicate job IDs'
          })
        seen.add(jobId.value)
        return { jobId: jobId.value, leaseToken: leaseToken.value }
      })
      return this.withTx('heartbeat', async (tx) => {
        const renewed = [] as JobRecord[]
        const lost = [] as JobStoreNamespace.LostLease[]
        const cancellationRequested = [] as never[]
        for (const lease of leases) {
          const r = await this.row(tx, lease.jobId, true)
          if (!r) {
            lost.push(
              Object.freeze({
                jobId: lease.jobId as never,
                leaseToken: lease.leaseToken as never,
                reason: 'missing-lease'
              })
            )
            continue
          }
          if (r.state !== 'active') {
            lost.push(
              Object.freeze({
                jobId: lease.jobId as never,
                leaseToken: lease.leaseToken as never,
                reason: 'missing-lease'
              })
            )
            continue
          }
          if (now < r.updatedAt)
            throw new JobDefinitionError({
              field: 'now',
              message: 'must not be earlier than updatedAt'
            })
          if (r.leaseToken !== lease.leaseToken) {
            lost.push(
              Object.freeze({
                jobId: lease.jobId as never,
                leaseToken: lease.leaseToken as never,
                reason: 'mismatched-token'
              })
            )
            continue
          }
          if (r.leaseExpiresAt === undefined || now >= r.leaseExpiresAt) {
            lost.push(
              Object.freeze({
                jobId: lease.jobId as never,
                leaseToken: lease.leaseToken as never,
                reason: 'expired-lease'
              })
            )
            continue
          }
          if (r.cancellationRequestedAt !== undefined) {
            cancellationRequested.push(r.id as never)
            continue
          }
          const n = makeJobRecord({ ...r, leaseExpiresAt: now + duration, updatedAt: now })
          if (Result.isError(n)) throw n.error
          await this.save(tx, n.value)
          renewed.push(n.value)
        }
        return {
          renewed: Object.freeze(renewed) as never,
          lost: Object.freeze(lost),
          cancellationRequested: Object.freeze(cancellationRequested)
        }
      }) as Promise<StoreResult<JobStoreNamespace.HeartbeatResult>>
    } catch (cause) {
      return fail('heartbeat', cause)
    }
  }
  async recoverStalled(
    request: JobStoreNamespace.RecoverStalledRequest
  ): Promise<StoreResult<JobStoreNamespace.RecoverStalledResult>> {
    const checked = validateDto(
      request,
      'request',
      ['maxStalledCount', 'now'],
      ['maxStalledCount', 'limit', 'now']
    )
    if (Result.isError(checked))
      return checked as StoreResult<JobStoreNamespace.RecoverStalledResult>
    request = checked.value
    try {
      const maximum = safeNumber(request.maxStalledCount, 'maxStalledCount')
      const now = safeNumber(request.now, 'now')
      const limit =
        request.limit === undefined
          ? Number.MAX_SAFE_INTEGER - 1
          : safeNumber(request.limit, 'limit')
      if (limit < 1) return definition('limit', 'must be positive')
      return this.withTx('recoverStalled', async (tx) => {
        const rows = await tx.query<Row>(
          `SELECT ${columnNames.join(',')} FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND state='active' AND lease_expires_at_ms <= $2 ORDER BY lease_expires_at_ms LIMIT $3 FOR UPDATE SKIP LOCKED`,
          [this.client.namespace, now, limit]
        )
        const transitions = [] as JobTransition[]
        for (const raw of rows.rows) {
          const r = decodeJob(raw)
          const n = recoverStalledWithPolicy(
            r as never,
            { type: 'recover-stalled', jobId: r.id, now } as never,
            r.stalledCount >= maximum
          ) as unknown as ResultType<JobTransition, any>
          if (Result.isError(n)) throw n.error
          const transition = await this.prepareTransition(tx, r, n.value)
          await this.save(tx, transition.record)
          if (transition.attempt)
            await this.insertAttempt(tx, transition.attempt, r.id, r.leaseOwner)
          await this.notify(tx, r.queue, now)
          transitions.push(transition)
        }
        return { transitions: Object.freeze(transitions), recovered: transitions.length }
      }) as Promise<StoreResult<JobStoreNamespace.RecoverStalledResult>>
    } catch (cause) {
      return fail('recoverStalled', cause)
    }
  }
  async awaitWake(request: JobStoreNamespace.AwaitWakeRequest): Promise<StoreResult<void>> {
    const aborted = (): StoreResult<void> =>
      Result.err(new JobStoreWakeAbortedError()) as unknown as StoreResult<void>
    const checked = validateDto(
      request,
      'request',
      ['queues', 'wakeToken', 'signal'],
      ['queues', 'wakeToken', 'signal']
    )
    if (Result.isError(checked)) return checked as StoreResult<void>
    request = checked.value
    try {
      if (this.closed) return fail('awaitWake', new Error('store is closed'))
      if (!Array.isArray(request.queues)) return definition('queues', 'must be an array')
      const queuesGraph = snapshotDataGraph(request.queues, 'queues')
      if (Result.isError(queuesGraph)) return queuesGraph as StoreResult<void>
      const queuesSnapshot = queuesGraph.value as readonly unknown[]
      if (
        typeof request.signal?.aborted !== 'boolean' ||
        typeof request.signal.addEventListener !== 'function' ||
        typeof request.signal.removeEventListener !== 'function'
      ) {
        return fail('awaitWake', new Error('signal must be an AbortSignal'))
      }
      const baseline = parseWakeToken(request.wakeToken)
      if (Result.isError(baseline)) return baseline as StoreResult<void>
      const queues: string[] = []
      for (const value of queuesSnapshot) {
        const queue = makeQueueName(value)
        if (Result.isError(queue)) return queue as StoreResult<void>
        if (queue.value.includes('\u0000')) return definition('queues', 'must not contain NUL')
        if (!queues.includes(queue.value)) queues.push(queue.value)
      }
      if (request.signal.aborted) return aborted()
      if (await this.hasRelevantWake(baseline.value, queues)) return ok(undefined)
      if (this.closed) return fail('awaitWake', new Error('store is closed'))
      const signal = request.signal as AbortSignal
      return new Promise<StoreResult<void>>((resolve) => {
        let waiter: WakeWaiter
        waiter = {
          queues,
          baseline: baseline.value,
          signal,
          resolve,
          onAbort: () => this.finishWaiter(waiter, aborted()),
          settled: false
        }
        this.waiters.add(waiter)
        try {
          waiter.timer = setInterval(() => void this.checkWaiter(waiter), 250)
          signal.addEventListener('abort', waiter.onAbort, { once: true })
          void this.checkWaiter(waiter)
        } catch (cause) {
          this.finishWaiter(waiter, fail('awaitWake', cause))
        }
      })
    } catch (cause) {
      return fail('awaitWake', cause)
    }
  }
  async getJob(
    request: JobStoreNamespace.GetJobRequest
  ): Promise<StoreResult<JobRecord | undefined>> {
    const jobId = normalizeJobId(request)
    if (Result.isError(jobId)) return jobId as StoreResult<JobRecord | undefined>
    return this.withTx('getJob', async (tx) => this.row(tx, jobId.value))
  }
  async getAttempts(
    request: JobStoreNamespace.GetAttemptsRequest
  ): Promise<StoreResult<readonly AttemptRecord[]>> {
    const jobId = normalizeJobId(request)
    if (Result.isError(jobId)) return jobId as StoreResult<readonly AttemptRecord[]>
    return this.withTx('getAttempts', async (tx) => {
      const rows = await tx.query<Row>(
        `SELECT attempt,attempt_sequence,delivery,started_at_ms,finished_at_ms,outcome,result,failure,retry_at_ms,retry_delay_ms FROM ${this.table(POSTGRES_TABLES.attempts)} WHERE namespace=$1 AND job_id=$2 ORDER BY ledger_sequence`,
        [this.client.namespace, jobId.value]
      )
      return Object.freeze(
        rows.rows.map((r) => {
          const a = decodeAttempt(r)
          if (a === undefined)
            throw new JobDefinitionError({ field: 'attempt', message: 'missing attempt' })
          return a
        })
      )
    }) as Promise<StoreResult<readonly AttemptRecord[]>>
  }
  async list(
    request: JobStoreNamespace.ListJobsRequest
  ): Promise<StoreResult<JobStoreNamespace.ListJobsResult>> {
    const unsupported = firstUnsupportedField(request, [
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
    if (unsupported !== undefined)
      return Result.err(
        new UnsupportedJobStoreOperationError({ operation: `list.${unsupported}` })
      ) as StoreResult<JobStoreNamespace.ListJobsResult>
    const checked = validateDto(
      request,
      'request',
      ['limit'],
      ['queue', 'name', 'version', 'state', 'metadata', 'orderBy', 'order', 'limit', 'cursor']
    )
    if (Result.isError(checked)) return checked as StoreResult<JobStoreNamespace.ListJobsResult>
    request = checked.value
    try {
      const queue = request.queue === undefined ? undefined : makeQueueName(request.queue)
      const name = request.name === undefined ? undefined : makeJobName(request.name)
      if (queue !== undefined && Result.isError(queue))
        return queue as StoreResult<JobStoreNamespace.ListJobsResult>
      if (name !== undefined && Result.isError(name))
        return name as StoreResult<JobStoreNamespace.ListJobsResult>
      if (queue !== undefined && queue.value.includes('\u0000'))
        return definition('queue', 'must not contain NUL')
      if (name !== undefined && name.value.includes('\u0000'))
        return definition('name', 'must not contain NUL')
      const version =
        request.version === undefined ? undefined : safeNumber(request.version, 'version')
      if (version !== undefined && version < 1) return definition('version', 'must be positive')
      const orderBy = (
        request.orderBy === undefined ? 'enqueuedAt' : request.orderBy
      ) as JobListOrderBy
      const order = (request.order === undefined ? 'asc' : request.order) as JobListOrder
      if (!['enqueuedAt', 'runAt', 'finishedAt'].includes(orderBy))
        return definition('orderBy', 'must be enqueuedAt, runAt, or finishedAt')
      if (order !== 'asc' && order !== 'desc') return definition('order', 'must be asc or desc')
      const limit = safeNumber(request.limit, 'limit')
      if (limit < 1 || limit >= Number.MAX_SAFE_INTEGER - 1)
        return definition('limit', 'must be a positive bounded integer')
      let states: readonly import('better-effect-mq').JobState[] | undefined =
        request.state === undefined
          ? undefined
          : Array.isArray(request.state)
            ? request.state
            : [request.state]
      if (states !== undefined) {
        const statesGraph = snapshotDataGraph(states, 'state', false)
        if (Result.isError(statesGraph))
          return statesGraph as StoreResult<JobStoreNamespace.ListJobsResult>
        states = statesGraph.value as typeof states
      }
      if (
        states !== undefined &&
        (states.length === 0 ||
          states.some((state: unknown) => !validJobStates.has(state as string)))
      )
        return definition('state', 'contains an unsupported job state')
      let metadata = request.metadata
      if (metadata !== undefined) {
        const checkedMetadata = validateMetadata(metadata, 'metadata')
        if (Result.isError(checkedMetadata)) return checkedMetadata
        metadata = checkedMetadata.value
      }
      const signature = listSignature(
        {
          ...request,
          queue: queue && queue.value,
          name: name && name.value,
          version,
          state: states,
          metadata
        },
        orderBy,
        order
      )
      const cursor = request.cursor
      let cursorInput: JobListCursor | undefined
      if (cursor !== undefined) {
        const cursorFields = validateDto(
          cursor,
          'cursor',
          [
            'version',
            'orderBy',
            'order',
            'ordering',
            'direction',
            'filterSignature',
            'value',
            'createdAt',
            'orderingSequence',
            'id'
          ],
          [
            'version',
            'orderBy',
            'order',
            'ordering',
            'direction',
            'filterSignature',
            'value',
            'createdAt',
            'orderingSequence',
            'id'
          ]
        )
        if (Result.isError(cursorFields))
          return cursorFields as StoreResult<JobStoreNamespace.ListJobsResult>
        cursorInput = cursorFields.value as JobListCursor
        if (
          cursorInput.version !== 1 ||
          cursorInput.orderBy !== orderBy ||
          cursorInput.order !== order ||
          cursorInput.direction !== order ||
          cursorInput.ordering !== cursorOrdering(orderBy) ||
          typeof cursorInput.filterSignature !== 'string'
        )
          return Result.err(
            new UnsupportedJobStoreOperationError({ operation: 'list.cursor-version' })
          ) as StoreResult<JobStoreNamespace.ListJobsResult>
        const cursorId = makeJobId(cursorInput.id)
        if (Result.isError(cursorId))
          return cursorId as StoreResult<JobStoreNamespace.ListJobsResult>
        if (cursorId.value.includes('\u0000'))
          return definition('cursor.id', 'must not contain NUL')
        if (
          cursorInput.filterSignature.includes('\u0000') ||
          hasUnpairedSurrogate(cursorInput.filterSignature)
        )
          return definition('cursor.filterSignature', 'must be a well-formed string without NUL')
        if (cursorInput.filterSignature !== signature)
          return Result.err(
            new UnsupportedJobStoreOperationError({ operation: 'list.cursor-options' })
          ) as StoreResult<JobStoreNamespace.ListJobsResult>
        if (cursorInput.value === null && orderBy !== 'finishedAt')
          return definition('cursor.value', 'null is only valid for finishedAt')
        if (cursorInput.value !== null) safeNumber(cursorInput.value, 'cursor.value')
        safeNumber(cursorInput.createdAt, 'cursor.createdAt')
        safeNumber(cursorInput.orderingSequence, 'cursor.orderingSequence')
      }
      return this.withTx('list', async (tx) => {
        const values: unknown[] = [this.client.namespace]
        const where = ['namespace=$1']
        const add = (sql: string, value: unknown) => {
          values.push(value)
          where.push(sql.replace('$N', `$${values.length}`))
        }
        const parameter = (value: unknown): string => {
          values.push(value)
          return `$${values.length}`
        }
        if (queue !== undefined) add('queue=$N', queue.value)
        if (name !== undefined) add('name=$N', name.value)
        if (version !== undefined) add('version=$N', version)
        if (states !== undefined) add('state=ANY($N::text[])', states)
        if (metadata !== undefined) {
          values.push(json(metadata))
          const metadataParameter = `$${values.length}::jsonb`
          where.push(`metadata @> ${metadataParameter} AND metadata <@ ${metadataParameter}`)
        }
        const column =
          orderBy === 'enqueuedAt'
            ? 'created_at_ms'
            : orderBy === 'runAt'
              ? 'run_at_ms'
              : 'finished_at_ms'
        if (cursorInput !== undefined) {
          const value = cursorInput.value
          const cmp = order === 'asc' ? '>' : '<'
          const sequence = parameter(cursorInput.orderingSequence)
          const id = parameter(cursorInput.id)
          if (value === null) {
            const nullTie = `(sequence ${cmp} ${sequence} OR (sequence = ${sequence} AND id COLLATE "C" ${cmp} ${id}))`
            where.push(
              order === 'desc'
                ? `((${column} IS NULL AND ${nullTie}) OR ${column} IS NOT NULL)`
                : `(${column} IS NULL AND ${nullTie})`
            )
          } else {
            const primary = parameter(value)
            const tie = `(${column} = ${primary} AND (sequence ${cmp} ${sequence} OR (sequence = ${sequence} AND id COLLATE "C" ${cmp} ${id})))`
            where.push(
              order === 'asc'
                ? `(${column} > ${primary} OR ${column} IS NULL OR ${tie})`
                : `(${column} < ${primary} OR ${tie})`
            )
          }
        }
        const limitParameter = parameter(limit + 1)
        const direction = order === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST'
        const rows = await tx.query<Row>(
          `SELECT ${columnNames.join(',')} FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE ${where.join(' AND ')} ORDER BY ${column} ${direction},sequence ${order},id COLLATE "C" ${order} LIMIT ${limitParameter}`,
          values
        )
        const page = rows.rows.slice(0, limit)
        const last = page.at(-1)
        const nextCursor =
          rows.rows.length > limit && last !== undefined
            ? Object.freeze({
                version: 1 as const,
                orderBy,
                order,
                direction: order,
                ordering: cursorOrdering(orderBy),
                filterSignature: signature,
                value: listValue(last, orderBy),
                createdAt: integer(last.created_at_ms, 'created_at_ms'),
                orderingSequence: integer(last.sequence, 'sequence'),
                id: text(last.id, 'id') as never
              })
            : undefined
        return { jobs: Object.freeze(page.map(decodeJob)), nextCursor }
      }) as Promise<StoreResult<JobStoreNamespace.ListJobsResult>>
    } catch (cause) {
      return fail('list', cause)
    }
  }
  async counts(
    request: JobStoreNamespace.CountsRequest = {}
  ): Promise<StoreResult<JobStoreNamespace.JobCounts>> {
    const unsupported = firstUnsupportedField(request, ['queue', 'name'])
    if (unsupported !== undefined)
      return Result.err(
        new UnsupportedJobStoreOperationError({ operation: `counts.${unsupported}` })
      ) as StoreResult<JobStoreNamespace.JobCounts>
    const checked = validateDto(request, 'request', [], ['queue', 'name'])
    if (Result.isError(checked)) return checked as StoreResult<JobStoreNamespace.JobCounts>
    request = checked.value
    return this.withTx('counts', async (tx) => {
      const queue = request.queue === undefined ? undefined : makeQueueName(request.queue)
      const name = request.name === undefined ? undefined : makeJobName(request.name)
      if (queue !== undefined && Result.isError(queue)) throw queue.error
      if (name !== undefined && Result.isError(name)) throw name.error
      if (queue !== undefined && queue.value.includes('\u0000'))
        throw new JobDefinitionError({ field: 'queue', message: 'must not contain NUL' })
      if (name !== undefined && name.value.includes('\u0000'))
        throw new JobDefinitionError({ field: 'name', message: 'must not contain NUL' })
      const values: unknown[] = [this.client.namespace]
      const where = ['namespace=$1']
      if (queue !== undefined) {
        values.push(queue.value)
        where.push(`queue=$${values.length}`)
      }
      if (name !== undefined) {
        values.push(name.value)
        where.push(`name=$${values.length}`)
      }
      const rows = await tx.query<Row>(
        `SELECT state,count(*)::bigint AS count FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE ${where.join(' AND ')} GROUP BY state`,
        values
      )
      const out = {
        total: 0,
        waiting: 0,
        delayed: 0,
        active: 0,
        completed: 0,
        failed: 0,
        cancelled: 0
      }
      for (const r of rows.rows) {
        if (!validJobStates.has(r.state as string))
          throw new JobDefinitionError({
            field: 'state',
            message: 'contains an unsupported job state'
          })
        const n = integer(r.count, 'count')
        if (n < 0 || out.total > Number.MAX_SAFE_INTEGER - n)
          throw new JobDefinitionError({ field: 'count', message: 'is outside the safe range' })
        out.total += n
        out[r.state as keyof typeof out] = n
      }
      return out
    }) as Promise<StoreResult<JobStoreNamespace.JobCounts>>
  }
  async retry(request: JobStoreNamespace.RetryRequest): Promise<StoreResult<JobTransition>> {
    const checked = normalizeJobIdRequest(request, ['jobId', 'runAt', 'now'])
    if (Result.isError(checked)) return checked as StoreResult<JobTransition>
    try {
      const runAt = safeNumber(checked.value.runAt, 'runAt')
      return this.transition('retry', checked.value, (r) =>
        reduceJob(r, { type: 'retry', jobId: r.id, runAt, now: checked.value.now })
      )
    } catch (cause) {
      return fail('retry', cause)
    }
  }
  async cancel(request: JobStoreNamespace.CancelRequest): Promise<StoreResult<JobTransition>> {
    const checked = normalizeJobIdRequest(request)
    if (Result.isError(checked)) return checked as StoreResult<JobTransition>
    return this.transition('cancel', checked.value, (r) =>
      reduceJob(r, { type: 'cancel', jobId: r.id, now: checked.value.now })
    )
  }
  async requestCancellation(
    request: JobStoreNamespace.RequestCancellationRequest
  ): Promise<StoreResult<JobTransition>> {
    const checked = normalizeJobIdRequest(request)
    if (Result.isError(checked)) return checked as StoreResult<JobTransition>
    return this.transition('requestCancellation', checked.value, (r) =>
      reduceJob(r, { type: 'request-cancellation', jobId: r.id, now: checked.value.now })
    )
  }
  async promote(request: JobStoreNamespace.PromoteRequest): Promise<StoreResult<JobTransition>> {
    const checked = normalizeJobIdRequest(request)
    if (Result.isError(checked)) return checked as StoreResult<JobTransition>
    return this.transition('promote', checked.value, (r) =>
      reduceJob(r, { type: 'promote', jobId: r.id, now: checked.value.now })
    )
  }
  async remove(
    request: JobStoreNamespace.RemoveRequest
  ): Promise<StoreResult<JobStoreNamespace.RemoveResult>> {
    const checked = validateDto(
      request,
      'request',
      ['jobId', 'now'],
      ['jobId', 'now', 'expectedState']
    )
    if (Result.isError(checked)) return checked as StoreResult<JobStoreNamespace.RemoveResult>
    request = checked.value
    try {
      const jobId = makeJobId(request.jobId)
      const now = safeNumber(request.now, 'now')
      if (Result.isError(jobId)) return jobId as StoreResult<JobStoreNamespace.RemoveResult>
      if (jobId.value.includes('\u0000')) return definition('jobId', 'must not contain NUL')
      if (
        request.expectedState !== undefined &&
        !['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'].includes(
          request.expectedState
        )
      )
        return definition('expectedState', 'unsupported job state')
      return this.withTx('remove', async (tx) => {
        const r = await this.row(tx, jobId.value, true)
        if (!r) throw new JobNotFoundError({ jobId: jobId.value })
        if (now < r.updatedAt)
          throw new JobDefinitionError({
            field: 'now',
            message: 'must not be earlier than updatedAt'
          })
        if (request.expectedState !== undefined && r.state !== request.expectedState)
          throw new InvalidJobTransitionError({ jobId: r.id, from: r.state, operation: 'remove' })
        if (r.state === 'active')
          throw new InvalidJobTransitionError({ jobId: r.id, from: r.state, operation: 'remove' })
        await tx.query(
          `DELETE FROM ${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND id=$2`,
          [this.client.namespace, r.id]
        )
        await this.notify(tx, r.queue, now)
        return { job: r, removed: true }
      }) as Promise<StoreResult<JobStoreNamespace.RemoveResult>>
    } catch (cause) {
      return fail('remove', cause)
    }
  }
  async pause(
    request: JobStoreNamespace.PauseQueueRequest
  ): Promise<StoreResult<JobStoreNamespace.QueuePauseResult>> {
    const checked = this.normalizePauseRequest(request)
    if (Result.isError(checked)) return checked as StoreResult<JobStoreNamespace.QueuePauseResult>
    return this.pauseResume(checked.value, true)
  }
  async resume(
    request: JobStoreNamespace.PauseQueueRequest
  ): Promise<StoreResult<JobStoreNamespace.QueuePauseResult>> {
    const checked = this.normalizePauseRequest(request)
    if (Result.isError(checked)) return checked as StoreResult<JobStoreNamespace.QueuePauseResult>
    return this.pauseResume(checked.value, false)
  }
  private normalizePauseRequest(
    request: unknown
  ): StoreResult<{ readonly queue: string; readonly now: number }> {
    const checked = validateDto(request, 'request', ['queue', 'now'], ['queue', 'now'])
    if (Result.isError(checked)) return checked as StoreResult<{ queue: string; now: number }>
    const input = checked.value as { queue: unknown; now: unknown }
    try {
      const queue = makeQueueName(input.queue)
      const now = safeNumber(input.now, 'now')
      if (Result.isError(queue)) return queue as StoreResult<{ queue: string; now: number }>
      if (queue.value.includes('\u0000')) return definition('queue', 'must not contain NUL')
      return ok({ queue: queue.value, now })
    } catch (cause) {
      return fail('request', cause)
    }
  }
  private async pauseResume(
    request: { readonly queue: string; readonly now: number },
    paused: boolean
  ): Promise<StoreResult<JobStoreNamespace.QueuePauseResult>> {
    return this.withTx(paused ? 'pause' : 'resume', async (tx) => {
      const result = await tx.query<Row>(
        `INSERT INTO ${this.table(POSTGRES_TABLES.queues)} (namespace,queue,paused,wake_version,updated_at_ms) VALUES ($1,$2,$3,1,$4) ON CONFLICT(namespace,queue) DO UPDATE SET paused=EXCLUDED.paused,updated_at_ms=EXCLUDED.updated_at_ms,wake_version=${this.table(POSTGRES_TABLES.queues)}.wake_version+1 WHERE ${this.table(POSTGRES_TABLES.queues)}.wake_version < 9007199254740991 RETURNING wake_version`,
        [this.client.namespace, request.queue, paused, request.now]
      )
      if (result.rows[0] === undefined) {
        throw new JobDefinitionError({
          field: 'wakeVersion',
          message: 'cannot exceed safe integer range'
        })
      }
      integer(result.rows[0].wake_version, 'wake_version')
      await this.emitNotification(tx, request.queue)
      return { queue: request.queue as never, paused }
    })
  }
  async pausedQueues(): Promise<StoreResult<readonly import('better-effect-mq').QueueName[]>> {
    return this.withTx('pausedQueues', async (tx) => {
      const rows = await tx.query<Row>(
        `SELECT queue FROM ${this.table(POSTGRES_TABLES.queues)} WHERE namespace=$1 AND paused ORDER BY queue COLLATE "C"`,
        [this.client.namespace]
      )
      return Object.freeze(
        rows.rows.map((r) => {
          const queue = makeQueueName(r.queue)
          if (Result.isError(queue)) throw queue.error
          if (queue.value.includes('\u0000'))
            throw new JobDefinitionError({ field: 'queue', message: 'must not contain NUL' })
          return queue.value
        })
      )
    })
  }
  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = this.disposeResources()
    return this.disposal
  }

  private async disposeResources(): Promise<void> {
    for (const waiter of this.waiters) {
      this.finishWaiter(waiter, fail('awaitWake', new Error('store is closed')))
    }
    const listener = this.listener
    this.listener = undefined
    let cleanup: unknown
    if (listener !== undefined) {
      try {
        await listener.client.query(`UNLISTEN ${quoteIdentifier(this.channel)}`)
      } catch (cause) {
        cleanup = cause
      }
      try {
        listener.client.removeListener?.('notification', listener.handler)
        listener.client.removeListener?.('error', listener.errorHandler)
      } catch (cause) {
        cleanup = cleanup === undefined ? cause : new AggregateError([cleanup, cause])
      }
      try {
        listener.client.release(releaseCleanupError(cleanup, 'PostgreSQL listener cleanup failed'))
      } catch (cause) {
        cleanup = cleanup === undefined ? cause : new AggregateError([cleanup, cause])
      }
      this.releaseListenerReservation()
    }
    if (this.client.ownsPool) {
      try {
        await this.client.dispose()
      } catch (cause) {
        cleanup = cleanup === undefined ? cause : new AggregateError([cleanup, cause])
      }
    }
    if (cleanup !== undefined) throw releaseCleanupError(cleanup, 'PostgreSQL store cleanup failed')
  }
}

const makeStoreLayer = <T extends AnyJobStoreToken>(
  token: T,
  acquire: () => Promise<PostgresClient>,
  ownsClient: boolean
): Layer<InstanceType<T>, never> =>
  Layer.scoped(
    token,
    async () => {
      const client = await acquire()
      let implementation: PostgresJobStoreImplementation | undefined
      try {
        if (client.validateSchema) await client.validate()
        implementation = new PostgresJobStoreImplementation(client)
        await implementation.start()
        return JobStore.of(implementation as never) as unknown as ServiceContract<InstanceType<T>>
      } catch (cause) {
        let cleanup: unknown
        if (implementation !== undefined) {
          try {
            await implementation.dispose()
          } catch (failure) {
            cleanup = failure
          }
        } else if (ownsClient) {
          try {
            await client.dispose()
          } catch (failure) {
            cleanup = failure
          }
        }
        throw aggregateCleanup(cause, cleanup, 'PostgreSQL store acquisition cleanup failed')
      }
    },
    async (store) => {
      await (store as unknown as PostgresJobStoreImplementation).dispose()
    }
  ) as Layer<InstanceType<T>, never>

const namespaceForToken = (token: AnyJobStoreToken, namespace: string): string =>
  token.serviceTag === JobStore.serviceTag
    ? namespace
    : `${namespace}:store-${hash(token.serviceTag)}`

const borrowedClient = (
  token: AnyJobStoreToken,
  config: PostgresJobStoreConfig
): (() => Promise<PostgresClient>) => {
  const normalized = normalizePostgresJobStoreConfig(config)
  return async () =>
    PostgresClient.fromPool({
      ...normalized,
      namespace: namespaceForToken(token, normalized.namespace)
    })
}
const ownedClient = (
  token: AnyJobStoreToken,
  config: PostgresJobStoreConnectionConfig
): (() => Promise<PostgresClient>) => {
  const normalized = normalizePostgresJobStoreConnectionConfig(config)
  return () =>
    PostgresClient.fromConfig({
      ...normalized,
      namespace: namespaceForToken(token, normalized.namespace)
    })
}

export const PostgresJobStore = Object.freeze({
  layer(config: PostgresJobStoreConfig) {
    return makeStoreLayer(JobStore, borrowedClient(JobStore, config), false)
  },
  layerFor<T extends AnyJobStoreToken>(token: T, config: PostgresJobStoreConfig) {
    return makeStoreLayer(token, borrowedClient(token, config), false)
  },
  layerFromConfig(config: PostgresJobStoreConnectionConfig) {
    return makeStoreLayer(JobStore, ownedClient(JobStore, config), true)
  },
  layerFromConfigFor<T extends AnyJobStoreToken>(
    token: T,
    config: PostgresJobStoreConnectionConfig
  ) {
    return makeStoreLayer(token, ownedClient(token, config), true)
  }
})
