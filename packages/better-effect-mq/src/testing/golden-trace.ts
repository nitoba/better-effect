import { Result } from 'better-result'

import type { AttemptRecord, JsonObject, JsonValue, JobRecord } from '../protocol'
import type {
  ClaimResult,
  EnqueueResult,
  JobCounts,
  JobStoreOperation,
  SettlementResult
} from '../store'
import type { JobStoreContractScenarioContext } from './job-store-contract'

export type JobStoreGoldenTraceCommand =
  | 'enqueue'
  | 'claim'
  | 'settle'
  | 'getJob'
  | 'getAttempts'
  | 'counts'

export interface JobStoreGoldenTraceStep {
  readonly id: string
  readonly command: JobStoreGoldenTraceCommand
  readonly expected: JsonValue
}

const baseTime = 1_700_000_000_000
const jobId = 'contract-job-golden'
const workerId = 'contract-worker-golden'

/**
 * The protocol-v1 command trace shared by every adapter conformance runner.
 * Dynamic lease tokens are deliberately not part of the portable snapshot.
 */
const goldenTrace: JobStoreGoldenTraceStep[] = [
  {
    id: 'enqueue',
    command: 'enqueue',
    expected: {
      job: {
        id: jobId,
        state: 'waiting',
        payload: { value: 'golden' },
        metadata: { scenario: 'golden-transition-trace', label: 'golden' },
        runAt: baseTime,
        orderingSequence: 1,
        attemptsMade: 0,
        attemptSequence: 0,
        deliveryCount: 0,
        stalledCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        result: null
      },
      duplicate: false
    }
  },
  {
    id: 'claim',
    command: 'claim',
    expected: {
      job: {
        id: jobId,
        state: 'active',
        payload: { value: 'golden' },
        metadata: { scenario: 'golden-transition-trace', label: 'golden' },
        runAt: baseTime,
        orderingSequence: 1,
        attemptsMade: 0,
        attemptSequence: 0,
        deliveryCount: 1,
        stalledCount: 0,
        leaseOwner: workerId,
        leaseExpiresAt: baseTime + 100,
        result: null
      }
    }
  },
  {
    id: 'settle',
    command: 'settle',
    expected: {
      status: 'applied',
      job: {
        id: jobId,
        state: 'completed',
        payload: { value: 'golden' },
        metadata: { scenario: 'golden-transition-trace', label: 'golden' },
        runAt: baseTime,
        orderingSequence: 1,
        attemptsMade: 1,
        attemptSequence: 1,
        deliveryCount: 1,
        stalledCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        result: { value: 'done' }
      },
      attempt: {
        attempt: 1,
        attemptSequence: 1,
        delivery: 1,
        startedAt: baseTime,
        finishedAt: baseTime + 10,
        outcome: 'completed',
        result: { value: 'done' },
        failure: null
      }
    }
  },
  {
    id: 'get-job',
    command: 'getJob',
    expected: {
      job: {
        id: jobId,
        state: 'completed',
        payload: { value: 'golden' },
        metadata: { scenario: 'golden-transition-trace', label: 'golden' },
        runAt: baseTime,
        orderingSequence: 1,
        attemptsMade: 1,
        attemptSequence: 1,
        deliveryCount: 1,
        stalledCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        result: { value: 'done' }
      }
    }
  },
  {
    id: 'get-attempts',
    command: 'getAttempts',
    expected: {
      attempts: [
        {
          attempt: 1,
          attemptSequence: 1,
          delivery: 1,
          startedAt: baseTime,
          finishedAt: baseTime + 10,
          outcome: 'completed',
          result: { value: 'done' },
          failure: null
        }
      ]
    }
  },
  {
    id: 'counts',
    command: 'counts',
    expected: {
      total: 1,
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 1,
      failed: 0,
      cancelled: 0
    }
  }
]

export const jobStoreGoldenTrace: readonly JobStoreGoldenTraceStep[] = Object.freeze(goldenTrace)

