import { expect, test } from 'bun:test'
import { Result, TaggedError } from 'better-result'

import {
  JobCodecFailure,
  JobDefinitionError,
  JobId,
  JobName,
  LeaseLostError,
  LeaseToken,
  QueueName,
  WorkerId,
  claimJob,
  compareJobOrder,
  makeJobRecord,
  makePersistedBackoff,
  makeSerializedJobFailure,
  orderJobs,
  recoverStalledJob,
  redriveJob,
  reduceJob,
  releaseJob,
  requestJobCancellation,
  settleJob,
  validateAttemptRecord,
  validateDuration,
  validateJobRecord,
  validateTimestamp
} from '../src'
import type { JobRecord, LeaseToken as LeaseTokenValue, SerializedJobFailure } from '../src'

const unwrap = <Value, Failure>(result: Result<Value, Failure>): Value => {
  if (Result.isError(result)) {
    throw result.error
  }

  return result.value
}

const jobId = unwrap(JobId.make('job-1'))
const otherJobId = unwrap(JobId.make('job-2'))
const queue = unwrap(QueueName.make('emails'))
const worker = unwrap(WorkerId.make('worker-1'))
const leaseToken = unwrap(LeaseToken.make('lease-1'))
const oldLeaseToken = unwrap(LeaseToken.make('lease-old'))
const nextLeaseToken = unwrap(LeaseToken.make('lease-2'))
const jobName = unwrap(JobName.make('send-email'))

const waitingJob = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  id: jobId,
  name: jobName,
  version: 1,
  queue,
  state: 'waiting',
  payload: { recipient: 'ada@example.test' },
  metadata: { source: 'test' },
  priority: 10,
  runAt: 100,
  orderingSequence: 1,
  attemptsMax: 3,
  attemptsMade: 0,
  deliveryCount: 0,
  stalledCount: 0,
  backoff: undefined,
  timeoutMs: undefined,
  idempotencyKey: undefined,
  createdAt: 1,
  updatedAt: 100,
  processedAt: undefined,
  finishedAt: undefined,
  leaseOwner: undefined,
  leaseToken: undefined,
  leaseExpiresAt: undefined,
  cancellationRequestedAt: undefined,
  result: undefined,
  failure: undefined,
  ...overrides
})

const activeJob = (overrides: Partial<JobRecord> = {}): JobRecord =>
  waitingJob({
    state: 'active',
    updatedAt: 101,
    deliveryCount: 1,
    leaseOwner: worker,
    leaseToken,
    leaseExpiresAt: 200,
    ...overrides
  })

const claim = (record: JobRecord = waitingJob(), token: LeaseTokenValue = leaseToken) =>
  claimJob(record, {
    type: 'claim',
    jobId: record.id,
    workerId: worker,
    leaseToken: token,
    leaseExpiresAt: 200,
    now: 100
  })

test('identity constructors validate without changing persistent identity strings', () => {
  expect(String(unwrap(JobId.make('  job/1  ')))).toBe('  job/1  ')
  expect(String(unwrap(QueueName.make('queue.v1')))).toBe('queue.v1')

  const invalidValues: readonly unknown[] = [undefined, null, 42, false, '', {}, []]

  for (const value of invalidValues) {
    const result = JobId.make(value)

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(JobDefinitionError.is(result.error)).toBe(true)
    }
  }
})

test('record and attempt validators reject unsafe DTOs', () => {
  const checked = unwrap(makeJobRecord(waitingJob()))

  expect(checked).not.toBe(waitingJob())
  expect(Object.isFrozen(checked)).toBe(true)
  expect(Object.isFrozen(checked.metadata)).toBe(true)

  const polluted: unknown = JSON.parse('{"__proto__":"safe","constructor":"safe"}')
  const safeMetadata = unwrap(makeJobRecord({ ...waitingJob(), metadata: polluted }))

  expect(Object.prototype.hasOwnProperty.call(safeMetadata.metadata, '__proto__')).toBe(true)
  expect(safeMetadata.metadata['__proto__']).toBe('safe')
  expect(Object.getPrototypeOf(safeMetadata.metadata)).toBe(Object.prototype)

  expect(Result.isError(makeJobRecord(null))).toBe(true)
  expect(
    Result.isError(makeJobRecord({ ...waitingJob(), payload: { symbol: Symbol('nope') } }))
  ).toBe(true)
  expect(
    Result.isError(
      validateAttemptRecord({
        attempt: 0,
        delivery: 1,
        startedAt: undefined,
        finishedAt: 1,
        outcome: 'unknown',
        result: undefined,
        failure: undefined
      })
    )
  ).toBe(true)
})

