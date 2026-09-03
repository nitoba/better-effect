// oxlint-disable anti-slop/no-runtime-typeof -- application methods validate untyped consumer boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- callbacks, options, and store results cross JavaScript boundaries.
// oxlint-disable anti-slop/no-unknown-returns -- erased descriptor operations are restored at the typed Job boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts stay at codec and heterogeneous descriptor boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- each erased boundary is checked immediately before restoration.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- option and request records are validated before use.
// oxlint-disable anti-slop/no-known-value-widening -- dynamic DTOs are assembled after field validation.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional protocol fields are copied after validation.
// oxlint-disable anti-slop/no-object-parameters -- plain objects are used for validated boundary records.
// oxlint-disable typescript/no-redundant-type-constituents -- erased internal operations intentionally carry unknown failures.

import { CurrentAbortSignal } from 'better-effect'
import type { ServiceRequirement } from 'better-effect'
import { Clock } from 'better-effect/standard-services'
import { Result, UnhandledException } from 'better-result'
import type { Err, Result as ResultType } from 'better-result'

import { JobDecodeFailure, JobEncodeFailure } from '../codec'
import { hasUnpairedSurrogate } from '../internal/validation'
import { isMarkedVoidCodec } from '../codec/snapshot'
import { validateJsonValue } from '../codec/json'
import {
  JobDefinitionError,
  JobNotFoundError,
  JobStoreFailure,
  UnsupportedJobStoreOperationError,
  makeJobId,
  makeJobName,
  makePersistedBackoff,
  makeQueueName,
  validateDuration,
  validateOptionalDuration,
  validateTimestamp
} from '../protocol'
import type {
  AttemptRecord,
  JobFailureKind,
  JobId,
  JobRecord,
  JobState,
  JsonValue,
  PersistedBackoff,
  SerializedJobFailure
} from '../protocol'
import { isJobStoreToken } from '../store'
import type {
  AnyJobStoreToken,
  JobStoreOperation,
  JobStoreError,
  JobStoreCancelError,
  JobStoreGetAttemptsError,
  JobStoreGetJobError,
  JobStoreListError,
  JobStoreCountsError,
  JobStorePauseError,
  JobStoreResumeError,
  JobStoreRemoveError,
  JobListCursor,
  JobListOrder,
  JobListOrderBy,
  JobStorePromoteError,
  JobStoreRetryError
} from '../store'

import type { CodecLike, JobDefaults, JobIdentity } from './job'
import { freezeJobEvent } from '../observability/events'
import type { JobObserver } from '../observability/observer'
import { notifyJobObserver } from '../observability/observer'
import {
  JobAwaitAbortedError,
  JobExecutionCancelledError,
  JobExecutionFailureError,
  JobIdentityMismatchError
} from './application-errors'

/** The Result-yielding operation shape used by Job and JobAdmin methods. */
export type JobOperation<
  Success,
  Failure,
  Store extends AnyJobStoreToken,
  NeedsClock extends boolean = false
> = AsyncGenerator<
  | Err<never, Failure>
  | ServiceRequirement<
      InstanceType<Store> | (NeedsClock extends true ? InstanceType<typeof Clock> : never)
    >,
  Success,
  unknown
>

/** Alias for consumers that describe Job methods as Effects. */
export type JobEffect<
  Success,
  Failure,
  Store extends AnyJobStoreToken,
  NeedsClock extends boolean = false
> = JobOperation<Success, Failure, Store, NeedsClock>

type JobScheduleFields =
  | {
      readonly delayMs?: never
      readonly at?: never
    }
  | {
      readonly delayMs: number
      readonly at?: never
    }
  | {
      readonly delayMs?: never
      readonly at: number
    }

type JobEnqueueFields = {
  readonly jobId?: string
  readonly idempotencyKey?: string
  readonly priority?: number
  readonly attempts?: number
  readonly backoff?: PersistedBackoff
  readonly timeoutMs?: number
  readonly metadata?: Readonly<Record<string, string>>
}

/** Options for one typed enqueue. `delayMs` and `at` are mutually exclusive. */
export type JobEnqueueOptions =
  | (JobEnqueueFields & { readonly delayMs?: never; readonly at?: never })
  | (JobEnqueueFields & { readonly delayMs: number; readonly at?: never })
  | (JobEnqueueFields & { readonly delayMs?: never; readonly at: number })

/** A per-item payload/options pair accepted by `Job.enqueueMany`. */
export type JobEnqueueManyItem<Payload> = {
  readonly payload: Payload
  readonly options?: JobEnqueueOptions
}

/** Shared batch options. IDs and shared idempotency keys are intentionally forbidden. */
export type JobEnqueueManyOptions =
  | (Omit<JobEnqueueFields, 'jobId' | 'idempotencyKey'> & {
      readonly delayMs?: never
      readonly at?: never
      readonly chunkSize?: number
    })
  | (Omit<JobEnqueueFields, 'jobId' | 'idempotencyKey'> & {
      readonly delayMs: number
      readonly at?: never
      readonly chunkSize?: number
    })
  | (Omit<JobEnqueueFields, 'jobId' | 'idempotencyKey'> & {
      readonly delayMs?: never
      readonly at: number
      readonly chunkSize?: number
    })

/** Polling controls used by `awaitResult`; aborting never cancels a persisted Job. */
export type JobAwaitOptions = {
  readonly pollIntervalMs?: number
  readonly signal?: AbortSignal
}

/** Enqueue options plus caller-owned waiting controls for `execute`. */
export type JobExecuteOptions = JobEnqueueOptions & JobAwaitOptions

/** Explicit retry schedule controls. */
export type JobRetryOptions = JobScheduleFields

export type JobEnqueueError =
  | JobDecodeFailure
  | JobEncodeFailure
  | JobDefinitionError
  | import('../store').JobStoreEnqueueError
  | import('better-result').UnhandledException

export type JobPollError =
  | JobStoreGetJobError
  | JobIdentityMismatchError
  | JobDecodeFailure
  | UnhandledException

export type JobAttemptsError =
  | JobStoreGetJobError
  | JobStoreGetAttemptsError
  | JobNotFoundError
  | JobIdentityMismatchError
  | JobDecodeFailure
  | UnhandledException

export type JobCancelError =
  | JobStoreGetJobError
  | JobIdentityMismatchError
  | JobStoreCancelError
  | UnhandledException

export type JobPromoteError =
  | JobStoreGetJobError
  | JobIdentityMismatchError
  | JobStorePromoteError
  | UnhandledException

export type JobRetryError =
  | JobStoreGetJobError
  | JobIdentityMismatchError
  | JobStoreRetryError
  | UnhandledException

type JobTransitionApplicationError = JobCancelError | JobPromoteError | JobRetryError

/** An encoded failure view with typed `data` only for the `typed` kind. */
export type DecodedJobFailure<Failure> =
  | (Omit<SerializedJobFailure, 'kind' | 'data'> & {
      readonly kind: 'typed'
      readonly data: Failure
    })
  | (Omit<SerializedJobFailure, 'kind'> & {
      readonly kind: Exclude<JobFailureKind, 'typed'>
    })

/** A Job snapshot with result/failure payloads decoded according to one definition. */
export type JobRecordView<Success, Failure> = Omit<JobRecord, 'result' | 'failure'> & {
  readonly result: Success | undefined
  readonly failure: DecodedJobFailure<Failure> | undefined
}

/** An attempt ledger entry with outcome-specific payload decoding. */
export type JobAttemptView<Success, Failure> = Omit<AttemptRecord, 'result' | 'failure'> & {
  readonly result: Success | undefined
  readonly failure: DecodedJobFailure<Failure> | undefined
}

export type JobAwaitResultError<Failure> =
  | Failure
  | JobStoreGetJobError
  | JobIdentityMismatchError
  | JobNotFoundError
  | JobDecodeFailure
  | JobExecutionFailureError
  | JobExecutionCancelledError
  | JobAwaitAbortedError
  | UnhandledException