const jobSnapshot = (job: JobRecord): JsonValue => ({
  id: job.id,
  state: job.state,
  payload: job.payload,
  metadata: job.metadata,
  runAt: job.runAt,
  orderingSequence: job.orderingSequence,
  attemptsMade: job.attemptsMade,
  attemptSequence: job.attemptSequence ?? null,
  deliveryCount: job.deliveryCount,
  stalledCount: job.stalledCount,
  leaseOwner: job.leaseOwner ?? null,
  leaseExpiresAt: job.leaseExpiresAt ?? null,
  result: job.result ?? null
})

const attemptSnapshot = (attempt: AttemptRecord): JsonValue => ({
  attempt: attempt.attempt,
  attemptSequence: attempt.attemptSequence ?? null,
  delivery: attempt.delivery,
  startedAt: attempt.startedAt ?? null,
  finishedAt: attempt.finishedAt,
  outcome: attempt.outcome,
  result: attempt.result ?? null,
  failure:
    attempt.failure === undefined
      ? null
      : {
          kind: attempt.failure.kind,
          code: attempt.failure.code ?? null,
          message: attempt.failure.message,
          data: attempt.failure.data ?? null,
          retryable: attempt.failure.retryable,
          recordedAt: attempt.failure.recordedAt
        }
})

const expected = (id: string): JsonValue => {
  const step = jobStoreGoldenTrace.find((candidate) => candidate.id === id)
  if (step === undefined) throw new Error(`missing golden trace step: ${id}`)
  return step.expected
}

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && !Array.isArray(value) && Object(value) === value

const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const assertSnapshot = (id: string, actual: JsonValue): void => {
  const actualText = canonicalJson(actual)
  const expectedText = canonicalJson(expected(id))
  if (actualText !== expectedText) {
    throw new Error(`golden trace ${id} diverged: expected ${expectedText}, received ${actualText}`)
  }
}

const unwrap = async <Value>(operation: JobStoreOperation<Value>): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  // SAFETY: Result.isError narrows the completed operation to its success value.
  return result.value as Value
}

/** Execute the canonical trace against one resolved protocol-v1 store. */
export const runJobStoreGoldenTrace = async (
  context: JobStoreContractScenarioContext
): Promise<void> => {
  const now = context.clock.now()
  const job = await unwrap<EnqueueResult>(
    context.store.enqueue({
      id: context.ids.jobId('golden'),
      identity: context.fixtures.job.identity,
      payload: { value: 'golden' },
      metadata: { scenario: 'golden-transition-trace', label: 'golden' },
      priority: 1,
      runAt: now,
      attemptsMax: 2,
      now
    })
  )
  assertSnapshot('enqueue', { job: jobSnapshot(job.job), duplicate: job.duplicate })

  const claimed = await unwrap<ClaimResult>(
    context.store.claim({
      queue: context.fixtures.queueName,
      accepted: context.fixtures.registry.accepted,
      limit: 1,
      workerId: context.ids.workerId('golden'),
      leaseDurationMs: 100,
      now
    })
  )
  const active = claimed.jobs[0]
  if (active === undefined) throw new Error('golden trace claim returned no job')
  assertSnapshot('claim', { job: jobSnapshot(active) })

  context.clock.advance(10)
  const settled = await unwrap<SettlementResult>(
    context.store.settle({
      jobId: active.id,
      leaseToken: active.leaseToken,
      outcome: { type: 'complete', result: { value: 'done' } },
      startedAt: now,
      now: context.clock.now()
    })
  )
  assertSnapshot('settle', {
    status: settled.status,
    job: jobSnapshot(settled.record),
    attempt: settled.attempt === undefined ? null : attemptSnapshot(settled.attempt)
  })

  const found = await unwrap<JobRecord | undefined>(context.store.getJob({ jobId: active.id }))
  if (found === undefined) throw new Error('golden trace getJob returned no job')
  assertSnapshot('get-job', { job: jobSnapshot(found) })

  const attempts = await unwrap<readonly AttemptRecord[]>(
    context.store.getAttempts({ jobId: active.id })
  )
  assertSnapshot('get-attempts', { attempts: attempts.map(attemptSnapshot) })

  const counts = await unwrap<JobCounts>(context.store.counts())
  assertSnapshot('counts', {
    total: counts.total,
    waiting: counts.waiting,
    delayed: counts.delayed,
    active: counts.active,
    completed: counts.completed,
    failed: counts.failed,
    cancelled: counts.cancelled
  })
}