test('public DTO boundaries reject extra fields and hostile access', () => {
  const secret = Symbol('secret')
  const extraRecord = {
    ...waitingJob(),
    extraFunction: () => 'not persistent',
    cause: new Error('do-not-persist'),
    [secret]: 'symbol secret'
  }
  const extraFailure = {
    kind: 'defect',
    message: 'safe',
    retryable: false,
    recordedAt: 100,
    stack: 'secret stack',
    cause: new Error('secret cause'),
    headers: { authorization: 'secret' },
    extraFunction: () => undefined,
    [secret]: 'symbol secret'
  }
  const extraBackoff = {
    type: 'constant',
    delayMs: 1,
    extraFunction: () => undefined,
    [secret]: 'symbol secret'
  }
  const extraAttempt = {
    attempt: 1,
    delivery: 1,
    startedAt: undefined,
    finishedAt: 1,
    outcome: 'completed',
    result: undefined,
    failure: undefined,
    extraFunction: () => undefined,
    [secret]: 'symbol secret'
  }

  expect(Result.isError(makeJobRecord(extraRecord))).toBe(true)
  expect(Result.isError(makeSerializedJobFailure(extraFailure))).toBe(true)
  expect(Result.isError(makePersistedBackoff(extraBackoff))).toBe(true)
  expect(Result.isError(validateAttemptRecord(extraAttempt))).toBe(true)

  const getterRecord = { ...waitingJob() }
  Object.defineProperty(getterRecord, 'payload', {
    enumerable: true,
    get: () => {
      throw new Error('secret getter')
    }
  })
  const getterFailure = { ...extraFailure }
  Object.defineProperty(getterFailure, 'message', {
    enumerable: true,
    get: () => {
      throw new Error('secret getter')
    }
  })
  const getterBackoff = { type: 'constant', delayMs: 1 }
  Object.defineProperty(getterBackoff, 'delayMs', {
    enumerable: true,
    get: () => {
      throw new Error('secret getter')
    }
  })

  expect(() => makeJobRecord(getterRecord)).not.toThrow()
  expect(() => makeSerializedJobFailure(getterFailure)).not.toThrow()
  expect(() => makePersistedBackoff(getterBackoff)).not.toThrow()
  expect(Result.isError(makeJobRecord(getterRecord))).toBe(true)
  expect(Result.isError(makeSerializedJobFailure(getterFailure))).toBe(true)
  expect(Result.isError(makePersistedBackoff(getterBackoff))).toBe(true)

  const revoked = Proxy.revocable(waitingJob(), {})
  revoked.revoke()
  expect(() => makeJobRecord(revoked.proxy)).not.toThrow()
  expect(Result.isError(makeJobRecord(revoked.proxy))).toBe(true)

  const nestedGetter = { nested: {} }
  Object.defineProperty(nestedGetter.nested, 'secret', {
    enumerable: true,
    get: () => {
      throw new Error('secret nested getter')
    }
  })
  const nestedProxy = new Proxy(
    {},
    {
      ownKeys: () => {
        throw new Error('secret nested proxy')
      }
    }
  )

  expect(() => makeJobRecord({ ...waitingJob(), payload: nestedGetter })).not.toThrow()
  expect(Result.isError(makeJobRecord({ ...waitingJob(), payload: nestedGetter }))).toBe(true)
  expect(Result.isError(makeJobRecord({ ...waitingJob(), payload: nestedProxy }))).toBe(true)

  const nested = { profile: { roles: ['reader'] }, attempts: [{ count: 1 }] }
  const input = waitingJob({ payload: nested })
  const inputSnapshot = structuredClone(input)
  const checked = unwrap(makeJobRecord(input))

  expect(input).toEqual(inputSnapshot)
  expect(checked.payload).not.toBe(nested)
  expect(Object.isFrozen(checked.payload)).toBe(true)
  // SAFETY: the payload above is a validated object with the asserted fields.
  expect(Object.isFrozen((checked.payload as { profile: object }).profile)).toBe(true)
  // SAFETY: the payload above is a validated object with the asserted fields.
  expect(Object.isFrozen((checked.payload as { attempts: readonly object[] }).attempts)).toBe(true)

  nested.profile.roles.push('admin')
  nested.attempts[0]!.count = 2
  expect(checked.payload).toEqual({ profile: { roles: ['reader'] }, attempts: [{ count: 1 }] })

  const data = { nested: { safe: true } }
  const failure = unwrap(
    makeSerializedJobFailure({
      kind: 'typed',
      message: 'safe',
      retryable: true,
      recordedAt: 100,
      data
    })
  )
  data.nested.safe = false
  expect(failure.data).toEqual({ nested: { safe: true } })
  expect(Object.isFrozen(failure.data)).toBe(true)
  // SAFETY: the failure data above is a validated object with the asserted field.
  expect(Object.isFrozen((failure.data as { nested: object }).nested)).toBe(true)
})

