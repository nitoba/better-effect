// oxlint-disable anti-slop/no-runtime-typeof -- Worker validates handler, clock, and store results at JavaScript boundaries.
// oxlint-disable anti-slop/no-known-value-widening -- hostile callback results are normalized explicitly.
// oxlint-disable anti-slop/no-unknown-parameters -- store and handler adapters are intentionally untyped at this erased boundary.
// oxlint-disable anti-slop/no-unknown-returns -- Result and codec values are normalized immediately after crossing a boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- heterogeneous handlers and store operations are erased in one module.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below are localized to checked runtime boundaries.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- event snapshots omit optional fields.

import { Runtime, ServiceRuntime } from 'better-effect'
import { Result, UnhandledException, type Result as ResultType } from 'better-result'

import {
  isUnrecoverableFailure,
  runRetryable,
  type AnyJobDefinition,
  type CodecLike,
  type JobFailure
} from '../job'
import { Retry } from '../retry'
import { parseJsonValue } from '../internal/json'
import {
  JobDefinitionError,
  JobStoreFailure,
  LeaseLostError,
  makeSerializedJobFailure,
  makeWorkerId,
  makeQueueName
} from '../protocol'
import type { JobRecord, JsonValue, SerializedJobFailure, SettlementOutcome } from '../protocol'
import { JobStore, JobStoreWakeAbortedError } from '../store'
import type {
  ActiveJobSnapshot,
  AnyJobStoreToken,
  ClaimResult,
  HeartbeatResult,
  RecoverStalledResult,
  JobStoreContract,
  JobStoreOperation,
  SettlementResult
} from '../store'

import { JobContext } from './context'
import { JobTimeoutError, WorkerAwaitIdleError, WorkerRuntimeOwnershipError } from './errors'
import type {
  AnyWorkerHandler,
  WorkerAwaitIdleOptions,
  WorkerErrorHandler,
  JobFailureEvent,
  JobFailureHandler,
  WorkerHandle,
  WorkerOptions,
  WorkerRandom,
  WorkerStopOptions
} from './types'

type AnyRuntime = Runtime<any>
type UnknownResult = ResultType<unknown, unknown>
type StoreOperation<Value> = JobStoreOperation<Value, JobStore.Error>

type HandlerEntry = {
  readonly handler: AnyWorkerHandler
  readonly definition: AnyJobDefinition
  readonly identityKey: string
  readonly queue: JobRecord['queue']
  readonly store: AnyJobStoreToken
  readonly concurrency: number
}

type ClaimGroup = {
  readonly key: string
  readonly queue: JobRecord['queue']
  readonly store: AnyJobStoreToken
  readonly handlers: readonly HandlerEntry[]
  observedEmpty: boolean
}

type ClaimPlan = {
  readonly group: ClaimGroup
  readonly handlers: readonly HandlerEntry[]
  readonly limit: number
}

type ClaimLease = {
  readonly generation: number
  readonly plan: ClaimPlan
  readonly store: JobStoreContract
  lifecycle: 'pending' | 'abandoned' | 'adopted' | 'compensation-scheduled'
}

type AttemptState = {
  readonly key: string
  readonly entry: HandlerEntry
  readonly job: ActiveJobSnapshot
  readonly controller: AbortController
  readonly startedAt: number
  promise: Promise<void>
  state: 'running' | 'cancelling' | 'settling' | 'lost'
  timeoutTimer?: ReturnType<typeof setTimeout>
  timedOut?: boolean
  failureCause?: unknown
  failureNotified?: boolean
}

type CodecOutcome =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly cause: unknown }

type Waiter = {
  readonly resolve: () => void
  readonly reject: (cause: unknown) => void
  readonly signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  settled: boolean
}

class DecodeOutcome {
  constructor(readonly cause: unknown) {}
}

class StoreOperationTimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`Job store operation timed out: ${operation}`)
    this.name = 'StoreOperationTimeoutError'
  }
}

const defaultConcurrency = 1
const defaultLeaseDurationMs = 30_000
const defaultPollIntervalMs = 100
const defaultMaxStalledCount = 1
const minimumTimerMs = 1
const minimumLeaseDurationMs = 10
const minimumStalledIntervalMs = 10
const maximumStoreRetries = 3

export class WorkerSupervisor implements WorkerHandle {
  private readonly workerId: NormalizedWorkerOptions['id']

  private currentState: WorkerHandle['state'] = 'running'
  private stopPromise: Promise<void> | undefined
  private active = 0
  private reserved = 0
  private readonly reservedByQueue = new Map<string, number>()
  private readonly activeByHandler = new Map<string, number>()
  private readonly activeAttempts = new Map<string, AttemptState>()
  private readonly shutdownAborts = new Set<string>()
  private readonly groupTasks = new Set<Promise<void>>()
  private readonly slotWaiters = new Set<() => void>()
  private readonly idleWaiters = new Set<Waiter>()
  private readonly claimController = new AbortController()
  // Only cancels retry backoff. The first release/settle call must still be attempted
  // after a handler finishes, even when shutdown has begun.
  private readonly shutdownController = new AbortController()
  private readonly groups: readonly ClaimGroup[]
  private readonly runtime: AnyRuntime
  private readonly workerOptions: NormalizedWorkerOptions
  private readonly supervisionTasks = new Set<Promise<void>>()
  private readonly supervisionController = new AbortController()
  private readonly claimLeases = new Set<ClaimLease>()
  private readonly claimCleanupTasks = new Set<Promise<void>>()
  private nextClaimGeneration = 0

  constructor(
    runtime: AnyRuntime,
    handlers: readonly AnyWorkerHandler[],
    options: NormalizedWorkerOptions
  ) {
    this.runtime = runtime
    this.workerOptions = options
    this.workerId = options.id
    this.groups = makeGroups(handlers, options)
  }

  start(): void {
    for (const group of this.groups) {
      const task = this.runGroup(group)
      this.groupTasks.add(task)
      void task.then(
        () => this.groupTasks.delete(task),
        (cause) => {
          this.report(cause)
          this.groupTasks.delete(task)
        }
      )
    }

    const stores = new Map<string, AnyJobStoreToken>()
    for (const group of this.groups) stores.set(group.store.serviceTag, group.store)
    for (const store of stores.values()) {
      this.startSupervisionLoop(store, 'heartbeat')
      this.startSupervisionLoop(store, 'stalled')
    }
  }

  get id(): NormalizedWorkerOptions['id'] {
    return this.workerId
  }

  get state(): WorkerHandle['state'] {
    return this.currentState
  }

  get activeCount(): number {
    return this.active
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop()
  }

