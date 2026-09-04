// oxlint-disable anti-slop/no-unknown-parameters -- Redis replies are validated by codecs at this boundary.
// oxlint-disable anti-slop/no-runtime-typeof -- untyped public inputs are narrowed at this boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts are confined to validated contract edges.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional reducer fields are explicit protocol data.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts follow validation.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- Redis command payloads are intentionally structural.
// oxlint-disable anti-slop/no-unknown-returns -- all replies are narrowed before returning.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to Result/contract boundaries.
import { randomUUID } from 'node:crypto'
import { Layer, type ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  JobStore,
  JobStoreWakeAbortedError,
  JobStoreFailure,
  JobNotFoundError,
  LeaseLostError,
  JobDefinitionError,
  InvalidJobTransitionError,
  UnsupportedJobStoreOperationError,
  makeJobId,
  makeLeaseToken,
  makeQueueName,
  makeJobName,
  makeWorkerId,
  makeJobRecord,
  protocolVersion,
  reduceJob,
  recoverStalledWithPolicy,
  type AnyJobStoreToken,
  type JobRecord,
  type AttemptRecord,
  type JobTransition,
  type ActiveJobSnapshot,
  type LostLease,
  type JobStore as J
} from 'better-effect-mq'
import { RedisClient } from './client'
import { RedisConnectionError, RedisLayoutError } from './errors'
import { encodeJobRecord, decodeJobRecord, encodeAttempt, decodeAttempt } from './codec'
import { hashReply, stringsReply, scriptReply, type RedisScriptReply } from './internal/replies'
import { runScript } from './internal/run-script'
import { subscribeWake } from './internal/wake'
import {
  sendRedisCommand,
  type RedisJobStoreConnectionConfig,
  type RedisJobStoreConfig
} from './config'
import { hasUnpairedSurrogate } from './internal/text'
import {
  decodeDelayedMember,
  decodeKeySegment,
  decodeListingMember,
  decodeWaitingMember,
  encodeDelayedMember,
  encodeIdentity,
  encodeKeySegment,
  encodeListingMember,
  encodeWaitingMember,
  type RedisKeyLayout
} from './keys'

type Op<T> = ResultType<T, any>
const ok = <T>(v: T): Op<T> => Result.ok(v) as Op<T>
const tagged = new Set([
  'JobStoreFailure',
  'JobDefinitionError',
  'JobNotFoundError',
  'LeaseLostError',
  'InvalidJobTransitionError',
  'UnsupportedJobStoreOperationError',
  'JobNotRetryableError',
  'JobNotCancellableError',
  'JobNotPromotableError'
])
const retryableRedisFailure = (cause: unknown): boolean => {
  if (cause instanceof RedisConnectionError) return true
  const messages: string[] = []
  const seen = new Set<object>()
  let current: unknown = cause
  for (let depth = 0; depth < 8 && current !== undefined; depth++) {
    if (current !== null && typeof current === 'object') {
      if (seen.has(current)) break
      seen.add(current)
      try {
        const value = current as {
          readonly message?: unknown
          readonly code?: unknown
          readonly cause?: unknown
        }
        if (typeof value.message === 'string') messages.push(value.message)
        if (typeof value.code === 'string') messages.push(value.code)
        current = value.cause
        continue
      } catch {
        break
      }
    }
    if (typeof current === 'string') messages.push(current)
    break
  }
  const upper = messages.join(' ').toUpperCase()
  return [
    'TRYAGAIN',
    'CLUSTERDOWN',
    'READONLY',
    'MOVED',
    'ASK',
    'LOADING',
    'TIMEOUT',
    'SOCKET',
    'CONNECTION',
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EPIPE',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN'
  ].some((marker) => upper.includes(marker))
}
const fail = <T>(operation: string, cause: unknown): Op<T> => {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    tagged.has((cause as { _tag?: string })._tag ?? '')
  )
    return Result.err(cause) as Op<T>
  return Result.err(
    new JobStoreFailure({
      operation,
      retryable: retryableRedisFailure(cause),
      message: `Redis ${operation} failed`
    })
  ) as Op<T>
}
const requireObject = (
  value: unknown,
  field: string,
  allowed?: readonly string[]
): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new JobDefinitionError({ field, message: 'must be a plain object' })
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new JobDefinitionError({ field, message: 'must be a plain object' })
    const allowedSet = allowed === undefined ? undefined : new Set(allowed)
    const snapshot = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string')
        throw new JobDefinitionError({ field, message: 'must not contain symbol fields' })
      if (allowedSet !== undefined && !allowedSet.has(key))
        throw new JobDefinitionError({ field, message: 'contains unsupported fields' })
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor))
        throw new JobDefinitionError({ field: `${field}.${key}`, message: 'must be a data field' })
      snapshot[key] = descriptor.value
    }
    return Object.freeze(snapshot)
  } catch (cause) {
    if (cause instanceof JobDefinitionError) throw cause
    throw new JobDefinitionError({ field, message: 'could not read request fields' })
  }
}
const requireArray = (value: unknown, field: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new JobDefinitionError({ field, message: 'must be an array' })
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      throw new JobDefinitionError({ field, message: 'must use the standard array prototype' })
    const ownKeys = Reflect.ownKeys(value)
    if (
      ownKeys.length !== value.length + 1 ||
      ownKeys.some((key) => {
        if (key === 'length') return false
        return (
          typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length
        )
      })
    )
      throw new JobDefinitionError({ field, message: 'contains unsupported array fields' })
    const output: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
        throw new JobDefinitionError({
          field,
          message: 'must not contain sparse or accessor items'
        })
      output.push(descriptor.value)
    }
    return Object.freeze(output)
  } catch (cause) {
    if (cause instanceof JobDefinitionError) throw cause
    throw new JobDefinitionError({ field, message: 'could not read array items' })
  }
}
const integer = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v))
    throw new JobDefinitionError({ field, message: 'must be a safe integer' })
  return v
}
const number = (v: unknown, field: string, positive = false): number => {
  const value = integer(v, field)
  if (value < 0 || (positive && value === 0))
    throw new JobDefinitionError({
      field,
      message: positive ? 'must be positive' : 'must be a non-negative safe integer'
    })
  return value
}
const redisNumber = (value: unknown, field: string): number => {
  if (typeof value === 'number') return number(value, field)
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value))
    return number(Number(value), field)
  throw new JobDefinitionError({ field, message: 'must be a canonical safe integer' })
}
const text = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || v.length === 0 || v.includes('\0') || hasUnpairedSurrogate(v))
    throw new JobDefinitionError({ field, message: 'must be a non-empty string without NUL' })
  return v
}
const identity = (v: unknown, field: string) => {
  const x = requireObject(v, field, ['queue', 'name', 'version'])
  const q = makeQueueName(x.queue)
  const n = makeJobName(x.name)
  const version = number(x.version, `${field}.version`, true)
  if (Result.isError(q)) throw q.error
  if (Result.isError(n)) throw n.error
  return { queue: q.value, name: n.value, version }
}
const enqueueFields = [
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
const claimFields = ['queue', 'accepted', 'limit', 'workerId', 'leaseDurationMs', 'now'] as const
const settleFields = ['jobId', 'leaseToken', 'outcome', 'now', 'startedAt'] as const
const leaseFields = ['jobId', 'leaseToken', 'now'] as const
const heartbeatFields = ['leases', 'leaseDurationMs', 'now'] as const
const recoverFields = ['maxStalledCount', 'limit', 'now'] as const
const idFields = ['jobId', 'now'] as const
const retryFields = ['jobId', 'runAt', 'now'] as const
const removeFields = ['jobId', 'expectedState', 'now'] as const
const pauseFields = ['queue', 'now'] as const
const MAX_ENQUEUE_CHUNK_ITEMS = 128
const MAX_ENQUEUE_CHUNK_BYTES = 524_288
const MAX_CLAIM_LIMIT = 1_024
const MAX_ACCEPTED_IDENTITIES = 2_048
const MAX_CLAIM_WORK = 250_000
const MAX_CLAIM_DISCOVERY_RETRIES = 4
const MAX_CLAIM_DISCOVERY_SCAN = 8_192
const MAX_CLAIM_DYNAMIC_KEYS = 100_000
const MAX_CLAIM_KEY_BYTES = 8_388_608
const MAX_CLAIM_BODY_BYTES = 8_388_608
const MAX_RECOVER_LIMIT = 10_000
const MAX_RECOVER_SCAN = 40_000
const MAX_HEARTBEAT_CHUNK_ITEMS = 128
const MAX_HEARTBEAT_CHUNK_BYTES = 524_288
const WAKE_POLL_INTERVAL_MS = 250
const uniqueKeys = (keys: readonly string[]): readonly string[] => [...new Set(keys)]
const listFields = new Set([
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
const assertListFields = (request: Record<string, unknown>): void => {
  for (const key of Object.keys(request)) {
    if (!listFields.has(key))
      throw new UnsupportedJobStoreOperationError({
        operation: 'list',
        message: `list does not support ${key}`
      })
  }
}
const listSignature = (request: Record<string, unknown>): string =>
  JSON.stringify({
    queue: request.queue,
    name: request.name,
    version: request.version,
    state: request.state,
    metadata:
      request.metadata === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(requireObject(request.metadata, 'metadata')).sort(([left], [right]) =>
              left.localeCompare(right)
            )
          ),
    orderBy: request.orderBy ?? 'enqueuedAt',
    order: request.order ?? 'asc'
  })

const waitingMember = (record: JobRecord): string =>
  encodeWaitingMember(record.runAt, record.orderingSequence, record.id)
const delayedMember = (record: JobRecord): string =>
  encodeDelayedMember(record.orderingSequence, record.id)

const nestedHashReplies = (value: unknown, field: string): readonly Record<string, string>[] => {
  const values = requireArray(value, field)
  return Object.freeze(values.map((item) => hashReply(item)))
}

const decodeJobReplies = (value: unknown, field: string): readonly JobRecord[] => {
  const jobs: JobRecord[] = []
  for (const fields of nestedHashReplies(value, field)) {
    const decoded = decodeJobRecord(fields)
    if (Result.isError(decoded)) throw decoded.error
    jobs.push(decoded.value)
  }
  return Object.freeze(jobs)
}

const decodeActiveJobReplies = (value: unknown, field: string): readonly ActiveJobSnapshot[] => {
  const jobs = decodeJobReplies(value, field)
  if (
    jobs.some(
      (job) =>
        job.state !== 'active' ||
        job.leaseOwner === undefined ||
        job.leaseToken === undefined ||
        job.leaseExpiresAt === undefined
    )
  )
    throw new JobStoreFailure({
      operation: field,
      retryable: false,
      message: 'Redis returned a non-active job snapshot'
    })
  return jobs as readonly ActiveJobSnapshot[]
}
const decodeHeartbeatReply = (reply: RedisScriptReply): J.HeartbeatResult => {
  if (reply.values.length !== 4 || reply.values[0] !== 'applied')
    throw new JobStoreFailure({
      operation: 'heartbeat',
      retryable: false,
      message: 'Redis heartbeat returned an invalid reply'
    })
  const renewed = decodeActiveJobReplies(reply.values[1], 'renewed')
  const lost: LostLease[] = []
  for (const [index, item] of requireArray(reply.values[2], 'lost').entries()) {
    const tuple = tupleReply(item, `lost.${index}`, 3)
    const reason = tuple[2]
    if (reason !== 'missing-lease' && reason !== 'mismatched-token' && reason !== 'expired-lease')
      throw new JobStoreFailure({
        operation: 'heartbeat',
        retryable: false,
        message: 'Redis heartbeat returned an invalid lease reason'
      })
    lost.push({ jobId: tuple[0]! as never, leaseToken: tuple[1]! as never, reason })
  }
  return {
    renewed,
    lost: Object.freeze(lost),
    cancellationRequested: stringsReply(reply.values[3]).map((id) => id as never)
  }
}

const tupleReply = (value: unknown, field: string, length: number): readonly string[] => {
  const tuple = requireArray(value, field)
  if (tuple.length !== length || tuple.some((item) => typeof item !== 'string'))
    throw new JobStoreFailure({
      operation: field,
      retryable: false,
      message: 'Redis script returned an invalid tuple'
    })
  return tuple as readonly string[]
}

type MutationKeys = {
  readonly job: string
  readonly attempts: string
  readonly settlement: string
  readonly all: string
  readonly byQueue: string
  readonly byIdentity: string
  readonly identities: string
  readonly byState: string
  readonly oldByState: string
  readonly idempotency: string
  readonly counts: string
  readonly wake: string
  readonly wakeChannel: string
  readonly queueControls: string
  readonly active: string
  readonly sequenceJobs: string
  readonly revision: string
  readonly created: string
  readonly runAt: string
  readonly finishedAt: string
  readonly oldWaiting?: string
  readonly oldDelayed?: string
  readonly newWaiting?: string
  readonly newDelayed?: string
  readonly oldCreatedMember?: string
  readonly newCreatedMember?: string
  readonly oldRunAtMember?: string
  readonly newRunAtMember?: string
  readonly oldFinishedMember?: string
  readonly newFinishedMember?: string
  readonly identityMember?: string
}

type AlreadyAppliedMutation = {
  readonly already: {
    readonly record: JobRecord
    readonly attempt: AttemptRecord
  }
}
type MutationResult = number | undefined | AlreadyAppliedMutation

const isAlreadyAppliedMutation = (value: MutationResult): value is AlreadyAppliedMutation =>
  typeof value === 'object' && value !== null && 'already' in value

const canonicalJson = (value: unknown): string => {
  const seen = new Set<object>()
  const encode = (current: unknown, field: string): string => {
    if (current === null) return 'null'
    if (typeof current === 'string') {
      if (hasUnpairedSurrogate(current))
        throw new JobDefinitionError({ field, message: 'contains malformed Unicode' })
      return JSON.stringify(current)
    }
    if (typeof current === 'boolean') return current ? 'true' : 'false'
    if (typeof current === 'number') {
      if (!Number.isFinite(current))
        throw new JobDefinitionError({ field, message: 'must contain finite JSON numbers' })
      return JSON.stringify(current)
    }
    if (typeof current !== 'object')
      throw new JobDefinitionError({ field, message: 'must be JSON data' })
    if (seen.has(current))
      throw new JobDefinitionError({ field, message: 'must not contain cycles' })
    seen.add(current)
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype)
          throw new JobDefinitionError({ field, message: 'must use the standard array prototype' })
        const output: string[] = []
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (descriptor === undefined || !('value' in descriptor))
            throw new JobDefinitionError({
              field,
              message: 'must not contain sparse or accessor items'
            })
          output.push(encode(descriptor.value, `${field}.${index}`))
        }
        for (const key of Reflect.ownKeys(current)) {
          if (key === 'length') continue
          if (
            typeof key !== 'string' ||
            !/^(?:0|[1-9]\d*)$/u.test(key) ||
            Number(key) >= current.length
          )
            throw new JobDefinitionError({ field, message: 'must not contain extra array fields' })
        }
        return `[${output.join(',')}]`
      }
      const object = requireObject(current, field)
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(object[key], `${field}.${key}`)}`)
        .join(',')}}`
    } finally {
      seen.delete(current)
    }
  }
  return encode(value, 'outcome')
}