test('time and persisted backoff validators reject unsafe values', () => {
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    expect(Result.isError(validateTimestamp(value))).toBe(true)
    expect(Result.isError(validateDuration(value))).toBe(true)
  }

  const invalidBackoffs: readonly unknown[] = [
    { type: 'constant', delayMs: -1 },
    { type: 'linear', delayMs: Number.NaN },
    { type: 'exponential', delayMs: 10, maxDelayMs: 5 },
    { type: 'unsupported', delayMs: 1 }
  ]

  for (const backoff of invalidBackoffs) {
    expect(Result.isError(makePersistedBackoff(backoff))).toBe(true)
  }
})

test('claim ordering is priority, due time, durable sequence, then id', () => {
  const sameKey = {
    priority: 1,
    runAt: 100
  }
  const first = waitingJob({ id: otherJobId, orderingSequence: 1, ...sameKey })
  const second = waitingJob({ id: jobId, orderingSequence: 2, ...sameKey })
  const sequenceTie = waitingJob({ id: jobId, orderingSequence: 3, priority: 2, runAt: 100 })
  const sequenceTieOther = waitingJob({
    id: otherJobId,
    orderingSequence: 3,
    priority: 2,
    runAt: 100
  })
  const ordered = unwrap(orderJobs([second, first, sequenceTie, sequenceTieOther]))

  expect(ordered.map((job) => job.id)).toEqual([jobId, otherJobId, otherJobId, jobId])
  expect(compareJobOrder(sequenceTieOther, sequenceTie)).toBeGreaterThan(0)
})

test('the final JobId tie-breaker compares UTF-8 bytes rather than UTF-16 code units', () => {
  const privateUse = unwrap(JobId.make('\uE000'))
  const astral = unwrap(JobId.make('\u{10000}'))
  const left = waitingJob({ priority: 1, runAt: 100, orderingSequence: 3, id: privateUse })
  const right = waitingJob({ priority: 1, runAt: 100, orderingSequence: 3, id: astral })

  // JavaScript UTF-16 ordering puts the astral surrogate pair first; bytewise
  // UTF-8 ordering puts E0 before F0 and therefore the private-use ID first.
  expect(privateUse < astral).toBe(false)
  expect(compareJobOrder(left, right)).toBeLessThan(0)
  expect(unwrap(orderJobs([right, left])).map((job) => job.id)).toEqual([privateUse, astral])
})

test('due delayed jobs become active atomically during claim', () => {
  const delayed = waitingJob({ state: 'delayed', runAt: 200 })
  const claimed = unwrap(
    claimJob(delayed, {
      type: 'claim',
      jobId,
      workerId: worker,
      leaseToken: leaseToken,
      leaseExpiresAt: 300,
      now: 200
    })
  )

  expect(claimed.state).toBe('active')
  expect(claimed.deliveryCount).toBe(1)
  expect(claimed.leaseToken).toBe(leaseToken)
})

test('invalid claims and fenced transitions leave the input snapshot untouched', () => {
  const delayed = waitingJob({ state: 'delayed', runAt: 200 })
  const delayedSnapshot = structuredClone(delayed)
  const notDue = claim(delayed)

  expect(Result.isError(notDue)).toBe(true)
  expect(delayed).toEqual(delayedSnapshot)

  const active = activeJob()
  const activeSnapshot = structuredClone(active)
  const oldToken = settleJob(active, {
    type: 'settle',
    jobId,
    leaseToken: oldLeaseToken,
    now: 150,
    outcome: { type: 'complete', result: { ok: true } }
  })

  expect(Result.isError(oldToken)).toBe(true)
  if (Result.isError(oldToken) && LeaseLostError.is(oldToken.error)) {
    expect(oldToken.error.reason).toBe('mismatched-token')
  }
  expect(active).toEqual(activeSnapshot)

  const missingToken = releaseJob(active, {
    type: 'release',
    jobId,
    leaseToken: undefined,
    now: 150
  })

  expect(Result.isError(missingToken)).toBe(true)
  if (Result.isError(missingToken) && LeaseLostError.is(missingToken.error)) {
    expect(missingToken.error.reason).toBe('missing-token')
  }
  expect(active).toEqual(activeSnapshot)

  const expired = settleJob(active, {
    type: 'settle',
    jobId,
    leaseToken,
    now: 200,
    outcome: { type: 'complete' }
  })

  expect(Result.isError(expired)).toBe(true)
  if (Result.isError(expired) && LeaseLostError.is(expired.error)) {
    expect(expired.error.reason).toBe('expired-lease')
  }
  expect(active).toEqual(activeSnapshot)
})