/** Public list options mirror the protocol's portable, encoded-neutral query shape. */
export type JobAdminListOptions = {
  readonly queue?: string
  readonly name?: string
  readonly version?: number
  readonly metadata?: Readonly<Record<string, string>>
  readonly orderBy?: 'enqueuedAt' | 'runAt' | 'finishedAt'
  readonly order?: 'asc' | 'desc'
  readonly limit?: number
  readonly cursor?: JobListCursor
} & (
  | {
      readonly state?: JobState | readonly JobState[]
      readonly states?: never
    }
  | {
      readonly state?: never
      readonly states?: readonly JobState[]
    }
)

export type JobAdminCountOptions = {
  readonly queue?: string
  readonly name?: string
}

export type JobAdminRemoveOptions = {
  readonly expectedState?: JobState
}

export type JobAdminListError = JobStoreListError | UnhandledException
export type JobAdminCountError = JobStoreCountsError | UnhandledException
export type JobAdminPauseError = JobStorePauseError | UnhandledException
export type JobAdminResumeError = JobStoreResumeError | UnhandledException
export type JobAdminRemoveError = JobStoreRemoveError | UnhandledException

/** Stateless generic admin methods bound explicitly to one JobStore token. */
export interface JobAdminClient<Store extends AnyJobStoreToken> {
  readonly list: (
    options?: JobAdminListOptions
  ) => JobOperation<import('../store').ListJobsResult, JobAdminListError, Store>
  readonly counts: {
    (queue?: string): JobOperation<import('../store').JobCounts, JobAdminCountError, Store>
    (
      options: JobAdminCountOptions
    ): JobOperation<import('../store').JobCounts, JobAdminCountError, Store>
  }
  readonly count: {
    (queue?: string): JobOperation<number, JobAdminCountError, Store>
    (options: JobAdminCountOptions): JobOperation<number, JobAdminCountError, Store>
  }
  readonly pause: (
    queue: string
  ) => JobOperation<import('../store').QueuePauseResult, JobAdminPauseError, Store, true>
  readonly resume: (
    queue: string
  ) => JobOperation<import('../store').QueuePauseResult, JobAdminResumeError, Store, true>
  readonly pausedQueues: () => JobOperation<
    readonly import('../protocol').QueueName[],
    import('../store').JobStorePausedQueuesError | UnhandledException,
    Store
  >
  readonly remove: (
    jobId: string,
    options?: JobAdminRemoveOptions
  ) => JobOperation<import('../store').RemoveResult, JobAdminRemoveError, Store, true>
}

/** An observer binding that can be applied to a selected JobStore. */
export interface JobAdminObserverBinding {
  readonly for: <Store extends AnyJobStoreToken>(token: Store) => JobAdminClient<Store>
}

/** Runtime descriptor fields needed by the single descriptor-bound implementation. */
export type JobOperationDescriptor = {
  readonly identity: JobIdentity<string, string, number>
  readonly payload: CodecLike
  readonly result: CodecLike | undefined
  readonly failure: CodecLike | undefined
  readonly defaults: JobDefaults
  readonly store: AnyJobStoreToken
  readonly idempotencyKey: unknown
  readonly metadata: unknown
  readonly observer?: JobObserver | undefined
}

/** The methods attached immutably to every Job descriptor. */
export interface JobBoundOperations<
  PayloadInput,
  Success,
  Failure,
  Store extends AnyJobStoreToken
> {
  readonly enqueue: (
    payload: PayloadInput,
    options?: JobEnqueueOptions
  ) => JobOperation<JobId, JobEnqueueError, Store, true>
  readonly enqueueMany: {
    (
      items: readonly JobEnqueueManyItem<PayloadInput>[],
      options?: JobEnqueueManyOptions
    ): JobOperation<readonly JobId[], JobEnqueueError, Store, true>
    (
      payloads: readonly PayloadInput[],
      options?: JobEnqueueManyOptions
    ): JobOperation<readonly JobId[], JobEnqueueError, Store, true>
  }
  readonly poll: (
    jobId: string
  ) => JobOperation<JobRecordView<Success, Failure> | undefined, JobPollError, Store>
  readonly attempts: (
    jobId: string
  ) => JobOperation<readonly JobAttemptView<Success, Failure>[], JobAttemptsError, Store>
  readonly awaitResult: (
    jobId: string,
    options?: JobAwaitOptions
  ) => JobOperation<JobAwaitResultSuccess<Success>, JobAwaitResultError<Failure>, Store, true>
  readonly execute: (
    payload: PayloadInput,
    options?: JobExecuteOptions
  ) => JobOperation<
    JobAwaitResultSuccess<Success>,
    JobEnqueueError | JobAwaitResultError<Failure>,
    Store,
    true
  >
  readonly cancel: (jobId: string) => JobOperation<JobRecord, JobCancelError, Store, true>
  readonly promote: (jobId: string) => JobOperation<JobRecord, JobPromoteError, Store, true>
  readonly retry: (
    jobId: string,
    options?: JobRetryOptions
  ) => JobOperation<JobRecord, JobRetryError, Store, true>
}

/** `undefined` is the runtime result of a completed Job without a result codec. */
type JobAwaitResultSuccess<Success> = [Success] extends [never] ? Success | undefined : Success

type ErasedOperations = JobBoundOperations<unknown, unknown, unknown, AnyJobStoreToken>
type ErasedView = JobRecordView<unknown, unknown>
type ErasedAttemptView = JobAttemptView<unknown, unknown>
type ErasedAwaitError = JobAwaitResultError<unknown>
type ErasedOperation<
  Success = unknown,
  Failure = unknown,
  NeedsClock extends boolean = false
> = JobOperation<Success, Failure, AnyJobStoreToken, NeedsClock>

type MutableRecord = Record<string, unknown>

const enqueueFields = [
  'jobId',
  'idempotencyKey',
  'delayMs',
  'at',
  'priority',
  'attempts',
  'backoff',
  'timeoutMs',
  'metadata'
] as const

const batchFields = [
  ...enqueueFields.filter((field) => field !== 'jobId' && field !== 'idempotencyKey'),
  'chunkSize'
] as const
const awaitFields = ['pollIntervalMs', 'signal'] as const
const executeFields = [...enqueueFields, ...awaitFields] as const
const listFields = [
  'queue',
  'name',
  'version',
  'state',
  'states',
  'metadata',
  'orderBy',
  'order',
  'limit',
  'cursor'
] as const
const countFields = ['queue', 'name'] as const
const removeFields = ['expectedState'] as const
const cursorFields = [
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
] as const

const defaultBatchChunkSize = 32
const defaultPollIntervalMs = 100
const cursorVersion = 1 as const
const defaultListOrderBy: JobListOrderBy = 'enqueuedAt'
const defaultListOrder: JobListOrder = 'asc'

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const isObjectLike = (value: unknown): value is object | ((...arguments_: never[]) => unknown) =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const isPlainObject = (value: unknown): value is object => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const invalid = <Value>(field: string, message: string): ResultType<Value, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

const readFields = (
  value: unknown,
  fields: readonly string[],
  field: string,
  allowUndefined = true
): ResultType<Readonly<Record<string, unknown>>, JobDefinitionError> => {
  if (value === undefined && allowUndefined) {
    return Result.ok(Object.freeze(Object.create(null) as Record<string, unknown>))
  }

  if (!isPlainObject(value)) {
    return invalid(field, 'must be a plain object')
  }

  try {
    const allowed = new Set(fields)
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        return invalid(field, 'contains unsupported fields')
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor)) {
        return invalid(field, 'contains an accessor field')
      }

      output[key] = descriptor.value
    }

    return Result.ok(Object.freeze(output))
  } catch {
    return invalid(field, 'could not read fields')
  }
}

const isResultValue = (value: unknown): value is ResultType<unknown, unknown> => {
  if (!isObjectLike(value)) {
    return false
  }

  try {
    // SAFETY: only the status/branch methods are read before the value enters a Result operation.
    const result = value as ResultType<unknown, unknown>
    return Result.isOk(result) || Result.isError(result)
  } catch {
    return false
  }
}

const normalizeCodecFailure = (
  kind: 'encode' | 'decode',
  cause: unknown
): JobEncodeFailure | JobDecodeFailure => {
  if (kind === 'encode') {
    return JobEncodeFailure.is(cause)
      ? cause
      : new JobEncodeFailure({
          message: 'Job payload encode operation failed',
          code: 'callback-failure'
        })
  }

  return JobDecodeFailure.is(cause)
    ? cause
    : new JobDecodeFailure({
        message: 'Job payload decode operation failed',
        code: 'callback-failure'
      })
}