const jobStates = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'] as const
const isAbortSignal = (value: unknown): value is AbortSignal => {
  if (value === null || typeof value !== 'object') return false
  try {
    const candidate = value as {
      readonly aborted?: unknown
      readonly addEventListener?: unknown
      readonly removeEventListener?: unknown
    }
    return (
      typeof candidate.aborted === 'boolean' &&
      typeof candidate.addEventListener === 'function' &&
      typeof candidate.removeEventListener === 'function'
    )
  } catch {
    return false
  }
}
const cursorOrdering = (orderBy: J.JobListOrderBy): J.JobListOrdering =>
  orderBy === 'enqueuedAt' ? 'createdAt,orderingSequence,id' : `${orderBy},orderingSequence,id`
const listValue = (record: JobRecord, orderBy: J.JobListOrderBy): number | null =>
  orderBy === 'enqueuedAt'
    ? record.createdAt
    : orderBy === 'runAt'
      ? record.runAt
      : (record.finishedAt ?? null)
class RedisJobStoreImplementation {
  readonly protocolVersion = protocolVersion
  readonly capabilities = Object.freeze({
    notifications: true,
    queueFilteredNotifications: true,
    batchClaim: true,
    // Oversized calls are intentionally split into independently atomic chunks.
    transactionalEnqueue: false,
    changeFeed: false
  })
  private closed = false
  private disposal: Promise<void> | undefined
  private unsubscribeWake: (() => Promise<void>) | undefined
  private wakePollTimer: ReturnType<typeof setTimeout> | undefined
  private readonly lastWakeVersions = new Map<string, number>()
  private readonly waiters = new Set<{
    queues: readonly string[]
    baseline: Record<string, number>
    signal: AbortSignal
    resolve: (r: Op<void>) => void
    listener: () => void
    settled: boolean
  }>()
  constructor(private readonly redis: RedisClient) {}
  async start(): Promise<void> {
    this.unsubscribeWake = await subscribeWake(
      this.redis.subscriber,
      this.layout.wakeChannel,
      (message) => this.handleWake(message),
      () => this.checkWaiters(),
      this.redis.ownsSubscriber
    )
  }
  private get layout(): RedisKeyLayout {
    return this.redis.layout
  }
  private assertOpen(operation: string): void {
    if (this.closed)
      throw new JobStoreFailure({
        operation,
        retryable: false,
        message: 'Redis JobStore has been disposed'
      })
  }
  private command<T = unknown>(args: string[]): Promise<T> {
    this.assertOpen('command')
    return sendRedisCommand(this.redis.client, args, this.layout.base) as Promise<T>
  }
  private async script(
    name: Parameters<typeof runScript>[1],
    keys: readonly string[],
    args: readonly string[] = [],
    allowErrors = false
  ) {
    this.assertOpen(name)
    const result = await runScript(this.redis.scripts, name, {
      keys,
      args,
      decode: (reply) => scriptReply(reply, name)
    })
    if (Result.isError(result)) throw result.error
    if (result.value.status === 'error' && !allowErrors)
      throw new JobStoreFailure({
        operation: name,
        retryable: false,
        message: `Redis ${name} script rejected the request`
      })
    return result.value
  }
  private async read(id: string): Promise<JobRecord | undefined> {
    const fields = hashReply(await this.command(['HGETALL', this.layout.job(id)]))
    if (Object.keys(fields).length === 0) return undefined
    const decoded = decodeJobRecord(fields)
    if (Result.isError(decoded)) throw decoded.error
    return decoded.value
  }
  private async revision(id: string): Promise<number> {
    const value = await this.command<string | null>(['GET', `${this.layout.job(id)}:revision`])
    return value === null ? 0 : redisNumber(value, 'revision')
  }
  /** Return all keys referenced by a mutation. Every key shares the namespace hash tag. */
  private mutationKeys(record: JobRecord, previous?: JobRecord): MutationKeys {
    const oldWaiting =
      previous?.state === 'waiting'
        ? this.layout.waiting(previous.queue, previous.name, previous.version)
        : undefined
    const oldDelayed =
      previous?.state === 'delayed'
        ? this.layout.delayed(previous.queue, previous.name, previous.version)
        : undefined
    const newWaiting =
      record.state === 'waiting'
        ? this.layout.waiting(record.queue, record.name, record.version)
        : undefined
    const newDelayed =
      record.state === 'delayed'
        ? this.layout.delayed(record.queue, record.name, record.version)
        : undefined
    return {
      job: this.layout.job(record.id),
      attempts: this.layout.attempts(record.id),
      settlement: `${this.layout.job(record.id)}:settlement`,
      all: this.layout.all,
      byQueue: this.layout.byQueue(record.queue),
      byIdentity: this.layout.byIdentity(record.name, record.version),
      identities: this.layout.identities(record.queue),
      byState: this.layout.byState(record.state),
      oldByState: this.layout.byState(previous?.state ?? record.state),
      idempotency: this.layout.idempotency(`${record.queue}:${record.name}:${record.version}`),
      counts: this.layout.counts,
      wake: this.layout.wake,
      wakeChannel: this.layout.wakeChannel,
      queueControls: this.layout.queues,
      active: this.layout.active,
      sequenceJobs: this.layout.sequenceJobs,
      revision: `${this.layout.job(record.id)}:revision`,
      created: this.layout.created,
      runAt: this.layout.runAt,
      finishedAt: this.layout.finishedAt,
      ...(previous === undefined
        ? {}
        : {
            oldCreatedMember: encodeListingMember(
              previous.createdAt,
              previous.orderingSequence,
              previous.id
            )
          }),
      newCreatedMember: encodeListingMember(record.createdAt, record.orderingSequence, record.id),
      ...(previous === undefined
        ? {}
        : {
            oldRunAtMember: encodeListingMember(
              previous.runAt,
              previous.orderingSequence,
              previous.id
            )
          }),
      newRunAtMember: encodeListingMember(record.runAt, record.orderingSequence, record.id),
      ...(previous === undefined
        ? {}
        : {
            oldFinishedMember: encodeListingMember(
              previous.finishedAt ?? null,
              previous.orderingSequence,
              previous.id
            )
          }),
      newFinishedMember: encodeListingMember(
        record.finishedAt ?? null,
        record.orderingSequence,
        record.id
      ),
      identityMember: encodeIdentity(record.name, record.version),
      ...(oldWaiting === undefined ? {} : { oldWaiting }),
      ...(oldDelayed === undefined ? {} : { oldDelayed }),
      ...(newWaiting === undefined ? {} : { newWaiting }),
      ...(newDelayed === undefined ? {} : { newDelayed })
    }
  }