  stop(options: WorkerStopOptions = {}): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise
    }

    const normalizedOptions = normalizeStopOptions(options)
    this.currentState = 'stopping'
    // A store cannot be required to observe our AbortSignal. Fence every claim
    // before waking its caller; a later successful result is compensated below.
    for (const lease of this.claimLeases) {
      if (lease.lifecycle === 'pending') lease.lifecycle = 'abandoned'
    }
    // Stop claiming immediately, but keep lease supervision alive while local
    // handlers and their cleanup are still able to settle.
    this.claimController.abort()
    this.shutdownController.abort(new Error('Worker is stopping'))

    if (normalizedOptions.abortActive === true) this.abortActiveAttempts()

    this.stopPromise = this.finishStop(normalizedOptions)
    return this.stopPromise
  }

  awaitIdle(options: WorkerAwaitIdleOptions = {}): Promise<void> {
    const normalizedOptions = normalizeAwaitIdleOptions(options)

    if (this.isIdle()) {
      return Promise.resolve()
    }

    if (normalizedOptions.signal !== undefined && readSignalAborted(normalizedOptions.signal)) {
      return Promise.reject(makeAwaitIdleAbortedError(normalizedOptions.signal))
    }

    return new Promise<void>((resolve, reject) => {
      let waiter: Waiter
      waiter = makeWaiter(resolve, reject, normalizedOptions, () => {
        this.idleWaiters.delete(waiter)
      })
      this.idleWaiters.add(waiter)
      installWaiter(waiter, normalizedOptions)

      if (!waiter.settled) {
        this.notifyIdle()
      }
    })
  }

  private async finishStop(options: NormalizedStopOptions): Promise<void> {
    await Promise.allSettled(this.groupTasks)
    const attempts = Promise.allSettled(
      [...this.activeAttempts.values()].map((attempt) => attempt.promise)
    )
    const grace = this.workerOptions.shutdown.gracePeriodMs
    if (grace > 0 && this.activeAttempts.size > 0) {
      await Promise.race([attempts, this.sleep(grace, new AbortController().signal)])
    }
    if (
      this.activeAttempts.size > 0 &&
      (options.abortActive || this.workerOptions.shutdown.abortAfterGracePeriod)
    ) {
      this.abortActiveAttempts()
    }
    await attempts
    this.supervisionController.abort()
    await Promise.allSettled(this.supervisionTasks)
    await Promise.allSettled(this.claimCleanupTasks)
    this.currentState = 'stopped'
    this.notifySlots()
    this.notifyIdle()
  }

  private abortActiveAttempts(): void {
    for (const attempt of this.activeAttempts.values()) {
      if (attempt.state === 'running') attempt.state = 'cancelling'
      this.shutdownAborts.add(attempt.key)
      attempt.controller.abort(new Error('Worker is stopping'))
    }
  }

  private async runGroup(group: ClaimGroup): Promise<void> {
    while (this.currentState === 'running') {
      try {
        await this.runGroupIteration(group)
      } catch (cause) {
        this.report(cause)
        await this.sleep(this.workerOptions.pollIntervalMs, this.claimController.signal)
      }
    }
  }

  private async runGroupIteration(group: ClaimGroup): Promise<void> {
    const plan = this.planClaim(group)

    if (plan === undefined) {
      await this.waitForSlot()
      return
    }

    let result: ResultType<ClaimResult, unknown>

    try {
      result = await this.claim(plan)
    } catch (cause) {
      this.releaseClaim(plan)
      throw cause
    }

    if (Result.isError(result)) {
      plan.group.observedEmpty = false
      this.releaseClaim(plan)
      this.notifyIdle()
      this.report(result.error)
      await this.sleep(this.workerOptions.pollIntervalMs, this.claimController.signal)
      return
    }

    if (result.value.jobs.length === 0) {
      group.observedEmpty = true
      this.releaseClaim(plan)
      this.notifyIdle()
      await this.waitForWork(group, result.value)
      return
    }

    group.observedEmpty = false

    try {
      await this.dispatchJobs(group, result.value.jobs)
    } finally {
      this.releaseClaim(plan)
    }
  }

  private planClaim(group: ClaimGroup): ClaimPlan | undefined {
    if (this.currentState !== 'running') {
      return undefined
    }

    const globalAvailable = this.workerOptions.concurrency - this.active - this.reserved
    const queueReserved = this.reservedByQueue.get(group.key) ?? 0
    const queueAvailable =
      this.workerOptions.queueLimit(group.queue) - queueReserved - this.activeInQueue(group)
    const handlers = group.handlers.filter((entry) => this.availableForHandler(entry) > 0)
    const available = Math.min(globalAvailable, queueAvailable)

    if (available <= 0 || handlers.length === 0) {
      return undefined
    }

    const handlerCapacity = handlers.reduce(
      (total, entry) => total + this.availableForHandler(entry),
      0
    )
    const limit = Math.min(available, handlerCapacity)
    const plan = { group, handlers, limit }
    group.observedEmpty = false
    this.reserveClaim(plan)
    return plan
  }

  private availableForHandler(entry: HandlerEntry): number {
    return entry.concurrency - (this.activeByHandler.get(entry.identityKey) ?? 0)
  }

  private activeInQueue(group: ClaimGroup): number {
    let count = 0

    for (const attempt of this.activeAttempts.values()) {
      if (
        attempt.entry.queue === group.queue &&
        attempt.entry.store.serviceTag === group.store.serviceTag
      ) {
        count += 1
      }
    }

    return count
  }

  private reserveClaim(plan: ClaimPlan): void {
    this.reserved += plan.limit
    const queueReserved = this.reservedByQueue.get(plan.group.key) ?? 0
    this.reservedByQueue.set(plan.group.key, queueReserved + plan.limit)
  }

  private releaseClaim(plan: ClaimPlan): void {
    this.reserved -= plan.limit
    const queueReserved = this.reservedByQueue.get(plan.group.key) ?? 0

    if (queueReserved <= plan.limit) {
      this.reservedByQueue.delete(plan.group.key)
    } else {
      this.reservedByQueue.set(plan.group.key, queueReserved - plan.limit)
    }

    this.notifySlots()
  }

  private readNow(): number {
    try {
      return this.workerOptions.now()
    } catch (cause) {
      this.report(cause)
      return Math.max(0, Date.now())
    }
  }

  private async claim(plan: ClaimPlan): Promise<ResultType<ClaimResult, unknown>> {
    const request = {
      queue: plan.group.queue,
      accepted: plan.handlers.map((entry) => entry.definition.identity),
      limit: plan.limit,
      workerId: this.id,
      leaseDurationMs: this.workerOptions.leaseDurationMs,
      now: this.readNow()
    }

    let retries = 0
    while (true) {
      const result = await this.claimOnce(plan, request)
      if (
        !Result.isError(result) ||
        !JobStoreFailure.is(result.error) ||
        !result.error.retryable ||
        retries >= maximumStoreRetries ||
        this.claimController.signal.aborted
      ) {
        return result
      }
      retries += 1
      await cancellableDelay(
        Math.min(100, this.workerOptions.pollIntervalMs * 2 ** (retries - 1)),
        this.claimController.signal
      )
      if (this.claimController.signal.aborted) return result
    }
  }

  private async claimOnce(
    plan: ClaimPlan,
    request: Omit<import('../store').ClaimRequest, 'now'> & { readonly now: number }
  ): Promise<ResultType<ClaimResult, unknown>> {
    let store: JobStoreContract
    try {
      // Keep the Runtime boundary limited to token resolution. The exact client
      // is retained by the lease so compensation cannot resolve a disposed or
      // otherwise different provider.
      store = await this.runtime.run(() => ServiceRuntime.resolve(plan.group.store))
    } catch (cause) {
      return Result.err(new WorkerRuntimeOwnershipError(cause)) as ResultType<ClaimResult, unknown>
    }
    if (this.currentState !== 'running' || this.claimController.signal.aborted) {
      return Result.err(new StoreOperationTimeoutError('claim')) as ResultType<ClaimResult, unknown>
    }

    const lease: ClaimLease = {
      generation: ++this.nextClaimGeneration,
      plan,
      store,
      lifecycle: 'pending'
    }
    this.claimLeases.add(lease)
    const pending = Promise.resolve().then(() => store.claim(request)) as Promise<
      ResultType<ClaimResult, unknown>
    >
    void pending.then(
      (result) => {
        if (Result.isOk(result)) this.scheduleClaimCompensation(lease, result.value.jobs)
        else this.claimLeases.delete(lease)
      },
      () => {
        this.claimLeases.delete(lease)
      }
    )

    const result = await raceStoreOperation(
      pending,
      plan.group.store.serviceTag,
      this.workerOptions.storeOperationTimeoutMs,
      this.claimController.signal
    )
    if (Result.isError(result)) {
      // This write happens before returning to the group loop, establishing the
      // generation fence even when the adapter ignores cancellation.
      if (lease.lifecycle === 'pending') lease.lifecycle = 'abandoned'
      return result
    }
    if (lease.lifecycle === 'abandoned') {
      this.scheduleClaimCompensation(lease, result.value.jobs)
      return Result.err(new StoreOperationTimeoutError('claim')) as ResultType<ClaimResult, unknown>
    }
    if (lease.lifecycle !== 'pending') {
      return Result.err(new StoreOperationTimeoutError('claim')) as ResultType<ClaimResult, unknown>
    }
    lease.lifecycle = 'adopted'
    this.claimLeases.delete(lease)
    return result
  }

  private scheduleClaimCompensation(lease: ClaimLease, jobs: readonly ActiveJobSnapshot[]): void {
    if (lease.lifecycle !== 'abandoned') return
    lease.lifecycle = 'compensation-scheduled'
    this.claimLeases.delete(lease)
    if (jobs.length === 0) return

    const task = Promise.allSettled(jobs.map((job) => this.releaseClaimSnapshot(lease, job))).then(
      () => undefined
    )
    this.claimCleanupTasks.add(task)
    void task.then(
      () => this.claimCleanupTasks.delete(task),
      () => this.claimCleanupTasks.delete(task)
    )
  }

  private async releaseClaimSnapshot(lease: ClaimLease, job: ActiveJobSnapshot): Promise<void> {
    const result = await runStoreOperation<import('../store').ReleaseResult>(
      this.runtime,
      lease.plan.group.store,
      (store) => store.release({ jobId: job.id, leaseToken: job.leaseToken, now: this.readNow() }),
      undefined,
      this.workerOptions.pollIntervalMs,
      this.workerOptions.storeOperationTimeoutMs,
      this.shutdownController.signal,
      lease.store
    )
    // Late compensation is deliberately best effort. Its rejection is contained
    // and the lease remains fenced for adapters that cannot release immediately.
    if (Result.isError(result)) this.report(result.error)
  }

  private async dispatchJobs(group: ClaimGroup, jobs: readonly ActiveJobSnapshot[]): Promise<void> {
    for (const job of jobs) {
      if (this.currentState !== 'running') {
        await this.releaseJob(group, job)
        continue
      }

      const entry = findHandler(group, job)

      if (entry === undefined || !this.canStart(entry, group)) {
        await this.releaseJob(group, job)
        continue
      }

      this.startAttempt(group, entry, job)
    }

    this.notifyIdle()
  }

  private canStart(entry: HandlerEntry, group: ClaimGroup): boolean {
    return (
      this.active < this.workerOptions.concurrency &&
      this.activeInQueue(group) < this.workerOptions.queueLimit(group.queue) &&
      this.availableForHandler(entry) > 0
    )
  }

  private startAttempt(group: ClaimGroup, entry: HandlerEntry, job: ActiveJobSnapshot): void {
    const key = JSON.stringify([group.key, job.id])

    if (this.activeAttempts.has(key)) {
      void this.releaseJob(group, job).catch((cause) => this.report(cause))
      return
    }

    const controller = new AbortController()
    let context: JobContext

    try {
      context = makeContext(this.id, job)
    } catch (cause) {
      this.report(cause)
      void this.releaseJob(group, job).catch((releaseCause) => this.report(releaseCause))
      return
    }

    const attempt: AttemptState = {
      key,
      entry,
      job,
      controller,
      startedAt: this.readNow(),
      promise: Promise.resolve(),
      state: 'running'
    }

    this.active += 1
    increment(this.activeByHandler, entry.identityKey)
    this.activeAttempts.set(key, attempt)
    if (job.timeoutMs !== undefined) {
      attempt.timeoutTimer = setTimeout(() => {
        attempt.timedOut = true
        attempt.controller.abort(new JobTimeoutError(String(job.id)))
      }, job.timeoutMs)
    }

    const promise = this.executeAttempt(group, attempt, context)
      .catch((cause) => {
        this.report(cause)
      })
      .finally(() => this.finishAttempt(attempt))

    attempt.promise = promise
    void promise
  }

  private async executeAttempt(
    group: ClaimGroup,
    attempt: AttemptState,
    context: JobContext
  ): Promise<void> {
    const startedAt = attempt.startedAt
    let outcome: SettlementOutcome

    try {
      const result = await this.executeProgram(attempt, context)
      if (attempt.state === 'lost') return
      if (this.shutdownAborts.has(attempt.key)) {
        await this.releaseJob(group, attempt.job)
        return
      }
      if (attempt.timedOut) attempt.failureCause = new JobTimeoutError(String(attempt.job.id))
      outcome = attempt.timedOut
        ? timeoutOutcome(
            attempt.failureCause,
            this.readNow(),
            attempt.job,
            attempt.entry.definition.retryPolicy?.type !== 'never',
            this.workerOptions.random
          )
        : await this.makeOutcome(attempt, result)
      // Timeout is authoritative even when outcome encoding or policy work
      // completed after the cooperative abort was requested.
      if (attempt.timedOut) {
        outcome = timeoutOutcome(
          attempt.failureCause ?? new JobTimeoutError(String(attempt.job.id)),
          this.readNow(),
          attempt.job,
          attempt.entry.definition.retryPolicy?.type !== 'never',
          this.workerOptions.random
        )
      }
    } catch (cause) {
      if (attempt.state === 'lost') return
      if (this.shutdownAborts.has(attempt.key)) {
        await this.releaseJob(group, attempt.job)
        return
      }
      this.report(cause)
      attempt.failureCause = cause
      outcome =
        attempt.state === 'cancelling'
          ? { type: 'cancelled' }
          : attempt.timedOut
            ? timeoutOutcome(
                cause,
                this.readNow(),
                attempt.job,
                attempt.entry.definition.retryPolicy?.type !== 'never',
                this.workerOptions.random
              )
            : defectOutcome(
                safeCauseMessage(cause),
                this.readNow(),
                this.workerOptions.retryDefects &&
                  attempt.entry.definition.retryPolicy?.type !== 'never',
                attempt.job,
                this.workerOptions.random
              )
    }

    // Encoding a result/failure is an async boundary. Cancellation may have been
    // observed while it was pending, so it must win before settlement begins.
    if (this.isLost(attempt)) return
    if (this.shutdownAborts.has(attempt.key)) {
      await this.releaseJob(group, attempt.job)
      return
    }
    if (attempt.state === 'cancelling') outcome = { type: 'cancelled' }
    if (attempt.timedOut) {
      outcome = timeoutOutcome(
        attempt.failureCause ?? new JobTimeoutError(String(attempt.job.id)),
        this.readNow(),
        attempt.job,
        attempt.entry.definition.retryPolicy?.type !== 'never',
        this.workerOptions.random
      )
    }
    await this.settleJob(group, attempt.job, outcome, startedAt)
  }

  private async executeProgram(attempt: AttemptState, context: JobContext): Promise<unknown> {
    const attributes = {
      workerId: this.id,
      jobId: attempt.job.id,
      queue: attempt.job.queue,
      name: attempt.job.name,
      version: attempt.job.version,
      attempt: attempt.job.attemptsMade + 1,
      delivery: attempt.job.deliveryCount
    }

    return this.runtime.runWith(
      JobContext.layer(context),
      async () => {
        const decoded = await decodePayload(attempt.entry.definition.payload, attempt.job.payload)

        if (!decoded.ok) {
          return Result.err(new DecodeOutcome(decoded.cause))
        }

        const program = attempt.entry.handler.handler(decoded.value as never)
        return program()
      },
      { signal: attempt.controller.signal, attributes }
    )
  }

  private async makeOutcome(attempt: AttemptState, result: unknown): Promise<SettlementOutcome> {
    const definition = attempt.entry.definition
    const recordedAt = this.readNow()

    if (!isResultLike(result)) {
      return failOutcome('Handler did not return a Result', recordedAt)
    }

    if (Result.isError(result)) {
      if (result.error instanceof DecodeOutcome) {
        attempt.failureCause = result.error.cause
        return decodeOutcome(result.error.cause, recordedAt)
      }

      attempt.failureCause = result.error
      return typedFailureOutcome(
        definition,
        result.error,
        recordedAt,
        attempt.job,
        this.workerOptions.random
      )
    }

    return completeOutcome(definition, result.value, recordedAt)
  }

  private async settleJob(
    group: ClaimGroup,
    job: ActiveJobSnapshot,
    outcome: SettlementOutcome,
    startedAt: number
  ): Promise<void> {
    const attempt = this.activeAttempts.get(JSON.stringify([group.key, job.id]))
    if (attempt?.state === 'lost') return
    if (attempt !== undefined) attempt.state = 'settling'
    let submittedOutcome = outcome
    const result = await runStoreOperation<SettlementResult>(
      this.runtime,
      group.store,
      (store) => {
        // runStoreOperation invokes this callback asynchronously. Re-check at that
        // gate so a deadline that wins before adapter invocation cannot submit Complete.
        if (attempt?.timedOut) {
          submittedOutcome = timeoutOutcome(
            attempt.failureCause ?? new JobTimeoutError(String(job.id)),
            this.readNow(),
            job,
            attempt.entry.definition.retryPolicy?.type !== 'never',
            this.workerOptions.random
          )
        }
        const settlementNow =
          submittedOutcome.type === 'retry' && submittedOutcome.retryDelayMs !== undefined
            ? submittedOutcome.runAt - submittedOutcome.retryDelayMs
            : this.readNow()
        return store.settle({
          jobId: job.id,
          leaseToken: job.leaseToken,
          outcome: submittedOutcome,
          now: settlementNow,
          startedAt
        })
      },
      undefined,
      this.workerOptions.pollIntervalMs,
      this.workerOptions.storeOperationTimeoutMs,
      this.shutdownController.signal
    )

    if (Result.isError(result)) {
      this.report(result.error)
    } else if (
      (result.value.status === 'applied' || result.value.status === 'already-applied') &&
      (submittedOutcome.type === 'fail' || submittedOutcome.type === 'retry') &&
      (result.value.attempt.outcome === 'failed' || result.value.attempt.outcome === 'retried')
    ) {
      const persisted = result.value.attempt
      const persistedFailure = persisted.failure ?? submittedOutcome.failure
      if (persistedFailure === undefined) return
      const persistedOutcome =
        persisted.outcome === 'retried'
          ? {
              type: 'retry' as const,
              runAt: persisted.retryAt ?? job.runAt,
              ...(persisted.retryDelayMs === undefined
                ? {}
                : { retryDelayMs: persisted.retryDelayMs })
            }
          : { type: 'fail' as const, failure: persistedFailure }
      if (result.value.status === 'already-applied' && attempt?.failureNotified) return
      if (attempt !== undefined) attempt.failureNotified = true
      // Hooks are advisory and must not occupy a worker slot or block stop().
      void this.notifyFailure(
        job,
        persisted.attempt,
        persistedFailure,
        persistedOutcome,
        attempt?.failureCause
      )
    }
  }

  private async notifyFailure(
    job: ActiveJobSnapshot,
    attempt: number,
    failure: SerializedJobFailure | undefined,
    outcome: SettlementOutcome,
    cause?: unknown
  ): Promise<void> {
    if (failure === undefined || (outcome.type !== 'fail' && outcome.type !== 'retry')) return
    const hook = this.workerOptions.onJobFailure
    if (hook === undefined) return
    // SAFETY: the persisted failure kind and event kind are copied from the same validated value.
    const event = {
      job: { id: job.id, queue: job.queue, name: job.name, version: job.version },
      attempt,
      attemptsMax: job.attemptsMax,
      kind: failure.kind,
      cause:
        cause === undefined ? (failure.kind === 'typed' ? failure.data : failure.message) : cause,
      failure,
      willRetry: outcome.type === 'retry',
      ...(outcome.type === 'retry'
        ? {
            retryAt: outcome.runAt,
            retryDelayMs: outcome.retryDelayMs ?? Math.max(0, outcome.runAt - failure.recordedAt)
          }
        : {})
    } as JobFailureEvent
    try {
      await hook(event)
    } catch (cause) {
      this.report(cause)
    }
  }

  private async releaseJob(group: ClaimGroup, job: ActiveJobSnapshot): Promise<void> {
    const result = await runStoreOperation<import('../store').ReleaseResult>(
      this.runtime,
      group.store,
      (store) => store.release({ jobId: job.id, leaseToken: job.leaseToken, now: this.readNow() }),
      undefined,
      this.workerOptions.pollIntervalMs,
      this.workerOptions.storeOperationTimeoutMs,
      this.shutdownController.signal
    )

    if (Result.isError(result)) {
      this.report(result.error)
    }
  }

  private finishAttempt(attempt: AttemptState): void {
    if (attempt.timeoutTimer !== undefined) clearTimeout(attempt.timeoutTimer)
    this.active -= 1
    decrement(this.activeByHandler, attempt.entry.identityKey)
    this.activeAttempts.delete(attempt.key)
    this.shutdownAborts.delete(attempt.key)
    this.notifySlots()
    this.notifyIdle()
  }

  private startSupervisionLoop(store: AnyJobStoreToken, kind: 'heartbeat' | 'stalled'): void {
    const task = this.superviseStore(store, kind)
    this.supervisionTasks.add(task)
    void task.then(
      () => this.supervisionTasks.delete(task),
      (cause) => {
        this.supervisionTasks.delete(task)
        this.report(cause)
      }
    )
  }

  private async superviseStore(
    store: AnyJobStoreToken,
    kind: 'heartbeat' | 'stalled'
  ): Promise<void> {
    const interval =
      kind === 'heartbeat'
        ? this.workerOptions.heartbeatIntervalMs
        : this.workerOptions.stalledIntervalMs
    while (!this.supervisionController.signal.aborted) {
      await this.sleep(interval, this.supervisionController.signal)
      if (this.supervisionController.signal.aborted) return
      try {
        if (kind === 'heartbeat') await this.heartbeat(store)
        else await this.recoverStalled(store)
      } catch (cause) {
        this.report(cause)
      }
    }
  }

  private async heartbeat(store: AnyJobStoreToken): Promise<void> {
    const leases = [...this.activeAttempts.values()]
      .filter(
        (attempt) =>
          attempt.job.leaseOwner === this.id &&
          attempt.job.leaseToken !== undefined &&
          attempt.entry.store.serviceTag === store.serviceTag
      )
      .filter((attempt) => attempt.state !== 'lost' && attempt.state !== 'settling')
      .map((attempt) => ({ jobId: attempt.job.id, leaseToken: attempt.job.leaseToken! }))
    if (leases.length === 0) return
    const snapshot = new Map(
      [...this.activeAttempts.values()]
        .filter(
          (attempt) =>
            attempt.entry.store.serviceTag === store.serviceTag &&
            leases.some(
              (lease) =>
                lease.jobId === attempt.job.id && lease.leaseToken === attempt.job.leaseToken
            )
        )
        .map((attempt) => [heartbeatKey(attempt.job.id, attempt.job.leaseToken), attempt])
    )
    const result = await runStoreOperation<HeartbeatResult>(
      this.runtime,
      store,
      (client) =>
        client.heartbeat({
          leases,
          leaseDurationMs: this.workerOptions.leaseDurationMs,
          now: this.readNow()
        }),
      this.supervisionController.signal,
      this.workerOptions.pollIntervalMs,
      this.workerOptions.storeOperationTimeoutMs
    )
    if (Result.isError(result)) {
      if (result.error instanceof StoreOperationTimeoutError) {
        for (const attempt of snapshot.values()) this.markLost(attempt, result.error)
      } else {
        this.report(result.error)
      }
      return
    }
    for (const lost of result.value.lost) {
      const attempt = snapshot.get(heartbeatKey(lost.jobId, lost.leaseToken))
      if (
        attempt === undefined ||
        attempt.state === 'lost' ||
        attempt.job.leaseToken !== lost.leaseToken ||
        attempt.job.leaseOwner !== this.id
      )
        continue
      this.markLost(
        attempt,
        new LeaseLostError({ jobId: lost.jobId, leaseToken: lost.leaseToken, reason: lost.reason })
      )
    }
    for (const jobId of result.value.cancellationRequested) {
      const attempt = [...snapshot.values()].find(
        (candidate) =>
          candidate.job.id === jobId && candidate.entry.store.serviceTag === store.serviceTag
      )
      if (attempt === undefined || attempt.state !== 'running') continue
      attempt.state = 'cancelling'
      attempt.controller.abort(new Error('Job cancellation requested'))
    }
  }

  private isLost(attempt: AttemptState): boolean {
    return attempt.state === 'lost'
  }

  private markLost(attempt: AttemptState, cause: unknown): void {
    if (attempt.state === 'lost') return
    attempt.state = 'lost'
    attempt.controller.abort(cause)
  }

  private async recoverStalled(store: AnyJobStoreToken): Promise<void> {
    const result = await runStoreOperation<RecoverStalledResult>(
      this.runtime,
      store,
      (client) =>
        client.recoverStalled({
          maxStalledCount: this.workerOptions.maxStalledCount,
          now: this.readNow()
        }),
      this.supervisionController.signal,
      this.workerOptions.pollIntervalMs,
      this.workerOptions.storeOperationTimeoutMs
    )
    if (Result.isError(result)) this.report(result.error)
  }

  private async waitForWork(group: ClaimGroup, claim: ClaimResult): Promise<void> {
    if (this.currentState !== 'running') {
      return
    }

    const controller = new AbortController()
    const onStop = () => controller.abort()
    this.claimController.signal.addEventListener('abort', onStop, { once: true })

    if (this.claimController.signal.aborted) {
      controller.abort()
    }

    const wake = runStoreOperation(this.runtime, group.store, (store) =>
      store.awaitWake({
        queues: [group.queue],
        wakeToken: claim.wakeToken,
        signal: controller.signal
      })
    )
    const wakeResult = wake.then(
      (result) => {
        if (Result.isError(result)) {
          if (!JobStoreWakeAbortedError.is(result.error)) {
            this.report(result.error)
            return 'wake-error'
          }

          return 'wake'
        }

        return 'wake'
      },
      (cause) => {
        this.report(cause)
        return 'wake-error'
      }
    )
    const timer = this.sleep(this.workerOptions.pollIntervalMs, controller.signal).then(
      () => 'poll'
    )

    try {
      const winner = await Promise.race([wakeResult, timer])

      if (winner === 'wake-error') {
        await this.sleep(this.workerOptions.pollIntervalMs, this.claimController.signal)
      }
    } finally {
      controller.abort()
      this.claimController.signal.removeEventListener('abort', onStop)
      await wakeResult
    }
  }

  private async waitForSlot(): Promise<void> {
    if (this.currentState !== 'running') {
      return
    }

    await new Promise<void>((resolve) => {
      const finish = () => {
        this.slotWaiters.delete(finish)
        this.claimController.signal.removeEventListener('abort', finish)
        resolve()
      }

      this.slotWaiters.add(finish)
      this.claimController.signal.addEventListener('abort', finish, { once: true })

      if (this.claimController.signal.aborted) {
        finish()
      }
    })
  }

  private notifySlots(): void {
    for (const resolve of this.slotWaiters) {
      resolve()
    }

    this.slotWaiters.clear()
  }

  private isIdle(): boolean {
    if (this.currentState === 'stopped') {
      return this.active === 0 && this.reserved === 0
    }

    return (
      this.currentState === 'running' &&
      this.active === 0 &&
      this.reserved === 0 &&
      this.groups.every((group) => group.observedEmpty)
    )
  }

  private notifyIdle(): void {
    if (!this.isIdle()) {
      return
    }

    for (const waiter of this.idleWaiters) {
      waiter.resolve()
    }

    this.idleWaiters.clear()
  }

  private report(cause: unknown): void {
    const callback = this.workerOptions.onError

    if (callback === undefined) {
      return
    }

    try {
      void Promise.resolve(callback(cause)).catch(() => undefined)
    } catch {
      // Observers must not stop a Worker or replace the primary operation failure.
    }
  }

  private sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, delayMs)
      signal.addEventListener('abort', finish, { once: true })

      if (signal.aborted) {
        finish()
      }
    })
  }
}

