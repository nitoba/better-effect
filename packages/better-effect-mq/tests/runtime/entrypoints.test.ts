import { expect, test } from 'bun:test'

import * as core from '../../src/index'
import * as testing from '../../src/testing/index'

const expectedCoreRuntimeExports = [
  'Codec',
  'InvalidJobTransitionError',
  'Job',
  'JobAdmin',
  'JobAwaitAbortedError',
  'JobRegistry',
  'JobStore',
  'JobStoreWakeAbortedError',
  'JobTimeoutError',
  'JobMetricNames',
  'JobObserver',
  'makeJobDepthSampler',
  'JobContext',
  'MemoryJobStore',
  'JobCodecFailure',
  'JobDecodeFailure',
  'JobDefinitionError',
  'JobEncodeFailure',
  'JobExecutionCancelledError',
  'JobExecutionFailureError',
  'JobId',
  'JobIdentityMismatchError',
  'JobName',
  'JobNotCancellableError',
  'JobNotFoundError',
  'JobNotPromotableError',
  'JobNotRetryableError',
  'JobStoreFailure',
  'LeaseLostError',
  'LeaseToken',
  'Queue',
  'QueueName',
  'Retry',
  'UnsupportedJobStoreOperationError',
  'Worker',
  'WorkerAwaitIdleError',
  'WorkerRuntimeOwnershipError',
  'WorkerId',
  'cancelJob',
  'claimJob',
  'compareJobOrder',
  'isUnrecoverableFailure',
  'bindJob',
  'makeJobId',
  'makeJobName',
  'makeJobRecord',
  'makeJobRegistry',
  'makeLeaseToken',
  'makePersistedBackoff',
  'makePersistedJobFailure',
  'makeQueueName',
  'makeSerializedJobFailure',
  'makeWorkerId',
  'markUnrecoverable',
  'normalizeIdempotencyKey',
  'normalizeMetadata',
  'normalizeRetryable',
  'observeJob',
  'orderJobs',
  'promoteJob',
  'protocolVersion',
  'recoverStalledJob',
  'recoverStalledWithPolicy',
  'retryJob',
  'reduceJob',
  'releaseJob',
  'requestJobCancellation',
  'runIdempotencyKey',
  'runMetadata',
  'runRetryable',
  'settleJob',
  'sortClaimCandidates',
  'transitionJob',
  'validateAttemptRecord',
  'validateDuration',
  'validateJobRecord',
  'validateOptionalDuration',
  'validateOptionalTimestamp',
  'validatePersistedBackoff',
  'validatePositiveDuration',
  'validateSerializedJobFailure',
  'validateTimestamp'
] as const

test('the core entrypoint exposes only the durable protocol surface', () => {
  expect(Object.keys(core).sort()).toEqual([...expectedCoreRuntimeExports].sort())
  expect(core.protocolVersion).toBe(1)
})

test('the testing entrypoint exposes only runner-agnostic testing utilities', () => {
  expect(Object.keys(testing).sort()).toEqual([
    'JobStoreConformanceError',
    'RecordedJobObserver',
    'TestJobStore',
    'jobStoreContract'
  ])
  expect(testing.jobStoreContract).toBeDefined()
  expect(testing.RecordedJobObserver).toBeDefined()
  expect(testing.TestJobStore).toBeDefined()
  expect(testing.JobStoreConformanceError.name).toBe('JobStoreConformanceError')
})
