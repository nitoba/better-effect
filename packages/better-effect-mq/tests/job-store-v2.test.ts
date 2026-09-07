// oxlint-disable anti-slop/no-unknown-parameters -- this helper narrows the synchronous Memory adapter boundary.

import { expect, test } from 'bun:test'
import { Result } from 'better-result'

import {
  JobId,
  QueueName,
  WorkerId,
  JobStore,
  MemoryJobStore,
  makeFlowChildId,
  protocolVersion,
  protocolVersionV2,
  validateJobRecordV2
} from '../src'
import type {
  FlowChildSpec,
  AppendChildReportResult,
  FlowFanOutResult,
  FlowOutboxPage,
  JobStoreError,
  JobRecordV2,
  AttemptRecordV2,
  JobCountsV2,
  ListJobsV2Result,
  ClaimResult,
  EnqueueResult,
  JobStoreV2Contract
} from '../src'

const parentId = JobId.make('parent-v2').unwrap()

const resultValue = <Value>(result: unknown): Value => {
  // MemoryJobStore is synchronous; durable adapters may return a PromiseLike through the same API.
  // SAFETY: MemoryJobStore's concrete implementation returns a Result synchronously; the public PromiseLike branch is not used by this test fixture.
  const synchronous = result as Result<Value, JobStoreError>
  if (Result.isError(synchronous)) throw synchronous.error
  return synchronous.value
}

const queue = QueueName.make('v2').unwrap()

const childSpec = (key: string): FlowChildSpec => ({
  childKey: key,
  name: 'child',
  version: 1,
  storeKey: 'child-store',
  childJobId: makeFlowChildId({
    parentStoreKey: 'parent-store',
    flowId: parentId,
    childKey: key
  }).unwrap(),
  request: {
    protocolVersion,
    identity: { queue: 'v2', name: 'child', version: 1 },
    id: makeFlowChildId({
      parentStoreKey: 'parent-store',
      flowId: parentId,
      childKey: key
    }).unwrap(),
    payload: { key },
    metadata: {},
    priority: 0,
    runAt: 0,
    attemptsMax: 1,
    now: 0
  }
})

test('MemoryJobStore keeps v1 compatibility while exposing an explicit v2 contract', () => {
  const store = MemoryJobStore.make()

  expect(protocolVersion).toBe(1)
  expect(protocolVersionV2).toBe(2)
  expect(store.descriptor.protocolVersion).toBe(1)
  expect(store.v2.descriptor.protocolVersion).toBe(2)
  expect(store.v2.descriptor.migration.status).toBe('not-required')
  expect(store.v2.flow.descriptor.protocolVersion).toBe(2)
  expect(Object.isFrozen(store.v2.descriptor)).toBe(true)
  expect(JobStore).toBeDefined()
})