const invokeCodec = async (
  operation: unknown,
  value: unknown,
  kind: 'encode' | 'decode'
): Promise<ResultType<unknown, JobEncodeFailure | JobDecodeFailure>> => {
  if (typeof operation !== 'function') {
    return Result.err(normalizeCodecFailure(kind, undefined))
  }

  try {
    // SAFETY: codec snapshots erase their argument type; this call is guarded by the callable check.
    const returned = (operation as (input: unknown) => unknown)(value)
    const resolved = await returned

    if (!isResultValue(resolved)) {
      return Result.err(normalizeCodecFailure(kind, undefined))
    }

    if (Result.isError(resolved)) {
      return Result.err(normalizeCodecFailure(kind, resolved.error))
    }

    return Result.ok(resolved.value)
  } catch (cause) {
    return Result.err(normalizeCodecFailure(kind, cause))
  }
}

const encodeValue = async (
  codec: CodecLike | undefined,
  value: unknown
): Promise<ResultType<JsonValue, JobEncodeFailure>> => {
  const operation = codec?.encode
  const encoded = await invokeCodec(operation, value, 'encode')

  if (Result.isError(encoded)) {
    if (JobEncodeFailure.is(encoded.error)) {
      return Result.err(encoded.error)
    }

    return Result.err(new JobEncodeFailure({ code: 'callback-failure' }))
  }

  const checked = validateJsonValue(encoded.value)
  if (!checked.ok) {
    return Result.err(
      new JobEncodeFailure({
        message: 'Encoded Job payload is not JSON-safe',
        code: checked.code,
        path: checked.path
      })
    )
  }

  return Result.ok(checked.value)
}

const decodeValue = async (
  codec: CodecLike | undefined,
  value: unknown
): Promise<ResultType<unknown, JobDecodeFailure>> => {
  const operation = codec?.decode
  const decoded = await invokeCodec(operation, value, 'decode')

  if (Result.isError(decoded)) {
    if (JobDecodeFailure.is(decoded.error)) {
      return Result.err(decoded.error)
    }

    return Result.err(new JobDecodeFailure({ code: 'callback-failure' }))
  }

  return Result.ok(decoded.value)
}

const resolveStoreOperation = async <Value, Failure extends JobStoreError>(
  operation: JobStoreOperation<Value, Failure>
): Promise<ResultType<Value, Failure | UnhandledException>> => {
  try {
    const resolved = await operation

    if (Result.isOk(resolved)) {
      return Result.ok(resolved.value)
    }

    if (Result.isError(resolved)) {
      return Result.err(resolved.error)
    }

    return Result.err(
      new UnhandledException({ cause: new TypeError('JobStore returned an invalid Result') })
    )
  } catch (cause) {
    return Result.err(new UnhandledException({ cause }))
  }
}

const observedStoreOperation = async <Value, Failure extends JobStoreError>(
  operation: JobStoreOperation<Value, Failure>,
  observer: JobObserver | undefined,
  operationName: string,
  recordedAt?: number
): Promise<ResultType<Value, Failure | UnhandledException>> => {
  const result = await resolveStoreOperation(operation)
  if (Result.isError(result) && observer !== undefined) {
    notifyJobObserver(
      observer,
      freezeJobEvent({
        type: 'store-operation-failed',
        recordedAt: recordedAt ?? Date.now(),
        operation: operationName,
        retryable: isRetryableStoreFailure(result.error)
      })
    )
  }
  return result
}

const isRetryableStoreFailure = (error: unknown): boolean =>
  JobStoreFailure.is(error) && error.retryable === true

const clockNow = (
  clock: InstanceType<typeof Clock>
): ResultType<number, JobDefinitionError | UnhandledException> => {
  try {
    return validateTimestamp(clock.now().getTime(), 'clock.now')
  } catch (cause) {
    return Result.err(new UnhandledException({ cause }))
  }
}

const normalizePositiveInteger = (
  value: unknown,
  field: string
): ResultType<number, JobDefinitionError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return invalid(field, 'must be a positive safe integer')
  }

  return Result.ok(value)
}

const normalizePriority = (value: unknown): ResultType<number, JobDefinitionError> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return invalid('priority', 'must be a safe integer')
  }

  return Result.ok(value)
}

const normalizeJobId = (value: unknown): ResultType<JobId, JobDefinitionError> => makeJobId(value)

const normalizeSchedule = (
  fields: Readonly<Record<string, unknown>>,
  now: number
): ResultType<number, JobDefinitionError> => {
  const hasDelay = hasOwn(fields, 'delayMs')
  const hasAt = hasOwn(fields, 'at')

  if (hasDelay && hasAt) {
    return invalid('schedule', 'delayMs and at are mutually exclusive')
  }

  if (hasAt) {
    return validateTimestamp(fields.at, 'at')
  }

  if (!hasDelay || fields.delayMs === undefined) {
    return Result.ok(now)
  }

  const delay = validateDuration(fields.delayMs, 'delayMs')
  if (Result.isError(delay)) {
    return delay
  }

  if (delay.value > Number.MAX_SAFE_INTEGER - now) {
    return invalid('delayMs', 'runAt exceeds safe integer range')
  }

  return Result.ok(now + delay.value)
}

const normalizeMetadataValue = (
  value: unknown
): ResultType<Readonly<Record<string, string>>, JobDefinitionError> => {
  if (!isPlainObject(value)) {
    return invalid('metadata', 'must be a plain object with string values')
  }

  try {
    const result: Record<string, string> = {}

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        return invalid('metadata', 'must contain only string keys and values')
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor)) {
        return invalid('metadata', 'must contain only data properties')
      }

      if (typeof descriptor.value !== 'string') {
        return invalid('metadata', 'must contain only string keys and values')
      }

      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true
      })
    }

    return Result.ok(Object.freeze(result))
  } catch {
    return invalid('metadata', 'could not read metadata')
  }
}

const normalizeIdempotencyValue = (
  value: unknown
): ResultType<string | undefined, JobDefinitionError> => {
  if (value === undefined) {
    return Result.ok(undefined)
  }

  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    hasUnpairedSurrogate(value)
  ) {
    return invalid(
      'idempotencyKey',
      'must be a non-empty well-formed string without NUL or undefined'
    )
  }

  return Result.ok(value)
}

const invokeDefinitionCallback = (
  callback: unknown,
  value: unknown,
  field: 'idempotencyKey' | 'metadata'
): ResultType<unknown, JobDefinitionError> => {
  if (typeof callback !== 'function') {
    return invalid(field, 'callback is invalid')
  }

  try {
    // SAFETY: definitions validate callback callability; the payload value was materialized by its codec.
    return Result.ok((callback as (payload: unknown) => unknown)(value))
  } catch {
    return invalid(field, 'callback failed')
  }
}

const mergeMetadata = (
  derived: Readonly<Record<string, string>>,
  override: Readonly<Record<string, string>>
): Readonly<Record<string, string>> => Object.freeze({ ...derived, ...override })

