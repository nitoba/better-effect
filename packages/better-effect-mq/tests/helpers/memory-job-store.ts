// oxlint-disable anti-slop/no-runtime-typeof -- this test-only adapter validates deliberately untyped request defects.
// oxlint-disable anti-slop/no-unknown-parameters -- fault fixtures intentionally cross public boundaries.
// oxlint-disable anti-slop/no-chained-type-assertions -- the adapter restores focused operation types at one fixture boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- all assertions are test fixture erasure boundaries.

import { Layer, Runtime } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

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
  type AnyJobStoreToken,
  type AttemptRecord,
  type EnqueueRequest,
  type JobId,
  type JobIdentity,
  type JobRecord,
  type JobStore as JobStoreType,
  type JobStoreError,
  type JobTransition,
  type JobStoreCapabilities,
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
  | 'duplicate-claim'
  | 'broken-pagination'

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

const cursorKey = (cursor: ListJobsRequest['cursor']): string =>
  cursor === undefined ? '' : `${cursor.createdAt}:${cursor.orderingSequence}:${cursor.id}`

const identityFrom = (request: EnqueueRequest): JobIdentity => request.job ?? request.identity!

const compareListOrder = (left: JobRecord, right: JobRecord): number => {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  if (left.orderingSequence !== right.orderingSequence) {
    return left.orderingSequence - right.orderingSequence
  }
  const leftBytes = new TextEncoder().encode(left.id)
  const rightBytes = new TextEncoder().encode(right.id)
  const length = Math.min(leftBytes.length, rightBytes.length)

  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0)
    }
  }

  return leftBytes.length - rightBytes.length
}

const isKnownListField = (field: string): boolean =>
  ['queue', 'name', 'state', 'limit', 'cursor'].includes(field)

const freezeCapabilities = (
  capabilities: Partial<JobStoreCapabilities> | undefined
): JobStoreCapabilities =>
  Object.freeze({
    notifications: capabilities?.notifications ?? false,
    batchClaim: capabilities?.batchClaim ?? false,
    transactionalEnqueue: capabilities?.transactionalEnqueue ?? false,
    changeFeed: capabilities?.changeFeed ?? false
  })

const activeSnapshot = (record: JobRecord): ActiveJobSnapshot => record as ActiveJobSnapshot

const compareRecordToCursor = (record: JobRecord, cursor: ListJobsRequest['cursor']): number => {
  if (cursor === undefined) return 1
  if (record.createdAt !== cursor.createdAt) return record.createdAt - cursor.createdAt
  if (record.orderingSequence !== cursor.orderingSequence) {
    return record.orderingSequence - cursor.orderingSequence
  }
  return record.id === cursor.id ? 0 : record.id < cursor.id ? -1 : 1
}

class MemoryStore {
  readonly protocolVersion = 1 as const
  readonly capabilities: JobStoreCapabilities

  private readonly jobs = new Map<string, JobRecord>()
  private readonly attempts = new Map<string, AttemptRecord[]>()
  private readonly idempotency = new Map<string, string>()
  private readonly cursorScopes = new Map<string, string>()
  private readonly paused = new Set<string>()
  private readonly waiters = new Set<StoredWaiter>()
  private readonly wakeEvents: StoredWakeEvent[] = []
  private sequence = 0
  private wakeVersion = 0

  constructor(
    private readonly fault: MemoryStoreFault | undefined,
    capabilities?: Partial<JobStoreCapabilities>
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
    const results: JobStoreType.EnqueueResult[] = []

    for (const request of requests) {
      const result = this.enqueue(request)
      if (result.isErr()) return error(result.error)
      results.push(result.value)
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
      const input =
        current.stalledCount >= request.maxStalledCount
          ? { ...current, stalledCount: Number.MAX_SAFE_INTEGER }
          : current
      const checked = input === current ? Result.ok(current) : makeJobRecord(input)
      const transition = checked.match({
        ok: (value) =>
          reduceJob(value, { type: 'recover-stalled', jobId: current.id, now: request.now }),
        err: (cause) => Result.err(cause)
      })
      const applied = this.applyTransition(transition)
      if (applied.isErr()) return error(applied.error)
      transitions.push(applied.value)
    }

    return ok({ transitions: Object.freeze(transitions), recovered: transitions.length })
  }