export type NormalizedWorkerOptions = {
  readonly id: import('../protocol').WorkerId
  readonly concurrency: number
  readonly queueLimit: (queue: string) => number
  readonly leaseDurationMs: number
  readonly heartbeatIntervalMs: number
  readonly stalledIntervalMs: number
  readonly maxStalledCount: number
  readonly pollIntervalMs: number
  readonly storeOperationTimeoutMs: number
  readonly now: () => number
  readonly random: WorkerRandom
  readonly onError: WorkerErrorHandler | undefined
  readonly onJobFailure: JobFailureHandler | undefined
  readonly retryDefects: boolean
  readonly shutdown: { readonly gracePeriodMs: number; readonly abortAfterGracePeriod: boolean }
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- fields are read only after public boundary validation.
const readOption = (value: object, key: string, field = key): unknown => {
  let descriptor: PropertyDescriptor | undefined

  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    throw new JobDefinitionError({ field, message: 'could not read descriptor' })
  }

  if (descriptor === undefined) {
    return undefined
  }

  if (!('value' in descriptor)) {
    throw new JobDefinitionError({ field, message: 'must be a data property' })
  }

  return descriptor.value
}

export const normalizeWorkerOptions = (
  options: WorkerOptions<readonly AnyWorkerHandler[]>
): NormalizedWorkerOptions => {
  const concurrency = positiveInteger(
    readOption(options, 'concurrency') ?? defaultConcurrency,
    'concurrency'
  )
  const leaseDurationMs = positiveDuration(
    readOption(options, 'leaseDurationMs') ?? defaultLeaseDurationMs,
    'leaseDurationMs'
  )
  if (leaseDurationMs < minimumLeaseDurationMs) {
    throw new JobDefinitionError({
      field: 'leaseDurationMs',
      message: `must be at least ${minimumLeaseDurationMs}ms`
    })
  }
  const heartbeatIntervalMs = positiveDuration(
    readOption(options, 'heartbeatIntervalMs') ??
      Math.max(minimumTimerMs, Math.floor(leaseDurationMs / 3)),
    'heartbeatIntervalMs'
  )
  if (heartbeatIntervalMs >= leaseDurationMs) {
    throw new JobDefinitionError({
      field: 'heartbeatIntervalMs',
      message: 'must be less than leaseDurationMs'
    })
  }
  const stalledIntervalMs = positiveDuration(
    readOption(options, 'stalledIntervalMs') ?? leaseDurationMs,
    'stalledIntervalMs'
  )
  if (stalledIntervalMs < minimumStalledIntervalMs) {
    throw new JobDefinitionError({
      field: 'stalledIntervalMs',
      message: `must be at least ${minimumStalledIntervalMs}ms`
    })
  }
  const maxStalledCount = nonNegativeInteger(
    readOption(options, 'maxStalledCount') ?? defaultMaxStalledCount,
    'maxStalledCount'
  )
  const pollIntervalMs = boundedPollInterval(
    readOption(options, 'pollIntervalMs') ?? defaultPollIntervalMs,
    'pollIntervalMs'
  )
  const shutdownValue = readOption(options, 'shutdown')
  const shutdown = normalizeShutdown(shutdownValue)
  const id = normalizeWorkerId(readOption(options, 'id'), readOption(options, 'workerId'))
  const queueLimits = normalizeQueueLimits(readOption(options, 'queueConcurrency'), concurrency)
  const now = normalizeClock(readOption(options, 'now'))
  const randomValue = readOption(options, 'random')
  if (randomValue !== undefined && typeof randomValue !== 'function') {
    throw new JobDefinitionError({ field: 'random', message: 'must be callable' })
  }
  const random = (randomValue ?? Math.random) as WorkerRandom
  const onError = readOption(options, 'onError')
  const onJobFailure = readOption(options, 'onJobFailure')
  const retryDefects = readOption(options, 'retryDefects') ?? true

  if (onError !== undefined && typeof onError !== 'function') {
    throw new JobDefinitionError({ field: 'onError', message: 'must be callable' })
  }
  if (onJobFailure !== undefined && typeof onJobFailure !== 'function') {
    throw new JobDefinitionError({ field: 'onJobFailure', message: 'must be callable' })
  }
  if (typeof retryDefects !== 'boolean') {
    throw new JobDefinitionError({ field: 'retryDefects', message: 'must be boolean' })
  }

  return {
    id,
    concurrency,
    queueLimit: (queue) => queueLimits.named.get(queue) ?? queueLimits.defaultLimit,
    leaseDurationMs,
    heartbeatIntervalMs,
    stalledIntervalMs,
    maxStalledCount,
    pollIntervalMs,
    storeOperationTimeoutMs: Math.max(
      pollIntervalMs,
      Math.min(leaseDurationMs, heartbeatIntervalMs * 2)
    ),
    now,
    random,
    shutdown,
    onError: onError as WorkerErrorHandler | undefined,
    onJobFailure: onJobFailure as JobFailureHandler | undefined,
    retryDefects
  }
}

