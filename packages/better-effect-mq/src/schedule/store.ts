// oxlint-disable anti-slop/no-runtime-typeof -- validate the public associated-token boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- token guards inspect untyped callers.
// oxlint-disable anti-slop/no-chained-type-assertions -- Service's erased instance is restored at one token boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- token casts are justified by the structural contract.

import { Service } from 'better-effect'

import type { ServiceClass, ServiceRequirement } from 'better-effect'

import { JobStore, isJobStoreToken, jobStoreTag } from '../store'
import type { AnyJobStoreToken, DefaultJobStoreToken, JobStoreToken } from '../store'
import type {
  JobScheduleStoreContract,
  JobScheduleStoreDescriptor,
  ScheduleStoreEffect,
  ScheduleStoreError,
  ScheduleStoreOperation
} from './types'

export const jobScheduleStoreTag = '@better-effect/mq/JobScheduleStore' as const
const jobScheduleStoreTypeId = Symbol.for('better-effect-mq/JobScheduleStore')

export type JobScheduleStoreTag<Store extends AnyJobStoreToken = DefaultJobStoreToken> =
  Store extends DefaultJobStoreToken
    ? typeof jobScheduleStoreTag
    : Store extends JobStoreToken<infer Name>
      ? `${typeof jobScheduleStoreTag}/${Extract<Name, string>}`
      : `${typeof jobScheduleStoreTag}/${string}`

export type JobScheduleStoreInstance<Store extends AnyJobStoreToken = DefaultJobStoreToken> =
  JobScheduleStoreContract & Service.Identity<JobScheduleStoreTag<Store>>

export type JobScheduleStoreToken<Store extends AnyJobStoreToken = DefaultJobStoreToken> =
  ServiceClass<JobScheduleStoreTag<Store>, JobScheduleStoreInstance<Store>> &
    (new () => JobScheduleStoreInstance<Store>) & {
      readonly jobStore: Store
      readonly store: Store
      readonly descriptor: JobScheduleStoreDescriptor
      readonly [Symbol.asyncIterator]: () => AsyncGenerator<
        ServiceRequirement<JobScheduleStoreInstance<Store>>,
        JobScheduleStoreInstance<Store>,
        unknown
      >
    }

export type DefaultJobScheduleStoreToken = JobScheduleStoreToken<DefaultJobStoreToken> & {
  readonly for: <Store extends AnyJobStoreToken>(store: Store) => JobScheduleStoreToken<Store>
}

export type AnyJobScheduleStoreToken =
  | DefaultJobScheduleStoreToken
  | JobScheduleStoreToken<JobStoreToken<string>>

type JobScheduleStoreValue = DefaultJobScheduleStoreToken

const descriptor: JobScheduleStoreDescriptor = Object.freeze({
  extension: 'better-effect-mq/schedules',
  extensionVersion: 1,
  jobStoreProtocolVersion: 1
})

const makeToken = <Store extends AnyJobStoreToken>(store: Store): JobScheduleStoreToken<Store> => {
  const storeTag = store.serviceTag
  const scheduleTag = (
    storeTag === jobStoreTag
      ? jobScheduleStoreTag
      : `${jobScheduleStoreTag}/${storeTag.slice(`${jobStoreTag}/`.length)}`
  ) as JobScheduleStoreTag<Store>

  const token = Service<JobScheduleStoreInstance<Store>>()(scheduleTag as never)
  Object.defineProperties(token, {
    [jobScheduleStoreTypeId]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false
    },
    descriptor: {
      configurable: false,
      enumerable: true,
      value: descriptor,
      writable: false
    },
    jobStore: {
      configurable: false,
      enumerable: true,
      value: store,
      writable: false
    },
    store: {
      configurable: false,
      enumerable: true,
      value: store,
      writable: false
    }
  })

  // SAFETY: the token is extended only with associated store metadata; Service remains the runtime token.
  return token as unknown as JobScheduleStoreToken<Store>
}

const defaultScheduleToken = makeToken(JobStore)

const forJobStore = <Store extends AnyJobStoreToken>(
  store: Store
): JobScheduleStoreToken<Store> => {
  if (!isJobStoreToken(store)) {
    throw new TypeError('JobScheduleStore.for requires a JobStore token')
  }

  return makeToken(store)
}

Object.defineProperty(defaultScheduleToken, 'for', {
  configurable: false,
  enumerable: true,
  value: forJobStore,
  writable: false
})

export interface JobScheduleStore<
  Store extends AnyJobStoreToken = DefaultJobStoreToken
> extends JobScheduleStoreInstance<Store> {}

export declare namespace JobScheduleStore {
  export type Any = JobScheduleStoreInstance<AnyJobStoreToken>
  export type Contract<_Store extends AnyJobStoreToken = DefaultJobStoreToken> =
    JobScheduleStoreContract
  export type Instance<Store extends AnyJobStoreToken = DefaultJobStoreToken> =
    JobScheduleStoreInstance<Store>
  export type Token<Store extends AnyJobStoreToken = DefaultJobStoreToken> =
    Store extends DefaultJobStoreToken ? DefaultJobScheduleStoreToken : JobScheduleStoreToken<Store>
  export type Descriptor = JobScheduleStoreDescriptor
  export type Effect<
    Success,
    Failure extends ScheduleStoreError = ScheduleStoreError,
    Requirements extends import('better-effect').AnyService = never
  > = ScheduleStoreEffect<Success, Failure, Requirements>
  export type Operation<
    Success,
    Failure extends ScheduleStoreError = ScheduleStoreError,
    Requirements extends import('better-effect').AnyService = never
  > = ScheduleStoreOperation<Success, Failure, Requirements>
  export type Error = ScheduleStoreError
  export type Failure = ScheduleStoreError
}

export const JobScheduleStore = defaultScheduleToken as JobScheduleStoreValue

export const isJobScheduleStoreToken = (value: unknown): value is AnyJobScheduleStoreToken => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false

  try {
    const marker = Object.getOwnPropertyDescriptor(value, jobScheduleStoreTypeId)
    const candidate = value as {
      readonly serviceTag?: unknown
      readonly jobStore?: unknown
      readonly [Symbol.asyncIterator]?: unknown
    }
    return (
      marker !== undefined &&
      'value' in marker &&
      marker.value === true &&
      typeof candidate.serviceTag === 'string' &&
      (candidate.serviceTag === jobScheduleStoreTag ||
        candidate.serviceTag.startsWith(`${jobScheduleStoreTag}/`)) &&
      isJobStoreToken(candidate.jobStore) &&
      typeof candidate[Symbol.asyncIterator] === 'function'
    )
  } catch {
    return false
  }
}