  awaitWake(request: JobStoreType.AwaitWakeRequest): Operation<void> {
    if (request.signal.aborted) return error(new JobStoreWakeAbortedError())
    if (this.fault === 'lost-wake') return new Promise(() => {}) as unknown as Operation<void>
    const token = tokenNumber(request.wakeToken)
    if (this.hasRelevantEvent(token, request.queues)) return ok(undefined)

    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.waiters.delete(waiter)
        resolve(error<void>(new JobStoreWakeAbortedError()))
      }
      const waiter: StoredWaiter = {
        queues: request.queues,
        token,
        resolve: () => resolve(ok(undefined)),
        signal: request.signal,
        onAbort
      }
      this.waiters.add(waiter)
      request.signal.addEventListener('abort', onAbort, { once: true })
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

    const filterKey = `${request.queue ?? ''}|${request.name ?? ''}|${JSON.stringify(request.state ?? '')}`
    const key = cursorKey(request.cursor)
    const previousFilter = key === '' ? undefined : this.cursorScopes.get(key)
    if (previousFilter !== undefined && previousFilter !== filterKey) {
      return error(new UnsupportedJobStoreOperationError({ operation: 'list.cursor-options' }))
    }
    if (key !== '') this.cursorScopes.set(key, filterKey)

    const states =
      request.state === undefined
        ? undefined
        : new Set(Array.isArray(request.state) ? request.state : [request.state])
    const filtered = [...this.jobs.values()]
      .filter(
        (job) =>
          (request.queue === undefined || job.queue === request.queue) &&
          (request.name === undefined || job.name === request.name) &&
          (states === undefined || states.has(job.state))
      )
      .sort(compareListOrder)
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
        ? { createdAt: last.createdAt, orderingSequence: last.orderingSequence, id: last.id }
        : undefined
    const outputCursor =
      this.fault === 'broken-pagination' && nextCursor !== undefined
        ? (request.cursor ?? nextCursor)
        : nextCursor
    if (outputCursor !== undefined) this.cursorScopes.set(cursorKey(outputCursor), filterKey)
    return ok({ jobs: Object.freeze(jobs), nextCursor: outputCursor })
  }

  counts(request?: JobStoreType.CountsRequest): Operation<JobStoreType.JobCounts> {
    const selected = [...this.jobs.values()].filter(
      (job) =>
        (request?.queue === undefined || job.queue === request.queue) &&
        (request?.name === undefined || job.name === request.name)
    )
    return ok({
      total: selected.length,
      waiting: selected.filter((job) => job.state === 'waiting').length,
      delayed: selected.filter((job) => job.state === 'delayed').length,
      active: selected.filter((job) => job.state === 'active').length,
      completed: selected.filter((job) => job.state === 'completed').length,
      failed: selected.filter((job) => job.state === 'failed').length,
      cancelled: selected.filter((job) => job.state === 'cancelled').length
    })
  }

  redrive(request: JobStoreType.RedriveRequest): Operation<JobStoreType.RedriveResult> {
    return this.transition(request.jobId, {
      type: 'redrive',
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
      if (queue !== undefined && waiter.queues.length > 0 && !waiter.queues.includes(queue))
        continue
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
  JobStore.of(new MemoryStore(options.fault, options.capabilities) as never)

export const makeMemoryRuntime = async (
  store: JobStoreType.Contract,
  token: AnyJobStoreToken = JobStore
): Promise<{
  run: JobStoreContractRuntime['run']
  dispose: JobStoreContractRuntime['dispose']
}> => {
  // SAFETY: this test fixture deliberately erases the named-token union at the Layer boundary.
  const layer = Layer.succeed(token as never, token.of(store) as never)
  const runtime = await Runtime.make(layer as never)
  return {
    run: (program) => runtime.run(program as never),
    dispose: () => runtime.dispose()
  }
}

export type JobStoreContractRuntime = {
  run<A>(program: () => A | PromiseLike<A>): PromiseLike<Awaited<A>>
  dispose(): PromiseLike<void>
}