const makeGroups = (
  handlers: readonly AnyWorkerHandler[],
  options: NormalizedWorkerOptions
): readonly ClaimGroup[] => {
  const groups: {
    readonly queue: JobRecord['queue']
    readonly store: AnyJobStoreToken
    handlers: HandlerEntry[]
  }[] = []

  for (const handler of handlers) {
    const definition = handler.job
    const queue = makeQueueName(definition.queue)

    if (Result.isError(queue)) {
      throw queue.error
    }

    const identityKey = identityKeyFor(definition)
    const entry: HandlerEntry = {
      handler,
      definition,
      identityKey,
      queue: queue.value,
      store: definition.store,
      concurrency: handler.concurrency ?? options.concurrency
    }
    // Repeated named handles share a logical group by stable tag. Different tags are
    // the explicit identity boundary for separate storage backends.
    const group = groups.find(
      (candidate) =>
        candidate.store.serviceTag === definition.store.serviceTag &&
        candidate.queue === queue.value
    )

    if (group === undefined) {
      groups.push({ queue: queue.value, store: definition.store, handlers: [entry] })
    } else {
      group.handlers.push(entry)
    }
  }

  return groups.map((group, index) => ({
    key: String(index),
    queue: group.queue,
    store: group.store,
    handlers: Object.freeze(group.handlers.slice()),
    observedEmpty: false
  }))
}

