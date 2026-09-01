// oxlint-disable anti-slop/no-runtime-typeof -- this test-only adapter validates deliberately untyped request defects.
// oxlint-disable anti-slop/no-unknown-parameters -- fault fixtures intentionally cross public boundaries.
// oxlint-disable anti-slop/no-chained-type-assertions -- the adapter restores focused operation types at one fixture boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- all assertions are test fixture erasure boundaries.

import { Layer, Runtime } from 'better-effect'
import type { ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

import { recoverStalledWithPolicy } from '../../src/protocol/transitions'

import type {
  JobStoreContractRuntime,
  JobStoreContractSynchronization,
  JobStoreContractMultiStoreContext,
  JobStoreContractMultiStoreRuntime
} from '../../src/testing'

import {
  InvalidJobTransitionError,
  JobDefinitionError,
  JobNotFoundError,
  JobStore,
  JobStoreWakeAbortedError,
  QueueName,
  UnsupportedJobStoreOperationError,
  compareJobOrder,
  makeJobId,
  makeJobName,
  makeJobRecord,
  makeLeaseToken,
  makeQueueName,
  reduceJob,
  type ActiveJobSnapshot,
  type AttemptRecord,
  type EnqueueRequest,
  type JobId,
  type JobIdentity,
  type JobRecord,
  type JobStore as JobStoreType,
  type JobStoreError,
  type JobStoreToken,
  type JobTransition,
  type JobStoreCapabilities,
  type JobListOrder,
  type JobListOrderBy,
  type LeaseLossReason,
  type ListJobsRequest,
  type LostLease,
  type QueuePauseResult,
  type WakeToken
} from '../../src'

export type MemoryStoreFault =
  | 'no-fencing'
  | 'wrong-ordering'
  | 'lost-wake'
  | 'delayed-wake-check'
  | 'unfiltered-wake'
  | 'duplicate-claim'
  | 'broken-pagination'
  | 'drop-enqueue-many-suffix'
  | 'zero-count-channels'
  | 'cross-store'

type Operation<Value> = ResultType<Value, JobStoreError>
type StoredWakeEvent = {
  readonly version: number
  readonly queue: string | undefined
}

type StoredWaiter = {
  readonly queues: readonly string[]
  readonly token: number
  readonly resolve: () => void
  readonly signal: AbortSignal
  readonly onAbort: () => void
}

type MemoryStoreOptions = {
  readonly capabilities?: Partial<JobStoreCapabilities>
  readonly fault?: MemoryStoreFault
  readonly synchronization?: JobStoreContractSynchronization
}

const ok = <Value>(value: Value): Operation<Value> =>
  Result.ok(value) as unknown as Operation<Value>

const error = <Value>(cause: JobStoreError): Operation<Value> =>
  Result.err(cause) as unknown as Operation<Value>

const unwrap = <Value, Failure>(value: ResultType<Value, Failure>): Value =>
  value.match({
    ok: (result) => result,
    err: (cause) => {
      throw cause
    }
  })

const jobStoreError = (field: string, message: string): JobDefinitionError =>
  new JobDefinitionError({ field, message })

const queueText = (queue: string): string => queue
const tokenNumber = (token: WakeToken): number => {
  const value = Number(token.slice('wake-'.length))
  return Number.isSafeInteger(value) && value >= 0 ? value : -1
}

const cursorVersion = 1 as const
const listStateOrder = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'] as const

const identityFrom = (request: EnqueueRequest): JobIdentity => request.job ?? request.identity!

const primaryValue = (record: JobRecord, orderBy: JobListOrderBy): number | null =>
  orderBy === 'enqueuedAt'
    ? record.createdAt
    : orderBy === 'runAt'
      ? record.runAt
      : (record.finishedAt ?? null)

const compareListOrder = (
  left: JobRecord,
  right: JobRecord,
  orderBy: JobListOrderBy,
  order: JobListOrder
): number => {
  const direction = order === 'asc' ? 1 : -1
  const leftValue = primaryValue(left, orderBy)
  const rightValue = primaryValue(right, orderBy)
  const primary =
    leftValue === null
      ? rightValue === null
        ? 0
        : 1
      : rightValue === null
        ? -1
        : leftValue < rightValue
          ? -1
          : leftValue > rightValue
            ? 1
            : 0
  if (primary !== 0) return primary * direction
  if (left.orderingSequence !== right.orderingSequence) {
    return (left.orderingSequence < right.orderingSequence ? -1 : 1) * direction
  }
  return (left.id === right.id ? 0 : left.id < right.id ? -1 : 1) * direction
}

const cursorOrderingFor = (
  orderBy: JobListOrderBy
): NonNullable<ListJobsRequest['cursor']>['ordering'] =>
  orderBy === 'enqueuedAt' ? 'createdAt,orderingSequence,id' : `${orderBy},orderingSequence,id`

const isKnownListField = (field: string): boolean =>
  ['queue', 'name', 'version', 'state', 'metadata', 'orderBy', 'order', 'limit', 'cursor'].includes(
    field
  )

const freezeCapabilities = (
  capabilities: Partial<JobStoreCapabilities> | undefined
): JobStoreCapabilities =>
  Object.freeze({
    notifications: capabilities?.notifications ?? false,
    queueFilteredNotifications: capabilities?.queueFilteredNotifications ?? false,
    batchClaim: capabilities?.batchClaim ?? false,
    transactionalEnqueue: capabilities?.transactionalEnqueue ?? false,
    changeFeed: capabilities?.changeFeed ?? false
  })

const activeSnapshot = (record: JobRecord): ActiveJobSnapshot => record as ActiveJobSnapshot

const compareRecordToCursor = (record: JobRecord, cursor: ListJobsRequest['cursor']): number => {
  if (cursor === undefined) return 1
  const direction = cursor.order === 'asc' ? 1 : -1
  const recordValue = primaryValue(record, cursor.orderBy)
  const primary =
    recordValue === null
      ? cursor.value === null
        ? 0
        : 1
      : cursor.value === null
        ? -1
        : recordValue < cursor.value
          ? -1
          : recordValue > cursor.value
            ? 1
            : 0
  if (primary !== 0) return primary * direction
  if (record.orderingSequence !== cursor.orderingSequence) {
    return (record.orderingSequence < cursor.orderingSequence ? -1 : 1) * direction
  }
  return (record.id === cursor.id ? 0 : record.id < cursor.id ? -1 : 1) * direction
}

class MemoryStore {
  readonly protocolVersion = 1 as const
  readonly capabilities: JobStoreCapabilities

  private readonly jobs = new Map<string, JobRecord>()
  private readonly attempts = new Map<string, AttemptRecord[]>()
  private readonly idempotency = new Map<string, string>()
  private readonly paused = new Set<string>()
  private readonly waiters = new Set<StoredWaiter>()
  private readonly wakeEvents: StoredWakeEvent[] = []
  private sequence = 0
  private wakeVersion = 0
  private enqueueManyCalls = 0

  constructor(
    private readonly fault: MemoryStoreFault | undefined,
    capabilities?: Partial<JobStoreCapabilities>,
    private readonly synchronization?: JobStoreContractSynchronization
  ) {
    this.capabilities = freezeCapabilities(capabilities)
  }

  enqueue(request: EnqueueRequest): Operation<JobStoreType.EnqueueResult> {
    const identity = identityFrom(request)
    const dedupeKey = this.dedupeKey(request, identity)
    const existingId = request.id === undefined ? this.idempotency.get(dedupeKey) : undefined
    const id =
      request.id ??
      (existingId === undefined ? this.generatedId(dedupeKey) : unwrap(makeJobId(existingId)))
    const existing = this.jobs.get(id)

    if (existing !== undefined) return ok({ job: existing, duplicate: true })

    const record = makeJobRecord({
      id,
      name: unwrap(makeJobName(identity.name)),
      version: identity.version,
      queue: unwrap(makeQueueName(identity.queue)),
      state: request.runAt <= request.now ? 'waiting' : 'delayed',
      payload: request.payload,
      metadata: request.metadata ?? {},
      priority: request.priority ?? 0,
      runAt: request.runAt,
      orderingSequence: this.sequence,
      attemptsMax: request.attemptsMax,
      attemptsMade: 0,
      deliveryCount: 0,
      stalledCount: 0,
      backoff: request.backoff,
      timeoutMs: request.timeoutMs,
      idempotencyKey: request.idempotencyKey,
      createdAt: request.now,
      updatedAt: request.now,
      processedAt: undefined,
      finishedAt: undefined,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      cancellationRequestedAt: undefined,
      result: undefined,
      failure: undefined
    })

    if (record.isErr()) return error(record.error)
    const value = record.value
    this.sequence += 1
    this.jobs.set(value.id, value)
    if (request.idempotencyKey !== undefined) this.idempotency.set(dedupeKey, value.id)
    this.notify(value.queue)
    return ok({ job: value, duplicate: false })
  }

  enqueueMany(requests: readonly EnqueueRequest[]): Operation<JobStoreType.EnqueueManyResult> {
    this.enqueueManyCalls += 1
    const results: JobStoreType.EnqueueResult[] = []

    for (const request of requests) {
      const result = this.enqueue(request)
      if (result.isErr()) return error(result.error)
      results.push(result.value)
      if (this.fault === 'drop-enqueue-many-suffix' && this.enqueueManyCalls === 2) break
    }

    return ok(Object.freeze(results))
  }

  claim(request: JobStoreType.ClaimRequest): Operation<JobStoreType.ClaimResult> {
    if (!Number.isSafeInteger(request.limit) || request.limit <= 0) {
      return error(jobStoreError('limit', 'must be a positive safe integer'))
    }
    if (!Number.isSafeInteger(request.leaseDurationMs) || request.leaseDurationMs <= 0) {
      return error(jobStoreError('leaseDurationMs', 'must be a positive safe integer'))
    }

    let candidates = [...this.jobs.values()].filter(
      (job) =>
        job.queue === request.queue &&
        !this.paused.has(queueText(job.queue)) &&
        (job.state === 'waiting' || (job.state === 'delayed' && job.runAt <= request.now)) &&
        request.accepted.some(
          (identity) =>
            identity.queue === job.queue &&
            identity.name === job.name &&
            identity.version === job.version
        )
    )
    candidates.sort(compareJobOrder)
    if (this.fault === 'wrong-ordering') candidates.reverse()

    if (this.fault === 'duplicate-claim' && candidates.length === 0) {
      candidates = [...this.jobs.values()].filter(
        (job) => job.queue === request.queue && job.state === 'active'
      )
    }

    const selected = candidates.slice(0, request.limit)
    const jobs: ActiveJobSnapshot[] = []

    for (const candidate of selected) {
      if (candidate.state === 'active') {
        jobs.push(activeSnapshot(candidate))
        continue
      }
      const lease = makeLeaseToken(`memory-lease-${candidate.id}-${candidate.deliveryCount + 1}`)
      if (lease.status === 'error') return error(lease.error)
      const transition = reduceJob(candidate, {
        type: 'claim',
        jobId: candidate.id,
        workerId: request.workerId,
        leaseToken: lease.value,
        leaseExpiresAt: request.now + request.leaseDurationMs,
        now: request.now
      })
      const updated = this.applyTransition(transition)
      if (updated.isErr()) return error(updated.error)
      jobs.push(activeSnapshot(updated.value.record))
    }

    const nextRunAt = [...this.jobs.values()]
      .filter(
        (job) =>
          job.queue === request.queue &&
          (job.state === 'waiting' || job.state === 'delayed') &&
          job.runAt > request.now
      )
      .reduce<number | undefined>(
        (earliest, job) => (earliest === undefined ? job.runAt : Math.min(earliest, job.runAt)),
        undefined
      )

    return ok({ jobs: Object.freeze(jobs), wakeToken: this.wakeToken(), nextRunAt })
  }

  settle(request: JobStoreType.SettleRequest): Operation<JobStoreType.SettlementResult> {
    const current = this.requireJob(request.jobId)
    if (current.status === 'error') return error(current.error)
    const leaseToken =
      this.fault === 'no-fencing'
        ? (current.value.leaseToken ?? request.leaseToken)
        : request.leaseToken
    const command = {
      type: 'settle' as const,
      jobId: request.jobId,
      leaseToken,
      outcome: request.outcome,
      now: request.now
    }
    const transition =
      request.startedAt === undefined
        ? reduceJob(current.value, command)
        : reduceJob(current.value, { ...command, startedAt: request.startedAt })
    const applied = this.applyTransition(transition)
    if (applied.isErr()) return error(applied.error)
    if (applied.value.attempt === undefined) {
      return error(jobStoreError('attempt', 'settlement did not return an attempt'))
    }
    return ok({ record: applied.value.record, attempt: applied.value.attempt })
  }

  release(request: JobStoreType.ReleaseRequest): Operation<JobStoreType.ReleaseResult> {
    const current = this.requireJob(request.jobId)
    if (current.status === 'error') return error(current.error)
    const transition = reduceJob(current.value, {
      type: 'release',
      jobId: request.jobId,
      leaseToken:
        this.fault === 'no-fencing'
          ? (current.value.leaseToken ?? request.leaseToken)
          : request.leaseToken,
      now: request.now
    })
    return this.applyTransition(transition)
  }

  heartbeat(request: JobStoreType.HeartbeatRequest): Operation<JobStoreType.HeartbeatResult> {
    if (!Number.isSafeInteger(request.leaseDurationMs) || request.leaseDurationMs <= 0) {
      return error(jobStoreError('leaseDurationMs', 'must be a positive safe integer'))
    }
    const renewed: ActiveJobSnapshot[] = []
    const lost: LostLease[] = []
    const cancellationRequested: JobId[] = []

    for (const lease of request.leases) {
      const current = this.jobs.get(lease.jobId)
      if (
        current === undefined ||
        current.state !== 'active' ||
        current.leaseToken !== lease.leaseToken ||
        current.leaseExpiresAt === undefined ||
        request.now >= current.leaseExpiresAt
      ) {
        lost.push({
          jobId: lease.jobId,
          leaseToken: lease.leaseToken,
          reason: this.leaseReason(current, lease.leaseToken, request.now)
        })
        continue
      }
      const updated = makeJobRecord({
        ...current,
        updatedAt: request.now,
        leaseExpiresAt: request.now + request.leaseDurationMs
      })
      if (updated.isErr()) return error(updated.error)
      this.jobs.set(lease.jobId, updated.value)
      renewed.push(activeSnapshot(updated.value))
      if (updated.value.cancellationRequestedAt !== undefined)
        cancellationRequested.push(lease.jobId)
    }

    if (renewed.length > 0) this.notify(undefined)
    return ok({
      renewed: Object.freeze(renewed),
      lost: Object.freeze(lost),
      cancellationRequested: Object.freeze(cancellationRequested)
    })
  }

  recoverStalled(
    request: JobStoreType.RecoverStalledRequest
  ): Operation<JobStoreType.RecoverStalledResult> {
    if (!Number.isSafeInteger(request.maxStalledCount) || request.maxStalledCount <= 0) {
      return error(jobStoreError('maxStalledCount', 'must be a positive safe integer'))
    }
    const transitions: JobTransition[] = []
    const limit = request.limit ?? Number.MAX_SAFE_INTEGER

    for (const current of this.jobs.values()) {
      if (transitions.length >= limit) break
      if (
        current.state !== 'active' ||
        current.leaseExpiresAt === undefined ||
        request.now < current.leaseExpiresAt
      )
        continue
      const transition = recoverStalledWithPolicy(
        current,
        {
          type: 'recover-stalled',
          jobId: current.id,
          now: request.now
        },
        current.stalledCount >= request.maxStalledCount
      )
      const applied = this.applyTransition(transition)
      if (applied.isErr()) return error(applied.error)
      transitions.push(applied.value)
    }

    return ok({ transitions: Object.freeze(transitions), recovered: transitions.length })
  }

  awaitWake(request: JobStoreType.AwaitWakeRequest): Operation<void> {
    if (request.signal.aborted) return error(new JobStoreWakeAbortedError())
    if (this.fault === 'lost-wake') return this.lostWake(request)

    const token = tokenNumber(request.wakeToken)
    if (this.hasRelevantEvent(token, request.queues)) {
      if (this.fault === 'delayed-wake-check') return this.delayedWakeCheck(request)
      this.synchronization?.ready()
      this.synchronization?.observed()
      return ok(undefined)
    }

    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.waiters.delete(waiter)
        resolve(error<void>(new JobStoreWakeAbortedError()))
      }
      const waiter: StoredWaiter = {
        queues: request.queues,
        token,
        resolve: () => {
          resolve(ok(undefined))
          this.synchronization?.observed()
        },
        signal: request.signal,
        onAbort
      }
      this.waiters.add(waiter)
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.synchronization?.ready()
    }) as unknown as Operation<void>
  }

  private delayedWakeCheck(request: JobStoreType.AwaitWakeRequest): Operation<void> {
    return new Promise((resolve) => {
      let settled = false
      const onAbort = (): void => {
        if (settled) return
        settled = true
        request.signal.removeEventListener('abort', onAbort)
        resolve(error<void>(new JobStoreWakeAbortedError()))
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.synchronization?.ready()
      const delivery = this.synchronization?.waitForDelivery() ?? Promise.resolve()
      void delivery.then(() => {
        if (settled) return
        settled = true
        request.signal.removeEventListener('abort', onAbort)
        resolve(ok(undefined))
        this.synchronization?.observed()
      })
    }) as unknown as Operation<void>
  }

  private lostWake(request: JobStoreType.AwaitWakeRequest): Operation<void> {
    return new Promise((resolve) => {
      let aborted = false
      const onAbort = (): void => {
        if (aborted) return
        aborted = true
        request.signal.removeEventListener('abort', onAbort)
        resolve(error<void>(new JobStoreWakeAbortedError()))
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.synchronization?.ready()
      const delivery = this.synchronization?.waitForDelivery() ?? Promise.resolve()
      void delivery.then(() => {
        if (!aborted) this.synchronization?.observed()
      })
    }) as unknown as Operation<void>
  }

  getJob(request: JobStoreType.GetJobRequest): Operation<JobRecord | undefined> {
    return ok(this.jobs.get(request.jobId))
  }

  getAttempts(request: JobStoreType.GetAttemptsRequest): Operation<readonly AttemptRecord[]> {
    return ok(Object.freeze([...(this.attempts.get(request.jobId) ?? [])]))
  }

  list(request: ListJobsRequest): Operation<JobStoreType.ListJobsResult> {
    if (!request || typeof request !== 'object')
      return error(jobStoreError('request', 'must be an object'))
    const unknown = Object.keys(request).find((field) => !isKnownListField(field))
    if (unknown !== undefined)
      return error(new UnsupportedJobStoreOperationError({ operation: `list.${unknown}` }))
    if (!Number.isSafeInteger(request.limit) || request.limit <= 0)
      return error(jobStoreError('limit', 'must be a positive safe integer'))

    const orderBy = request.orderBy ?? 'enqueuedAt'
    const order = request.order ?? 'asc'
    const states =
      request.state === undefined
        ? undefined
        : new Set(Array.isArray(request.state) ? request.state : [request.state])
    const stateSignature =
      states === undefined ? '*' : listStateOrder.filter((state) => states.has(state)).join(',')
    const metadataSignature =
      request.metadata === undefined
        ? null
        : Object.entries(request.metadata)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => [key, value])
    const filterKey = JSON.stringify([
      request.queue ?? null,
      request.name ?? null,
      request.version ?? null,
      stateSignature,
      metadataSignature,
      orderBy,
      order
    ])
    if (
      request.cursor !== undefined &&
      (request.cursor.version !== cursorVersion ||
        request.cursor.orderBy !== orderBy ||
        request.cursor.order !== order ||
        request.cursor.filterSignature !== filterKey)
    ) {
      return error(new UnsupportedJobStoreOperationError({ operation: 'list.cursor-options' }))
    }
    const filtered = [...this.jobs.values()]
      .filter(
        (job) =>
          (request.queue === undefined || job.queue === request.queue) &&
          (request.name === undefined || job.name === request.name) &&
          (request.version === undefined || job.version === request.version) &&
          (states === undefined || states.has(job.state)) &&
          (request.metadata === undefined ||
            (Object.keys(request.metadata).length === Object.keys(job.metadata).length &&
              Object.entries(request.metadata).every(
                ([key, value]) => job.metadata[key] === value
              )))
      )
      .sort((left, right) => compareListOrder(left, right, orderBy, order))
    const start =
      request.cursor === undefined
        ? 0
        : filtered.findIndex((job) => compareRecordToCursor(job, request.cursor) > 0)
    const offset = start < 0 ? filtered.length : start
    const jobs = filtered.slice(offset, offset + request.limit)
    const last = jobs[jobs.length - 1]
    const hasMore = offset + jobs.length < filtered.length
    const nextCursor =
      hasMore && last !== undefined
        ? {
            version: cursorVersion,
            orderBy,
            order,
            ordering: cursorOrderingFor(orderBy),
            direction: order,
            filterSignature: filterKey,
            value: primaryValue(last, orderBy),
            createdAt: last.createdAt,
            orderingSequence: last.orderingSequence,
            id: last.id
          }
        : undefined
    const outputCursor =
      this.fault === 'broken-pagination' && nextCursor !== undefined
        ? (request.cursor ?? nextCursor)
        : nextCursor
    return ok({ jobs: Object.freeze(jobs), nextCursor: outputCursor })
  }

  counts(request?: JobStoreType.CountsRequest): Operation<JobStoreType.JobCounts> {
    const selected = [...this.jobs.values()].filter(
      (job) =>
        (request?.queue === undefined || job.queue === request.queue) &&
        (request?.name === undefined || job.name === request.name)
    )
    const counts = {
      total: selected.length,
      waiting: selected.filter((job) => job.state === 'waiting').length,
      delayed: selected.filter((job) => job.state === 'delayed').length,
      active: selected.filter((job) => job.state === 'active').length,
      completed: selected.filter((job) => job.state === 'completed').length,
      failed: selected.filter((job) => job.state === 'failed').length,
      cancelled: selected.filter((job) => job.state === 'cancelled').length
    }
    if (this.fault === 'zero-count-channels') {
      return ok({
        ...counts,
        waiting: 0,
        delayed: 0,
        active: 0,
        completed: 0,
        failed: 0,
        cancelled: 0
      })
    }
    return ok(counts)
  }

  retry(request: JobStoreType.RetryRequest): Operation<JobStoreType.RetryResult> {
    return this.transition(request.jobId, {
      type: 'retry',
      jobId: request.jobId,
      runAt: request.runAt,
      now: request.now
    })
  }

  cancel(request: JobStoreType.CancelRequest): Operation<JobStoreType.CancelResult> {
    return this.transition(request.jobId, {
      type: 'cancel',
      jobId: request.jobId,
      now: request.now
    })
  }

  requestCancellation(
    request: JobStoreType.RequestCancellationRequest
  ): Operation<JobStoreType.RequestCancellationResult> {
    return this.transition(request.jobId, {
      type: 'request-cancellation',
      jobId: request.jobId,
      now: request.now
    })
  }

  promote(request: JobStoreType.PromoteRequest): Operation<JobStoreType.PromoteResult> {
    return this.transition(request.jobId, {
      type: 'promote',
      jobId: request.jobId,
      now: request.now
    })
  }

  remove(request: JobStoreType.RemoveRequest): Operation<JobStoreType.RemoveResult> {
    const current = this.requireJob(request.jobId)
    if (current.status === 'error') return error(current.error)
    if (request.expectedState !== undefined && request.expectedState !== current.value.state) {
      return error(
        new InvalidJobTransitionError({
          jobId: request.jobId,
          from: current.value.state,
          operation: 'remove'
        })
      )
    }
    if (current.value.state === 'active')
      return error(
        new InvalidJobTransitionError({ jobId: request.jobId, from: 'active', operation: 'remove' })
      )
    this.jobs.delete(request.jobId)
    this.attempts.delete(request.jobId)
    this.notify(current.value.queue)
    return ok({ job: current.value, removed: true })
  }

  pause(request: JobStoreType.PauseQueueRequest): Operation<QueuePauseResult> {
    this.paused.add(queueText(request.queue))
    this.notify(request.queue)
    return ok({ queue: request.queue, paused: true })
  }

  resume(request: JobStoreType.PauseQueueRequest): Operation<QueuePauseResult> {
    this.paused.delete(queueText(request.queue))
    this.notify(request.queue)
    return ok({ queue: request.queue, paused: false })
  }

  pausedQueues(): Operation<readonly import('../../src').QueueName[]> {
    return ok(Object.freeze([...this.paused].map((value) => unwrap(QueueName.make(value)))))
  }

  private transition<Value>(
    jobId: JobId,
    command: Parameters<typeof reduceJob>[1]
  ): Operation<Value> {
    const current = this.requireJob(jobId)
    if (current.status === 'error') return error(current.error)
    return this.applyTransition(reduceJob(current.value, command)) as unknown as Operation<Value>
  }

  private applyTransition(
    result: ResultType<JobTransition, JobStoreError>
  ): Operation<JobTransition> {
    return result.match({
      ok: (transition) => {
        this.jobs.set(transition.record.id, transition.record)
        if (transition.attempt !== undefined) {
          const history = this.attempts.get(transition.record.id) ?? []
          history.push(transition.attempt)
          this.attempts.set(transition.record.id, history)
        }
        this.notify(transition.record.queue)
        return ok(transition)
      },
      err: (cause) => error(cause)
    })
  }

  private requireJob(jobId: JobId): ResultType<JobRecord, JobStoreError> {
    const record = this.jobs.get(jobId)
    return record === undefined ? Result.err(new JobNotFoundError({ jobId })) : Result.ok(record)
  }

  private dedupeKey(request: EnqueueRequest, identity: JobIdentity): string {
    return `${identity.queue}|${identity.name}|${identity.version}|${request.idempotencyKey ?? ''}`
  }

  private generatedId(key: string): JobId {
    return unwrap(makeJobId(`memory-${this.sequence}-${key.replaceAll('|', '-')}`))
  }

  private leaseReason(
    current: JobRecord | undefined,
    token: import('../../src').LeaseToken,
    now: number
  ): LeaseLossReason {
    if (current === undefined) return 'missing-lease'
    if (current.leaseToken !== token) return 'mismatched-token'
    if (current.leaseExpiresAt === undefined || now >= current.leaseExpiresAt)
      return 'expired-lease'
    return 'missing-lease'
  }

  private wakeToken(): WakeToken {
    return `wake-${this.wakeVersion}` as WakeToken
  }

  private notify(queue: import('../../src').QueueName | undefined): void {
    this.wakeVersion += 1
    this.wakeEvents.push({ version: this.wakeVersion, queue })
    for (const waiter of this.waiters) {
      if (
        this.fault !== 'unfiltered-wake' &&
        queue !== undefined &&
        waiter.queues.length > 0 &&
        !waiter.queues.includes(queue)
      ) {
        this.synchronization?.observed()
        continue
      }
      this.waiters.delete(waiter)
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.resolve()
    }
  }

  private hasRelevantEvent(
    token: number,
    queues: readonly import('../../src').QueueName[]
  ): boolean {
    return this.wakeEvents.some(
      (event) =>
        event.version > token &&
        (event.queue === undefined ||
          queues.length === 0 ||
          queues.some((queue) => queueText(queue) === event.queue))
    )
  }
}

