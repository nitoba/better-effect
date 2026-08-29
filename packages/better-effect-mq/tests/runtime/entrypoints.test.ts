import { expect, test } from 'bun:test'

import * as core from '../../src/index'
import * as testing from '../../src/testing/index'

const expectedCoreRuntimeExports = [
  'InvalidJobTransitionError',
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
  'QueueName',
  'UnsupportedJobStoreOperationError',
  'WorkerId',
  'cancelJob',
  'claimJob',
  'compareJobOrder',
  'makeJobId',
  'makeJobName',
  'makeJobRecord',
  'makeLeaseToken',
  'makePersistedBackoff',
  'makePersistedJobFailure',
  'makeQueueName',
  'makeSerializedJobFailure',
  'makeWorkerId',
  'orderJobs',
  'promoteJob',
  'protocolVersion',
  'recoverStalledJob',
  'redriveJob',
  'reduceJob',
  'releaseJob',
  'requestJobCancellation',
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