const findHandler = (group: ClaimGroup, job: ActiveJobSnapshot): HandlerEntry | undefined => {
  const key = identityKeyFor(job)
  return group.handlers.find((entry) => entry.identityKey === key)
}

const identityKeyFor = (definition: Pick<AnyJobDefinition, 'queue' | 'name' | 'version'>): string =>
  JSON.stringify([definition.queue, definition.name, definition.version])

const makeContext = (
  workerId: import('../protocol').WorkerId,
  job: ActiveJobSnapshot
): JobContext =>
  new JobContext({
    jobId: job.id,
    queue: job.queue,
    name: job.name,
    version: job.version,
    attempt: job.attemptsMade + 1,
    attemptsMax: job.attemptsMax,
    delivery: job.deliveryCount,
    workerId,
    metadata: job.metadata
  })

const decodePayload = async (codec: CodecLike, payload: JsonValue): Promise<CodecOutcome> => {
  try {
    const decoded = await codec.decode(payload as never)

    if (!isResultLike(decoded)) {
      return { ok: false, cause: new Error('Payload codec did not return a Result') }
    }

    return Result.isError(decoded)
      ? { ok: false, cause: decoded.error }
      : { ok: true, value: decoded.value as JsonValue }
  } catch (cause) {
    return { ok: false, cause }
  }
}