const makeEnqueueRequest = (
  definition: JobOperationDescriptor,
  fields: Readonly<Record<string, unknown>>,
  materialized: unknown,
  encoded: JsonValue,
  now: number
): ResultType<import('../store').EnqueueRequest, JobEnqueueError> => {
  const schedule = normalizeSchedule(fields, now)
  if (Result.isError(schedule)) return schedule

  const priority =
    fields.priority === undefined
      ? Result.ok(definition.defaults.priority)
      : normalizePriority(fields.priority)
  const attempts =
    fields.attempts === undefined
      ? Result.ok(definition.defaults.attempts)
      : normalizePositiveInteger(fields.attempts, 'attempts')
  const timeout =
    fields.timeoutMs === undefined
      ? Result.ok<number | undefined>(definition.defaults.timeoutMs)
      : validateOptionalDuration(fields.timeoutMs, 'timeoutMs')

  if (Result.isError(priority)) return priority
  if (Result.isError(attempts)) return attempts
  if (Result.isError(timeout)) return timeout
  if (timeout.value === 0) return invalid('timeoutMs', 'must be greater than zero')

  const backoff =
    fields.backoff === undefined
      ? Result.ok<PersistedBackoff | undefined>(definition.defaults.backoff)
      : makePersistedBackoff(fields.backoff)
  if (Result.isError(backoff)) return backoff

  const derivedMetadata =
    definition.metadata === undefined
      ? Result.ok<Readonly<Record<string, string>>>({})
      : invokeDefinitionCallback(definition.metadata, materialized, 'metadata').andThen(
          normalizeMetadataValue
        )
  if (Result.isError(derivedMetadata)) return derivedMetadata

  const overrideMetadata =
    fields.metadata === undefined
      ? Result.ok<Readonly<Record<string, string>>>({})
      : normalizeMetadataValue(fields.metadata)
  if (Result.isError(overrideMetadata)) return overrideMetadata

  const metadata = mergeMetadata(derivedMetadata.value, overrideMetadata.value)
  const explicitJobId =
    fields.jobId === undefined
      ? Result.ok<JobId | undefined>(undefined)
      : normalizeJobId(fields.jobId)
  if (Result.isError(explicitJobId)) return explicitJobId

  // An explicit ID is the stronger identity choice. Do not evaluate or forward
  // an idempotency key that could make the store return another Job.
  const idempotency =
    explicitJobId.value !== undefined
      ? Result.ok<string | undefined>(undefined)
      : hasOwn(fields, 'idempotencyKey')
        ? normalizeIdempotencyValue(fields.idempotencyKey)
        : definition.idempotencyKey === undefined
          ? Result.ok<string | undefined>(undefined)
          : invokeDefinitionCallback(
              definition.idempotencyKey,
              materialized,
              'idempotencyKey'
            ).andThen(normalizeIdempotencyValue)
  if (Result.isError(idempotency)) return idempotency

  const request: MutableRecord = {
    identity: definition.identity,
    payload: encoded,
    metadata,
    priority: priority.value,
    runAt: schedule.value,
    attemptsMax: attempts.value,
    now
  }

  if (explicitJobId.value !== undefined) request.id = explicitJobId.value

  if (backoff.value !== undefined) request.backoff = backoff.value
  if (timeout.value !== undefined) request.timeoutMs = timeout.value
  if (idempotency.value !== undefined) request.idempotencyKey = idempotency.value

  return Result.ok(request as import('../store').EnqueueRequest)
}

const prepareEnqueue = async (
  definition: JobOperationDescriptor,
  payload: unknown,
  options: unknown,
  now: number
): Promise<ResultType<import('../store').EnqueueRequest, JobEnqueueError>> => {
  const fields = readFields(options, enqueueFields, 'options')
  if (Result.isError(fields)) return fields

  const materialized = await decodeValue(definition.payload, payload)
  if (Result.isError(materialized)) return materialized

  const encoded = await encodeValue(definition.payload, materialized.value)
  if (Result.isError(encoded)) return encoded

  return makeEnqueueRequest(definition, fields.value, materialized.value, encoded.value, now)
}

const copyKnownFields = (
  fields: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): Record<string, unknown> => {
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>

  for (const field of allowed) {
    if (hasOwn(fields, field)) output[field] = fields[field]
  }

  return output
}

const normalizeBatchItem = (
  value: unknown
): { readonly payload: unknown; readonly options: unknown } => {
  if (!isPlainObject(value)) {
    return { payload: value, options: undefined }
  }

  try {
    // The options member is optional, so the payload marker alone identifies a
    // batch wrapper. This prevents `{ payload }` from being encoded as a Job payload.
    if (!hasOwn(value, 'payload')) {
      return { payload: value, options: undefined }
    }

    const payload = Object.getOwnPropertyDescriptor(value, 'payload')
    if (payload === undefined || !('value' in payload)) {
      return { payload: value, options: undefined }
    }

    if (!hasOwn(value, 'options')) {
      return { payload: payload.value, options: undefined }
    }

    const options = Object.getOwnPropertyDescriptor(value, 'options')
    if (options === undefined || !('value' in options)) {
      return { payload: value, options: undefined }
    }

    return { payload: payload.value, options: options.value }
  } catch {
    return { payload: value, options: undefined }
  }
}

const normalizeChunkSize = (value: unknown): ResultType<number, JobDefinitionError> =>
  value === undefined
    ? Result.ok(defaultBatchChunkSize)
    : normalizePositiveInteger(value, 'chunkSize')

const mergeBatchOptions = (
  shared: Readonly<Record<string, unknown>>,
  item: Readonly<Record<string, unknown>>
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...shared, ...item }
  if (hasOwn(item, 'delayMs')) delete merged.at
  if (hasOwn(item, 'at')) delete merged.delayMs
  return merged
}

const emitEnqueued = (
  observer: JobObserver | undefined,
  job: JobRecord,
  duplicate: boolean,
  recordedAt: number
): void => {
  if (observer === undefined) return
  notifyJobObserver(
    observer,
    freezeJobEvent({
      type: 'enqueued',
      recordedAt,
      jobId: job.id,
      queue: job.queue,
      name: job.name,
      version: job.version,
      duplicate
    })
  )
}

const runEnqueue = async function* (
  definition: JobOperationDescriptor,
  payload: unknown,
  options: unknown
): ErasedOperation<JobId, JobEnqueueError, true> {
  const fields = readFields(options, enqueueFields, 'options')
  const checkedFields = yield* Result.await(Promise.resolve(fields))
  const store = yield* definition.store
  const clock = yield* Clock
  const now = yield* Result.await(Promise.resolve(clockNow(clock)))
  const request = yield* Result.await(
    Promise.resolve(prepareEnqueue(definition, payload, checkedFields, now))
  )
  const result = yield* Result.await(
    Promise.resolve(
      observedStoreOperation(store.enqueue(request), definition.observer, 'enqueue', now)
    )
  )
  emitEnqueued(definition.observer, result.job, result.duplicate, now)

  return result.job.id
}

const runEnqueueMany = async function* (
  definition: JobOperationDescriptor,
  values: readonly unknown[],
  options: unknown
): ErasedOperation<readonly JobId[], JobEnqueueError, true> {
  if (!Array.isArray(values)) {
    return yield* failOperation<readonly JobId[], JobDefinitionError>(
      new JobDefinitionError({ field: 'payloads', message: 'must be an array' })
    )
  }
  const fields = readFields(options, batchFields, 'options')
  const checkedFields = yield* Result.await(Promise.resolve(fields))
  const chunkSize = yield* Result.await(
    Promise.resolve(normalizeChunkSize(checkedFields.chunkSize))
  )
  const store = yield* definition.store
  const clock = yield* Clock
  const now = yield* Result.await(Promise.resolve(clockNow(clock)))
  const ids: JobId[] = []
  const sharedOptions = copyKnownFields(checkedFields, enqueueFields)

  // Validate every schedule before the first chunk can reach the store. In
  // particular, do not let option merging delete one side of a per-item
  // delay/at conflict and leave a partially inserted batch.
  yield* Result.await(Promise.resolve(normalizeSchedule(checkedFields, now)))
  const items: Array<{
    readonly payload: unknown
    readonly options: Readonly<Record<string, unknown>>
  }> = []
  for (let index = 0; index < values.length; index += 1) {
    const item = normalizeBatchItem(values[index])
    const itemFields = yield* Result.await(
      Promise.resolve(readFields(item.options, enqueueFields, `items[${index}].options`))
    )
    yield* Result.await(Promise.resolve(normalizeSchedule(itemFields, now)))
    items.push({ payload: item.payload, options: itemFields })
  }

  for (let start = 0; start < items.length; start += chunkSize) {
    const requests: import('../store').EnqueueRequest[] = []
    const end = Math.min(items.length, start + chunkSize)

    for (let index = start; index < end; index += 1) {
      const item = items[index]
      if (item === undefined) continue
      const mergedOptions = mergeBatchOptions(sharedOptions, item.options)
      const request = yield* Result.await(
        Promise.resolve(prepareEnqueue(definition, item.payload, mergedOptions, now))
      )
      requests.push(request)
    }

    const results = yield* Result.await(
      Promise.resolve(
        observedStoreOperation(store.enqueueMany(requests), definition.observer, 'enqueueMany', now)
      )
    )

    for (const result of results) {
      emitEnqueued(definition.observer, result.job, result.duplicate, now)
      ids.push(result.job.id)
    }
  }

  return Object.freeze(ids)
}