test('settlement records attempts separately from deliveries and releases', () => {
  const active = unwrap(claim())
  const retryFailure: SerializedJobFailure = {
    kind: 'typed',
    code: 'TEMPORARY',
    message: 'temporary failure',
    retryable: true,
    recordedAt: 150
  }
  const retried = unwrap(
    reduceJob(active, {
      type: 'settle',
      jobId,
      leaseToken,
      now: 150,
      startedAt: 110,
      outcome: { type: 'retry', runAt: 250, failure: retryFailure }
    })
  )

  expect(retried.record.state).toBe('delayed')
  expect(retried.record.attemptsMade).toBe(1)
  expect(retried.record.deliveryCount).toBe(1)
  expect(retried.record.stalledCount).toBe(0)
  expect(retried.attempt).toMatchObject({
    attempt: 1,
    delivery: 1,
    outcome: 'retried',
    startedAt: 110,
    finishedAt: 150
  })

  const claimedAgain = unwrap(
    claimJob(retried.record, {
      type: 'claim',
      jobId,
      workerId: worker,
      leaseToken: nextLeaseToken,
      leaseExpiresAt: 350,
      now: 250
    })
  )
  const released = unwrap(
    reduceJob(claimedAgain, {
      type: 'release',
      jobId,
      leaseToken: nextLeaseToken,
      now: 260
    })
  )

  expect(released.record.state).toBe('waiting')
  expect(released.record.attemptsMade).toBe(1)
  expect(released.record.deliveryCount).toBe(2)
  expect(released.attempt?.outcome).toBe('released')
})

test('terminal jobs require explicit redrive and receive a fresh attempt budget', () => {
  const failed = unwrap(
    settleJob(activeJob({ attemptsMade: 2, deliveryCount: 2 }), {
      type: 'settle',
      jobId,
      leaseToken,
      now: 150,
      outcome: {
        type: 'fail',
        failure: {
          kind: 'typed',
          message: 'permanent failure',
          retryable: false,
          recordedAt: 150
        }
      }
    })
  )

  expect(
    Result.isError(
      claimJob(failed, {
        type: 'claim',
        jobId,
        workerId: worker,
        leaseToken: nextLeaseToken,
        leaseExpiresAt: 300,
        now: 200
      })
    )
  ).toBe(true)

  const redriven = unwrap(
    redriveJob(failed, {
      type: 'redrive',
      jobId,
      runAt: 300,
      now: 200
    })
  )

  expect(redriven.state).toBe('delayed')
  expect(redriven.attemptsMade).toBe(0)
  expect(redriven.deliveryCount).toBe(2)
})

test('cancellation requests do not steal an active lease', () => {
  const active = activeJob()
  const requested = unwrap(
    requestJobCancellation(active, {
      type: 'request-cancellation',
      jobId,
      now: 150
    })
  )

  expect(requested.state).toBe('active')
  expect(requested.cancellationRequestedAt).toBe(150)
  expect(requested.leaseOwner).toBe(worker)
  expect(requested.leaseToken).toBe(leaseToken)
  expect(requested.leaseExpiresAt).toBe(200)

  const cancelled = unwrap(
    settleJob(requested, {
      type: 'settle',
      jobId,
      leaseToken,
      now: 160,
      outcome: { type: 'cancelled' }
    })
  )

  expect(cancelled.state).toBe('cancelled')
  expect(cancelled.leaseToken).toBeUndefined()
  expect(cancelled.cancellationRequestedAt).toBeUndefined()
})

test('a requested cancellation wins over every active settlement outcome', () => {
  const outcomes = [
    { type: 'complete' as const, result: { ok: true } },
    { type: 'retry' as const, runAt: 300 },
    {
      type: 'fail' as const,
      failure: {
        kind: 'typed' as const,
        message: 'handler failure',
        retryable: false,
        recordedAt: 150
      }
    }
  ] as const

  for (const outcome of outcomes) {
    const requested = unwrap(
      requestJobCancellation(activeJob(), {
        type: 'request-cancellation',
        jobId,
        now: 150
      })
    )
    const settled = unwrap(
      settleJob(requested, {
        type: 'settle',
        jobId,
        leaseToken,
        now: 160,
        outcome
      })
    )

    expect(settled.state).toBe('cancelled')
    expect(settled.attemptsMade).toBe(1)
    expect(settled.deliveryCount).toBe(1)
    expect(settled.failure?.kind).toBe('cancelled')
  }
})