const completeOutcome = async (
  definition: AnyJobDefinition,
  value: unknown,
  recordedAt: number
): Promise<SettlementOutcome> => {
  if (definition.result === undefined) {
    return value === undefined
      ? { type: 'complete' }
      : encodeFailureOutcome('Result codec is not configured', recordedAt)
  }

  const encoded = await encodeCodec(definition.result, value)
  return encoded.ok
    ? { type: 'complete', result: encoded.value }
    : encodeFailureOutcome(safeCauseMessage(encoded.cause), recordedAt)
}

const typedFailureOutcome = async (
  definition: AnyJobDefinition,
  failure: unknown,
  recordedAt: number,
  job: ActiveJobSnapshot,
  random: WorkerRandom
): Promise<SettlementOutcome> => {
  if (definition.failure === undefined) {
    return failOutcome('Failure codec is not configured', recordedAt)
  }

  const encoded = await encodeCodec(definition.failure, failure)

  if (!encoded.ok) return encodeFailureOutcome(safeCauseMessage(encoded.cause), recordedAt)

  const retryableResult = runRetryable(definition, failure as JobFailure<typeof definition>)
  const predicateRetryable = !Result.isError(retryableResult) && retryableResult.value === true
  const policy = definition.retryPolicy
  const retryable =
    !isUnrecoverableFailure(failure) &&
    (definition.retryable === undefined
      ? policy?.type === 'custom' || predicateRetryable
      : predicateRetryable)
  const allowed = retryable && policy?.type !== 'never' && job.attemptsMade + 1 < job.attemptsMax
  const failureEnvelope = makeFailure({
    kind: 'typed',
    code: 'handler-failure',
    message: 'Handler returned a typed failure',
    data: encoded.value,
    retryable,
    recordedAt
  })
  if (!allowed) return { type: 'fail', failure: failureEnvelope }
  const decision =
    policy?.type === 'custom'
      ? safeCustomDecision(policy, failure, job.attemptsMade + 1, job.attemptsMax)
      : { retry: true }
  if (!decision.retry) return { type: 'fail', failure: failureEnvelope }
  const delay =
    decision.delayMs ??
    (job.backoff === undefined ? 0 : Retry.delay(job.backoff, job.attemptsMade + 1, random()))
  return {
    type: 'retry',
    runAt: safeRunAt(recordedAt, delay),
    retryDelayMs: delay,
    failure: failureEnvelope
  }
}

const decodeOutcome = (cause: unknown, recordedAt: number): SettlementOutcome => ({
  type: 'fail',
  failure: makeFailure({
    kind: 'decode',
    code: 'payload-decode',
    message: safeCauseMessage(cause),
    retryable: false,
    recordedAt
  })
})

const failOutcome = (message: string, recordedAt: number): SettlementOutcome => ({
  type: 'fail',
  failure: makeFailure({
    kind: 'defect',
    code: 'handler-defect',
    message,
    retryable: false,
    recordedAt
  })
})

const retryOrFail = (
  failure: SerializedJobFailure,
  recordedAt: number,
  retryable: boolean,
  job: ActiveJobSnapshot,
  random: WorkerRandom
): SettlementOutcome => {
  if (!retryable || job.attemptsMade + 1 >= job.attemptsMax) return { type: 'fail', failure }
  const delay =
    job.backoff === undefined ? 0 : Retry.delay(job.backoff, job.attemptsMade + 1, random())
  return {
    type: 'retry',
    runAt: safeRunAt(recordedAt, delay),
    retryDelayMs: delay,
    failure
  }
}

const safeRunAt = (recordedAt: number, delay: number): number => {
  if (!Number.isSafeInteger(recordedAt) || !Number.isSafeInteger(delay) || delay < 0) {
    return Number.MAX_SAFE_INTEGER
  }
  return recordedAt >= Number.MAX_SAFE_INTEGER - delay
    ? Number.MAX_SAFE_INTEGER
    : recordedAt + delay
}

const defectOutcome = (
  message: string,
  recordedAt: number,
  retryable: boolean,
  job: ActiveJobSnapshot,
  random: WorkerRandom
): SettlementOutcome =>
  retryOrFail(
    makeFailure({ kind: 'defect', code: 'handler-defect', message, retryable, recordedAt }),
    recordedAt,
    retryable,
    job,
    random
  )

const timeoutOutcome = (
  cause: unknown,
  recordedAt: number,
  job: ActiveJobSnapshot,
  enabled = true,
  random: WorkerRandom = Math.random
): SettlementOutcome =>
  retryOrFail(
    makeFailure({
      kind: 'timeout',
      code: 'job-timeout',
      message: safeCauseMessage(cause),
      retryable: true,
      recordedAt
    }),
    recordedAt,
    enabled,
    job,
    random
  )

const encodeFailureOutcome = (message: string, recordedAt: number): SettlementOutcome => ({
  type: 'fail',
  failure: makeFailure({
    kind: 'encode',
    code: 'codec-encode',
    message,
    retryable: false,
    recordedAt
  })
})

const safeCustomDecision = (
  policy: {
    readonly decide: (
      failure: never,
      context: { readonly attempt: number; readonly attemptsMax: number }
    ) => unknown
  },
  failure: unknown,
  attempt: number,
  attemptsMax: number
): { retry: boolean; delayMs?: number } => {
  try {
    const decision = policy.decide(failure as never, { attempt, attemptsMax })
    if (isThenable(decision)) {
      // Custom decisions are synchronous. Assimilate and observe hostile thenables now;
      // otherwise a returned rejected Promise would become an unhandled rejection.
      void Promise.resolve(decision).catch(() => undefined)
      return { retry: false }
    }
    if (decision === true) return { retry: true }
    if (decision === false || decision === undefined || decision === null) return { retry: false }
    if (typeof decision !== 'object' || decision === null) return { retry: false }
    const prototype = Object.getPrototypeOf(decision)
    if (prototype !== Object.prototype && prototype !== null) return { retry: false }
    const retryDescriptor = Object.getOwnPropertyDescriptor(decision, 'retry')
    const delayDescriptor = Object.getOwnPropertyDescriptor(decision, 'delayMs')
    if (
      retryDescriptor === undefined ||
      !('value' in retryDescriptor) ||
      (delayDescriptor !== undefined && !('value' in delayDescriptor)) ||
      typeof retryDescriptor.value !== 'boolean'
    )
      return { retry: false }
    const allowed = new Set(['retry', 'delayMs'])
    for (const key of Reflect.ownKeys(decision)) {
      if (typeof key !== 'string' || !allowed.has(key)) return { retry: false }
      const descriptor = Object.getOwnPropertyDescriptor(decision, key)
      if (descriptor === undefined || !('value' in descriptor)) return { retry: false }
    }
    const delay = delayDescriptor?.value
    return delay === undefined
      ? { retry: retryDescriptor.value }
      : typeof delay === 'number' && Number.isSafeInteger(delay) && delay >= 0
        ? { retry: retryDescriptor.value, delayMs: delay }
        : { retry: false }
  } catch {
    return { retry: false }
  }
}