const identityMismatch = (
  jobId: JobId,
  definition: JobOperationDescriptor,
  record: JobRecord
): JobIdentityMismatchError =>
  new JobIdentityMismatchError({
    jobId,
    expected: definition.identity,
    actual: record
  })

const matchesIdentity = (definition: JobOperationDescriptor, record: JobRecord): boolean =>
  record.queue === definition.identity.queue &&
  record.name === definition.identity.name &&
  record.version === definition.identity.version

const readJob = async function* (
  definition: JobOperationDescriptor,
  value: unknown
): ErasedOperation<JobRecord | undefined, JobPollError> {
  const jobId = yield* Result.await(Promise.resolve(normalizeJobId(value)))
  const store = yield* definition.store
  const found = yield* Result.await(
    Promise.resolve(observedStoreOperation(store.getJob({ jobId }), definition.observer, 'getJob'))
  )

  if (found !== undefined && !matchesIdentity(definition, found)) {
    yield* failOperation<JobRecord | undefined, JobIdentityMismatchError>(
      identityMismatch(jobId, definition, found)
    )
  }

  return found
}

const decodeFailure = async (
  definition: JobOperationDescriptor,
  failure: SerializedJobFailure
): Promise<ResultType<DecodedJobFailure<unknown>, JobDecodeFailure>> => {
  if (failure.kind !== 'typed') {
    return Result.ok(
      Object.freeze({
        kind: failure.kind,
        message: failure.message,
        retryable: failure.retryable,
        recordedAt: failure.recordedAt,
        ...(failure.code === undefined ? {} : { code: failure.code }),
        ...(failure.data === undefined ? {} : { data: failure.data })
      }) as DecodedJobFailure<unknown>
    )
  }

  if (definition.failure === undefined || failure.data === undefined) {
    return Result.err(
      new JobDecodeFailure({
        message: 'Typed Job failure has no compatible failure codec',
        code: 'missing-codec'
      })
    )
  }

  const decoded = await decodeValue(definition.failure, failure.data)
  if (Result.isError(decoded)) return decoded

  return Result.ok(
    Object.freeze({
      kind: 'typed' as const,
      message: failure.message,
      retryable: failure.retryable,
      recordedAt: failure.recordedAt,
      data: decoded.value,
      ...(failure.code === undefined ? {} : { code: failure.code })
    }) as DecodedJobFailure<unknown>
  )
}

const decodeResult = async (
  definition: JobOperationDescriptor,
  value: JsonValue | undefined,
  requireValue: boolean
): Promise<ResultType<unknown, JobDecodeFailure>> => {
  if (value === undefined) {
    if (!requireValue || definition.result === undefined || isMarkedVoidCodec(definition.result)) {
      return Result.ok(undefined)
    }

    return Result.err(
      new JobDecodeFailure({
        message: 'Completed Job record has no result for its result codec',
        code: 'missing-result'
      })
    )
  }
  if (definition.result === undefined) {
    return Result.err(
      new JobDecodeFailure({
        message: 'Job record contains a result without a result codec',
        code: 'missing-codec'
      })
    )
  }

  return decodeValue(definition.result, value)
}

const decodeRecord = async (
  definition: JobOperationDescriptor,
  record: JobRecord
): Promise<ResultType<ErasedView, JobDecodeFailure>> => {
  const result = await decodeResult(definition, record.result, record.state === 'completed')
  if (Result.isError(result)) return result

  const failure =
    record.failure === undefined
      ? Result.ok<DecodedJobFailure<unknown> | undefined>(undefined)
      : await decodeFailure(definition, record.failure)
  if (Result.isError(failure)) return failure

  return Result.ok(Object.freeze({ ...record, result: result.value, failure: failure.value }))
}

const decodeAttempt = async (
  definition: JobOperationDescriptor,
  attempt: AttemptRecord
): Promise<ResultType<ErasedAttemptView, JobDecodeFailure>> => {
  const result = await decodeResult(definition, attempt.result, attempt.outcome === 'completed')
  if (Result.isError(result)) return result

  const failure =
    attempt.failure === undefined
      ? Result.ok<DecodedJobFailure<unknown> | undefined>(undefined)
      : await decodeFailure(definition, attempt.failure)
  if (Result.isError(failure)) return failure

  return Result.ok(Object.freeze({ ...attempt, result: result.value, failure: failure.value }))
}

const runPoll = async function* (
  definition: JobOperationDescriptor,
  jobId: unknown
): ErasedOperation<ErasedView | undefined, JobPollError> {
  const record = yield* readJob(definition, jobId)
  return record === undefined
    ? undefined
    : yield* Result.await(Promise.resolve(decodeRecord(definition, record)))
}

const runAttempts = async function* (
  definition: JobOperationDescriptor,
  jobId: unknown
): ErasedOperation<readonly ErasedAttemptView[], JobAttemptsError> {
  const record = yield* readJob(definition, jobId)
  if (record === undefined) {
    const checkedId = yield* Result.await(Promise.resolve(normalizeJobId(jobId)))
    return yield* failOperation<readonly ErasedAttemptView[], JobNotFoundError>(
      new JobNotFoundError({ jobId: checkedId })
    )
  }
  const store = yield* definition.store
  const entries = yield* Result.await(
    Promise.resolve(
      observedStoreOperation(
        store.getAttempts({ jobId: record.id }),
        definition.observer,
        'getAttempts'
      )
    )
  )
  const decoded: ErasedAttemptView[] = []

  for (const entry of entries) {
    decoded.push(yield* Result.await(Promise.resolve(decodeAttempt(definition, entry))))
  }

  return Object.freeze(decoded)
}

const makeExecutionFailure = (
  jobId: JobId,
  failure: SerializedJobFailure
): JobExecutionFailureError | JobExecutionCancelledError => {
  if (failure.kind === 'cancelled') {
    return new JobExecutionCancelledError({ jobId, failure })
  }

  const kind = failure.kind === 'typed' ? 'decode' : failure.kind
  return new JobExecutionFailureError({ jobId, kind, failure })
}

const awaitTerminal = async (
  definition: JobOperationDescriptor,
  record: JobRecord
): Promise<ResultType<unknown, ErasedAwaitError>> => {
  if (record.state === 'completed') {
    return decodeResult(definition, record.result, true)
  }

  if (record.state === 'cancelled') {
    return Result.err(
      record.failure === undefined
        ? new JobExecutionCancelledError({ jobId: record.id })
        : new JobExecutionCancelledError({ jobId: record.id, failure: record.failure })
    )
  }

  if (record.state !== 'failed') {
    return Result.err(new UnhandledException({ cause: new Error('Job is not terminal') }))
  }

  if (record.failure === undefined) {
    return Result.err(
      new JobDecodeFailure({
        message: 'Failed Job record has no failure envelope',
        code: 'missing-failure'
      })
    )
  }

  const failure = await decodeFailure(definition, record.failure)
  if (Result.isError(failure)) return failure
  if (failure.value.kind === 'typed') return Result.err(failure.value.data)

  return Result.err(makeExecutionFailure(record.id, record.failure))
}

const isAbortSignal = (value: unknown): value is AbortSignal => {
  if (!isObjectLike(value)) return false

  try {
    return (
      typeof (value as { readonly aborted?: unknown }).aborted === 'boolean' &&
      typeof (value as { readonly addEventListener?: unknown }).addEventListener === 'function' &&
      typeof (value as { readonly removeEventListener?: unknown }).removeEventListener ===
        'function'
    )
  } catch {
    return false
  }
}

const normalizeAwaitOptions = (
  value: unknown
): ResultType<
  { readonly pollIntervalMs: number; readonly signal: AbortSignal | undefined },
  JobDefinitionError
> => {
  const fields = readFields(value, awaitFields, 'options')
  if (Result.isError(fields)) return fields
  const interval =
    fields.value.pollIntervalMs === undefined
      ? Result.ok(defaultPollIntervalMs)
      : validateDuration(fields.value.pollIntervalMs, 'pollIntervalMs')
  if (Result.isError(interval)) return interval

  if (fields.value.signal !== undefined && !isAbortSignal(fields.value.signal)) {
    return invalid('signal', 'must be an AbortSignal')
  }

  return Result.ok({
    pollIntervalMs: interval.value,
    signal: fields.value.signal as AbortSignal | undefined
  })
}

