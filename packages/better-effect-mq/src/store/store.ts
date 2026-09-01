// oxlint-disable anti-slop/no-runtime-typeof -- validate the public named-token JavaScript boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- named-token guards inspect untyped callers.
// oxlint-disable anti-slop/no-chained-type-assertions -- the Service factory's erased instance is restored at one token boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- token casts are justified by the structural contract below.

import { Service } from 'better-effect'

import type { ServiceClass, ServiceRequirement } from 'better-effect'

import type { JobStoreContract, JobStoreEffect, JobStoreOperation } from './types'
import type { JobStoreError } from './errors'

export const jobStoreTag = '@better-effect/mq/JobStore' as const
const jobStoreTypeId = Symbol.for('better-effect-mq/JobStore')

/** A non-empty literal accepted by `JobStore.named`. */
export type JobStoreNameLiteral<Name extends string> = string extends Name
  ? never
  : Name extends ''
    ? never
    : Name

/** The stable Service tag used by the default and named stores. */
export type JobStoreTag<Name extends string | undefined = undefined> = [Name] extends [undefined]
  ? typeof jobStoreTag
  : `${typeof jobStoreTag}/${Extract<Name, string>}`

/** The branded Service instance for a default or named store. */
export type JobStoreInstance<Name extends string | undefined = undefined> = JobStoreContract &
  Service.Identity<JobStoreTag<Name>>

/** A constructible, yieldable Service token for a default or named store. */
export type JobStoreToken<Name extends string | undefined = undefined> = ServiceClass<
  JobStoreTag<Name>,
  JobStoreInstance<Name>
> &
  (new () => JobStoreInstance<Name>) & {
    readonly [Symbol.asyncIterator]: () => AsyncGenerator<
      ServiceRequirement<JobStoreInstance<Name>>,
      JobStoreInstance<Name>,
      unknown
    >
  }

export type DefaultJobStoreToken = JobStoreToken<undefined> & {
  readonly named: <const Named extends string>(
    name: JobStoreNameLiteral<Named>
  ) => JobStoreToken<Named>
}
export type AnyJobStoreToken = DefaultJobStoreToken | JobStoreToken<string>

type JobStoreValue = DefaultJobStoreToken

const validateName = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('JobStore.named requires a non-empty string name')
  }

  return value
}

const makeToken = <Name extends string | undefined>(name: Name): JobStoreToken<Name> => {
  const tag = (name === undefined ? jobStoreTag : `${jobStoreTag}/${name}`) as JobStoreTag<Name>
  // SAFETY: `tag` is assembled from the validated name and exactly matches the Service tag at runtime.
  const token = Service<JobStoreInstance<Name>>()(tag as never)
  Object.defineProperty(token, jobStoreTypeId, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  })

  // SAFETY: the token is extended only with the declaration-only JobStore contract and remains the Service factory result at runtime.
  return token as unknown as JobStoreToken<Name>
}

const namedJobStore = <const Name extends string>(
  name: JobStoreNameLiteral<Name>
): JobStoreToken<Name> => {
  const validated = validateName(name)

  // SAFETY: `validated` is the runtime-checked form of the caller's string literal.
  return makeToken(validated as Name)
}

const defaultJobStore = makeToken(undefined)

Object.defineProperty(defaultJobStore, 'named', {
  configurable: false,
  enumerable: true,
  value: namedJobStore,
  writable: false
})

/**
 * Yieldable storage-neutral queue contract.
 *
 * The default token uses `@better-effect/mq/JobStore`; named tokens use
 * `@better-effect/mq/JobStore/<name>`. Named tokens are lightweight handles,
 * not mutable registrations: repeated calls for one literal name have the same
 * type and tag, and resolver backends resolve them by that complete tag. Keep
 * a token value when referential equality is useful; no process-global name
 * registry is retained.
 */
export interface JobStore extends JobStoreInstance<undefined> {}