const makeFailure = (failure: {
  readonly kind: SerializedJobFailure['kind']
  readonly code: string
  readonly message: string
  readonly data?: JsonValue
  readonly retryable: boolean
  readonly recordedAt: number
}): SerializedJobFailure => {
  const result = makeSerializedJobFailure(failure)

  if (Result.isError(result)) {
    return {
      kind: 'defect',
      code: 'failure-normalization',
      message: 'Worker could not normalize a failure',
      retryable: false,
      recordedAt: Math.max(0, Number.isSafeInteger(failure.recordedAt) ? failure.recordedAt : 0)
    }
  }

  return result.value
}

const encodeCodec = async (codec: CodecLike, value: unknown): Promise<CodecOutcome> => {
  try {
    const encoded = await codec.encode(value as never)

    if (!isResultLike(encoded)) {
      return { ok: false, cause: new Error('Codec did not return a Result') }
    }

    if (Result.isError(encoded)) {
      return { ok: false, cause: encoded.error }
    }

    const json = parseJsonValue(encoded.value)

    return Result.isError(json) ? { ok: false, cause: json.error } : { ok: true, value: json.value }
  } catch (cause) {
    return { ok: false, cause }
  }
}

const safeCauseMessage = (cause: unknown): string => {
  try {
    return new UnhandledException({ cause }).message
  } catch {
    return 'Unhandled exception'
  }
}

const runStoreOperation = async <Value>(
  runtime: AnyRuntime,
  token: AnyJobStoreToken,
  operation: (store: JobStoreContract) => StoreOperation<Value>,
  signal?: AbortSignal,
  retryDelayMs = 1,
  timeoutMs = Math.max(minimumTimerMs, retryDelayMs),
  retrySignal: AbortSignal | undefined = signal,
  resolvedStore?: JobStoreContract
): Promise<ResultType<Value, unknown>> => {
  let retries = 0
  while (true) {
    let result: ResultType<Value, unknown>
    try {
      // Resolve only the token inside a completed Runtime execution. An arbitrary adapter
      // Promise is then invoked outside Runtime: Runtime cannot preempt it and must retain
      // its scope until settlement, so owning a hung adapter call would leak execution.
      const store = resolvedStore ?? (await runtime.run(() => ServiceRuntime.resolve(token)))
      const pending = Promise.resolve().then(() => operation(store))
      // A timed-out adapter may reject later, but its late result cannot mutate Worker state.
      void pending.catch(() => undefined)
      result = await raceStoreOperation(
        pending as Promise<ResultType<Value, unknown>>,
        token.serviceTag,
        timeoutMs,
        signal
      )
    } catch (cause) {
      return Result.err(new WorkerRuntimeOwnershipError(cause)) as ResultType<Value, unknown>
    }
    if (
      !Result.isError(result) ||
      !JobStoreFailure.is(result.error) ||
      !result.error.retryable ||
      retries >= maximumStoreRetries ||
      retrySignal?.aborted
    )
      return result
    retries += 1
    await cancellableDelay(Math.min(100, retryDelayMs * 2 ** (retries - 1)), retrySignal)
    if (retrySignal?.aborted) return result
  }
}

const raceStoreOperation = async <Value>(
  pending: Promise<ResultType<Value, unknown>>,
  operation: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ResultType<Value, unknown>> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<ResultType<Value, unknown>>((resolve) => {
    const finish = (cause: StoreOperationTimeoutError): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
      resolve(Result.err(cause) as ResultType<Value, unknown>)
    }
    timer = setTimeout(() => finish(new StoreOperationTimeoutError(operation)), timeoutMs)
    if (signal !== undefined) {
      onAbort = () => finish(new StoreOperationTimeoutError(operation))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
  })
  const result = await Promise.race([pending, interrupted])
  if (timer !== undefined) clearTimeout(timer)
  if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  return result
}

const cancellableDelay = (delay: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, delay)
    signal?.addEventListener('abort', done, { once: true })
  })

const heartbeatKey = (
  jobId: JobRecord['id'],
  leaseToken: NonNullable<JobRecord['leaseToken']>
): string => JSON.stringify([jobId, leaseToken])

const isThenable = (value: unknown): boolean => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  try {
    return typeof (value as { readonly then?: unknown }).then === 'function'
  } catch {
    return false
  }
}

const isResultLike = (value: unknown): value is UnknownResult => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  try {
    const candidate = value as {
      readonly status?: unknown
      readonly isOk?: unknown
      readonly isErr?: unknown
    }

    return (
      (candidate.status === 'ok' || candidate.status === 'error') &&
      typeof candidate.isOk === 'function' &&
      typeof candidate.isErr === 'function'
    )
  } catch {
    return false
  }
}

const increment = (values: Map<string, number>, key: string): void => {
  values.set(key, (values.get(key) ?? 0) + 1)
}

const decrement = (values: Map<string, number>, key: string): void => {
  const value = values.get(key) ?? 0

  if (value <= 1) {
    values.delete(key)
  } else {
    values.set(key, value - 1)
  }
}