const linkSignals = (
  first: AbortSignal,
  second: AbortSignal | undefined
): { readonly signal: AbortSignal; readonly dispose: () => void } => {
  if (second === undefined || first === second) return { signal: first, dispose: () => {} }

  const controller = new AbortController()
  const listeners: Array<readonly [AbortSignal, () => void]> = []
  let disposed = false

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
    listeners.length = 0
  }

  const abortFrom = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason)
    dispose()
  }

  for (const source of [first, second]) {
    if (source === undefined) continue
    if (source.aborted) {
      abortFrom(source)
      break
    }
    const listener = (): void => abortFrom(source)
    listeners.push([source, listener])
    source.addEventListener('abort', listener, { once: true })
  }

  return { signal: controller.signal, dispose }
}

const sleepForPoll = (
  clock: InstanceType<typeof Clock>,
  milliseconds: number,
  signal: AbortSignal
): Promise<ResultType<void, JobAwaitAbortedError | UnhandledException>> =>
  Result.tryPromise({
    try: () => clock.sleep(milliseconds, { signal }),
    catch: (cause) =>
      signal.aborted ? new JobAwaitAbortedError() : new UnhandledException({ cause })
  })

const runAwaitResult = async function* (
  definition: JobOperationDescriptor,
  jobId: unknown,
  options: unknown
): ErasedOperation<unknown, ErasedAwaitError, true> {
  const normalized = yield* Result.await(Promise.resolve(normalizeAwaitOptions(options)))
  const checkedId = yield* Result.await(Promise.resolve(normalizeJobId(jobId)))
  const store = yield* definition.store
  const clock = yield* Clock
  const runtimeSignal = yield* CurrentAbortSignal
  const signals = linkSignals(runtimeSignal, normalized.signal)

  try {
    for (;;) {
      const record = yield* Result.await(
        Promise.resolve(
          observedStoreOperation(store.getJob({ jobId: checkedId }), definition.observer, 'getJob')
        )
      )
      if (record === undefined) {
        return yield* failOperation<unknown, JobNotFoundError>(
          new JobNotFoundError({ jobId: checkedId })
        )
      }
      if (!matchesIdentity(definition, record)) {
        yield* failOperation<unknown, JobIdentityMismatchError>(
          identityMismatch(checkedId, definition, record)
        )
      }
      if (
        record.state === 'completed' ||
        record.state === 'failed' ||
        record.state === 'cancelled'
      ) {
        return yield* Result.await(Promise.resolve(awaitTerminal(definition, record)))
      }

      yield* Result.await(
        Promise.resolve(sleepForPoll(clock, normalized.pollIntervalMs, signals.signal))
      )
    }
  } finally {
    signals.dispose()
  }
}

const makeTransition = async function* (
  definition: JobOperationDescriptor,
  value: unknown,
  type: 'cancel' | 'promote' | 'retry',
  options: unknown
): ErasedOperation<JobRecord, JobTransitionApplicationError, true> {
  const checkedId = yield* Result.await(Promise.resolve(normalizeJobId(value)))
  const store = yield* definition.store
  const found = yield* Result.await(
    Promise.resolve(
      observedStoreOperation(store.getJob({ jobId: checkedId }), definition.observer, 'getJob')
    )
  )
  if (found === undefined) {
    return yield* failOperation<JobRecord, JobNotFoundError>(
      new JobNotFoundError({ jobId: checkedId })
    )
  }
  if (!matchesIdentity(definition, found)) {
    yield* failOperation<JobRecord, JobIdentityMismatchError>(
      identityMismatch(checkedId, definition, found)
    )
  }
  const clock = yield* Clock
  const now = yield* Result.await(Promise.resolve(clockNow(clock)))

  if (type === 'retry') {
    const fields = yield* Result.await(
      Promise.resolve(readFields(options, ['delayMs', 'at'], 'options'))
    )
    const runAt = yield* Result.await(Promise.resolve(normalizeSchedule(fields, now)))
    const transition = yield* Result.await(
      Promise.resolve(
        observedStoreOperation(
          store.retry({ jobId: checkedId, runAt, now }),
          definition.observer,
          'retry',
          now
        )
      )
    )
    emitAdminTransition(definition.observer, 'retry', transition, now)
    return transition.record
  }

  const transition =
    type === 'cancel'
      ? yield* Result.await(
          Promise.resolve(
            observedStoreOperation(
              store.cancel({ jobId: checkedId, now }),
              definition.observer,
              'cancel',
              now
            )
          )
        )
      : yield* Result.await(
          Promise.resolve(
            observedStoreOperation(
              store.promote({ jobId: checkedId, now }),
              definition.observer,
              'promote',
              now
            )
          )
        )

  emitAdminTransition(definition.observer, type, transition, now)
  return transition.record
}

const emitAdminTransition = (
  observer: JobObserver | undefined,
  type: 'cancel' | 'promote' | 'retry',
  transition: import('../protocol').JobTransition,
  recordedAt: number
): void => {
  if (observer === undefined || type === 'promote') return
  const record = transition.record
  const attempt = transition.attempt
  const common = {
    recordedAt,
    jobId: record.id,
    queue: record.queue,
    name: record.name,
    version: record.version,
    ...(attempt === undefined ? {} : { attempt: attempt.attempt, delivery: attempt.delivery })
  }
  if (type === 'cancel') {
    notifyJobObserver(observer, freezeJobEvent({ type: 'cancelled', ...common, source: 'admin' }))
    return
  }
  notifyJobObserver(
    observer,
    freezeJobEvent({
      type: 'retry-scheduled',
      ...common,
      retryAt: record.runAt,
      retryDelayMs: Math.max(0, record.runAt - recordedAt),
      source: 'admin'
    })
  )
}

const normalizeExecuteOptions = (
  value: unknown
): ResultType<
  {
    readonly enqueue: Readonly<Record<string, unknown>>
    readonly await: Readonly<Record<string, unknown>>
  },
  JobDefinitionError
> => {
  const fields = readFields(value, executeFields, 'options')
  if (Result.isError(fields)) return fields
  const awaitOptions = readFields(value, awaitFields, 'options')
  if (Result.isError(awaitOptions)) return awaitOptions
  if (fields.value.signal !== undefined && !isAbortSignal(fields.value.signal)) {
    return invalid('signal', 'must be an AbortSignal')
  }

  return Result.ok({
    enqueue: Object.freeze(copyKnownFields(fields.value, enqueueFields)),
    await: Object.freeze(copyKnownFields(fields.value, awaitFields))
  })
}

const runExecute = async function* (
  definition: JobOperationDescriptor,
  payload: unknown,
  options: unknown
): ErasedOperation<unknown, JobEnqueueError | ErasedAwaitError, true> {
  const normalized = yield* Result.await(Promise.resolve(normalizeExecuteOptions(options)))
  const id = yield* runEnqueue(definition, payload, normalized.enqueue)
  return yield* runAwaitResult(definition, id, normalized.await)
}

const normalizeListState = (
  value: unknown
): ResultType<JobState | readonly JobState[] | undefined, JobDefinitionError> => {
  if (value === undefined) return Result.ok(undefined)
  const values = Array.isArray(value) ? value : [value]
  const states: JobState[] = []
  for (const state of values) {
    if (
      state !== 'waiting' &&
      state !== 'delayed' &&
      state !== 'active' &&
      state !== 'completed' &&
      state !== 'failed' &&
      state !== 'cancelled'
    ) {
      return invalid('state', 'unsupported job state')
    }
    states.push(state)
  }
  return Result.ok(Array.isArray(value) ? Object.freeze(states) : states[0])
}

const normalizeListOrderBy = (
  value: unknown
): ResultType<JobListOrderBy, JobDefinitionError | UnsupportedJobStoreOperationError> => {
  if (value === 'enqueuedAt' || value === 'runAt' || value === 'finishedAt') {
    return Result.ok(value)
  }
  return invalid('orderBy', 'must be enqueuedAt, runAt, or finishedAt')
}

const normalizeListOrder = (value: unknown): ResultType<JobListOrder, JobDefinitionError> => {
  if (value === 'asc' || value === 'desc') return Result.ok(value)
  return invalid('order', 'must be asc or desc')
}

