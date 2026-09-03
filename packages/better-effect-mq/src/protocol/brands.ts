import type { Result as ResultType } from 'better-result'

import { validateIdentity } from '../internal/validation'

import type { JobDefinitionError } from './errors'

declare const JobIdBrand: unique symbol
declare const QueueNameBrand: unique symbol
declare const JobNameBrand: unique symbol
declare const LeaseTokenBrand: unique symbol
declare const WorkerIdBrand: unique symbol

export type JobId = string & { readonly [JobIdBrand]: 'JobId' }
export type QueueName = string & { readonly [QueueNameBrand]: 'QueueName' }
export type JobName = string & { readonly [JobNameBrand]: 'JobName' }
export type LeaseToken = string & { readonly [LeaseTokenBrand]: 'LeaseToken' }
export type WorkerId = string & { readonly [WorkerIdBrand]: 'WorkerId' }

const asJobId = (value: string): JobId => {
  // SAFETY: validateIdentity checks that the value is an unmodified non-empty string.
  return value as JobId
}

const asQueueName = (value: string): QueueName => {
  // SAFETY: validateIdentity checks that the value is an unmodified non-empty string.
  return value as QueueName
}

const asJobName = (value: string): JobName => {
  // SAFETY: validateIdentity checks that the value is an unmodified non-empty string.
  return value as JobName
}

const asLeaseToken = (value: string): LeaseToken => {
  // SAFETY: validateIdentity checks that the value is an unmodified non-empty string.
  return value as LeaseToken
}

const asWorkerId = (value: string): WorkerId => {
  // SAFETY: validateIdentity checks that the value is an unmodified non-empty string.
  return value as WorkerId
}

export const makeJobId = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is a public untyped identity boundary.
  value: unknown
): ResultType<JobId, JobDefinitionError> =>
  validateIdentity(value, 'jobId', asJobId, { requireWellFormedUnicode: true })

export const makeQueueName = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is a public untyped identity boundary.
  value: unknown
): ResultType<QueueName, JobDefinitionError> =>
  validateIdentity(value, 'queue', asQueueName, { requireWellFormedUnicode: true })

export const makeJobName = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is a public untyped identity boundary.
  value: unknown
): ResultType<JobName, JobDefinitionError> =>
  validateIdentity(value, 'name', asJobName, { requireWellFormedUnicode: true })

export const makeLeaseToken = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is a public untyped identity boundary.
  value: unknown
): ResultType<LeaseToken, JobDefinitionError> =>
  validateIdentity(value, 'leaseToken', asLeaseToken, { requireWellFormedUnicode: true })

export const makeWorkerId = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is a public untyped identity boundary.
  value: unknown
): ResultType<WorkerId, JobDefinitionError> =>
  validateIdentity(value, 'workerId', asWorkerId, { requireWellFormedUnicode: true })

export const JobId = { make: makeJobId } as const
export const QueueName = { make: makeQueueName } as const
export const JobName = { make: makeJobName } as const
export const LeaseToken = { make: makeLeaseToken } as const
export const WorkerId = { make: makeWorkerId } as const