const normalizeWorkerId = (
  idValue: unknown,
  workerIdValue: unknown
): import('../protocol').WorkerId => {
  if (idValue !== undefined && workerIdValue !== undefined && idValue !== workerIdValue) {
    throw new JobDefinitionError({
      field: 'id',
      message: 'id and workerId must match when both are provided'
    })
  }

  const supplied = idValue ?? workerIdValue

  if (supplied !== undefined) {
    const result = makeWorkerId(supplied)

    if (Result.isError(result)) {
      throw result.error
    }

    return result.value
  }

  const generated = makeWorkerId(`worker-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return generated.unwrap()
}

type QueueLimits = {
  readonly defaultLimit: number
  readonly named: ReadonlyMap<string, number>
}

const normalizeQueueLimits = (value: unknown, fallback: number): QueueLimits => {
  if (value === undefined) {
    return { defaultLimit: fallback, named: new Map() }
  }

  if (typeof value === 'number') {
    return { defaultLimit: positiveInteger(value, 'queueConcurrency'), named: new Map() }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JobDefinitionError({
      field: 'queueConcurrency',
      message: 'must be a positive integer or record'
    })
  }

  const prototype = Object.getPrototypeOf(value)

  if (prototype !== Object.prototype && prototype !== null) {
    throw new JobDefinitionError({
      field: 'queueConcurrency',
      message: 'must be a positive integer or plain record'
    })
  }

  const limits = new Map<string, number>()

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new JobDefinitionError({
        field: 'queueConcurrency',
        message: 'record keys must be strings'
      })
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (descriptor === undefined || !('value' in descriptor)) {
      throw new JobDefinitionError({
        field: `queueConcurrency.${key}`,
        message: 'must be a data property'
      })
    }

    limits.set(key, positiveInteger(descriptor.value, `queueConcurrency.${key}`))
  }

  return { defaultLimit: fallback, named: limits }
}

const normalizeClock = (clock: unknown): (() => number) => {
  let read: () => number | Date

  if (clock === undefined) {
    read = () => Date.now()
  } else if (typeof clock === 'function') {
    read = clock as () => number | Date
  } else if (clock === null || typeof clock !== 'object' || Array.isArray(clock)) {
    throw new JobDefinitionError({ field: 'now', message: 'must be callable' })
  } else {
    const callback = readOption(clock, 'now', 'now')

    if (typeof callback !== 'function') {
      throw new JobDefinitionError({ field: 'now', message: 'must be callable' })
    }

    read = callback.bind(clock)
  }

  return () => {
    const value = read()
    const timestamp = value instanceof Date ? value.getTime() : value

    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new JobDefinitionError({
        field: 'now',
        message: 'must return a non-negative safe integer timestamp'
      })
    }

    return timestamp
  }
}

const positiveDuration = (value: unknown, field: string): number => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isSafeInteger(value)
  ) {
    throw new JobDefinitionError({
      field,
      message: 'must be a positive finite safe-integer duration'
    })
  }
  return value
}

const boundedPollInterval = (value: unknown, field: string): number => {
  const interval = nonNegativeInteger(value, field)
  return Math.max(minimumTimerMs, interval)
}

type NormalizedShutdown = {
  readonly gracePeriodMs: number
  readonly abortAfterGracePeriod: boolean
}

const normalizeShutdown = (value: unknown): NormalizedShutdown => {
  if (value === undefined) return { gracePeriodMs: 0, abortAfterGracePeriod: false }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobDefinitionError({ field: 'shutdown', message: 'must be an object' })
  }
  const gracePeriodMs = positiveOrZeroDuration(
    readOption(value, 'gracePeriodMs', 'shutdown.gracePeriodMs') ?? 0,
    'shutdown.gracePeriodMs'
  )
  const abort =
    readOption(value, 'abortAfterGracePeriod', 'shutdown.abortAfterGracePeriod') ?? false
  if (typeof abort !== 'boolean')
    throw new JobDefinitionError({
      field: 'shutdown.abortAfterGracePeriod',
      message: 'must be a boolean'
    })
  return { gracePeriodMs, abortAfterGracePeriod: abort }
}

const positiveOrZeroDuration = (value: unknown, field: string): number => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(value)
  ) {
    throw new JobDefinitionError({
      field,
      message: 'must be a finite non-negative safe-integer duration'
    })
  }
  return value
}

const positiveInteger = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new JobDefinitionError({ field, message: 'must be a positive safe integer' })
  }

  return value
}

const nonNegativeInteger = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new JobDefinitionError({ field, message: 'must be a non-negative safe integer' })
  }

  return value
}

type NormalizedAwaitIdleOptions = {
  readonly signal: AbortSignal | undefined
  readonly timeoutMs: number | undefined
}

const isAwaitIdleObject = (value: unknown): value is object => {
  if (value === null || typeof value !== 'object') {
    return false
  }

  try {
    return !Array.isArray(value)
  } catch {
    return false
  }
}

const normalizeAwaitIdleOptions = (options: unknown): NormalizedAwaitIdleOptions => {
  if (!isAwaitIdleObject(options)) {
    throw new WorkerAwaitIdleError('invalid-options', 'Worker awaitIdle options must be an object')
  }

  let timeoutValue: unknown
  let signalValue: unknown

  try {
    timeoutValue = readOption(options, 'timeoutMs', 'awaitIdle.timeoutMs')
    signalValue = readOption(options, 'signal', 'awaitIdle.signal')
  } catch (cause) {
    throw new WorkerAwaitIdleError(
      'invalid-options',
      'Worker awaitIdle options could not be read',
      cause
    )
  }

  const timeoutMs = timeoutValue === undefined ? undefined : normalizeAwaitIdleTimeout(timeoutValue)
  const signal = signalValue === undefined ? undefined : normalizeAwaitIdleSignal(signalValue)

  return { signal, timeoutMs }
}

const normalizeAwaitIdleTimeout = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkerAwaitIdleError(
      'invalid-timeout',
      'Worker awaitIdle timeoutMs must be a non-negative safe integer'
    )
  }

  return value
}

const normalizeAwaitIdleSignal = (value: unknown): AbortSignal => {
  if (!isAwaitIdleObject(value)) {
    throw new WorkerAwaitIdleError(
      'invalid-signal',
      'Worker awaitIdle signal must expose a boolean aborted property and callable add/removeEventListener methods'
    )
  }

  let aborted: unknown
  let addEventListener: unknown
  let removeEventListener: unknown

  try {
    const candidate = value as {
      readonly aborted?: unknown
      readonly addEventListener?: unknown
      readonly removeEventListener?: unknown
    }
    aborted = candidate.aborted
    addEventListener = candidate.addEventListener
    removeEventListener = candidate.removeEventListener
  } catch (cause) {
    throw new WorkerAwaitIdleError(
      'invalid-signal',
      'Worker awaitIdle signal could not be read',
      cause
    )
  }

  if (
    typeof aborted !== 'boolean' ||
    typeof addEventListener !== 'function' ||
    typeof removeEventListener !== 'function'
  ) {
    throw new WorkerAwaitIdleError(
      'invalid-signal',
      'Worker awaitIdle signal must expose a boolean aborted property and callable add/removeEventListener methods'
    )
  }

  return value as AbortSignal
}

const readSignalAborted = (signal: AbortSignal): boolean => {
  let aborted: unknown

  try {
    aborted = signal.aborted
  } catch (cause) {
    throw new WorkerAwaitIdleError(
      'invalid-signal',
      'Worker awaitIdle signal.aborted could not be read',
      cause
    )
  }

  if (typeof aborted !== 'boolean') {
    throw new WorkerAwaitIdleError(
      'invalid-signal',
      'Worker awaitIdle signal.aborted must be a boolean'
    )
  }

  return aborted
}

const makeAwaitIdleAbortedError = (signal: AbortSignal): WorkerAwaitIdleError => {
  let reason: unknown

  try {
    reason = signal.reason
  } catch (cause) {
    return new WorkerAwaitIdleError('aborted', 'Worker awaitIdle was aborted', cause)
  }

  return new WorkerAwaitIdleError(
    'aborted',
    'Worker awaitIdle was aborted',
    reason === undefined ? undefined : reason
  )
}

const observeRejectedSignalListenerResult = (value: unknown): void => {
  if (value === undefined) {
    return
  }

  try {
    void Promise.resolve(value).catch(() => undefined)
  } catch {
    // Promise resolution itself is best effort; no returned rejection may escape cleanup.
  }
}

const invalidSignalListenerReturn = (): WorkerAwaitIdleError =>
  new WorkerAwaitIdleError(
    'invalid-signal',
    'Worker awaitIdle abort listener registration must return void'
  )

const installWaiter = (waiter: Waiter, options: NormalizedAwaitIdleOptions): void => {
  const signal = options.signal

  if (signal !== undefined) {
    waiter.onAbort = () => waiter.reject(makeAwaitIdleAbortedError(signal))

    try {
      const result: unknown = signal.addEventListener('abort', waiter.onAbort, { once: true })

      if (result !== undefined) {
        observeRejectedSignalListenerResult(result)
        waiter.reject(invalidSignalListenerReturn())
        return
      }
    } catch (cause) {
      waiter.reject(
        new WorkerAwaitIdleError(
          'invalid-signal',
          'Worker awaitIdle could not register the abort listener',
          cause
        )
      )
      return
    }

    if (waiter.settled) {
      return
    }
  }

  if (options.timeoutMs !== undefined) {
    try {
      waiter.timer = setTimeout(
        () => waiter.reject(new WorkerAwaitIdleError('timeout', 'Worker awaitIdle timed out')),
        options.timeoutMs
      )
    } catch (cause) {
      waiter.reject(
        new WorkerAwaitIdleError(
          'invalid-timeout',
          'Worker awaitIdle could not install its timeout',
          cause
        )
      )
      return
    }
  }

  if (signal !== undefined) {
    try {
      if (readSignalAborted(signal)) {
        waiter.reject(makeAwaitIdleAbortedError(signal))
      }
    } catch (cause) {
      waiter.reject(cause)
    }
  }
}

const makeWaiter = (
  resolve: () => void,
  reject: (cause: unknown) => void,
  options: NormalizedAwaitIdleOptions,
  onSettled: () => void
): Waiter => {
  const waiter: Waiter = {
    resolve: () => {
      if (!waiter.settled) {
        waiter.settled = true
        onSettled()
        cleanupWaiter(waiter)
        resolve()
      }
    },
    reject: (cause) => {
      if (!waiter.settled) {
        waiter.settled = true
        onSettled()
        cleanupWaiter(waiter)
        reject(cause)
      }
    },
    signal: options.signal,
    onAbort: undefined,
    timer: undefined,
    settled: false
  }

  return waiter
}

const cleanupWaiter = (waiter: Waiter): void => {
  if (waiter.timer !== undefined) {
    clearTimeout(waiter.timer)
    waiter.timer = undefined
  }

  const signal = waiter.signal
  const onAbort = waiter.onAbort
  waiter.onAbort = undefined

  if (signal !== undefined && onAbort !== undefined) {
    try {
      const result: unknown = signal.removeEventListener('abort', onAbort)
      observeRejectedSignalListenerResult(result)
    } catch {
      // A malformed signal cannot retain this waiter's local references.
    }
  }
}

type NormalizedStopOptions = { readonly abortActive: boolean }

const normalizeStopOptions = (options: unknown): NormalizedStopOptions => {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new JobDefinitionError({ field: 'stop.options', message: 'must be an object' })
  }

  const abortActive = readOption(options, 'abortActive', 'stop.options.abortActive')

  if (abortActive !== undefined && typeof abortActive !== 'boolean') {
    throw new JobDefinitionError({
      field: 'stop.options.abortActive',
      message: 'must be a boolean'
    })
  }

  return { abortActive: abortActive === true }
}