  /** Persist a state transition and every durable index in one compare-and-set Lua mutation. */
  private async write(
    record: JobRecord,
    previous?: JobRecord,
    mutation: {
      readonly attempt?: AttemptRecord
      readonly settlementToken?: string
      readonly settlementDigest?: string
      readonly expectedRevision?: number
      readonly scriptName?: Parameters<typeof runScript>[1]
    } = {}
  ): Promise<MutationResult> {
    const scriptName = mutation.scriptName ?? (previous === undefined ? 'enqueue' : 'claim')
    const fields = encodeJobRecord(record)
    const prior = previous === undefined ? {} : encodeJobRecord(previous)
    const keys = this.mutationKeys(record, previous)
    const item = {
      reply: scriptName,
      mode: previous === undefined ? 'enqueue' : 'write',
      keys,
      record: fields,
      expected:
        previous === undefined
          ? {}
          : {
              state: prior.state,
              updatedAt: prior.updatedAt,
              orderingSequence: prior.orderingSequence,
              ...(prior.leaseToken === undefined ? {} : { leaseToken: prior.leaseToken })
            },
      previousState: previous?.state,
      queue: record.queue,
      idempotencyKey: record.idempotencyKey ?? '',
      now: record.updatedAt,
      ...(previous?.state === 'waiting'
        ? { oldWaitingMember: waitingMember(previous) }
        : previous?.state === 'delayed'
          ? { oldDelayedMember: delayedMember(previous) }
          : {}),
      ...(record.state === 'waiting'
        ? { newWaitingMember: waitingMember(record) }
        : record.state === 'delayed'
          ? { newDelayedMember: delayedMember(record) }
          : {}),
      ...(mutation.attempt === undefined ? {} : { attempt: encodeAttempt(mutation.attempt) }),
      ...(mutation.settlementToken === undefined
        ? {}
        : {
            settlementToken: mutation.settlementToken,
            settlementDigest: mutation.settlementDigest ?? '',
            settlementAttempt: String(
              mutation.attempt?.attemptSequence ?? mutation.attempt?.attempt ?? ''
            )
          }),
      ...(mutation.expectedRevision === undefined
        ? {}
        : { expectedRevision: String(mutation.expectedRevision) })
    }
    const keyList = uniqueKeys(
      Object.entries(keys)
        .filter(([name, key]) => !name.endsWith('Member') && typeof key === 'string')
        .map(([, key]) => key as string)
    )
    const reply = await this.script(scriptName, keyList, [JSON.stringify(item)], true)
    if (reply.status === 'error') {
      if (
        reply.operation === 'MQ_CONFLICT' &&
        (scriptName === 'settle' || scriptName === 'release' || scriptName === 'recover-stalled')
      )
        throw new LeaseLostError({ jobId: record.id as never, reason: 'mismatched-token' })
      throw new JobStoreFailure({
        operation: scriptName,
        retryable: false,
        message: 'Redis mutation rejected the request'
      })
    }
    if (reply.values[0] === 'already' && mutation.settlementToken !== undefined) {
      if (
        reply.values.length !== 4 ||
        typeof reply.values[2] !== 'string' ||
        typeof reply.values[3] !== 'string'
      )
        throw new JobStoreFailure({
          operation: scriptName,
          retryable: false,
          message: 'Redis settlement returned an invalid replay'
        })
      const decodedRecord = decodeJobRecord(hashReply(reply.values[1]))
      if (Result.isError(decodedRecord) || decodedRecord.value.id !== record.id)
        throw new JobStoreFailure({
          operation: scriptName,
          retryable: false,
          message: 'Redis settlement returned an invalid replay record'
        })
      const decodedAttempt = decodeAttempt(reply.values[2])
      if (Result.isError(decodedAttempt)) throw decodedAttempt.error
      const settledAttempt = redisNumber(reply.values[3], 'settlementAttempt')
      if (decodedAttempt.value.attemptSequence !== settledAttempt)
        throw new JobStoreFailure({
          operation: scriptName,
          retryable: false,
          message: 'Redis settlement returned a mismatched replay attempt'
        })
      return { already: { record: decodedRecord.value, attempt: decodedAttempt.value } }
    }
    if (reply.values.length !== 3 && reply.values.length !== 4)
      throw new JobStoreFailure({
        operation: scriptName,
        retryable: false,
        message: 'Redis mutation returned an invalid reply'
      })
    const [status, id, version, sequence] = reply.values
    if (
      status !== 'applied' ||
      typeof id !== 'string' ||
      typeof version !== 'string' ||
      (sequence !== undefined && typeof sequence !== 'string') ||
      id !== record.id
    )
      throw new JobStoreFailure({
        operation: scriptName,
        retryable: false,
        message: 'Redis mutation returned an invalid reply'
      })
    redisNumber(version, `${scriptName}.version`)
    return sequence === undefined ? undefined : redisNumber(sequence, 'orderingSequence')
  }