test('v2 fanOut changes the parent state atomically and blocks normal claims', () => {
  const store = MemoryJobStore.make()
  const parent = resultValue<EnqueueResult>(
    store.enqueue({
      id: parentId,
      job: { queue, name: 'parent', version: 1 },
      payload: { day: 'today' },
      metadata: {},
      priority: 0,
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  const claimed = resultValue<ClaimResult>(
    store.claim({
      queue,
      accepted: [{ queue, name: 'parent', version: 1 }],
      limit: 1,
      workerId: WorkerId.make('worker-v2').unwrap(),
      leaseDurationMs: 100,
      now: 0
    })
  )
  const lease = claimed.jobs[0]
  expect(lease?.id).toBe(parent.job.id)

  const request = {
    flowId: parentId,
    flowName: 'daily',
    parentStoreKey: 'parent-store',
    depth: 1,
    leaseToken: lease!.leaseToken,
    failFast: false,
    children: [childSpec('one')],
    now: 1
  } as const
  const fanOut = resultValue<FlowFanOutResult>(store.v2.fanOut(request))

  expect(fanOut.parent.state).toBe('waiting-children')
  expect(
    resultValue<readonly AttemptRecordV2[]>(store.v2.getAttempts({ jobId: parentId }))[0]?.outcome
  ).toBe('fanned-out')
  expect(resultValue<JobRecordV2 | undefined>(store.v2.getJob({ jobId: parentId }))?.state).toBe(
    'waiting-children'
  )
  const counts = resultValue<JobCountsV2>(store.v2.counts({ queue }))
  expect(counts.waiting).toBe(0)
  expect(counts.waitingChildren).toBe(1)
  const listed = resultValue<ListJobsV2Result>(
    store.v2.list({ queue, state: 'waiting-children', limit: 10 })
  )
  expect(listed.jobs.map((job) => job.id)).toEqual([parentId])
  const claimAfterFanOut = resultValue<ClaimResult>(
    store.claim({
      queue,
      accepted: [{ queue, name: 'parent', version: 1 }],
      limit: 1,
      workerId: WorkerId.make('worker-v2b').unwrap(),
      leaseDurationMs: 100,
      now: 1
    })
  )
  expect(claimAfterFanOut.jobs).toEqual([])

  const replay = resultValue<FlowFanOutResult>(store.v2.fanOut(request))
  expect(replay.status).toBe('already-applied')
})

test('v2 report append remains idempotent across terminal child settlement', () => {
  const store = MemoryJobStore.make()
  const entry = {
    id: 'report-v2-1',
    flowName: 'daily',
    parentStoreKey: 'parent-store',
    report: {
      flowId: parentId,
      childKey: 'one',
      outcome: 'completed' as const,
      result: { sent: true },
      failure: undefined
    }
  }

  expect(resultValue<AppendChildReportResult>(store.v2.appendChildReport(entry)).status).toBe(
    'applied'
  )
  expect(resultValue<AppendChildReportResult>(store.v2.appendChildReport(entry)).status).toBe(
    'already-applied'
  )
  expect(resultValue<FlowOutboxPage>(store.v2.peekOutbox({ limit: 10 })).entries).toHaveLength(1)
})

test('v2 terminal child settlement appends its parent report exactly once', () => {
  const store = MemoryJobStore.make()
  const childId = JobId.make('child-v2').unwrap()
  const parent = {
    flowName: 'daily',
    flowId: parentId,
    childKey: 'one',
    parentStoreKey: 'parent-store',
    depth: 1
  } as const
  const child = resultValue<EnqueueResult>(
    store.enqueue({
      id: childId,
      job: { queue, name: 'child', version: 1 },
      payload: { key: 'one' },
      metadata: {},
      priority: 0,
      runAt: 0,
      attemptsMax: 1,
      now: 0,
      parent
    })
  )
  const claimed = resultValue<ClaimResult>(
    store.claim({
      queue,
      accepted: [{ queue, name: 'child', version: 1 }],
      limit: 1,
      workerId: WorkerId.make('child-worker').unwrap(),
      leaseDurationMs: 100,
      now: 0
    })
  )
  const lease = claimed.jobs[0]!
  resultValue(
    store.settle({
      jobId: child.job.id,
      leaseToken: lease.leaseToken,
      outcome: { type: 'complete', result: { sent: true } },
      now: 1
    })
  )

  const entries = resultValue<FlowOutboxPage>(store.v2.peekOutbox({ limit: 10 })).entries
  expect(entries).toHaveLength(1)
  expect(entries[0]?.report).toEqual({
    flowId: parentId,
    childKey: 'one',
    outcome: 'completed',
    result: { sent: true },
    failure: undefined
  })
  expect(resultValue<JobRecordV2 | undefined>(store.v2.getJob({ jobId: childId }))?.parent).toEqual(
    parent
  )
})

test('v2 waiting-child cancellation appends a cancelled report', () => {
  const store = MemoryJobStore.make()
  const childId = JobId.make('child-v2-cancelled').unwrap()
  const parent = {
    flowName: 'daily',
    flowId: parentId,
    childKey: 'cancelled',
    parentStoreKey: 'parent-store',
    depth: 1
  } as const
  resultValue<EnqueueResult>(
    store.enqueue({
      id: childId,
      job: { queue, name: 'child', version: 1 },
      payload: { key: 'cancelled' },
      metadata: {},
      priority: 0,
      runAt: 0,
      attemptsMax: 1,
      now: 0,
      parent
    })
  )
  resultValue(store.cancel({ jobId: childId, now: 1 }))

  const entries = resultValue<FlowOutboxPage>(store.v2.peekOutbox({ limit: 10 })).entries
  expect(entries).toHaveLength(1)
  expect(entries[0]?.report.outcome).toBe('cancelled')
})

test('v2 JobRecord validation rejects waiting-children without flow metadata', () => {
  const invalid = validateJobRecordV2({
    id: parentId,
    name: 'parent',
    version: 1,
    queue: 'v2',
    state: 'waiting-children',
    payload: {},
    metadata: {},
    priority: 0,
    runAt: 0,
    orderingSequence: 1,
    attemptsMax: 1,
    attemptsMade: 0,
    deliveryCount: 0,
    stalledCount: 0,
    backoff: undefined,
    timeoutMs: undefined,
    idempotencyKey: undefined,
    createdAt: 0,
    updatedAt: 0,
    processedAt: undefined,
    finishedAt: undefined,
    leaseOwner: undefined,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    cancellationRequestedAt: undefined,
    result: undefined,
    failure: undefined,
    parent: undefined,
    flow: undefined
  })

  expect(Result.isError(invalid)).toBe(true)
})

const typedStore: JobStoreV2Contract = MemoryJobStore.make().v2
void typedStore