/** Type-level aliases for JobStore instances, tokens, and operations. */
export declare namespace JobStore {
  export type Any = JobStoreInstance<undefined> | JobStoreInstance<string>
  export type Contract = JobStoreContract
  export type Instance<Name extends string | undefined = undefined> = JobStoreInstance<Name>
  export type Token<Name extends string | undefined = undefined> = [Name] extends [undefined]
    ? DefaultJobStoreToken
    : JobStoreToken<Name>
  export type Name = string
  export type Tag<Name extends string | undefined = undefined> = JobStoreTag<Name>
  export type Effect<
    Success,
    Failure extends JobStoreError = JobStoreError,
    Requirements extends import('better-effect').AnyService = never
  > = JobStoreEffect<Success, Failure, Requirements>
  export type Operation<
    Success,
    Failure extends JobStoreError = JobStoreError,
    Requirements extends import('better-effect').AnyService = never
  > = JobStoreOperation<Success, Failure, Requirements>
  export type Error = JobStoreError
  export type Failure = JobStoreError
  export type Capabilities = import('./types').JobStoreCapabilities
  export type EnqueueRequest = import('./types').EnqueueRequest
  export type EnqueueResult = import('./types').EnqueueResult
  export type EnqueueManyResult = import('./types').EnqueueManyResult
  export type ClaimIdentity = import('./types').ClaimIdentity
  export type ClaimRequest = import('./types').ClaimRequest
  export type ClaimRequestFor<Registry extends import('../job').AnyJobRegistry> =
    import('./types').ClaimRequestFor<Registry>
  export type ClaimResult = import('./types').ClaimResult
  export type SettleRequest = import('./types').SettleRequest
  export type SettlementRequest = import('./types').SettlementRequest
  export type SettlementResult = import('./types').SettlementResult
  export type ReleaseRequest = import('./types').ReleaseRequest
  export type ReleaseResult = import('./types').ReleaseResult
  export type HeartbeatLease = import('./types').HeartbeatLease
  export type HeartbeatRequest = import('./types').HeartbeatRequest
  export type HeartbeatResult = import('./types').HeartbeatResult
  export type LostLease = import('./types').LostLease
  export type RecoverStalledRequest = import('./types').RecoverStalledRequest
  export type RecoverStalledResult = import('./types').RecoverStalledResult
  export type AwaitWakeRequest = import('./types').AwaitWakeRequest
  export type WakeToken = import('./types').WakeToken
  export type GetJobRequest = import('./types').GetJobRequest
  export type GetAttemptsRequest = import('./types').GetAttemptsRequest
  export type JobListCursor = import('./types').JobListCursor
  export type JobListOrder = import('./types').JobListOrder
  export type JobListOrderBy = import('./types').JobListOrderBy
  export type JobListOrdering = import('./types').JobListOrdering
  export type ListJobsRequest = import('./types').ListJobsRequest
  export type ListJobsResult = import('./types').ListJobsResult
  export type CountsRequest = import('./types').CountsRequest
  export type JobCounts = import('./types').JobCounts
  export type RetryRequest = import('./types').RetryRequest
  export type RetryResult = import('./types').RetryResult
  export type CancelRequest = import('./types').CancelRequest
  export type CancelResult = import('./types').CancelResult
  export type RequestCancellationRequest = import('./types').RequestCancellationRequest
  export type RequestCancellationResult = import('./types').RequestCancellationResult
  export type PromoteRequest = import('./types').PromoteRequest
  export type PromoteResult = import('./types').PromoteResult
  export type RemoveRequest = import('./types').RemoveRequest
  export type RemoveResult = import('./types').RemoveResult
  export type PauseQueueRequest = import('./types').PauseQueueRequest
  export type QueuePauseResult = import('./types').QueuePauseResult
}

export const JobStore = defaultJobStore as JobStoreValue

/** Guard used by Job binding and other untyped descriptor boundaries. */
export const isJobStoreToken = (value: unknown): value is AnyJobStoreToken => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false
  }

  try {
    const marker = Object.getOwnPropertyDescriptor(value, jobStoreTypeId)
    const candidate = value as {
      readonly serviceTag?: unknown
      readonly [Symbol.asyncIterator]?: unknown
    }
    const tag = candidate.serviceTag

    return (
      marker !== undefined &&
      'value' in marker &&
      marker.value === true &&
      typeof tag === 'string' &&
      (tag === jobStoreTag || tag.startsWith(`${jobStoreTag}/`)) &&
      typeof candidate[Symbol.asyncIterator] === 'function'
    )
  } catch {
    return false
  }
}
