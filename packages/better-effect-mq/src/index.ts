import {
  JobId as JobIdFactory,
  JobName as JobNameFactory,
  LeaseToken as LeaseTokenFactory,
  QueueName as QueueNameFactory,
  WorkerId as WorkerIdFactory
} from './protocol'

export const JobId = JobIdFactory
export const JobName = JobNameFactory
export const LeaseToken = LeaseTokenFactory
export const QueueName = QueueNameFactory
export const WorkerId = WorkerIdFactory

export {
  InvalidJobTransitionError,
  JobCodecFailure,
  JobDefinitionError,
  JobNotCancellableError,
  JobNotFoundError,
  JobNotPromotableError,
  JobNotRetryableError,
  JobStoreFailure,
  LeaseLostError,
  UnsupportedJobStoreOperationError,
  cancelJob,
  claimJob,
  compareJobOrder,
  makeJobId,
  makeJobName,
  makeJobRecord,
  makeLeaseToken,
  makePersistedBackoff,
  makePersistedJobFailure,
  makeQueueName,
  makeSerializedJobFailure,
  makeWorkerId,
  orderJobs,
  promoteJob,
  protocolVersion,
  recoverStalledJob,
  redriveJob,
  reduceJob,
  releaseJob,
  requestJobCancellation,
  settleJob,
  sortClaimCandidates,
  transitionJob,
  validateAttemptRecord,
  validateDuration,
  validateJobRecord,
  validateOptionalDuration,
  validateOptionalTimestamp,
  validatePersistedBackoff,
  validatePositiveDuration,
  validateSerializedJobFailure,
  validateTimestamp
} from './protocol'

export type {
  ActiveLease,
  AttemptOutcome,
  AttemptRecord,
  BackoffKind,
  CancelCommand,
  CancelledOutcome,
  ClaimCommand,
  CompleteOutcome,
  FailOutcome,
  JobFailureKind,
  JobIdentityRecord,
  JobRecord,
  JobState,
  JobTransition,
  JobTransitionCommand,
  JobTransitionFailure,
  PersistedBackoff,
  PromoteCommand,
  ProtocolVersion,
  RecoverStalledCommand,
  RedriveCommand,
  ReleaseCommand,
  RequestCancellationCommand,
  RetryOutcome,
  SerializedJobFailure,
  SettleCommand,
  SettlementOutcome
} from './protocol'

export type JobId = import('./protocol/brands').JobId
export type JobName = import('./protocol/brands').JobName
export type LeaseToken = import('./protocol/brands').LeaseToken
export type QueueName = import('./protocol/brands').QueueName
export type WorkerId = import('./protocol/brands').WorkerId
export type JsonArray = import('./protocol/types').JsonArray
export type JsonObject = import('./protocol/types').JsonObject
export type JsonPrimitive = import('./protocol/types').JsonPrimitive
export type JsonValue = import('./protocol/types').JsonValue
export type LeaseLossReason = import('./protocol/errors').LeaseLossReason
