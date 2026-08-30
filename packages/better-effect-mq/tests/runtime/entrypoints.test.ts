import { expect, test } from 'bun:test'

import * as core from '../../src/index'
import * as testing from '../../src/testing/index'

const expectedCoreRuntimeExports = [
  'Codec',
  'InvalidJobTransitionError',
  'Job',
  'JobRegistry',
  'JobStore',
  'JobStoreWakeAbortedError',
  'JobCodecFailure',
  'JobDecodeFailure',
  'JobDefinitionError',
  'JobEncodeFailure',
  'JobId',
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
  'UnsupportedJobStoreOperationError',
  'WorkerId',
  'cancelJob',
  'claimJob',
  'compareJobOrder',
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
  'normalizeIdempotencyKey',
  'normalizeMetadata',
  'normalizeRetryable',
  'orderJobs',
  'promoteJob',
  'protocolVersion',
  'recoverStalledJob',
  'redriveJob',
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

test('the testing entrypoint remains inert', () => {
  expect(Object.keys(testing)).toEqual([])
})