  private async erase(record: JobRecord, now: number, expectedRevision: number): Promise<void> {
    const keys = this.mutationKeys(record, record)
    const reply = await this.script(
      'remove',
      uniqueKeys(
        Object.entries(keys)
          .filter(([name, key]) => !name.endsWith('Member') && typeof key === 'string')
          .map(([, key]) => key as string)
      ),
      [
        JSON.stringify({
          reply: 'remove',
          mode: 'remove',
          keys,
          record: encodeJobRecord(record),
          expected: {
            state: record.state,
            updatedAt: String(record.updatedAt),
            orderingSequence: String(record.orderingSequence)
          },
          expectedRevision: String(expectedRevision),
          queue: record.queue,
          idempotencyKey: record.idempotencyKey ?? '',
          now
        })
      ]
    )
    const values = tupleReply(reply.values, 'remove', 3)
    if (values[0] !== 'removed' || values[1] !== record.id) {
      throw new JobStoreFailure({
        operation: 'remove',
        retryable: false,
        message: 'Redis mutation returned an invalid removal'
      })
    }
    redisNumber(values[2], 'remove.version')
  }
  private async baseline(): Promise<Record<string, number>> {
    const fields = hashReply(await this.command(['HGETALL', this.layout.wake]))
    const out: Record<string, number> = Object.create(null)
    for (const [rawQueue, value] of Object.entries(fields)) {
      const queue = makeQueueName(rawQueue)
      if (Result.isError(queue)) throw queue.error
      out[queue.value] = redisNumber(value, 'wakeVersion')
    }
    return out
  }
  private async transition(
    operation: string,
    request: unknown,
    allowed: readonly string[],
    command: (r: JobRecord) => ResultType<JobTransition, any>
  ): Promise<Op<JobTransition>> {
    try {
      const x = requireObject(request, 'request', allowed)
      const id = makeJobId(x.jobId)
      if (Result.isError(id)) return Result.err(id.error) as Op<JobTransition>
      const current = await this.read(id.value)
      if (current === undefined) throw new JobNotFoundError({ jobId: id.value })
      const currentRevision = await this.revision(id.value)
      const next = command(current)
      if (Result.isError(next)) throw next.error
      let record = next.value.record
      const mutation = await this.write(record, current, {
        expectedRevision: currentRevision,
        scriptName:
          operation === 'requestCancellation'
            ? 'cancel'
            : (operation as Parameters<typeof runScript>[1])
      })
      if (isAlreadyAppliedMutation(mutation))
        throw new JobStoreFailure({
          operation,
          retryable: false,
          message: 'Redis transition returned a settlement replay'
        })
      const sequence = mutation
      if (sequence !== undefined) {
        const changed = makeJobRecord({ ...record, orderingSequence: sequence })
        if (Result.isError(changed)) throw changed.error
        record = changed.value
      }
      return ok({ ...next.value, record })
    } catch (cause) {
      return fail(operation, cause)
    }
  }
  private async generatedJobId(reserved: Set<string>): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = randomUUID()
      if (reserved.has(id)) continue
      const exists = redisNumber(await this.command(['EXISTS', this.layout.job(id)]), 'exists')
      if (exists === 0) {
        reserved.add(id)
        return id
      }
    }
    throw new JobStoreFailure({
      operation: 'enqueue',
      retryable: false,
      message: 'could not allocate a unique generated job ID'
    })
  }
  async enqueue(request: J.EnqueueRequest): Promise<Op<J.EnqueueResult>> {
    const many = await this.enqueueMany([request])
    return Result.isError(many) ? (many as Op<J.EnqueueResult>) : ok(many.value[0]!)
  }
  private async resolveEnqueueMapping(
    item: Record<string, unknown>,
    mapped: string
  ): Promise<string> {
    const prefix = item.jobPrefix as string
    if (!mapped.startsWith(prefix)) return this.layout.job(mapped)
    const suffix = mapped.slice(prefix.length)
    let decodedSuffix: string
    try {
      decodedSuffix = decodeKeySegment(suffix, 'idempotency mapping')
      if (this.layout.job(decodedSuffix) !== mapped) throw new Error('non-canonical mapping')
    } catch {
      return this.layout.job(mapped)
    }
    const rawJob = this.layout.job(mapped)
    const [directId, rawId] = await Promise.all([
      this.command<unknown>(['HGET', mapped, 'id']),
      this.command<unknown>(['HGET', rawJob, 'id'])
    ])
    const direct = directId === null || directId === undefined ? undefined : directId
    const raw = rawId === null || rawId === undefined ? undefined : rawId
    if (direct !== undefined && typeof direct !== 'string')
      throw new RedisLayoutError(
        'malformed idempotency mapping target',
        'idempotency',
        'INVALID_DATA'
      )
    if (raw !== undefined && typeof raw !== 'string')
      throw new RedisLayoutError(
        'malformed idempotency mapping target',
        'idempotency',
        'INVALID_DATA'
      )
    if (direct === decodedSuffix && raw === mapped)
      throw new RedisLayoutError('ambiguous idempotency mapping', 'idempotency', 'INVALID_DATA')
    if (direct === decodedSuffix) return mapped
    if (raw === mapped) return rawJob
    if (direct === undefined && raw === undefined) return mapped
    throw new RedisLayoutError('ambiguous idempotency mapping', 'idempotency', 'INVALID_DATA')
  }

  private async discoverEnqueueJobs(items: readonly Record<string, unknown>[]): Promise<{
    readonly jobs: Record<string, true>
    readonly mappings: Record<string, string>
  }> {
    const jobs = Object.create(null) as Record<string, true>
    const mappings = Object.create(null) as Record<string, string>
    for (const item of items) {
      if (typeof item.idempotencyKey !== 'string' || item.idempotencyKey === '') continue
      const itemKeys = item.keys as Record<string, unknown>
      if (typeof itemKeys.idempotency !== 'string') continue
      const mapped = await this.command<unknown>([
        'HGET',
        itemKeys.idempotency,
        item.idempotencyKey
      ])
      if (mapped === null || mapped === undefined) continue
      if (typeof mapped !== 'string' || mapped === '')
        throw new RedisLayoutError('malformed idempotency mapping', 'idempotency', 'INVALID_DATA')
      const prefix = item.jobPrefix as string
      const mappedJob = await this.resolveEnqueueMapping(item, mapped)
      jobs[mappedJob] = true
      mappings[`${prefix}\u0000${mapped}`] = mappedJob
    }
    return { jobs, mappings }
  }

  private async enqueueChunkOnce(
    items: readonly Record<string, unknown>[],
    declared: {
      readonly jobs: Readonly<Record<string, true>>
      readonly mappings: Readonly<Record<string, string>>
    }
  ): Promise<readonly J.EnqueueResult[] | undefined> {
    const keyList = uniqueKeys([
      ...items.flatMap((item) =>
        Object.entries(item.keys as Record<string, unknown>)
          .filter(([name, key]) => !name.endsWith('Member') && typeof key === 'string')
          .map(([, key]) => key as string)
      ),
      ...Object.keys(declared.jobs)
    ])
    const body = JSON.stringify({
      reply: 'enqueue-many',
      mode: 'enqueue-many',
      wakeChannel: this.layout.wakeChannel,
      declaredJobs: declared.jobs,
      declaredMappings: declared.mappings,
      items
    })
    if (Buffer.byteLength(body, 'utf8') > MAX_ENQUEUE_CHUNK_BYTES)
      throw new JobDefinitionError({
        field: 'requests',
        message: 'batch chunk exceeds the size limit'
      })
    const reply = await this.script('enqueue-many', keyList, [body], true)
    if (reply.status === 'error') {
      if (reply.operation === 'MQ_ENQUEUE_RETRY') return undefined
      throw new JobStoreFailure({
        operation: 'enqueue',
        retryable: false,
        message: `Redis enqueue batch rejected: ${reply.operation}`
      })
    }
    if (reply.values[0] !== 'batch' || reply.values.length !== items.length + 1)
      throw new JobStoreFailure({
        operation: 'enqueue',
        retryable: false,
        message: 'Redis enqueue batch returned an invalid reply'
      })
    const out: J.EnqueueResult[] = []
    for (const [index, raw] of reply.values.slice(1).entries()) {
      const tuple = requireArray(raw, `enqueue.${index}`)
      if (
        tuple.length !== 3 ||
        (tuple[0] !== 'applied' && tuple[0] !== 'duplicate') ||
        typeof tuple[1] !== 'string'
      )
        throw new JobStoreFailure({
          operation: 'enqueue',
          retryable: false,
          message: 'Redis enqueue batch returned an invalid item'
        })
      const decoded = decodeJobRecord(hashReply(tuple[2]))
      if (Result.isError(decoded)) throw decoded.error
      out.push({ job: decoded.value, duplicate: tuple[0] === 'duplicate' })
    }
    return Object.freeze(out)
  }

  private async enqueueChunk(
    items: readonly Record<string, unknown>[]
  ): Promise<readonly J.EnqueueResult[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const declared = await this.discoverEnqueueJobs(items)
      const result = await this.enqueueChunkOnce(items, declared)
      if (result !== undefined) return result
    }
    throw new JobStoreFailure({
      operation: 'enqueue',
      retryable: true,
      message: 'Redis enqueue mapping changed during the bounded retry'
    })
  }
  async enqueueMany(requests: readonly J.EnqueueRequest[]): Promise<Op<J.EnqueueManyResult>> {
    try {
      const inputs = requireArray(requests, 'requests')
      const items: Record<string, unknown>[] = []
      const reservedGeneratedIds = new Set<string>()
      for (const raw of inputs) {
        const x = requireObject(raw, 'request', enqueueFields)
        const hasJob = Object.prototype.hasOwnProperty.call(x, 'job')
        const hasIdentity = Object.prototype.hasOwnProperty.call(x, 'identity')
        if (hasJob === hasIdentity)
          throw new JobDefinitionError({
            field: 'identity',
            message: 'must provide exactly one of job or identity'
          })
        const i = identity(hasJob ? x.job : x.identity, 'identity')
        const now = number(x.now, 'now')
        const runAt = number(x.runAt, 'runAt')
        const attemptsMax = number(x.attemptsMax, 'attemptsMax', true)
        const explicitId = x.id !== undefined
        const id = explicitId ? text(x.id, 'id') : await this.generatedJobId(reservedGeneratedIds)
        const idempotencyKey =
          x.idempotencyKey === undefined ? undefined : text(x.idempotencyKey, 'idempotencyKey')
        if (x.timeoutMs === 0)
          throw new JobDefinitionError({ field: 'timeoutMs', message: 'must be greater than zero' })
        const record = makeJobRecord({
          id,
          ...i,
          state: runAt <= now ? 'waiting' : 'delayed',
          payload: x.payload as never,
          metadata: (x.metadata === undefined ? {} : x.metadata) as never,
          priority: x.priority === undefined ? 0 : integer(x.priority, 'priority'),
          runAt,
          orderingSequence: 0,
          attemptsMax,
          attemptsMade: 0,
          attemptSequence: 0,
          deliveryCount: 0,
          stalledCount: 0,
          backoff: x.backoff as never,
          timeoutMs: x.timeoutMs as never,
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
        const keys = this.mutationKeys(record.value)
        items.push({
          reply: 'enqueue-many',
          mode: 'enqueue',
          keys,
          record: encodeJobRecord(record.value),
          explicitId,
          idempotencyKey: explicitId ? undefined : idempotencyKey,
          queue: record.value.queue,
          jobPrefix: `${this.layout.base}:job:`,
          encodedId: encodeKeySegment(record.value.id),
          newWaitingMember:
            record.value.state === 'waiting' ? waitingMember(record.value) : undefined,
          newDelayedMember:
            record.value.state === 'delayed' ? delayedMember(record.value) : undefined
        })
      }
      if (items.length === 0) return ok(Object.freeze([]))
      const out: J.EnqueueResult[] = []
      let chunk: Record<string, unknown>[] = []
      for (const item of items) {
        const candidate = [...chunk, item]
        const body = JSON.stringify({
          reply: 'enqueue-many',
          mode: 'enqueue-many',
          wakeChannel: this.layout.wakeChannel,
          items: candidate
        })
        if (
          chunk.length > 0 &&
          (candidate.length > MAX_ENQUEUE_CHUNK_ITEMS ||
            Buffer.byteLength(body, 'utf8') > MAX_ENQUEUE_CHUNK_BYTES)
        ) {
          out.push(...(await this.enqueueChunk(chunk)))
          chunk = [item]
        } else {
          if (Buffer.byteLength(body, 'utf8') > MAX_ENQUEUE_CHUNK_BYTES)
            throw new JobDefinitionError({
              field: 'requests',
              message: 'batch item exceeds the size limit'
            })
          chunk = candidate
        }
      }
      if (chunk.length > 0) out.push(...(await this.enqueueChunk(chunk)))
      return ok(Object.freeze(out))
    } catch (cause) {
      return fail('enqueue', cause)
    }
  }
  private async discoverClaimKeys(
    identities: readonly {
      name: string
      version: number
      waiting: string
      delayed: string
    }[],
    waitingLimit: number,
    promotionBudget: number
  ): Promise<{
    readonly jobs: Record<string, string>
    readonly revisions: Record<string, string>
    readonly settlements: Record<string, string>
  }> {
    const jobs = Object.create(null) as Record<string, string>
    const revisions = Object.create(null) as Record<string, string>
    const settlements = Object.create(null) as Record<string, string>
    let dynamicKeyCount = 0
    let dynamicKeyBytes = 0
    const addJob = (jobId: string): void => {
      const encodedId = encodeKeySegment(jobId)
      if (jobs[encodedId] !== undefined) return
      const job = this.layout.job(jobId)
      const keys = [job, `${job}:revision`, `${job}:settlement`]
      dynamicKeyCount += keys.length
      dynamicKeyBytes += keys.reduce((total, key) => total + Buffer.byteLength(key, 'utf8'), 0)
      if (dynamicKeyCount > MAX_CLAIM_DYNAMIC_KEYS || dynamicKeyBytes > MAX_CLAIM_KEY_BYTES)
        throw new JobDefinitionError({
          field: 'accepted',
          message: 'claim key discovery exceeds its bounded limit'
        })
      jobs[encodedId] = job
      revisions[encodedId] = keys[1]!
      settlements[encodedId] = keys[2]!
    }
    for (const identity of identities) {
      const [waiting, delayed] = await Promise.all([
        this.command<unknown>(['ZRANGE', identity.waiting, '0', String(waitingLimit - 1)]),
        this.command<unknown>(['ZRANGE', identity.delayed, '0', String(promotionBudget)])
      ])
      for (const member of stringsReply(waiting)) addJob(decodeWaitingMember(member).jobId)
      for (const member of stringsReply(delayed)) addJob(decodeDelayedMember(member).jobId)
    }
    return { jobs, revisions, settlements }
  }

  async claim(request: J.ClaimRequest): Promise<Op<J.ClaimResult>> {
    try {
      const x = requireObject(request, 'request', claimFields)
      const q = makeQueueName(x.queue)
      const w = makeWorkerId(x.workerId)
      if (Result.isError(q)) throw q.error
      if (Result.isError(w)) throw w.error
      const now = number(x.now, 'now')
      const limit = number(x.limit, 'limit', true)
      const duration = number(x.leaseDurationMs, 'leaseDurationMs', true)
      if (limit > MAX_CLAIM_LIMIT)
        throw new JobDefinitionError({ field: 'limit', message: 'must be at most 1024' })
      const rawAccepted = requireArray(x.accepted, 'accepted')
      if (rawAccepted.length > MAX_ACCEPTED_IDENTITIES)
        throw new JobDefinitionError({
          field: 'accepted',
          message: 'must contain at most 2048 identities'
        })
      const accepted = [] as ReturnType<typeof identity>[]
      const acceptedKeys = new Set<string>()
      for (const value of rawAccepted) {
        const checked = identity(value, 'accepted')
        const key = `${checked.name}\u0000${checked.version}`
        if (!acceptedKeys.has(key)) {
          acceptedKeys.add(key)
          accepted.push(checked)
        }
      }
      const promotionBudget = Math.max(128, Math.min(10_000, limit * 4))
      if (accepted.length * (limit + promotionBudget + 128) > MAX_CLAIM_WORK)
        throw new JobDefinitionError({
          field: 'accepted',
          message: 'claim workload exceeds the bounded limit'
        })
      if (now > Number.MAX_SAFE_INTEGER - duration)
        throw new JobDefinitionError({
          field: 'leaseDurationMs',
          message: 'lease expiry exceeds safe integer range'
        })
      // Capture a pre-mutation baseline. A later wake can only advance this
      // token, so an enqueue racing with claim cannot be hidden by a post-read.
      const baseline = await this.baseline()
      const tokens = Array.from({ length: limit }, () => randomUUID())
      const identities = accepted.map((item) => ({
        name: item.name,
        version: item.version,
        waiting: this.layout.waiting(q.value, item.name, item.version),
        delayed: this.layout.delayed(q.value, item.name, item.version)
      }))
      const keys = {
        all: this.layout.all,
        active: this.layout.active,
        counts: this.layout.counts,
        wake: this.layout.wake,
        wakeChannel: this.layout.wakeChannel,
        queueControls: this.layout.queues,
        byQueue: this.layout.byQueue(q.value),
        byStateWaiting: this.layout.byState('waiting'),
        byStateDelayed: this.layout.byState('delayed'),
        byStateActive: this.layout.byState('active')
      }
      let discoveryLimit = Math.min(MAX_CLAIM_DISCOVERY_SCAN, Math.max(128, limit))
      let reply: Awaited<ReturnType<typeof this.script>> | undefined
      for (let attempt = 0; attempt <= MAX_CLAIM_DISCOVERY_RETRIES; attempt += 1) {
        const discovered = await this.discoverClaimKeys(identities, discoveryLimit, promotionBudget)
        const keyList = uniqueKeys([
          keys.all,
          keys.active,
          keys.counts,
          keys.wake,
          keys.wakeChannel,
          keys.queueControls,
          keys.byQueue,
          keys.byStateWaiting,
          keys.byStateDelayed,
          keys.byStateActive,
          ...identities.flatMap((item) => [item.waiting, item.delayed]),
          ...Object.values(discovered.jobs),
          ...Object.values(discovered.revisions),
          ...Object.values(discovered.settlements)
        ])
        const keyBytes = keyList.reduce((total, key) => total + Buffer.byteLength(key, 'utf8'), 0)
        if (keyList.length > MAX_CLAIM_DYNAMIC_KEYS || keyBytes > MAX_CLAIM_KEY_BYTES)
          throw new JobDefinitionError({
            field: 'accepted',
            message: 'claim key declaration exceeds its bounded limit'
          })
        const body = JSON.stringify({
          reply: 'claim',
          mode: 'claim',
          keys,
          identities,
          queue: q.value,
          workerId: w.value,
          tokens,
          jobPrefix: `${this.layout.base}:job:`,
          jobKeys: discovered.jobs,
          revisionKeys: discovered.revisions,
          settlementKeys: discovered.settlements,
          waitingScanLimit: discoveryLimit,
          now,
          limit,
          leaseDuration: duration,
          promotionBudget
        })
        if (Buffer.byteLength(body, 'utf8') > MAX_CLAIM_BODY_BYTES)
          throw new JobDefinitionError({
            field: 'accepted',
            message: 'claim request exceeds its bounded size'
          })
        reply = await this.script('claim', keyList, [body], true)
        if (reply.status !== 'error' || reply.operation !== 'MQ_CLAIM_RETRY') break
        if (attempt === MAX_CLAIM_DISCOVERY_RETRIES) break
        discoveryLimit = Math.min(MAX_CLAIM_DISCOVERY_SCAN, discoveryLimit * 2)
      }
      if (reply === undefined) throw new Error('Redis claim did not return a reply')
      if (reply.status === 'error') {
        if (reply.operation === 'MQ_CLAIM_RETRY')
          throw new JobStoreFailure({
            operation: 'claim',
            retryable: true,
            message: 'Redis claim key discovery exceeded its bounded retry'
          })
        throw new JobStoreFailure({
          operation: 'claim',
          retryable: false,
          message: `Redis claim rejected the request: ${reply.operation}`
        })
      }
      if (reply.values.length !== 4 || reply.values[0] !== 'applied')
        throw new JobStoreFailure({
          operation: 'claim',
          retryable: false,
          message: 'Redis claim returned an invalid reply'
        })
      const jobs = decodeActiveJobReplies(reply.values[1], 'claim.jobs')
      const nextRunAt =
        reply.values[2] === null || reply.values[2] === undefined
          ? undefined
          : redisNumber(reply.values[2], 'nextRunAt')
      const wakeVersion = redisNumber(reply.values[3], 'wakeVersion')
      const tokenBaseline = {
        ...baseline,
        [q.value]: Math.max(baseline[q.value] ?? 0, wakeVersion)
      }
      return ok({ jobs, wakeToken: this.token(tokenBaseline), nextRunAt })
    } catch (cause) {
      return fail('claim', cause)
    }
  }
  async settle(request: J.SettleRequest): Promise<Op<J.SettlementResult>> {
    try {
      const x = requireObject(request, 'request', settleFields)
      const token = makeLeaseToken(x.leaseToken)
      if (Result.isError(token)) throw token.error
      const id = makeJobId(x.jobId)
      if (Result.isError(id)) throw id.error
      const digest = canonicalJson(x.outcome)
      const current = await this.read(id.value)
      if (!current) throw new JobNotFoundError({ jobId: id.value })
      const currentRevision = await this.revision(id.value)
      const settled = hashReply(
        await this.command(['HGETALL', `${this.layout.job(id.value)}:settlement`])
      )
      if (settled.token === token.value) {
        if (settled.digest !== digest)
          throw new JobStoreFailure({
            operation: 'settle',
            retryable: false,
            message: 'settlement token was already used for a different outcome'
          })
        const attemptSequence = redisNumber(settled.attempt, 'attempt')
        const values = stringsReply(
          await this.command(['LRANGE', this.layout.attempts(id.value), '0', '-1'])
        )
        for (const value of values) {
          const decoded = decodeAttempt(value)
          if (Result.isError(decoded)) throw decoded.error
          if (decoded.value.attemptSequence === attemptSequence)
            return ok({ record: current, attempt: decoded.value, status: 'already-applied' })
        }
        throw new JobStoreFailure({
          operation: 'settle',
          retryable: false,
          message: 'settlement attempt is missing'
        })
      }
      if (current.state !== 'active') {
        throw new LeaseLostError({
          jobId: id.value,
          reason: 'missing-lease',
          leaseToken: token.value
        })
      }
      const next = reduceJob(current, {
        type: 'settle',
        jobId: id.value,
        leaseToken: token.value,
        outcome: x.outcome as never,
        now: number(x.now, 'now'),
        ...(x.startedAt === undefined ? {} : { startedAt: number(x.startedAt, 'startedAt') })
      })
      if (Result.isError(next)) throw next.error
      if (!next.value.attempt)
        throw new JobDefinitionError({
          field: 'attempt',
          message: 'settlement did not record an attempt'
        })
      const record = next.value.record
      const mutation = await this.write(record, current, {
        expectedRevision: currentRevision,
        scriptName: 'settle',
        attempt: next.value.attempt,
        settlementToken: token.value,
        settlementDigest: canonicalJson(x.outcome)
      })
      if (isAlreadyAppliedMutation(mutation))
        return ok({
          record: mutation.already.record,
          attempt: mutation.already.attempt,
          status: 'already-applied'
        })
      const sequence = mutation
      if (sequence !== undefined) {
        const changed = makeJobRecord({ ...record, orderingSequence: sequence })
        if (Result.isError(changed)) throw changed.error
        return ok({ record: changed.value, attempt: next.value.attempt, status: 'applied' })
      }
      return ok({ record, attempt: next.value.attempt, status: 'applied' })
    } catch (cause) {
      return fail('settle', cause)
    }
  }
  async release(request: J.ReleaseRequest): Promise<Op<JobTransition>> {
    return this.transition('release', request, leaseFields, (r) => {
      const x = requireObject(request, 'request', leaseFields)
      const token = makeLeaseToken(x.leaseToken)
      if (Result.isError(token)) return Result.err(token.error) as ResultType<JobTransition, any>
      return reduceJob(r, {
        type: 'release',
        jobId: r.id,
        leaseToken: token.value,
        now: number(x.now, 'now')
      })
    })
  }
  async heartbeat(request: J.HeartbeatRequest): Promise<Op<J.HeartbeatResult>> {
    try {
      const x = requireObject(request, 'request', heartbeatFields)
      const now = number(x.now, 'now')
      const duration = number(x.leaseDurationMs, 'leaseDurationMs', true)
      if (now > Number.MAX_SAFE_INTEGER - duration)
        throw new JobDefinitionError({
          field: 'leaseDurationMs',
          message: 'lease expiry exceeds safe integer range'
        })
      const leases = requireArray(x.leases, 'leases')
      const normalized: { jobId: string; encodedId: string; leaseToken: string }[] = []
      const seenLeaseIds = new Set<string>()
      for (const raw of leases) {
        const l = requireObject(raw, 'lease', ['jobId', 'leaseToken'])
        const id = makeJobId(l.jobId)
        const token = makeLeaseToken(l.leaseToken)
        if (Result.isError(id)) throw id.error
        if (Result.isError(token)) throw token.error
        if (seenLeaseIds.has(id.value))
          throw new JobDefinitionError({
            field: 'leases',
            message: 'must not contain duplicate job IDs'
          })
        seenLeaseIds.add(id.value)
        normalized.push({
          jobId: id.value,
          encodedId: encodeKeySegment(id.value),
          leaseToken: token.value
        })
      }
      const keys = { active: this.layout.active }
      const body = (chunk: readonly (typeof normalized)[number][]): string =>
        JSON.stringify({
          reply: 'heartbeat',
          mode: 'heartbeat',
          keys,
          jobPrefix: `${this.layout.base}:job:`,
          leases: chunk,
          now,
          leaseDuration: duration
        })
      const chunks: (typeof normalized)[] = []
      let chunk: typeof normalized = []
      for (const lease of normalized) {
        const candidate = [...chunk, lease]
        const encoded = body(candidate)
        if (
          chunk.length > 0 &&
          (candidate.length > MAX_HEARTBEAT_CHUNK_ITEMS ||
            Buffer.byteLength(encoded, 'utf8') > MAX_HEARTBEAT_CHUNK_BYTES)
        ) {
          chunks.push(chunk)
          chunk = [lease]
        } else {
          if (Buffer.byteLength(encoded, 'utf8') > MAX_HEARTBEAT_CHUNK_BYTES)
            throw new JobDefinitionError({
              field: 'leases',
              message: 'lease batch exceeds the size limit'
            })
          chunk = candidate
        }
      }
      if (chunk.length > 0) chunks.push(chunk)
      const renewed: ActiveJobSnapshot[] = []
      const lost: LostLease[] = []
      const cancellationRequested: J.HeartbeatResult['cancellationRequested'][number][] = []
      for (const leasesChunk of chunks) {
        const reply = await this.script(
          'heartbeat',
          uniqueKeys([
            keys.active,
            ...leasesChunk.flatMap((lease) => {
              const job = this.layout.job(lease.jobId)
              return [job, `${job}:revision`]
            })
          ]),
          [body(leasesChunk)]
        )
        const result = decodeHeartbeatReply(reply)
        renewed.push(...result.renewed)
        lost.push(...result.lost)
        cancellationRequested.push(...result.cancellationRequested)
      }
      return ok({
        renewed: Object.freeze(renewed),
        lost: Object.freeze(lost),
        cancellationRequested: Object.freeze(cancellationRequested)
      })
    } catch (cause) {
      return fail('heartbeat', cause)
    }
  }
  async recoverStalled(request: J.RecoverStalledRequest): Promise<Op<J.RecoverStalledResult>> {
    try {
      const x = requireObject(request, 'request', recoverFields),
        now = number(x.now, 'now'),
        max = number(x.maxStalledCount, 'maxStalledCount'),
        limit = x.limit === undefined ? MAX_RECOVER_LIMIT : number(x.limit, 'limit', true)
      if (limit > MAX_RECOVER_LIMIT)
        throw new JobDefinitionError({ field: 'limit', message: 'must be at most 10000' })
      const transitions: JobTransition[] = []
      let scanned = 0
      while (transitions.length < limit && scanned < MAX_RECOVER_SCAN) {
        const batchSize = Math.min(128, MAX_RECOVER_SCAN - scanned)
        const candidates = stringsReply(
          await this.command([
            'ZRANGEBYSCORE',
            this.layout.active,
            '-inf',
            String(now),
            'LIMIT',
            '0',
            String(batchSize)
          ])
        )
        if (candidates.length === 0) break
        scanned += candidates.length
        const stale: {
          id: string
          job: string
          score: number
          state?: string
          token?: string
        }[] = []
        const reindex: {
          id: string
          job: string
          score: number
          leaseExpiresAt: number
          token: string
        }[] = []
        const eligible: { record: JobRecord; revision: number }[] = []
        for (const id of candidates) {
          const record = await this.read(id)
          const job = this.layout.job(id)
          if (record === undefined || record.state !== 'active') {
            const indexedValue = await this.command(['ZSCORE', this.layout.active, id])
            if (indexedValue === null) continue
            stale.push({
              id,
              job,
              score: redisNumber(indexedValue, 'active lease expiry'),
              ...(record === undefined ? {} : { state: record.state })
            })
            continue
          }
          if (record.leaseExpiresAt === undefined) {
            const indexedValue = await this.command(['ZSCORE', this.layout.active, id])
            if (indexedValue === null) continue
            stale.push({
              id,
              job,
              score: redisNumber(indexedValue, 'active lease expiry'),
              state: 'active',
              ...(record.leaseToken === undefined ? {} : { token: record.leaseToken })
            })
            continue
          }
          const indexedValue = await this.command<string | null>(['ZSCORE', this.layout.active, id])
          if (indexedValue === null) continue
          const indexedExpiry = redisNumber(indexedValue, 'active lease expiry')
          if (record.leaseExpiresAt > now) {
            if (indexedExpiry !== record.leaseExpiresAt && record.leaseToken !== undefined) {
              reindex.push({
                id,
                job,
                score: indexedExpiry,
                leaseExpiresAt: record.leaseExpiresAt,
                token: record.leaseToken
              })
            }
            continue
          }
          eligible.push({ record, revision: await this.revision(record.id) })
        }
        if (stale.length > 0) {
          const cleanup = await this.script(
            'remove',
            uniqueKeys([this.layout.active, ...stale.map((item) => item.job)]),
            [
              JSON.stringify({
                reply: 'remove',
                mode: 'cleanup-active',
                active: this.layout.active,
                items: stale
              })
            ],
            true
          )
          if (
            cleanup.status === 'error' ||
            cleanup.values.length !== 2 ||
            cleanup.values[0] !== 'cleaned'
          )
            throw new JobStoreFailure({
              operation: 'recoverStalled',
              retryable: false,
              message: 'Redis stale-index cleanup returned an invalid reply'
            })
          redisNumber(cleanup.values[1], 'stale cleanup count')
        }
        if (reindex.length > 0) {
          try {
            const repair = await this.script(
              'remove',
              uniqueKeys([this.layout.active, ...reindex.map((item) => item.job)]),
              [
                JSON.stringify({
                  reply: 'remove',
                  mode: 'repair-active',
                  active: this.layout.active,
                  items: reindex
                })
              ],
              true
            )
            if (
              repair.status === 'error' ||
              repair.values.length !== 2 ||
              repair.values[0] !== 'repaired'
            )
              throw new JobStoreFailure({
                operation: 'recoverStalled',
                retryable: false,
                message: 'Redis active-index repair returned an invalid reply'
              })
            redisNumber(repair.values[1], 'active repair count')
          } catch {
            // Reindexing is advisory; the durable job state remains authoritative.
          }
        }
        for (const { record, revision } of eligible) {
          if (transitions.length >= limit) break
          const t = recoverStalledWithPolicy(
            record,
            { type: 'recover-stalled', jobId: record.id, now } as never,
            record.stalledCount >= max
          )
          if (Result.isError(t)) throw t.error
          try {
            const mutation = await this.write(
              t.value.record,
              record,
              t.value.attempt === undefined
                ? { scriptName: 'recover-stalled', expectedRevision: revision }
                : {
                    scriptName: 'recover-stalled',
                    attempt: t.value.attempt,
                    expectedRevision: revision
                  }
            )
            if (isAlreadyAppliedMutation(mutation))
              throw new JobStoreFailure({
                operation: 'recoverStalled',
                retryable: false,
                message: 'Redis recovery returned a settlement replay'
              })
            if (mutation === undefined) transitions.push(t.value)
            else {
              const changed = makeJobRecord({ ...t.value.record, orderingSequence: mutation })
              if (Result.isError(changed)) throw changed.error
              transitions.push({ ...t.value, record: changed.value })
            }
          } catch (cause) {
            if (!(cause instanceof LeaseLostError)) throw cause
          }
        }
      }
      return ok({ transitions: Object.freeze(transitions), recovered: transitions.length })
    } catch (cause) {
      return fail('recoverStalled', cause)
    }
  }
  private token(baseline: Record<string, number>): J.WakeToken {
    return `redis-wake-v1-${Buffer.from(JSON.stringify(baseline)).toString('base64url')}` as J.WakeToken
  }
  private decodeToken(value: unknown): Record<string, number> {
    if (typeof value !== 'string' || !value.startsWith('redis-wake-v1-'))
      throw new JobStoreFailure({
        operation: 'awaitWake',
        retryable: false,
        message: 'wakeToken was not created by this Redis store'
      })
    try {
      const parsed = requireObject(
        JSON.parse(Buffer.from(value.slice(14), 'base64url').toString()),
        'wakeToken'
      )
      const output: Record<string, number> = Object.create(null)
      for (const [queue, version] of Object.entries(parsed)) {
        const validQueue = makeQueueName(queue)
        if (Result.isError(validQueue)) throw validQueue.error
        output[validQueue.value] = redisNumber(version, 'wakeVersion')
      }
      return output
    } catch (cause) {
      if (cause instanceof JobDefinitionError) throw cause
      throw new JobStoreFailure({
        operation: 'awaitWake',
        retryable: false,
        message: 'wakeToken could not be decoded'
      })
    }
  }
  private async changed(
    baseline: Record<string, number>,
    queues: readonly string[]
  ): Promise<boolean> {
    const current = await this.baseline()
    return (queues.length ? queues : Object.keys(current)).some(
      (q) => (current[q] ?? 0) > (baseline[q] ?? 0)
    )
  }
  private handleWake(message: string): void {
    try {
      const value = requireObject(JSON.parse(message), 'wake message', ['queue', 'version'])
      const queue = makeQueueName(value.queue)
      if (Result.isError(queue)) return
      const version = redisNumber(value.version, 'wakeVersion')
      if ((this.lastWakeVersions.get(queue.value) ?? 0) >= version) return
      this.lastWakeVersions.set(queue.value, version)
      this.checkWaiters(queue.value)
    } catch {
      // Pub/Sub is an optimization. Invalid messages are ignored and polling
      // against the durable wake hash remains authoritative.
    }
  }
  private stopWakePoll(): void {
    if (this.wakePollTimer !== undefined) clearTimeout(this.wakePollTimer)
    this.wakePollTimer = undefined
  }
  private scheduleWakePoll(): void {
    if (this.closed || this.waiters.size === 0 || this.wakePollTimer !== undefined) return
    this.wakePollTimer = setTimeout(() => {
      this.wakePollTimer = undefined
      if (this.closed || this.waiters.size === 0) return
      this.checkWaiters()
      this.scheduleWakePoll()
    }, WAKE_POLL_INTERVAL_MS)
  }
  private finishWaiter(
    waiter: {
      queues: readonly string[]
      signal: AbortSignal
      listener: () => void
      resolve: (r: Op<void>) => void
      settled: boolean
    },
    result: Op<void>
  ): void {
    if (waiter.settled) return
    waiter.settled = true
    this.waiters.delete(waiter as never)
    if (this.waiters.size === 0) this.stopWakePoll()
    try {
      waiter.signal.removeEventListener('abort', waiter.listener)
    } catch {
      // The waiter is detached locally even when a structural signal rejects cleanup.
    }
    waiter.resolve(result)
  }
  private hasLocalWake(waiter: {
    queues: readonly string[]
    baseline: Record<string, number>
  }): boolean {
    const queues = waiter.queues.length ? waiter.queues : [...this.lastWakeVersions.keys()]
    return queues.some(
      (queue) => (this.lastWakeVersions.get(queue) ?? 0) > (waiter.baseline[queue] ?? 0)
    )
  }
  private checkWaiters(queue?: string): void {
    const snapshot = [...this.waiters]
    for (const waiter of snapshot) {
      if (queue !== undefined && waiter.queues.length > 0 && !waiter.queues.includes(queue))
        continue
      try {
        if (waiter.signal.aborted) {
          this.finishWaiter(waiter, Result.err(new JobStoreWakeAbortedError()) as Op<void>)
          continue
        }
      } catch (cause) {
        this.finishWaiter(waiter, fail('awaitWake', cause))
        continue
      }
      if (this.hasLocalWake(waiter)) {
        this.finishWaiter(waiter, ok(undefined))
        continue
      }
      void this.changed(waiter.baseline, waiter.queues)
        .then((yes) => {
          if (yes) this.finishWaiter(waiter, ok(undefined))
        })
        .catch((cause) => this.finishWaiter(waiter, fail('awaitWake', cause)))
    }
  }
  async awaitWake(request: J.AwaitWakeRequest): Promise<Op<void>> {
    try {
      const x = requireObject(request, 'request', ['queues', 'wakeToken', 'signal'])
      const queues = requireArray(x.queues, 'queues').map((q) => {
        const v = makeQueueName(q)
        if (Result.isError(v)) throw v.error
        return v.value
      })
      const signal = x.signal
      if (!isAbortSignal(signal))
        throw new JobDefinitionError({ field: 'signal', message: 'must be an AbortSignal' })
      if (signal.aborted) return Result.err(new JobStoreWakeAbortedError()) as Op<void>
      const baseline = this.decodeToken(x.wakeToken)
      if (signal.aborted) return Result.err(new JobStoreWakeAbortedError()) as Op<void>
      this.assertOpen('awaitWake')
      return new Promise((resolve) => {
        try {
          if (signal.aborted) {
            resolve(Result.err(new JobStoreWakeAbortedError()) as Op<void>)
            return
          }
        } catch (cause) {
          resolve(fail('awaitWake', cause))
          return
        }
        const waiter = {
          queues,
          baseline,
          signal,
          resolve,
          settled: false,
          listener: () =>
            this.finishWaiter(waiter, Result.err(new JobStoreWakeAbortedError()) as Op<void>)
        }
        try {
          signal.addEventListener('abort', waiter.listener, { once: true })
          if (signal.aborted) {
            this.finishWaiter(waiter, Result.err(new JobStoreWakeAbortedError()) as Op<void>)
            return
          }
        } catch (cause) {
          this.finishWaiter(waiter, fail('awaitWake', cause))
          return
        }
        if (waiter.settled) return
        this.waiters.add(waiter)
        this.scheduleWakePoll()
        // Revalidate both the local monotonic message cache and the durable
        // version after registration; either closes the message-before-waiter race.
        if (this.hasLocalWake(waiter)) this.finishWaiter(waiter, ok(undefined))
        else {
          void this.changed(baseline, queues)
            .then((yes) => {
              if (yes) this.finishWaiter(waiter, ok(undefined))
            })
            .catch((cause) => this.finishWaiter(waiter, fail('awaitWake', cause)))
        }
      })
    } catch (cause) {
      return fail('awaitWake', cause)
    }
  }
  async getJob(request: J.GetJobRequest): Promise<Op<JobRecord | undefined>> {
    try {
      const x = requireObject(request, 'request', ['jobId']),
        id = makeJobId(x.jobId)
      if (Result.isError(id)) throw id.error
      return ok(await this.read(id.value))
    } catch (cause) {
      return fail('getJob', cause)
    }
  }
  async getAttempts(request: J.GetAttemptsRequest): Promise<Op<readonly AttemptRecord[]>> {
    try {
      const x = requireObject(request, 'request', ['jobId']),
        id = makeJobId(x.jobId)
      if (Result.isError(id)) throw id.error
      const values = stringsReply(
        await this.command(['LRANGE', this.layout.attempts(id.value), '0', '-1'])
      )
      const out = [] as AttemptRecord[]
      for (const value of values) {
        const a = decodeAttempt(value)
        if (Result.isError(a)) throw a.error
        out.push(a.value)
      }
      return ok(Object.freeze(out))
    } catch (cause) {
      return fail('getAttempts', cause)
    }
  }
  async list(request: J.ListJobsRequest): Promise<Op<J.ListJobsResult>> {
    try {
      const x = requireObject(request, 'request')
      assertListFields(x)
      const limit = number(x.limit, 'limit', true)
      if (limit >= Number.MAX_SAFE_INTEGER - 1)
        throw new JobDefinitionError({ field: 'limit', message: 'must be bounded' })
      const queue = x.queue === undefined ? undefined : makeQueueName(x.queue)
      const name = x.name === undefined ? undefined : makeJobName(x.name)
      if (queue !== undefined && Result.isError(queue)) throw queue.error
      if (name !== undefined && Result.isError(name)) throw name.error
      const version = x.version === undefined ? undefined : number(x.version, 'version', true)
      const orderBy = (x.orderBy ?? 'enqueuedAt') as J.JobListOrderBy
      const order = (x.order ?? 'asc') as J.JobListOrder
      if (!['enqueuedAt', 'runAt', 'finishedAt'].includes(orderBy))
        throw new JobDefinitionError({ field: 'orderBy', message: 'is not supported' })
      if (order !== 'asc' && order !== 'desc')
        throw new JobDefinitionError({ field: 'order', message: 'must be asc or desc' })
      const states =
        x.state === undefined
          ? undefined
          : Array.isArray(x.state)
            ? requireArray(x.state, 'state')
            : [x.state]
      if (
        states !== undefined &&
        (states.length === 0 || states.some((item) => !jobStates.includes(item as never)))
      )
        throw new JobDefinitionError({ field: 'state', message: 'contains an unsupported state' })
      const metadata = x.metadata === undefined ? undefined : requireObject(x.metadata, 'metadata')
      if (
        metadata !== undefined &&
        Object.values(metadata).some((value) => typeof value !== 'string')
      )
        throw new JobDefinitionError({ field: 'metadata', message: 'values must be strings' })
      const normalized = {
        ...x,
        queue: queue === undefined ? undefined : queue.value,
        name: name === undefined ? undefined : name.value,
        version,
        state: states,
        metadata,
        orderBy,
        order
      }
      const signature = listSignature(normalized)
      const cursor =
        x.cursor === undefined
          ? undefined
          : requireObject(x.cursor, 'cursor', [
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
            ])
      const cursorRecord =
        cursor === undefined
          ? undefined
          : (() => {
              if (
                cursor.version !== 1 ||
                cursor.orderBy !== orderBy ||
                cursor.order !== order ||
                cursor.direction !== order ||
                cursor.ordering !== cursorOrdering(orderBy) ||
                cursor.filterSignature !== signature
              )
                throw new UnsupportedJobStoreOperationError({
                  operation: 'list.cursor',
                  message: 'cursor does not match the list filters or ordering'
                })
              const value =
                cursor.value === null
                  ? orderBy === 'finishedAt'
                    ? null
                    : (() => {
                        throw new JobDefinitionError({
                          field: 'cursor.value',
                          message: 'must not be null'
                        })
                      })()
                  : number(cursor.value, 'cursor.value')
              const createdAt = number(cursor.createdAt, 'cursor.createdAt')
              const orderingSequence = number(cursor.orderingSequence, 'cursor.orderingSequence')
              const cursorId = makeJobId(cursor.id)
              if (Result.isError(cursorId)) throw cursorId.error
              return Object.freeze({
                version: 1 as const,
                orderBy,
                order,
                ordering: cursorOrdering(orderBy),
                direction: order,
                filterSignature: signature,
                value,
                createdAt,
                orderingSequence,
                id: cursorId.value
              })
            })()
      const index =
        orderBy === 'enqueuedAt'
          ? this.layout.created
          : orderBy === 'runAt'
            ? this.layout.runAt
            : this.layout.finishedAt
      const cursorMember =
        cursorRecord === undefined
          ? undefined
          : encodeListingMember(cursorRecord.value, cursorRecord.orderingSequence, cursorRecord.id)
      const jobs: JobRecord[] = []
      let boundary = cursorMember
      let hasMore = false
      let exhausted = false
      const pageSize = 256
      let page = 0
      for (; page < 10_000 && jobs.length <= limit; page += 1) {
        const command =
          order === 'asc'
            ? [
                'ZRANGEBYLEX',
                index,
                boundary === undefined ? '-' : `(${boundary}`,
                '+',
                'LIMIT',
                '0',
                String(pageSize)
              ]
            : [
                'ZREVRANGEBYLEX',
                index,
                boundary === undefined ? '+' : `(${boundary}`,
                '-',
                'LIMIT',
                '0',
                String(pageSize)
              ]
        const members = stringsReply(await this.command(command))
        if (members.length === 0) {
          exhausted = true
          break
        }
        const stale: string[] = []
        for (const member of members) {
          const decoded = decodeListingMember(member)
          const record = await this.read(decoded.jobId)
          if (
            record === undefined ||
            listValue(record, orderBy) !== decoded.value ||
            record.orderingSequence !== decoded.orderingSequence ||
            record.id !== decoded.jobId
          ) {
            stale.push(member)
            continue
          }
          if (
            (queue !== undefined && record.queue !== queue.value) ||
            (name !== undefined && record.name !== name.value) ||
            (version !== undefined && record.version !== version) ||
            (states !== undefined && !states.includes(record.state)) ||
            (metadata !== undefined &&
              (Object.keys(record.metadata).length !== Object.keys(metadata).length ||
                !Object.entries(metadata).every(([key, value]) => record.metadata[key] === value)))
          )
            continue
          jobs.push(record)
          if (jobs.length > limit) {
            hasMore = true
            break
          }
        }
        if (stale.length > 0) {
          try {
            await this.command(['ZREM', index, ...stale])
          } catch {
            /* best-effort healing */
          }
        }
        if (jobs.length > limit) break
        if (members.length < pageSize) {
          exhausted = true
          break
        }
        boundary = members[members.length - 1]
      }
      if (!exhausted && jobs.length <= limit)
        throw new JobStoreFailure({
          operation: 'list',
          retryable: false,
          message: 'Redis list query exceeded its bounded scan limit'
        })
      const selected = jobs.slice(0, limit)
      const last = selected.at(-1)
      const nextCursor =
        hasMore && last !== undefined
          ? Object.freeze({
              version: 1 as const,
              orderBy,
              order,
              ordering: cursorOrdering(orderBy),
              direction: order,
              filterSignature: signature,
              value: listValue(last, orderBy),
              createdAt: last.createdAt,
              orderingSequence: last.orderingSequence,
              id: last.id
            })
          : undefined
      return ok({ jobs: Object.freeze(selected), nextCursor })
    } catch (cause) {
      return fail('list', cause)
    }
  }
  async counts(request: J.CountsRequest = {}): Promise<Op<J.JobCounts>> {
    try {
      const x = requireObject(request, 'request', ['queue', 'name'])
      const queue = x.queue === undefined ? undefined : makeQueueName(x.queue)
      const name = x.name === undefined ? undefined : makeJobName(x.name)
      if (queue !== undefined && Result.isError(queue)) throw queue.error
      if (name !== undefined && Result.isError(name)) throw name.error
      if (queue === undefined && name === undefined) {
        const fields = hashReply(await this.command(['HGETALL', this.layout.counts]))
        const out = {
          total: redisNumber(fields.total ?? '0', 'total'),
          waiting: redisNumber(fields.waiting ?? '0', 'waiting'),
          delayed: redisNumber(fields.delayed ?? '0', 'delayed'),
          active: redisNumber(fields.active ?? '0', 'active'),
          completed: redisNumber(fields.completed ?? '0', 'completed'),
          failed: redisNumber(fields.failed ?? '0', 'failed'),
          cancelled: redisNumber(fields.cancelled ?? '0', 'cancelled')
        }
        const calculated =
          out.waiting + out.delayed + out.active + out.completed + out.failed + out.cancelled
        if (calculated !== out.total || Object.keys(fields).some((key) => !(key in out)))
          throw new JobStoreFailure({
            operation: 'counts',
            retryable: false,
            message: 'Redis counters are inconsistent'
          })
        return ok(Object.freeze(out))
      }
      const out = {
        total: 0,
        waiting: 0,
        delayed: 0,
        active: 0,
        completed: 0,
        failed: 0,
        cancelled: 0
      }
      const ids =
        queue === undefined
          ? stringsReply(await this.command(['SMEMBERS', this.layout.all]))
          : stringsReply(await this.command(['SMEMBERS', this.layout.byQueue(queue.value)]))
      for (const id of ids) {
        const record = await this.read(id)
        if (record !== undefined && (name === undefined || record.name === name.value)) {
          if (out.total >= Number.MAX_SAFE_INTEGER)
            throw new JobDefinitionError({ field: 'count', message: 'is outside the safe range' })
          out.total += 1
          out[record.state] += 1
        }
      }
      return ok(Object.freeze(out))
    } catch (cause) {
      return fail('counts', cause)
    }
  }
  async retry(request: J.RetryRequest): Promise<Op<JobTransition>> {
    return this.transition('retry', request, retryFields, (r) => {
      const x = requireObject(request, 'request', retryFields)
      return reduceJob(r, {
        type: 'retry',
        jobId: r.id,
        runAt: number(x.runAt, 'runAt'),
        now: number(x.now, 'now')
      })
    })
  }
  async cancel(request: J.CancelRequest): Promise<Op<JobTransition>> {
    return this.transition('cancel', request, idFields, (r) => {
      const x = requireObject(request, 'request', idFields)
      return reduceJob(r, { type: 'cancel', jobId: r.id, now: number(x.now, 'now') })
    })
  }
  async requestCancellation(request: J.RequestCancellationRequest): Promise<Op<JobTransition>> {
    return this.transition('requestCancellation', request, idFields, (r) => {
      const x = requireObject(request, 'request', idFields)
      return reduceJob(r, { type: 'request-cancellation', jobId: r.id, now: number(x.now, 'now') })
    })
  }
  async promote(request: J.PromoteRequest): Promise<Op<JobTransition>> {
    return this.transition('promote', request, idFields, (r) => {
      const x = requireObject(request, 'request', idFields)
      return reduceJob(r, { type: 'promote', jobId: r.id, now: number(x.now, 'now') })
    })
  }
  async remove(request: J.RemoveRequest): Promise<Op<J.RemoveResult>> {
    try {
      const x = requireObject(request, 'request', removeFields)
      const id = makeJobId(x.jobId)
      const now = number(x.now, 'now')
      if (Result.isError(id)) throw id.error
      const r = await this.read(id.value)
      if (!r) throw new JobNotFoundError({ jobId: id.value })
      const currentRevision = await this.revision(id.value)
      if (r.state === 'active')
        throw new InvalidJobTransitionError({ jobId: r.id, from: r.state, operation: 'remove' })
      if (
        x.expectedState !== undefined &&
        (!jobStates.includes(x.expectedState as never) || r.state !== x.expectedState)
      )
        throw new InvalidJobTransitionError({ jobId: r.id, from: r.state, operation: 'remove' })
      if (now < r.updatedAt)
        throw new JobDefinitionError({
          field: 'now',
          message: 'must not be earlier than updatedAt'
        })
      await this.erase(r, now, currentRevision)
      return ok({ job: r, removed: true })
    } catch (cause) {
      return fail('remove', cause)
    }
  }
  async pause(request: J.PauseQueueRequest): Promise<Op<J.QueuePauseResult>> {
    return this.pauseResume(request, true)
  }
  async resume(request: J.PauseQueueRequest): Promise<Op<J.QueuePauseResult>> {
    return this.pauseResume(request, false)
  }
  private async pauseResume(
    request: J.PauseQueueRequest,
    paused: boolean
  ): Promise<Op<J.QueuePauseResult>> {
    try {
      const x = requireObject(request, 'request', pauseFields),
        q = makeQueueName(x.queue)
      if (Result.isError(q)) throw q.error
      const now = number(x.now, 'now')
      const scriptName = paused ? 'pause' : 'resume'
      const keys = {
        queueControls: this.layout.queues,
        wake: this.layout.wake,
        wakeChannel: this.layout.wakeChannel
      }
      const reply = await this.script(scriptName, uniqueKeys(Object.values(keys)), [
        JSON.stringify({
          reply: scriptName,
          mode: paused ? 'pause' : 'resume',
          keys,
          queue: q.value,
          paused,
          now
        })
      ])
      const values = tupleReply(reply.values, scriptName, 3)
      if (values[0] !== 'applied' || values[1] !== q.value) {
        throw new JobStoreFailure({
          operation: scriptName,
          retryable: false,
          message: 'Redis queue control returned an invalid reply'
        })
      }
      redisNumber(values[2], `${scriptName}.version`)
      return ok({ queue: q.value as never, paused })
    } catch (cause) {
      return fail(paused ? 'pause' : 'resume', cause)
    }
  }
  async pausedQueues(): Promise<Op<readonly import('better-effect-mq').QueueName[]>> {
    try {
      const out: import('better-effect-mq').QueueName[] = []
      for (const [rawQueue, value] of Object.entries(
        hashReply(await this.command(['HGETALL', this.layout.queues]))
      )) {
        if (value !== '0' && value !== '1')
          throw new JobStoreFailure({
            operation: 'pausedQueues',
            retryable: false,
            message: 'Redis queue controls are corrupted'
          })
        if (value !== '1') continue
        const queue = makeQueueName(rawQueue)
        if (Result.isError(queue)) throw queue.error
        out.push(queue.value)
      }
      out.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      return ok(Object.freeze(out))
    } catch (cause) {
      return fail('pausedQueues', cause)
    }
  }
  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = this.disposeOnce()
    return this.disposal
  }
  private async disposeOnce(): Promise<void> {
    this.stopWakePoll()
    for (const waiter of this.waiters)
      this.finishWaiter(
        waiter,
        fail(
          'awaitWake',
          new JobStoreFailure({
            operation: 'awaitWake',
            retryable: false,
            message: 'Redis JobStore has been disposed'
          })
        )
      )
    const errors: unknown[] = []
    if (this.unsubscribeWake !== undefined) {
      try {
        await this.unsubscribeWake()
      } catch (cause) {
        errors.push(cause)
      }
    }
    try {
      await this.redis.dispose()
    } catch (cause) {
      errors.push(cause)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Redis JobStore cleanup failed')
  }
}

const makeLayer = <T extends AnyJobStoreToken>(
  token: T,
  acquire: () => Promise<RedisClient>
): Layer<InstanceType<T>, never> =>
  Layer.scoped(
    token,
    async () => {
      const client = await acquire()
      let implementation: RedisJobStoreImplementation | undefined
      try {
        await client.initialize()
        implementation = new RedisJobStoreImplementation(client)
        await implementation.start()
        return JobStore.of(implementation as never) as unknown as ServiceContract<InstanceType<T>>
      } catch (cause) {
        try {
          if (implementation !== undefined) await implementation.dispose()
          else await client.dispose()
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            'Redis JobStore acquisition cleanup failed'
          )
        }
        throw cause
      }
    },
    async (store) => {
      await (store as unknown as RedisJobStoreImplementation).dispose()
    }
  )
const namespaceFor = (token: AnyJobStoreToken, namespace: string) =>
  token.serviceTag === JobStore.serviceTag
    ? namespace
    : `${namespace}:store-${Buffer.from(token.serviceTag).toString('base64url')}`
export const RedisJobStore = Object.freeze({
  layer(config: RedisJobStoreConfig) {
    return makeLayer(JobStore, async () => RedisClient.fromClients(config))
  },
  layerFor<T extends AnyJobStoreToken>(token: T, config: RedisJobStoreConfig) {
    return makeLayer(token, async () =>
      RedisClient.fromClients({
        ...config,
        namespace: namespaceFor(token, config.namespace ?? 'default')
      })
    )
  },
  layerFromConfig(config: RedisJobStoreConnectionConfig) {
    return makeLayer(JobStore, async () => RedisClient.fromConfig(config))
  },
  layerFromConfigFor<T extends AnyJobStoreToken>(token: T, config: RedisJobStoreConnectionConfig) {
    return makeLayer(token, async () =>
      RedisClient.fromConfig({
        ...config,
        namespace: namespaceFor(token, config.namespace ?? 'default')
      })
    )
  }
})