export const makeMemoryJobStore = (options: MemoryStoreOptions = {}): JobStoreType.Contract =>
  // SAFETY: this test fixture implements every JobStore operation; the focused error aliases are
  // restored by JobStore.of at the fixture boundary.
  JobStore.of(
    new MemoryStore(options.fault, options.capabilities, options.synchronization) as never
  )

/** Keep the real MemoryJobStore wake operation while exposing deterministic test handshakes. */
export const synchronizeMemoryJobStore = (
  store: JobStoreType.Contract,
  synchronization: JobStoreContractSynchronization
): JobStoreType.Contract => {
  const originalAwaitWake = store.awaitWake.bind(store)
  Object.defineProperty(store, 'awaitWake', {
    configurable: true,
    enumerable: false,
    value: (request: JobStoreType.AwaitWakeRequest) => {
      const waiting = originalAwaitWake(request)
      synchronization.ready()
      return Promise.resolve(waiting).then((result) => {
        synchronization.observed()
        return result
      })
    },
    writable: true
  })

  return store
}

export const makeMemoryRuntime = async <Name extends string | undefined>(
  store: ServiceContract<InstanceType<JobStoreToken<Name>>>,
  token: JobStoreToken<Name>
): Promise<JobStoreContractRuntime<InstanceType<JobStoreToken<Name>>>> => {
  const layer = Layer.succeed(token, store)
  const runtime = await Runtime.make(layer)
  return {
    run: (program, options) => runtime.run(program, options),
    dispose: () => runtime.dispose()
  }
}

export const makeMemoryMultiRuntime = async (
  context: JobStoreContractMultiStoreContext,
  fault?: MemoryStoreFault
): Promise<JobStoreContractMultiStoreRuntime> => {
  const makeStore = (): JobStoreType.Contract =>
    makeMemoryJobStore({ synchronization: context.synchronization })
  const defaultStore = makeStore()
  const firstStore = fault === 'cross-store' ? defaultStore : makeStore()
  const secondStore = fault === 'cross-store' ? defaultStore : makeStore()
  const layer = Layer.merge(
    Layer.merge(
      Layer.succeed(context.tokens.default, defaultStore),
      Layer.succeed(context.tokens.first, firstStore)
    ),
    Layer.succeed(context.tokens.second, secondStore)
  )
  const runtime = await Runtime.make(layer)

  return {
    run: (program, options) => runtime.run(program, options),
    dispose: () => runtime.dispose()
  }
}