test('requested cancellation cannot be dropped by release or stalled recovery', () => {
  const requested = unwrap(
    requestJobCancellation(activeJob(), {
      type: 'request-cancellation',
      jobId,
      now: 150
    })
  )
  const released = unwrap(
    reduceJob(requested, {
      type: 'release',
      jobId,
      leaseToken,
      now: 160
    })
  )

  expect(released.record.state).toBe('cancelled')
  expect(released.record.attemptsMade).toBe(0)
  expect(released.record.deliveryCount).toBe(1)
  expect(released.record.stalledCount).toBe(0)
  expect(released.attempt?.outcome).toBe('cancelled')
  expect(released.attempt?.attempt).toBe(0)

  const requestedAgain = unwrap(
    requestJobCancellation(activeJob(), {
      type: 'request-cancellation',
      jobId,
      now: 150
    })
  )
  const recovered = unwrap(
    reduceJob(requestedAgain, {
      type: 'recover-stalled',
      jobId,
      now: 200
    })
  )

  expect(recovered.record.state).toBe('cancelled')
  expect(recovered.record.attemptsMade).toBe(0)
  expect(recovered.record.deliveryCount).toBe(1)
  expect(recovered.record.stalledCount).toBe(1)
  expect(recovered.attempt?.outcome).toBe('cancelled')
  expect(recovered.attempt?.attempt).toBe(0)
})

test('cancelled settlement consumes exactly one attempt, including at budget edges', () => {
  const settled = unwrap(
    reduceJob(activeJob({ attemptsMade: 2, attemptsMax: 3 }), {
      type: 'settle',
      jobId,
      leaseToken,
      now: 160,
      outcome: { type: 'cancelled' }
    })
  )

  expect(settled.record.state).toBe('cancelled')
  expect(settled.record.attemptsMade).toBe(3)
  expect(settled.attempt?.attempt).toBe(3)

  const atBudget = unwrap(
    settleJob(activeJob({ attemptsMade: 3, attemptsMax: 3 }), {
      type: 'settle',
      jobId,
      leaseToken,
      now: 160,
      outcome: { type: 'cancelled' }
    })
  )

  expect(atBudget.attemptsMade).toBe(4)
  expect(Result.isOk(validateJobRecord(atBudget))).toBe(true)
})

test('stalled recovery is visible without consuming an attempt', () => {
  const active = activeJob({ attemptsMade: 1, deliveryCount: 2, stalledCount: 0 })
  const recovered = unwrap(
    reduceJob(active, {
      type: 'recover-stalled',
      jobId,
      now: 200
    })
  )

  expect(recovered.record.state).toBe('waiting')
  expect(recovered.record.attemptsMade).toBe(1)
  expect(recovered.record.deliveryCount).toBe(2)
  expect(recovered.record.stalledCount).toBe(1)
  expect(recovered.record.failure?.kind).toBe('stalled')
  expect(recovered.attempt?.outcome).toBe('stalled')
  expect(recovered.attempt?.attempt).toBe(1)
  const highStallCount = unwrap(
    recoverStalledJob(activeJob({ stalledCount: 10 }), {
      type: 'recover-stalled',
      jobId,
      now: 200
    })
  )

  expect(highStallCount.state).toBe('waiting')
  expect(highStallCount.stalledCount).toBe(11)
})

test('the v0.1 codec contract exposes one tagged runtime error', () => {
  const failure = new JobCodecFailure({ message: 'codec unavailable' })

  expect(JobCodecFailure.is(failure)).toBe(true)
  expect(failure._tag).toBe('JobCodecFailure')
  expect(failure.message).toBe('codec unavailable')
})

test('persisted failure construction never copies a TaggedError cause or stack', () => {
  class SecretHandlerError extends TaggedError('SecretHandlerError')<{
    readonly cause: Error
    readonly message: string
  }> {}

  const handlerError = new SecretHandlerError({
    cause: new Error('do-not-persist'),
    message: 'safe diagnostic'
  })
  const persisted = unwrap(
    makeSerializedJobFailure({
      kind: 'defect',
      message: handlerError.message,
      retryable: false,
      recordedAt: 100,
      data: { publicCode: 'DEFECT' }
    })
  )
  const serialized = JSON.stringify(persisted)

  expect(serialized).toContain('publicCode')
  expect(serialized).not.toContain('do-not-persist')
  expect(serialized).not.toContain('stack')
  expect(serialized).not.toContain('cause')
})