const cursorOrderingFor = (orderBy: JobListOrderBy): JobListCursor['ordering'] =>
  orderBy === 'enqueuedAt'
    ? 'createdAt,orderingSequence,id'
    : orderBy === 'runAt'
      ? 'runAt,orderingSequence,id'
      : 'finishedAt,orderingSequence,id'

const cursorOrderByFromLegacy = (
  value: unknown
): ResultType<JobListOrderBy, JobDefinitionError | UnsupportedJobStoreOperationError> => {
  if (value === 'createdAt,orderingSequence,id') return Result.ok('enqueuedAt')
  if (value === 'runAt,orderingSequence,id') return Result.ok('runAt')
  if (value === 'finishedAt,orderingSequence,id') return Result.ok('finishedAt')
  return Result.err(new UnsupportedJobStoreOperationError({ operation: 'list.cursor-version' }))
}

const normalizeCursor = (
  value: unknown
): ResultType<
  JobListCursor | undefined,
  JobDefinitionError | UnsupportedJobStoreOperationError
> => {
  if (value === undefined) return Result.ok(undefined)
  const fields = readFields(value, cursorFields, 'cursor')
  if (Result.isError(fields)) return fields
  if (fields.value.version !== cursorVersion) {
    return Result.err(new UnsupportedJobStoreOperationError({ operation: 'list.cursor-version' }))
  }

  const orderBy =
    fields.value.orderBy === undefined
      ? cursorOrderByFromLegacy(fields.value.ordering)
      : normalizeListOrderBy(fields.value.orderBy)
  const order =
    fields.value.order === undefined
      ? normalizeListOrder(fields.value.direction)
      : normalizeListOrder(fields.value.order)
  if (Result.isError(orderBy)) return orderBy
  if (Result.isError(order)) return order
  if (
    (fields.value.ordering !== undefined &&
      fields.value.ordering !== cursorOrderingFor(orderBy.value)) ||
    (fields.value.direction !== undefined && fields.value.direction !== order.value)
  ) {
    return Result.err(new UnsupportedJobStoreOperationError({ operation: 'list.cursor-version' }))
  }

  if (typeof fields.value.filterSignature !== 'string') {
    return invalid('cursor.filterSignature', 'must be a string')
  }
  const createdAt = validateTimestamp(fields.value.createdAt, 'cursor.createdAt')
  const sequence = validateDuration(fields.value.orderingSequence, 'cursor.orderingSequence')
  const id = makeJobId(fields.value.id)
  const rawValue =
    fields.value.value === undefined && orderBy.value === 'enqueuedAt'
      ? fields.value.createdAt
      : fields.value.value
  const primaryValue =
    rawValue === null ? Result.ok<number | null>(null) : validateTimestamp(rawValue, 'cursor.value')
  if (Result.isError(createdAt)) return createdAt
  if (Result.isError(sequence)) return sequence
  if (Result.isError(id)) return id
  if (Result.isError(primaryValue)) return primaryValue
  if (primaryValue.value === null && orderBy.value !== 'finishedAt') {
    return invalid('cursor.value', 'null is only valid for finishedAt ordering')
  }

  return Result.ok(
    Object.freeze({
      version: cursorVersion,
      orderBy: orderBy.value,
      order: order.value,
      ordering: cursorOrderingFor(orderBy.value),
      direction: order.value,
      filterSignature: fields.value.filterSignature,
      value: primaryValue.value,
      createdAt: createdAt.value,
      orderingSequence: sequence.value,
      id: id.value
    })
  )
}

const firstUnsupportedListField = (value: unknown): string | undefined => {
  if (!isPlainObject(value)) return undefined

  try {
    const allowed = new Set<string>(listFields)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        return typeof key === 'string' ? key : 'symbol'
      }
    }
  } catch {
    return 'options'
  }

  return undefined
}

const normalizeListOptions = (
  value: unknown
): ResultType<import('../store').ListJobsRequest, JobAdminListError> => {
  const unsupported = firstUnsupportedListField(value)
  if (unsupported !== undefined) {
    return Result.err(new UnsupportedJobStoreOperationError({ operation: `list.${unsupported}` }))
  }
  const fields = readFields(value, listFields, 'options')
  if (Result.isError(fields)) return fields
  if (hasOwn(fields.value, 'state') && hasOwn(fields.value, 'states')) {
    return invalid('state', 'state and states are mutually exclusive')
  }
  const queue =
    fields.value.queue === undefined
      ? Result.ok<string | undefined>(undefined)
      : makeQueueName(fields.value.queue)
  const name =
    fields.value.name === undefined
      ? Result.ok<string | undefined>(undefined)
      : makeJobName(fields.value.name)
  const version =
    fields.value.version === undefined
      ? Result.ok<number | undefined>(undefined)
      : normalizePositiveInteger(fields.value.version, 'version')
  const metadata =
    fields.value.metadata === undefined
      ? Result.ok<Readonly<Record<string, string>> | undefined>(undefined)
      : normalizeMetadataValue(fields.value.metadata).map((value) => value)
  const orderBy =
    fields.value.orderBy === undefined
      ? Result.ok(defaultListOrderBy)
      : normalizeListOrderBy(fields.value.orderBy)
  const order =
    fields.value.order === undefined
      ? Result.ok(defaultListOrder)
      : normalizeListOrder(fields.value.order)
  const state = normalizeListState(fields.value.states ?? fields.value.state)
  const cursor = normalizeCursor(fields.value.cursor)
  const limit =
    fields.value.limit === undefined
      ? Result.ok(50)
      : normalizePositiveInteger(fields.value.limit, 'limit')
  if (Result.isError(queue)) return queue
  if (Result.isError(name)) return name
  if (Result.isError(version)) return version
  if (Result.isError(metadata)) return metadata
  if (Result.isError(orderBy)) return orderBy
  if (Result.isError(order)) return order
  if (Result.isError(state)) return state
  if (Result.isError(cursor)) return cursor
  if (Result.isError(limit)) return limit
  if (
    cursor.value !== undefined &&
    (cursor.value.orderBy !== orderBy.value || cursor.value.order !== order.value)
  ) {
    return Result.err(new UnsupportedJobStoreOperationError({ operation: 'list.cursor-options' }))
  }

  const request: MutableRecord = {
    limit: limit.value,
    orderBy: orderBy.value,
    order: order.value
  }
  if (queue.value !== undefined) request.queue = queue.value
  if (name.value !== undefined) request.name = name.value
  if (version.value !== undefined) request.version = version.value
  if (metadata.value !== undefined) request.metadata = metadata.value
  if (state.value !== undefined) request.state = state.value
  if (cursor.value !== undefined) request.cursor = cursor.value
  return Result.ok(request as unknown as import('../store').ListJobsRequest)
}

const normalizeCountOptions = (
  value: unknown
): ResultType<import('../store').CountsRequest | undefined, JobDefinitionError> => {
  if (value === undefined) return Result.ok(undefined)
  if (typeof value === 'string') {
    const queue = makeQueueName(value)
    return Result.isError(queue) ? queue : Result.ok({ queue: queue.value })
  }
  const fields = readFields(value, countFields, 'options')
  if (Result.isError(fields)) return fields
  const queue =
    fields.value.queue === undefined
      ? Result.ok<string | undefined>(undefined)
      : makeQueueName(fields.value.queue)
  const name =
    fields.value.name === undefined
      ? Result.ok<string | undefined>(undefined)
      : makeJobName(fields.value.name)
  if (Result.isError(queue)) return queue
  if (Result.isError(name)) return name
  const request: MutableRecord = {}
  if (queue.value !== undefined) request.queue = queue.value
  if (name.value !== undefined) request.name = name.value
  return Result.ok(request as import('../store').CountsRequest)
}

const normalizeQueue = (
  value: unknown
): ResultType<import('../protocol').QueueName, JobDefinitionError> => makeQueueName(value)

const normalizeRemoveOptions = (
  value: unknown
): ResultType<
  import('../store').RemoveRequest['expectedState'] | undefined,
  JobDefinitionError
> => {
  const fields = readFields(value, removeFields, 'options')
  if (Result.isError(fields)) return fields
  if (Array.isArray(fields.value.expectedState)) {
    return invalid('expectedState', 'must be one job state')
  }
  return normalizeListState(
    fields.value.expectedState as import('../protocol').JobState | undefined
  ).map((state) => state as import('../protocol').JobState | undefined)
}

const runAdminList = async function* (
  token: AnyJobStoreToken,
  options: unknown,
  observer: JobObserver | undefined
): JobOperation<import('../store').ListJobsResult, JobAdminListError, AnyJobStoreToken> {
  const request = yield* Result.await(Promise.resolve(normalizeListOptions(options)))
  const store = yield* token
  return yield* Result.await(
    Promise.resolve(observedStoreOperation(store.list(request), observer, 'list'))
  )
}

const runAdminCounts = async function* (
  token: AnyJobStoreToken,
  options: unknown,
  observer: JobObserver | undefined
): JobOperation<import('../store').JobCounts, JobAdminCountError, AnyJobStoreToken> {
  const request = yield* Result.await(Promise.resolve(normalizeCountOptions(options)))
  const store = yield* token
  return yield* Result.await(
    Promise.resolve(observedStoreOperation(store.counts(request), observer, 'counts'))
  )
}

const runAdminCount = async function* (
  token: AnyJobStoreToken,
  options: unknown,
  observer: JobObserver | undefined
): JobOperation<number, JobAdminCountError, AnyJobStoreToken> {
  const counts = yield* runAdminCounts(token, options, observer)
  return counts.total
}

const runAdminPause = async function* (
  token: AnyJobStoreToken,
  queue: unknown,
  shouldPause: boolean,
  observer: JobObserver | undefined
): JobOperation<
  import('../store').QueuePauseResult,
  JobAdminPauseError | JobAdminResumeError,
  AnyJobStoreToken,
  true
> {
  const checkedQueue = yield* Result.await(Promise.resolve(normalizeQueue(queue)))
  const store = yield* token
  const clock = yield* Clock
  const now = yield* Result.await(Promise.resolve(clockNow(clock)))
  const request = { queue: checkedQueue, now }
  return shouldPause
    ? yield* Result.await(
        Promise.resolve(observedStoreOperation(store.pause(request), observer, 'pause', now))
      )
    : yield* Result.await(
        Promise.resolve(observedStoreOperation(store.resume(request), observer, 'resume', now))
      )
}

const runAdminPaused = async function* (
  token: AnyJobStoreToken,
  observer: JobObserver | undefined
): JobOperation<
  readonly import('../protocol').QueueName[],
  import('../store').JobStorePausedQueuesError | UnhandledException,
  AnyJobStoreToken
> {
  const store = yield* token
  return yield* Result.await(
    Promise.resolve(observedStoreOperation(store.pausedQueues(), observer, 'pausedQueues'))
  )
}

const runAdminRemove = async function* (
  token: AnyJobStoreToken,
  jobId: unknown,
  options: unknown,
  observer: JobObserver | undefined
): JobOperation<import('../store').RemoveResult, JobAdminRemoveError, AnyJobStoreToken, true> {
  const checkedId = yield* Result.await(Promise.resolve(normalizeJobId(jobId)))
  const expectedState = yield* Result.await(Promise.resolve(normalizeRemoveOptions(options)))
  const store = yield* token
  const clock = yield* Clock
  const now = yield* Result.await(Promise.resolve(clockNow(clock)))
  const request: import('../store').RemoveRequest = { jobId: checkedId, now }
  if (expectedState !== undefined) Object.assign(request, { expectedState })
  return yield* Result.await(
    Promise.resolve(observedStoreOperation(store.remove(request), observer, 'remove', now))
  )
}

const makeAdminClient = <Store extends AnyJobStoreToken>(
  token: Store,
  observer: JobObserver | undefined
): JobAdminClient<Store> => {
  const client: JobAdminClient<Store> = {
    list: (options) =>
      runAdminList(token, options, observer) as JobAdminClient<Store>['list'] extends (
        ...args: never[]
      ) => infer Output
        ? Output
        : never,
    counts: ((options?: string | JobAdminCountOptions) =>
      runAdminCounts(token, options, observer) as JobAdminClient<Store>['counts'] extends (
        ...args: never[]
      ) => infer Output
        ? Output
        : never) as JobAdminClient<Store>['counts'],
    count: ((options?: string | JobAdminCountOptions) =>
      runAdminCount(token, options, observer) as JobAdminClient<Store>['count'] extends (
        ...args: never[]
      ) => infer Output
        ? Output
        : never) as JobAdminClient<Store>['count'],
    pause: (queue) =>
      runAdminPause(token, queue, true, observer) as JobAdminClient<Store>['pause'] extends (
        ...args: never[]
      ) => infer Output
        ? Output
        : never,
    resume: (queue) =>
      runAdminPause(token, queue, false, observer) as JobAdminClient<Store>['resume'] extends (
        ...args: never[]
      ) => infer Output
        ? Output
        : never,
    pausedQueues: () =>
      runAdminPaused(token, observer) as JobAdminClient<Store>['pausedQueues'] extends (
        ...args: never[]
      ) => infer Output
        ? Output
        : never,
    remove: (jobId, options) =>
      runAdminRemove(token, jobId, options, observer) as JobAdminClient<Store>['remove'] extends (
        ...args: never[]
      ) => infer Output
        ? Output
        : never
  }

  return Object.freeze(client)
}

const makeOperations = (definition: JobOperationDescriptor): ErasedOperations => {
  const operations: ErasedOperations = {
    enqueue: (payload, options) => runEnqueue(definition, payload, options),
    enqueueMany: (values, options) => runEnqueueMany(definition, values, options),
    poll: (jobId) => runPoll(definition, jobId),
    attempts: (jobId) => runAttempts(definition, jobId),
    awaitResult: (jobId, options) => runAwaitResult(definition, jobId, options),
    execute: (payload, options) => runExecute(definition, payload, options),
    cancel: (jobId) =>
      makeTransition(definition, jobId, 'cancel', undefined) as unknown as JobOperation<
        JobRecord,
        JobCancelError,
        AnyJobStoreToken,
        true
      >,
    promote: (jobId) =>
      makeTransition(definition, jobId, 'promote', undefined) as unknown as JobOperation<
        JobRecord,
        JobPromoteError,
        AnyJobStoreToken,
        true
      >,
    retry: (jobId, options) =>
      makeTransition(definition, jobId, 'retry', options) as unknown as JobOperation<
        JobRecord,
        JobRetryError,
        AnyJobStoreToken,
        true
      >
  }

  return Object.freeze(operations)
}

/** Attach the one immutable descriptor-bound producer/admin implementation. */
export const makeJobOperations = (definition: JobOperationDescriptor): ErasedOperations =>
  makeOperations(definition)

/** Explicitly bind generic admin operations to a selected store token. */
export const JobAdmin = Object.freeze({
  for: <Store extends AnyJobStoreToken>(token: Store): JobAdminClient<Store> => {
    validateAdminStore(token)
    return makeAdminClient(token, undefined)
  },
  observe: (observer: JobObserver): JobAdminObserverBinding => {
    validateObserver(observer)
    return Object.freeze({
      for: <Store extends AnyJobStoreToken>(token: Store): JobAdminClient<Store> => {
        validateAdminStore(token)
        return makeAdminClient(token, observer)
      }
    })
  }
})

const validateAdminStore: (token: unknown) => asserts token is AnyJobStoreToken = (token) => {
  if (!isJobStoreToken(token)) {
    throw new JobDefinitionError({ field: 'store', message: 'must be a JobStore token' })
  }
}

const validateObserver: (observer: unknown) => asserts observer is JobObserver = (observer) => {
  try {
    if (
      observer === null ||
      typeof observer !== 'object' ||
      typeof (observer as { readonly onEvent?: unknown }).onEvent !== 'function'
    ) {
      throw new JobDefinitionError({ field: 'observer', message: 'must implement onEvent' })
    }
  } catch (cause) {
    if (cause instanceof JobDefinitionError) throw cause
    throw new JobDefinitionError({ field: 'observer', message: 'could not read observer' })
  }
}

const failOperation = <Value, Failure>(
  error: Failure
): AsyncGenerator<Err<never, Failure>, Value, unknown> =>
  Result.await(Promise.resolve(Result.err<Value, Failure>(error)))
