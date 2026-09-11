// oxlint-disable anti-slop/no-runtime-typeof -- Worker validates handler, clock, and store results at JavaScript boundaries.
// oxlint-disable anti-slop/no-known-value-widening -- hostile callback results are normalized explicitly.
// oxlint-disable anti-slop/no-unknown-parameters -- store and handler adapters are intentionally untyped at this erased boundary.
// oxlint-disable anti-slop/no-unknown-returns -- Result and codec values are normalized immediately after crossing a boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- heterogeneous handlers and store operations are erased in one module.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below are localized to checked runtime boundaries.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- event snapshots omit optional fields.

import { Effect, Layer, Program, ServiceRuntime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import type { RuntimeExecutor } from 'better-effect'
import { Panic, Result, UnhandledException, type Result as ResultType } from 'better-result'

import { Flow } from '../flow'
import {
  Job,
  isUnrecoverableFailure,
  runRetryable,
  type AnyJobDefinition,
  type CodecLike,
  type JobFailure
} from '../job'
import { makePreparedEnqueue } from '../job'
import { Retry } from '../retry'
import { parseJsonValue } from '../internal/json'
import {
  JobDefinitionError,
  JobNotCancellableError,
  JobNotFoundError,
  JobStoreFailure,
  JobId,
  LeaseLostError,
  hardFlowMaxChildren,
  makeFlowChildId,
  makeJobId,
  makeSerializedJobFailure,
  makeWorkerId,
  makeQueueName
} from '../protocol'
import type {
  FlowChildReport,
  FlowChildRecord,
  FlowChildSpec,
  FlowOutboxEntry,
  JobRecord,
  JsonValue,
  SerializedJobFailure,
  SettlementOutcome
} from '../protocol'
import { freezeJobEvent } from '../observability/events'
import type { JobEvent } from '../observability/events'
import { notifyJobObserver } from '../observability/observer'
import { FlowStore, JobStore, JobStoreWakeAbortedError } from '../store'
import type {
  ActiveJobSnapshot,
  AnyJobStoreToken,
  AnyFlowStoreToken,
  ClaimResult,
  FlowChildObservation,
  FlowStoreV2,
  HeartbeatResult,
  RecoverStalledResult,
  JobStoreContract,
  JobStoreOperation,
  SettlementResult
} from '../store'

import { JobContext } from './context'
import { scheduleDeadline } from './timer'
import { JobTimeoutError, WorkerAwaitIdleError, WorkerRuntimeOwnershipError } from './errors'
import type {
  AnyWorkerHandler,
  WorkerFlowRegistration,
  WorkerAwaitIdleOptions,
  WorkerErrorHandler,
  JobFailureEvent,
  JobFailureHandler,
  WorkerHandle,
  WorkerOptions,
  WorkerRandom,
  WorkerStopOptions
} from './types'
import type { JobObserver } from '../observability'

type AnyExecutor = RuntimeExecutor<any>
type UnknownResult = ResultType<unknown, unknown>
type StoreOperation<Value> = JobStoreOperation<Value, JobStore.Error>

type FlowOperation<Value> = import('../store').FlowStoreV2Operation<Value>

type FlowRoute = {
  readonly key: string
  readonly flowName: string
  readonly parentStoreKey: string
  readonly definition: import('../flow').AnyFlowDefinition
  readonly handler: import('../flow').AnyFlowHandler | undefined
  readonly parentFlowStore: AnyFlowStoreToken
  readonly sourceFlowStores: readonly AnyFlowStoreToken[]
  readonly childStores: ReadonlyMap<string, AnyJobStoreToken>
}

type FlowSource = {
  readonly token: AnyFlowStoreToken
}

const flowMetadataKeys = Object.freeze({
  flowName: '__better_effect_flow_v2.flowName',
  flowId: '__better_effect_flow_v2.flowId',
  childKey: '__better_effect_flow_v2.childKey',
  parentStoreKey: '__better_effect_flow_v2.parentStoreKey',
  depth: '__better_effect_flow_v2.depth',
  chain: '__better_effect_flow_v2.chain'
})

type FlowMetadata = {
  readonly flowName: string
  readonly flowId: JobId
  readonly childKey: string
  readonly parentStoreKey: string
  readonly depth: number
  readonly chain: readonly string[]
}

type HandlerEntry = {
  readonly handler: AnyWorkerHandler | import('../flow').AnyFlowHandler
  readonly definition: AnyJobDefinition
  readonly identityKey: string
  readonly queue: JobRecord['queue']
  readonly store: AnyJobStoreToken
  readonly concurrency: number
  readonly flow: FlowRoute | undefined
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
  readonly monotonicStartedAt: number
  promise: Promise<void>
  state: 'running' | 'cancelling' | 'settling' | 'lost'
  timeoutCancel?: () => void
  timedOut?: boolean
  failureCause?: unknown
  failureCauseSet: boolean
  failureNotified?: boolean
  leaseLostNotified?: boolean
  terminalNotified?: boolean
  /** The durable store acknowledged release of this phase's lease. */
  flowHandoff?: boolean
  durationMs?: number
}

type CodecOutcome =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly cause: unknown }

type StoreFailureContext = {
  readonly workerId?: import('../protocol').WorkerId
  readonly jobId?: import('../protocol').JobId
  readonly queue?: import('../protocol').QueueName
  readonly name?: import('../protocol').JobName
  readonly version?: number
  readonly attempt?: number
  readonly delivery?: number
}

type Waiter = {
  readonly resolve: () => void
  readonly reject: (cause: unknown) => void
  readonly signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  timer: (() => void) | undefined
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

const monotonicNow = (): number => {
  if (typeof globalThis.performance?.now === 'function') {
    const value = globalThis.performance.now()
    if (Number.isFinite(value)) return value
  }
  const wallClock = Date.now()
  return Number.isFinite(wallClock) ? wallClock : 0
}

export class WorkerSupervisor<
  Environment extends import('better-effect').AnyService = any
> implements WorkerHandle {
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
  private readonly executor: RuntimeExecutor<Environment>
  private quiesced = false
  private readonly workerOptions: NormalizedWorkerOptions
  private readonly supervisionTasks = new Set<Promise<void>>()
  private readonly supervisionController = new AbortController()
  private readonly flowRoutes: readonly FlowRoute[]
  private readonly jobStores: ReadonlyMap<string, JobStoreContract>
  private readonly flowStores: ReadonlyMap<string, FlowStoreV2>
  private readonly flowRoutesByKey = new Map<string, FlowRoute>()
  private readonly flowSources = new Map<string, FlowSource>()
  private readonly flowIdsByRoute = new Map<string, Set<JobId>>()
  private flowSweepRouteCursor = 0
  private readonly flowChildSweepCursors = new Map<string, Map<JobId, string>>()
  private readonly relayCursors = new Map<string, string | undefined>()
  private readonly relayRetries = new Map<string, FlowOutboxEntry[]>()
  private readonly flowCycleTasks = new Set<Promise<void>>()
  private relayCycle: Promise<void> | undefined
  private sweepCycle: Promise<void> | undefined
  private relayPulsePending = false
  private sweepPulsePending = false
  private readonly claimLeases = new Set<ClaimLease>()
  private readonly claimCleanupTasks = new Set<Promise<void>>()
  private nextClaimGeneration = 0

  constructor(
    executor: RuntimeExecutor<Environment>,
    handlers: readonly AnyWorkerHandler[],
    options: NormalizedWorkerOptions,
    flows: readonly WorkerFlowRegistration[] = [],
    jobStores: ReadonlyMap<string, JobStoreContract> = new Map(),
    flowStores: ReadonlyMap<string, FlowStoreV2> = new Map()
  ) {
    this.executor = executor
    this.workerOptions = options
    this.workerId = options.id
    this.jobStores = jobStores
    this.flowStores = flowStores
    for (const store of flowStores.values()) {
      const mode = store.descriptor.parentLeaseMode
      if (mode !== undefined && mode !== 'retained' && mode !== 'handoff') {
        throw new JobDefinitionError({
          field: 'flows.parentLeaseMode',
          message: 'unsupported parent lease lifecycle'
        })
      }
    }
    this.flowRoutes = makeFlowRoutes(flows)
    this.groups = makeGroups(handlers, options, this.flowRoutes)
    for (const route of this.flowRoutes) {
      this.flowRoutesByKey.set(route.key, route)
      const ids = new Set<JobId>(options.flowSweepFlowIds)
      this.flowIdsByRoute.set(route.key, ids)
      for (const source of route.sourceFlowStores) {
        this.flowSources.set(source.serviceTag, { token: source })
      }
    }
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
    if (this.flowRoutes.length > 0) {
      this.startFlowSupervisionLoop('relay')
      this.startFlowSupervisionLoop('sweep')
    }
    this.emit({ type: 'worker-started', recordedAt: this.readNow(), workerId: this.id })
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

  /**
   * Stop accepting new claims while keeping active attempts and their leases alive.
   * The next Worker Layer can call this before it releases the owning Runtime.
   */
  quiesce(): void {
    if (this.quiesced || this.currentState !== 'running') return
    this.quiesced = true
    for (const lease of this.claimLeases) {
      if (lease.lifecycle === 'pending') lease.lifecycle = 'abandoned'
    }
    this.claimController.abort()
    this.notifySlots()
  }

  stop(options: WorkerStopOptions = {}): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise
    }

    const normalizedOptions = normalizeStopOptions(options)
    this.currentState = 'stopping'
    this.emit({ type: 'worker-stopping', recordedAt: this.readNow(), workerId: this.id })
    // A store cannot be required to observe our AbortSignal. Fence every claim
    // before waking its caller; a later successful result is compensated below.
    for (const lease of this.claimLeases) {
      if (lease.lifecycle === 'pending') lease.lifecycle = 'abandoned'
    }
    // Stop claiming immediately. Active attempt deadlines remain authoritative unless
    // the selected shutdown policy explicitly aborts the attempts.
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
    await Promise.allSettled(this.flowCycleTasks)
    await Promise.allSettled(this.claimCleanupTasks)
    this.currentState = 'stopped'
    this.emit({ type: 'worker-stopped', recordedAt: this.readNow(), workerId: this.id })
    this.notifySlots()
    this.notifyIdle()
  }

  private abortActiveAttempts(): void {
    for (const attempt of this.activeAttempts.values()) {
      if (attempt.flowHandoff) continue
      if (attempt.state === 'running') attempt.state = 'cancelling'
      this.shutdownAborts.add(attempt.key)
      attempt.timeoutCancel?.()
      attempt.controller.abort(new Error('Worker is stopping'))
    }
  }

  private async runGroup(group: ClaimGroup): Promise<void> {
    while (this.canAcceptWork()) {
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
      this.emitStoreFailure('claim', result.error, {
        workerId: this.id,
        queue: plan.group.queue
      })
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
      this.emitClaimed(result.value.jobs)
      await this.dispatchJobs(group, result.value.jobs)
    } finally {
      this.releaseClaim(plan)
    }
  }

  private planClaim(group: ClaimGroup): ClaimPlan | undefined {
    if (!this.canAcceptWork()) {
      return undefined
    }

    // Handoff-mode phases occupy ordinary capacity only until durable fan-out.
    // Retained-lease reference adapters keep their existing separate admission model.
    const globalAvailable = this.workerOptions.concurrency - this.occupiedSlots() - this.reserved
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
        !attempt.flowHandoff &&
        (attempt.entry.flow === undefined || this.usesFlowLeaseHandoff(attempt.entry.flow)) &&
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
      store = await this.executor.run(() => ServiceRuntime.resolve(plan.group.store))
    } catch (cause) {
      return Result.err(new WorkerRuntimeOwnershipError(cause)) as ResultType<ClaimResult, unknown>
    }
    if (!this.canAcceptWork() || this.claimController.signal.aborted) {
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

    // The claim was persisted even though the Worker stopped waiting for it. Emit
    // the claim before its compensating release so observers see a valid sequence.
    this.emitClaimed(jobs)
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
      this.executor,
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
    if (Result.isError(result)) {
      this.emitStoreFailure('release', result.error, {
        workerId: this.id,
        jobId: job.id,
        queue: job.queue,
        name: job.name,
        version: job.version,
        attempt: job.attemptsMade + 1,
        delivery: job.deliveryCount
      })
      this.report(result.error)
    } else {
      this.emitRelease(job, result.value)
    }
  }

  private async dispatchJobs(group: ClaimGroup, jobs: readonly ActiveJobSnapshot[]): Promise<void> {
    for (const job of jobs) {
      if (!this.canAcceptWork()) {
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

  private emitClaimed(jobs: readonly ActiveJobSnapshot[]): void {
    const recordedAt = this.readNow()
    for (const job of jobs) {
      this.emit({
        type: 'claimed',
        recordedAt,
        workerId: this.id,
        jobId: job.id,
        queue: job.queue,
        name: job.name,
        version: job.version,
        attempt: job.attemptsMade + 1,
        delivery: job.deliveryCount,
        waitDurationMs: Math.max(0, recordedAt - job.runAt)
      })
    }
  }

  private canStart(entry: HandlerEntry, group: ClaimGroup): boolean {
    return (
      this.occupiedSlots() < this.workerOptions.concurrency &&
      this.activeInQueue(group) < this.workerOptions.queueLimit(group.queue) &&
      this.availableForHandler(entry) > 0
    )
  }

  private usesFlowLeaseHandoff(route: FlowRoute | undefined): boolean {
    return (
      route !== undefined &&
      this.flowStores.get(route.parentFlowStore.serviceTag)?.descriptor.parentLeaseMode ===
        'handoff'
    )
  }

  private occupiedSlots(): number {
    let count = 0
    for (const attempt of this.activeAttempts.values()) {
      if (
        !attempt.flowHandoff &&
        (attempt.entry.flow === undefined || this.usesFlowLeaseHandoff(attempt.entry.flow))
      )
        count += 1
    }
    return count
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
      monotonicStartedAt: monotonicNow(),
      promise: Promise.resolve(),
      state: 'running',
      failureCauseSet: false
    }

    this.active += 1
    increment(this.activeByHandler, entry.identityKey)
    this.activeAttempts.set(key, attempt)
    if (job.timeoutMs !== undefined) {
      attempt.timeoutCancel = scheduleDeadline(job.timeoutMs, () => {
        const cause = new JobTimeoutError(String(job.id))
        attempt.timedOut = true
        attempt.failureCause = cause
        attempt.failureCauseSet = true
        attempt.controller.abort(cause)
      })
    }
    this.emit({
      type: 'started',
      recordedAt: attempt.startedAt,
      workerId: this.id,
      jobId: job.id,
      queue: job.queue,
      name: job.name,
      version: job.version,
      attempt: job.attemptsMade + 1,
      delivery: job.deliveryCount
    })

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
      if (attempt.state === 'lost' || attempt.flowHandoff) return
      if (this.shutdownAborts.has(attempt.key)) {
        await this.releaseJob(group, attempt.job)
        return
      }
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
      if (attempt.state === 'lost' || attempt.flowHandoff) return
      if (this.shutdownAborts.has(attempt.key)) {
        await this.releaseJob(group, attempt.job)
        return
      }
      this.report(cause)
      // The timeout error passed to abort() is the authoritative cause. Runtime
      // cancellation commonly rejects with a different AbortError. Result-based
      // handler generators wrap thrown defects in a better-result boundary; hooks
      // should observe the original in-memory cause rather than that wrapper.
      if (!attempt.timedOut) preserveAttemptCause(attempt, unwrapBetterResultCause(cause))
      outcome =
        attempt.state === 'cancelling'
          ? { type: 'cancelled' }
          : attempt.timedOut
            ? timeoutOutcome(
                attempt.failureCause ?? cause,
                this.readNow(),
                attempt.job,
                attempt.entry.definition.retryPolicy?.type !== 'never',
                this.workerOptions.random
              )
            : defectOutcome(
                this.readNow(),
                this.workerOptions.retryDefects &&
                  attempt.entry.definition.retryPolicy?.type !== 'never',
                attempt.job,
                this.workerOptions.random
              )
    }

    // Encoding a result/failure is an async boundary. Cancellation may have been
    // observed while it was pending, so it must win before settlement begins.
    if (this.isLost(attempt) || attempt.flowHandoff) return
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

  private async executeFlowProgram(
    attempt: AttemptState,
    context: JobContext,
    payload: unknown
  ): Promise<unknown> {
    const route = attempt.entry.flow
    if (route === undefined || route.handler === undefined) {
      return Result.err(new JobDefinitionError({ field: 'flows', message: 'missing Flow handler' }))
    }

    const flowId = attempt.job.id
    const current = await this.runFlowOperation(route.parentFlowStore, (store) =>
      store.getFlow({ flowId })
    )
    if (Result.isError(current)) return Result.err(current.error)

    let snapshot = current.value
    if (snapshot === undefined) {
      const flowContext = readFlowContext(attempt.job.metadata)
      if (Result.isError(flowContext)) return Result.err(flowContext.error)
      const depth = flowContext.value.depth + 1
      if (depth > route.definition.maxDepth) {
        return Result.err(
          new JobDefinitionError({
            field: 'flow.depth',
            message: `maximum nesting depth ${route.definition.maxDepth} exceeded`
          })
        )
      }
      if (flowContext.value.chain.includes(route.flowName)) {
        return Result.err(
          new JobDefinitionError({
            field: 'flow.name',
            message: `nested Flow cycle detected for ${route.flowName}`
          })
        )
      }

      const phase = Effect.fn(async function* () {
        const value = yield* Result.await(
          Promise.resolve(route.handler!.fanOut(payload as never)())
        )
        return Result.ok(value)
      })
      const groups = await (this.executor as AnyExecutor).runWith(
        JobContext.layer(context),
        phase,
        {
          signal: attempt.controller.signal,
          attributes: { 'mq.flow.phase': 'fanOut', 'mq.flow.name': route.flowName }
        }
      )
      if (Result.isError(groups)) return groups

      const specs = await this.materializeFlowChildren(
        route,
        attempt,
        context,
        groups.value,
        depth,
        [...flowContext.value.chain, route.flowName]
      )
      if (Result.isError(specs)) return specs

      const fanOut = await this.runFlowOperation(route.parentFlowStore, (store) =>
        store.fanOut({
          flowId,
          flowName: route.flowName,
          parentStoreKey: route.parentStoreKey,
          depth,
          leaseToken: attempt.job.leaseToken,
          failFast: route.definition.onChildFailure === 'fail',
          children: specs.value,
          now: this.readNow(),
          maxChildren: route.definition.maxChildren
        })
      )
      if (Result.isError(fanOut)) return Result.err(fanOut.error)
      if (this.usesFlowLeaseHandoff(route)) {
        // The successful native transaction owns the manifest now. Do not encode
        // this phase as the parent result or settle/release its relinquished lease.
        attempt.flowHandoff = true
        attempt.timeoutCancel?.()
        this.rememberFlowId(route, flowId)
        await this.enqueueFlowChildren(route, specs.value)
        this.requestFlowRelay()
        return Result.ok(undefined)
      }
      this.rememberFlowId(route, flowId)
      snapshot = {
        parent: fanOut.value.parent,
        children: fanOut.value.children,
        outbox: []
      }
      await this.enqueueFlowChildren(route, specs.value)
    }

    if (this.usesFlowLeaseHandoff(route)) {
      // This invocation was admitted by a new native claim. The manifest's token
      // can be archival, so it is not a replacement for the claimed job's lease.
      if (snapshot.parent.state !== 'active' || snapshot.parent.flow.pending !== 0) {
        const error = new LeaseLostError({
          jobId: flowId,
          leaseToken: attempt.job.leaseToken,
          reason: 'missing-lease'
        })
        this.markLost(attempt, error)
        return Result.err(error)
      }
    } else {
      const settled = await this.awaitFlow(route, flowId, attempt.controller.signal)
      if (Result.isError(settled)) return Result.err(settled.error)
      snapshot = settled.value
    }
    if (snapshot.parent.state === 'failed' || snapshot.parent.state === 'cancelled') {
      return Result.err(flowFailureForParent(snapshot.parent.failure))
    }

    const results = makeFlowResults(
      route,
      flowId,
      this.executor,
      this.workerOptions.flowBatchSize,
      snapshot,
      this.flowStores.get(route.parentFlowStore.serviceTag)
    )
    const collect = Effect.fn(async function* () {
      const value = yield* Result.await(
        Promise.resolve(route.handler!.collect(payload as never, results as never)())
      )
      return Result.ok(value)
    })
    return await (this.executor as AnyExecutor).runWith(JobContext.layer(context), collect, {
      signal: attempt.controller.signal,
      attributes: { 'mq.flow.phase': 'collect', 'mq.flow.name': route.flowName }
    })
  }

  private async materializeFlowChildren(
    route: FlowRoute,
    attempt: AttemptState,
    context: JobContext,
    groups: unknown,
    depth: number,
    chain: readonly string[]
  ): Promise<ResultType<readonly FlowChildSpec[], unknown>> {
    if (!Array.isArray(groups)) {
      return Result.err(new JobDefinitionError({ field: 'fanOut', message: 'must return groups' }))
    }

    const specs: FlowChildSpec[] = []
    const keys = new Set<string>()
    for (const [groupIndex, groupValue] of groups.entries()) {
      if (groupValue === null || typeof groupValue !== 'object') {
        return Result.err(
          new JobDefinitionError({ field: `fanOut[${groupIndex}]`, message: 'must be a group' })
        )
      }
      const group = groupValue as { readonly job?: unknown; readonly items?: unknown }
      const job = group.job
      if (
        !isAnyJobDefinition(job) ||
        !route.definition.children.some((candidate) => candidate === job)
      ) {
        return Result.err(
          new JobDefinitionError({
            field: `fanOut[${groupIndex}].job`,
            message: 'must reference a declared Flow child Job'
          })
        )
      }
      if (!Array.isArray(group.items)) {
        return Result.err(
          new JobDefinitionError({
            field: `fanOut[${groupIndex}].items`,
            message: 'must be an array'
          })
        )
      }
      for (const [itemIndex, itemValue] of group.items.entries()) {
        if (itemValue === null || typeof itemValue !== 'object') {
          return Result.err(
            new JobDefinitionError({
              field: `fanOut[${groupIndex}].items[${itemIndex}]`,
              message: 'must be an item'
            })
          )
        }
        const item = itemValue as {
          readonly key?: unknown
          readonly payload?: unknown
          // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- child options are normalized by Job.prepare at the boundary.
          readonly options?: Record<string, unknown>
        }
        if (typeof item.key !== 'string' || item.key.length === 0) {
          return Result.err(
            new JobDefinitionError({
              field: `fanOut[${groupIndex}].items[${itemIndex}].key`,
              message: 'must be a non-empty string'
            })
          )
        }
        if (keys.has(item.key)) {
          return Result.err(
            new JobDefinitionError({ field: 'fanOut', message: `duplicate childKey "${item.key}"` })
          )
        }
        keys.add(item.key)
        if (specs.length >= route.definition.maxChildren) {
          return Result.err(
            new JobDefinitionError({
              field: 'fanOut',
              message: `must not exceed maxChildren ${route.definition.maxChildren}`
            })
          )
        }
        const child = job as AnyJobDefinition
        const childId = makeFlowChildId({
          parentStoreKey: route.parentStoreKey,
          flowId: attempt.job.id,
          childKey: item.key
        })
        if (Result.isError(childId)) return Result.err(childId.error)
        const metadata = makeFlowChildMetadata(
          route,
          attempt.job.id,
          item.key,
          depth,
          chain,
          item.options?.metadata as Readonly<Record<string, string>> | undefined
        )
        const options = { ...item.options, jobId: childId.value, metadata }
        const prepare = Effect.fn(async function* () {
          const value = yield* child.prepare(item.payload as never, options as never)
          return Result.ok(value)
        })
        const prepared = await (this.executor as AnyExecutor).runWith(
          Layer.merge(JobContext.layer(context), ClockLive),
          prepare,
          {
            signal: attempt.controller.signal,
            attributes: { 'mq.flow.phase': 'prepare-child', 'mq.flow.name': route.flowName }
          }
        )
        if (Result.isError(prepared)) return Result.err(prepared.error)
        const checked = makePreparedEnqueue({ ...prepared.value, metadata })
        if (Result.isError(checked)) return Result.err(checked.error)
        specs.push({
          childKey: item.key,
          name: child.name,
          version: child.version,
          storeKey: child.store.serviceTag,
          childJobId: childId.value,
          request: checked.value
        })
      }
    }
    return Result.ok(Object.freeze(specs))
  }

  private async enqueueFlowChildren(
    route: FlowRoute,
    specs: readonly FlowChildSpec[]
  ): Promise<void> {
    const byStore = new Map<
      string,
      { store: AnyJobStoreToken; requests: import('../store').EnqueueRequest[] }
    >()
    for (const spec of specs) {
      const store = route.childStores.get(spec.storeKey)
      if (store === undefined) {
        this.report(
          new JobDefinitionError({
            field: 'fanOut',
            message: `unknown child store ${spec.storeKey}`
          })
        )
        continue
      }
      const group = byStore.get(spec.storeKey)
      if (group === undefined) {
        byStore.set(spec.storeKey, { store, requests: [enqueueRequestFromPrepared(spec.request)] })
      } else {
        group.requests.push(enqueueRequestFromPrepared(spec.request))
      }
    }
    for (const group of byStore.values()) {
      const result = await this.runJobOperation(group.store, (store) =>
        store.enqueueMany(group.requests)
      )
      if (Result.isError(result)) this.report(result.error)
    }
  }

  private async awaitFlow(
    route: FlowRoute,
    flowId: JobId,
    signal: AbortSignal
  ): Promise<ResultType<import('../store').FlowSnapshot, unknown>> {
    while (!signal.aborted) {
      const current = await this.runFlowOperation(route.parentFlowStore, (store) =>
        store.getFlow({ flowId })
      )
      if (Result.isError(current)) return Result.err(current.error)
      if (current.value === undefined) {
        return Result.err(new JobNotFoundError({ jobId: flowId }))
      }
      if (
        current.value.parent.state !== 'waiting-children' ||
        current.value.parent.flow.pending === 0
      ) {
        return Result.ok(current.value)
      }
      await this.sleep(this.workerOptions.pollIntervalMs, signal)
    }
    return Result.err(new Error('Flow execution was aborted'))
  }

  private async executeProgram(attempt: AttemptState, context: JobContext): Promise<unknown> {
    const attemptNumber = attempt.job.attemptsMade + 1
    const attributes = {
      'mq.job.id': attempt.job.id,
      'mq.job.name': attempt.job.name,
      'mq.job.version': attempt.job.version,
      'mq.job.queue': attempt.job.queue,
      'mq.job.attempt': attemptNumber,
      'mq.worker.id': this.id
    }
    const name = `better-effect-mq/${attempt.job.queue}/${attempt.job.name}@${attempt.job.version}`
    const callback = async () => {
      const decoded = await decodePayload(attempt.entry.definition.payload, attempt.job.payload)

      if (!decoded.ok) {
        return Result.err(new DecodeOutcome(decoded.cause))
      }

      if (attempt.entry.flow !== undefined) {
        return this.executeFlowProgram(attempt, context, decoded.value)
      }

      const handler = attempt.entry.handler as AnyWorkerHandler
      const handlerProgram = handler.handler(decoded.value as never)
      return handlerProgram()
    }
    const program = Program.named(
      name,
      // SAFETY: Runtime already accepts this exact callback shape; Program.named only adds
      // declaration-only metadata and does not require the nominal marker at runtime.
      callback as unknown as import('better-effect').Effect.Program<
        unknown,
        unknown,
        import('better-effect').AnyService
      >
    )

    try {
      // SAFETY: handler requirements were checked by the Worker Service layer before the
      // heterogeneous handler tuple was erased inside this supervisor.
      return await (this.executor as AnyExecutor).runWith(JobContext.layer(context), program, {
        signal: attempt.controller.signal,
        attributes
      })
    } finally {
      attempt.durationMs = Math.max(0, monotonicNow() - attempt.monotonicStartedAt)
    }
  }

  private async makeOutcome(attempt: AttemptState, result: unknown): Promise<SettlementOutcome> {
    const definition = attempt.entry.definition
    const recordedAt = this.readNow()

    if (!isResultLike(result)) {
      preserveAttemptCause(attempt, result)
      return failOutcome(recordedAt)
    }

    if (Result.isError(result)) {
      if (result.error instanceof DecodeOutcome) {
        preserveAttemptCause(attempt, result.error.cause)
        return decodeOutcome(result.error.cause, recordedAt)
      }

      preserveAttemptCause(attempt, result.error)
      return typedFailureOutcome(
        definition,
        result.error,
        recordedAt,
        attempt.job,
        this.workerOptions.random,
        (cause) => preserveAttemptCause(attempt, cause)
      )
    }

    return completeOutcome(definition, result.value, recordedAt, (cause) =>
      preserveAttemptCause(attempt, cause)
    )
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
      this.executor,
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
        // retryDelayMs/runAt cannot reconstruct the original timestamp after
        // safeRunAt saturates. The failure envelope retains that internal
        // settlement sample without adding adapter-visible outcome fields.
        const settlementNow =
          submittedOutcome.type === 'retry'
            ? (submittedOutcome.failure?.recordedAt ?? this.readNow())
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
      this.shutdownController.signal,
      this.jobStores.get(group.store.serviceTag)
    )

    if (Result.isError(result)) {
      if (attempt !== undefined && LeaseLostError.is(result.error))
        this.markLost(attempt, result.error)
      this.emitStoreFailure('settle', result.error, this.storeFailureContext(attempt, job))
      this.report(result.error)
      return
    }

    if (result.value.status !== 'applied' && result.value.status !== 'already-applied') return
    const persisted = result.value.attempt
    if (
      persisted.outcome === 'completed' ||
      persisted.outcome === 'failed' ||
      persisted.outcome === 'cancelled'
    ) {
      await this.appendFlowReport(group, job, persisted)
      this.requestFlowRelay()
    }
    if (attempt?.terminalNotified === true) return
    if (attempt !== undefined) attempt.terminalNotified = true
    this.emitSettled(job, persisted, attempt?.durationMs)

    const submittedFailure =
      submittedOutcome.type === 'fail' || submittedOutcome.type === 'retry'
        ? submittedOutcome.failure
        : undefined
    const persistedFailure = persisted.failure ?? submittedFailure
    if (
      persistedFailure === undefined ||
      (persisted.outcome !== 'failed' && persisted.outcome !== 'retried')
    )
      return
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
      attempt?.failureCause,
      attempt?.failureCauseSet === true
    )
  }

  private async appendFlowReport(
    group: ClaimGroup,
    job: ActiveJobSnapshot,
    attempt: import('../protocol').AttemptRecord
  ): Promise<void> {
    const context = readFlowContext(job.metadata)
    if (Result.isError(context)) {
      this.report(context.error)
      return
    }
    if (context.value.flowName.length === 0) return
    // Sources are indexed by FlowStore identity, not by the associated JobStore.
    const source = this.flowSources.get(FlowStore.for(group.store).serviceTag)
    if (source === undefined) return
    const outcome =
      attempt.outcome === 'completed'
        ? ('completed' as const)
        : attempt.outcome === 'failed'
          ? ('failed' as const)
          : ('cancelled' as const)
    const report: FlowChildReport = {
      flowId: context.value.flowId,
      childKey: context.value.childKey,
      outcome,
      result: attempt.result,
      failure: attempt.failure
    }
    const result = await this.runFlowOperation(source.token, (store) =>
      store.appendChildReport({
        id: job.id,
        flowName: context.value.flowName,
        parentStoreKey: context.value.parentStoreKey,
        report
      })
    )
    if (Result.isError(result)) this.report(result.error)
  }

  private emitSettled(
    job: ActiveJobSnapshot,
    attempt: import('../protocol').AttemptRecord,
    durationMs: number | undefined
  ): void {
    const common = {
      recordedAt: this.readNow(),
      workerId: this.id,
      jobId: job.id,
      queue: job.queue,
      name: job.name,
      version: job.version,
      attempt: attempt.attempt,
      delivery: attempt.delivery
    }
    switch (attempt.outcome) {
      case 'completed':
        this.emit({ type: 'completed', ...common, durationMs: durationMs ?? 0 })
        break
      case 'retried':
        this.emit({
          type: 'retry-scheduled',
          ...common,
          retryAt: attempt.retryAt ?? job.runAt,
          ...(attempt.retryDelayMs === undefined ? {} : { retryDelayMs: attempt.retryDelayMs }),
          ...(durationMs === undefined ? {} : { durationMs }),
          source: 'attempt',
          ...(attempt.failure?.kind === undefined ? {} : { failureKind: attempt.failure.kind }),
          ...(attempt.failure?.code === undefined ? {} : { failureCode: attempt.failure.code })
        })
        break
      case 'failed':
        this.emit({
          type: 'failed',
          ...common,
          willRetry: false,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(attempt.failure?.kind === undefined ? {} : { failureKind: attempt.failure.kind }),
          ...(attempt.failure?.code === undefined ? {} : { failureCode: attempt.failure.code })
        })
        break
      case 'cancelled':
        this.emit({
          type: 'cancelled',
          ...common,
          source: 'worker',
          ...(durationMs === undefined ? {} : { durationMs })
        })
        break
      case 'stalled':
      case 'released':
        break
    }
  }

  private async notifyFailure(
    job: ActiveJobSnapshot,
    attempt: number,
    failure: SerializedJobFailure | undefined,
    outcome: SettlementOutcome,
    cause: unknown,
    hasCause: boolean
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
      cause: hasCause ? cause : failure.kind === 'typed' ? failure.data : failure.message,
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
    const attempt = this.activeAttempts.get(JSON.stringify([group.key, job.id]))
    const result = await runStoreOperation<import('../store').ReleaseResult>(
      this.executor,
      group.store,
      (store) => store.release({ jobId: job.id, leaseToken: job.leaseToken, now: this.readNow() }),
      undefined,
      this.workerOptions.pollIntervalMs,
      this.workerOptions.storeOperationTimeoutMs,
      this.shutdownController.signal,
      this.jobStores.get(group.store.serviceTag)
    )

    if (Result.isError(result)) {
      if (attempt !== undefined && LeaseLostError.is(result.error))
        this.markLost(attempt, result.error)
      this.emitStoreFailure('release', result.error, this.storeFailureContext(attempt, job))
      this.report(result.error)
      return
    }
    this.emitRelease(job, result.value)
  }

  private emitRelease(
    job: ActiveJobSnapshot,
    transition: import('../protocol').JobTransition
  ): void {
    const attempt = transition.attempt
    if (attempt?.outcome === 'released') {
      this.emit({
        type: 'released',
        recordedAt: this.readNow(),
        workerId: this.id,
        jobId: job.id,
        queue: job.queue,
        name: job.name,
        version: job.version,
        attempt: attempt.attempt,
        delivery: attempt.delivery
      })
    } else if (attempt?.outcome === 'cancelled') {
      this.emit({
        type: 'cancelled',
        recordedAt: this.readNow(),
        workerId: this.id,
        jobId: job.id,
        queue: job.queue,
        name: job.name,
        version: job.version,
        attempt: attempt.attempt,
        delivery: attempt.delivery,
        source: 'release'
      })
    }
  }

  private finishAttempt(attempt: AttemptState): void {
    attempt.timeoutCancel?.()
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

  private startFlowSupervisionLoop(kind: 'relay' | 'sweep'): void {
    const task = this.superviseFlow(kind)
    this.supervisionTasks.add(task)
    void task.then(
      () => this.supervisionTasks.delete(task),
      (cause) => {
        this.supervisionTasks.delete(task)
        this.report(cause)
      }
    )
    if (kind === 'relay') this.requestFlowRelay()
    else this.requestFlowSweep()
  }

  private async superviseFlow(kind: 'relay' | 'sweep'): Promise<void> {
    while (!this.supervisionController.signal.aborted) {
      await this.sleep(this.workerOptions.flowSweepIntervalMs, this.supervisionController.signal)
      if (this.supervisionController.signal.aborted || !this.canAcceptWork()) return
      if (kind === 'relay') this.requestFlowRelay()
      else this.requestFlowSweep()
    }
  }

  private requestFlowRelay(): void {
    if (!this.canAcceptWork() || this.flowSources.size === 0) return
    if (this.relayCycle !== undefined) {
      this.relayPulsePending = true
      return
    }

    const task = this.relayOutbox()
    this.relayCycle = task
    this.flowCycleTasks.add(task)
    void task.then(
      () => this.finishFlowCycle('relay', task),
      (cause) => {
        this.report(cause)
        this.finishFlowCycle('relay', task)
      }
    )
  }

  private requestFlowSweep(): void {
    if (!this.canAcceptWork() || this.flowRoutes.length === 0) return
    if (this.sweepCycle !== undefined) {
      this.sweepPulsePending = true
      return
    }

    const task = this.sweepFlows()
    this.sweepCycle = task
    this.flowCycleTasks.add(task)
    void task.then(
      () => this.finishFlowCycle('sweep', task),
      (cause) => {
        this.report(cause)
        this.finishFlowCycle('sweep', task)
      }
    )
  }

  private finishFlowCycle(kind: 'relay' | 'sweep', task: Promise<void>): void {
    this.flowCycleTasks.delete(task)
    if (kind === 'relay') {
      if (this.relayCycle !== task) return
      this.relayCycle = undefined
      if (this.relayPulsePending) {
        this.relayPulsePending = false
        this.requestFlowRelay()
      }
      return
    }

    if (this.sweepCycle !== task) return
    this.sweepCycle = undefined
    if (this.sweepPulsePending) {
      this.sweepPulsePending = false
      this.requestFlowSweep()
    }
  }

  private async relayOutbox(): Promise<void> {
    for (const source of this.flowSources.values()) {
      const sourceKey = source.token.serviceTag
      const pending = this.relayRetries.get(sourceKey)
      let entries: readonly FlowOutboxEntry[]
      if (pending !== undefined && pending.length > 0) {
        entries = pending.slice(0, this.workerOptions.flowBatchSize)
        this.relayRetries.set(sourceKey, pending.slice(entries.length))
      } else {
        const pageResult = await this.runFlowOperation(source.token, (store) =>
          store.peekOutbox({
            cursor: this.relayCursors.get(sourceKey),
            limit: this.workerOptions.flowBatchSize
          })
        )
        if (Result.isError(pageResult)) {
          this.report(pageResult.error)
          continue
        }

        const page = pageResult.value
        this.relayCursors.set(sourceKey, page.hasMore ? page.cursor : undefined)
        entries = page.entries
      }
      if (entries.length === 0) continue

      const groups = new Map<
        string,
        { readonly route: FlowRoute; readonly entries: FlowOutboxEntry[] }
      >()
      for (const entry of entries) {
        const route = this.flowRoutesByKey.get(flowRouteKey(entry.flowName, entry.parentStoreKey))
        if (route === undefined) continue
        this.rememberFlowId(route, entry.report.flowId)
        const key = `${route.key}\u0000${entry.report.flowId}`
        const group = groups.get(key)
        if (group === undefined) {
          groups.set(key, { route, entries: [entry] })
        } else {
          group.entries.push(entry)
        }
      }

      const confirmed: FlowOutboxEntry[] = []
      const failed: FlowOutboxEntry[] = []
      for (const group of groups.values()) {
        const first = group.entries[0]
        if (first === undefined) continue
        const result = await this.runFlowOperation(group.route.parentFlowStore, (store) =>
          store.recordChildResults({
            flowId: first.report.flowId,
            reports: group.entries.map((entry) => entry.report),
            now: this.readNow()
          })
        )
        if (Result.isError(result)) {
          this.report(result.error)
          failed.push(...group.entries)
          continue
        }
        confirmed.push(...group.entries)
      }

      if (confirmed.length > 0) {
        const acknowledged = await this.runFlowOperation(source.token, (store) =>
          store.ackOutbox({ entries: confirmed })
        )
        if (Result.isError(acknowledged)) {
          this.report(acknowledged.error)
          failed.push(...confirmed)
        }
      }
      if (failed.length > 0) {
        const retries = this.relayRetries.get(sourceKey) ?? []
        this.relayRetries.set(sourceKey, [...failed, ...retries])
      }
    }
  }

  private async sweepFlows(): Promise<void> {
    let remaining = this.workerOptions.flowBatchSize
    let visits = 0
    for (const ids of this.flowIdsByRoute.values()) visits += ids.size
    let emptyRoutes = 0
    while (remaining > 0 && visits > 0 && emptyRoutes < this.flowRoutes.length) {
      const route = this.flowRoutes[this.flowSweepRouteCursor % this.flowRoutes.length]
      this.flowSweepRouteCursor = (this.flowSweepRouteCursor + 1) % this.flowRoutes.length
      if (route === undefined) break
      const ids = this.flowIdsByRoute.get(route.key)
      const flowId = ids?.values().next().value
      if (ids === undefined || flowId === undefined) {
        emptyRoutes += 1
        continue
      }
      emptyRoutes = 0
      // Rotate before I/O: a slow parent or a failed inspection must not pin the
      // next bounded cycle to the same prefix, even across different flow routes.
      ids.delete(flowId)
      ids.add(flowId)
      visits -= 1
      remaining -= Math.max(1, await this.sweepFlow(route, flowId, remaining))
    }
  }

  private async sweepFlow(route: FlowRoute, flowId: JobId, limit: number): Promise<number> {
    const snapshot = await this.runFlowOperation(route.parentFlowStore, (store) =>
      store.getFlow({ flowId })
    )
    if (Result.isError(snapshot)) {
      if (JobNotFoundError.is(snapshot.error)) this.forgetFlowId(route, flowId)
      else this.report(snapshot.error)
      return 1
    }
    if (snapshot.value === undefined) {
      this.forgetFlowId(route, flowId)
      return 1
    }

    if (
      (snapshot.value.parent.state === 'completed' ||
        snapshot.value.parent.state === 'failed' ||
        snapshot.value.parent.state === 'cancelled') &&
      snapshot.value.parent.flow.pending === 0 &&
      snapshot.value.children.every(
        (child) => child.status !== 'pending' && (child.status !== 'cancelled' || child.cascaded)
      )
    ) {
      this.forgetFlowId(route, flowId)
      return 1
    }

    // An empty manifest is real but has no children to reconcile or cascade.
    // Still consume one inspection unit so empty flows cannot bypass the budget.
    if (snapshot.value.children.length === 0) return 1

    const observations: FlowChildObservation[] = []
    const children = snapshot.value.children
    const cursors = this.flowChildSweepCursors.get(route.key) ?? new Map<JobId, string>()
    this.flowChildSweepCursors.set(route.key, cursors)
    const previous = cursors.get(flowId)
    const start =
      previous === undefined ? -1 : children.findIndex((child) => child.childKey === previous)
    let inspected = 0
    for (let offset = 1; offset <= children.length && inspected < limit; offset += 1) {
      const child = children[(start + offset) % children.length]
      if (child === undefined || child.status !== 'pending') continue
      cursors.set(flowId, child.childKey)
      inspected += 1
      const childStore = route.childStores.get(child.storeKey)
      if (childStore === undefined) continue
      const job = await this.runJobOperation<JobRecord | undefined>(childStore, (store) =>
        store.getJob({ jobId: child.childJobId })
      )
      if (Result.isError(job)) {
        this.report(job.error)
        continue
      }
      observations.push(observationForChild(child.childKey, job.value))
    }

    const reconciliation = await this.runFlowOperation(route.parentFlowStore, (store) =>
      store.reconcile({ flowId, observations, now: this.readNow(), limit })
    )
    if (Result.isError(reconciliation)) {
      this.report(reconciliation.error)
      return Math.max(1, inspected)
    }

    await this.enqueueReconciliation(route, reconciliation.value.enqueue)
    if (reconciliation.value.reports.length > 0) {
      const reportResult = await this.runFlowOperation(route.parentFlowStore, (store) =>
        store.recordChildResults({
          flowId,
          reports: reconciliation.value.reports,
          now: this.readNow()
        })
      )
      if (Result.isError(reportResult)) this.report(reportResult.error)
    }
    await this.cascadeReconciliation(route, flowId, reconciliation.value.cascade)
    return Math.max(1, inspected)
  }

  private async enqueueReconciliation(
    route: FlowRoute,
    specs: readonly FlowChildSpec[]
  ): Promise<void> {
    const byStore = new Map<
      string,
      { readonly store: AnyJobStoreToken; requests: import('../store').EnqueueRequest[] }
    >()
    for (const spec of specs) {
      const store = route.childStores.get(spec.storeKey)
      if (store === undefined) continue
      const group = byStore.get(spec.storeKey)
      if (group === undefined) {
        byStore.set(spec.storeKey, {
          store,
          requests: [enqueueRequestFromPrepared(spec.request)]
        })
      } else {
        group.requests.push(enqueueRequestFromPrepared(spec.request))
      }
    }
    for (const group of byStore.values()) {
      const result = await this.runJobOperation(group.store, (store) =>
        store.enqueueMany(group.requests)
      )
      if (Result.isError(result)) this.report(result.error)
    }
  }

  private async cascadeReconciliation(
    route: FlowRoute,
    flowId: JobId,
    specs: readonly FlowChildSpec[]
  ): Promise<void> {
    const marked: string[] = []
    for (const spec of specs) {
      const store = route.childStores.get(spec.storeKey)
      if (store === undefined) continue
      const job = await this.runJobOperation<JobRecord | undefined>(store, (client) =>
        client.getJob({ jobId: spec.childJobId })
      )
      if (Result.isError(job)) {
        this.report(job.error)
        continue
      }
      if (job.value === undefined || isTerminalJobState(job.value.state)) {
        marked.push(spec.childKey)
        continue
      }
      const currentJob = job.value

      const result = await this.runJobOperation(store, (client) =>
        currentJob.state === 'active'
          ? client.requestCancellation({ jobId: spec.childJobId, now: this.readNow() })
          : client.cancel({ jobId: spec.childJobId, now: this.readNow() })
      )
      if (Result.isError(result)) {
        if (JobNotFoundError.is(result.error)) {
          marked.push(spec.childKey)
        } else if (JobNotCancellableError.is(result.error)) {
          const latest = await this.runJobOperation<JobRecord | undefined>(store, (client) =>
            client.getJob({ jobId: spec.childJobId })
          )
          if (
            Result.isOk(latest) &&
            (latest.value === undefined || isTerminalJobState(latest.value.state))
          ) {
            marked.push(spec.childKey)
          } else {
            this.report(result.error)
          }
        } else {
          this.report(result.error)
        }
      } else if (currentJob.state !== 'active') {
        marked.push(spec.childKey)
      }
    }
    if (marked.length === 0) return
    const result = await this.runFlowOperation(route.parentFlowStore, (store) =>
      store.markCascaded({ flowId, childKeys: marked })
    )
    if (Result.isError(result)) this.report(result.error)
  }

  private rememberFlowId(route: FlowRoute, flowId: JobId): void {
    this.flowIdsByRoute.get(route.key)?.add(flowId)
  }

  private forgetFlowId(route: FlowRoute, flowId: JobId): void {
    this.flowIdsByRoute.get(route.key)?.delete(flowId)
    const cursors = this.flowChildSweepCursors.get(route.key)
    cursors?.delete(flowId)
    if (cursors?.size === 0) this.flowChildSweepCursors.delete(route.key)
  }

  private async runFlowOperation<Value>(
    token: AnyFlowStoreToken,
    operation: (store: FlowStoreV2) => FlowOperation<Value>
  ): Promise<ResultType<Value, unknown>> {
    try {
      const store =
        this.flowStores.get(token.serviceTag) ??
        ((await this.executor.run(() => ServiceRuntime.resolve(token))) as FlowStoreV2)
      const result = await Promise.resolve(operation(store))
      if (!isResultLike(result)) {
        return Result.err(new Error('FlowStore operation did not return a Result')) as ResultType<
          Value,
          unknown
        >
      }
      return result as ResultType<Value, unknown>
    } catch (cause) {
      return Result.err(new WorkerRuntimeOwnershipError(cause)) as ResultType<Value, unknown>
    }
  }

  private async runJobOperation<Value>(
    token: AnyJobStoreToken,
    operation: (store: JobStoreContract) => StoreOperation<Value>
  ): Promise<ResultType<Value, unknown>> {
    try {
      const store =
        this.jobStores.get(token.serviceTag) ??
        (await this.executor.run(() => ServiceRuntime.resolve(token)))
      const result = await Promise.resolve(operation(store))
      if (!isResultLike(result)) {
        return Result.err(new Error('JobStore operation did not return a Result')) as ResultType<
          Value,
          unknown
        >
      }
      return result as ResultType<Value, unknown>
    } catch (cause) {
      return Result.err(new WorkerRuntimeOwnershipError(cause)) as ResultType<Value, unknown>
    }
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
      .filter(
        (attempt) =>
          !attempt.flowHandoff && attempt.state !== 'lost' && attempt.state !== 'settling'
      )
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
      this.executor,
      store,
      (client) =>
        client.heartbeat({
          leases,
          leaseDurationMs: this.workerOptions.leaseDurationMs,
          now: this.readNow()
        }),
      this.supervisionController.signal,
      this.workerOptions.pollIntervalMs,
      this.workerOptions.storeOperationTimeoutMs,
      this.supervisionController.signal,
      this.jobStores.get(store.serviceTag)
    )
    if (Result.isError(result)) {
      this.emitStoreFailure('heartbeat', result.error)
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
        attempt.flowHandoff ||
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
      if (attempt === undefined || attempt.flowHandoff || attempt.state !== 'running') continue
      attempt.state = 'cancelling'
      attempt.controller.abort(new Error('Job cancellation requested'))
    }
  }

  private isLost(attempt: AttemptState): boolean {
    return attempt.state === 'lost'
  }

  private markLost(attempt: AttemptState, cause: unknown): void {
    if (attempt.state === 'lost' || attempt.flowHandoff) return
    attempt.state = 'lost'
    attempt.timeoutCancel?.()
    if (attempt.leaseLostNotified !== true) {
      attempt.leaseLostNotified = true
      this.emit({
        type: 'lease-lost',
        recordedAt: this.readNow(),
        workerId: this.id,
        jobId: attempt.job.id,
        queue: attempt.job.queue,
        name: attempt.job.name,
        version: attempt.job.version,
        attempt: attempt.job.attemptsMade + 1,
        delivery: attempt.job.deliveryCount,
        reason: LeaseLostError.is(cause) ? cause.reason : 'store-timeout'
      })
    }
    attempt.controller.abort(cause)
  }

  private async recoverStalled(store: AnyJobStoreToken): Promise<void> {
    const result = await runStoreOperation<RecoverStalledResult>(
      this.executor,
      store,
      (client) =>
        client.recoverStalled({
          maxStalledCount: this.workerOptions.maxStalledCount,
          now: this.readNow()
        }),
      this.supervisionController.signal,
      this.workerOptions.pollIntervalMs,
      this.workerOptions.storeOperationTimeoutMs,
      this.supervisionController.signal,
      this.jobStores.get(store.serviceTag)
    )
    if (Result.isError(result)) {
      this.emitStoreFailure('recoverStalled', result.error)
      this.report(result.error)
    } else {
      this.emitStalledRecoveries(result.value.transitions)
    }
  }

  private emitStalledRecoveries(transitions: readonly import('../protocol').JobTransition[]): void {
    for (const transition of transitions) {
      const record = transition.record
      const attempt = transition.attempt
      const attemptNumber = attempt?.attempt ?? record.attemptsMade
      const delivery = attempt?.delivery ?? record.deliveryCount
      const outcome =
        record.state === 'cancelled'
          ? 'cancelled'
          : record.state === 'failed'
            ? 'failed'
            : 'requeued'
      this.emit({
        type: 'stalled-recovered',
        recordedAt: this.readNow(),
        workerId: this.id,
        jobId: record.id,
        queue: record.queue,
        name: record.name,
        version: record.version,
        attempt: attemptNumber,
        delivery,
        outcome
      })
      if (outcome === 'cancelled') {
        this.emit({
          type: 'cancelled',
          recordedAt: this.readNow(),
          workerId: this.id,
          jobId: record.id,
          queue: record.queue,
          name: record.name,
          version: record.version,
          attempt: attemptNumber,
          delivery,
          source: 'stalled'
        })
      }
    }
  }

  private async waitForWork(group: ClaimGroup, claim: ClaimResult): Promise<void> {
    if (!this.canAcceptWork()) {
      return
    }

    const controller = new AbortController()
    const onStop = () => controller.abort()
    this.claimController.signal.addEventListener('abort', onStop, { once: true })

    if (this.claimController.signal.aborted) {
      controller.abort()
    }

    const wake = runStoreOperation(
      this.executor,
      group.store,
      (store) =>
        store.awaitWake({
          queues: [group.queue],
          wakeToken: claim.wakeToken,
          signal: controller.signal
        }),
      undefined,
      this.workerOptions.pollIntervalMs,
      // Waiting for a notification is expected to last the polling interval.
      // Give a cooperative adapter time to settle after the poll aborts it;
      // an unresponsive adapter remains bounded by the operation deadline.
      this.workerOptions.pollIntervalMs + this.workerOptions.storeOperationTimeoutMs,
      controller.signal,
      this.jobStores.get(group.store.serviceTag)
    )
    const wakeResult = wake.then(
      (result) => {
        if (Result.isError(result)) {
          if (!JobStoreWakeAbortedError.is(result.error)) {
            this.emitStoreFailure('awaitWake', result.error)
            this.report(result.error)
            return 'wake-error'
          }

          return 'wake'
        }

        return 'wake'
      },
      (cause) => {
        // Poll/quiesce deliberately abort this notification wait. The operation
        // helper's abort boundary is not an infrastructure deadline in that case.
        if (controller.signal.aborted && cause instanceof StoreOperationTimeoutError) return 'wake'
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
    if (!this.canAcceptWork()) {
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

  private canAcceptWork(): boolean {
    return this.currentState === 'running' && !this.quiesced
  }

  private isIdle(): boolean {
    if (this.currentState === 'stopped') {
      return this.active === 0 && this.reserved === 0
    }

    return (
      this.active === 0 &&
      this.reserved === 0 &&
      (this.quiesced || this.groups.every((group) => group.observedEmpty))
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

  private emit(event: JobEvent): void {
    const observer = this.workerOptions.observer
    if (observer !== undefined) notifyJobObserver(observer, freezeJobEvent(event))
  }

  private storeFailureContext(
    attempt: AttemptState | undefined,
    job: ActiveJobSnapshot
  ): StoreFailureContext {
    return {
      workerId: this.id,
      jobId: job.id,
      queue: job.queue,
      name: job.name,
      version: job.version,
      attempt: (attempt?.job.attemptsMade ?? job.attemptsMade) + 1,
      delivery: attempt?.job.deliveryCount ?? job.deliveryCount
    }
  }

  private emitStoreFailure(
    operation: string,
    cause: unknown,
    context: StoreFailureContext = {}
  ): void {
    this.emit({
      type: 'store-operation-failed',
      recordedAt: this.readNow(),
      operation,
      retryable: JobStoreFailure.is(cause) && cause.retryable === true,
      ...context
    })
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
      let cancelDeadline: (() => void) | undefined
      const finish = (): void => {
        cancelDeadline?.()
        signal.removeEventListener('abort', finish)
        resolve()
      }
      cancelDeadline = scheduleDeadline(delayMs, finish)
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
  readonly flowSweepIntervalMs: number
  readonly flowBatchSize: number
  readonly flowSweepFlowIds: readonly JobId[]
  readonly storeOperationTimeoutMs: number
  readonly now: () => number
  readonly random: WorkerRandom
  readonly onError: WorkerErrorHandler | undefined
  readonly observer: JobObserver | undefined
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

const validateObserver = (value: unknown): void => {
  if (value === undefined) return
  let callback: unknown
  try {
    callback =
      value !== null && typeof value === 'object'
        ? (value as { readonly onEvent?: unknown }).onEvent
        : undefined
  } catch {
    throw new JobDefinitionError({ field: 'observer', message: 'could not read observer' })
  }
  if (typeof callback !== 'function') {
    throw new JobDefinitionError({ field: 'observer', message: 'must implement onEvent' })
  }
}

export const normalizeWorkerOptions = (
  options: WorkerOptions<readonly AnyWorkerHandler[], readonly WorkerFlowRegistration[]>
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
  const flowSweepIntervalMs = positiveDuration(
    readOption(options, 'flowSweepIntervalMs') ?? 30_000,
    'flowSweepIntervalMs'
  )
  const flowBatchSize = positiveInteger(
    readOption(options, 'flowBatchSize') ?? 100,
    'flowBatchSize'
  )
  if (flowBatchSize > hardFlowMaxChildren) {
    throw new JobDefinitionError({
      field: 'flowBatchSize',
      message: `must not exceed the Flow hard limit of ${hardFlowMaxChildren}`
    })
  }
  const flowSweepFlowIds = normalizeFlowSweepIds(readOption(options, 'flowSweepFlowIds'))
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
  const observer = readOption(options, 'observer')
  const onJobFailure = readOption(options, 'onJobFailure')
  const retryDefects = readOption(options, 'retryDefects') ?? true

  if (onError !== undefined && typeof onError !== 'function') {
    throw new JobDefinitionError({ field: 'onError', message: 'must be callable' })
  }
  if (onJobFailure !== undefined && typeof onJobFailure !== 'function') {
    throw new JobDefinitionError({ field: 'onJobFailure', message: 'must be callable' })
  }
  validateObserver(observer)
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
    flowSweepIntervalMs,
    flowBatchSize,
    flowSweepFlowIds,
    storeOperationTimeoutMs: Math.max(
      pollIntervalMs,
      Math.min(leaseDurationMs, heartbeatIntervalMs * 2)
    ),
    now,
    random,
    shutdown,
    onError: onError as WorkerErrorHandler | undefined,
    observer: observer as JobObserver | undefined,
    onJobFailure: onJobFailure as JobFailureHandler | undefined,
    retryDefects
  }
}

const makeGroups = (
  handlers: readonly AnyWorkerHandler[],
  options: NormalizedWorkerOptions,
  flows: readonly FlowRoute[]
): readonly ClaimGroup[] => {
  const groups: {
    readonly queue: JobRecord['queue']
    readonly store: AnyJobStoreToken
    handlers: HandlerEntry[]
  }[] = []

  const add = (
    handler: AnyWorkerHandler | import('../flow').AnyFlowHandler,
    definition: AnyJobDefinition,
    flow: FlowRoute | undefined,
    concurrency: number
  ): void => {
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
      concurrency,
      flow
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
      if (group.handlers.some((candidate) => candidate.identityKey === identityKey)) {
        throw new JobDefinitionError({
          field: 'flows',
          message: `duplicate handler identity ${identityKey}`
        })
      }
      group.handlers.push(entry)
    }
  }

  for (const handler of handlers) {
    add(handler, handler.job, undefined, handler.concurrency ?? options.concurrency)
  }

  for (const flow of flows) {
    if (flow.handler !== undefined) {
      add(flow.handler, flow.definition.parent, flow, options.concurrency)
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
  recordedAt: number,
  preserveCause: (cause: unknown) => void
): Promise<SettlementOutcome> => {
  if (definition.result === undefined) {
    if (value === undefined) return { type: 'complete' }
    const cause = new Error('Result codec is not configured')
    preserveCause(cause)
    return encodeFailureOutcome('Job result could not be encoded', recordedAt)
  }

  const encoded = await encodeCodec(definition.result, value)
  if (encoded.ok) return { type: 'complete', result: encoded.value }
  preserveCause(encoded.cause)
  return encodeFailureOutcome('Job result could not be encoded', recordedAt)
}

const typedFailureOutcome = async (
  definition: AnyJobDefinition,
  failure: unknown,
  recordedAt: number,
  job: ActiveJobSnapshot,
  random: WorkerRandom,
  preserveCause: (cause: unknown) => void
): Promise<SettlementOutcome> => {
  if (definition.failure === undefined) {
    return failOutcome(recordedAt)
  }

  const encoded = await encodeCodec(definition.failure, failure)

  if (!encoded.ok) {
    preserveCause(encoded.cause)
    return encodeFailureOutcome('Job failure could not be encoded', recordedAt)
  }

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

const decodeOutcome = (_cause: unknown, recordedAt: number): SettlementOutcome => ({
  type: 'fail',
  failure: makeFailure({
    kind: 'decode',
    code: 'payload-decode',
    message: 'Job payload could not be decoded',
    retryable: false,
    recordedAt
  })
})

const unwrapBetterResultCause = (cause: unknown): unknown => {
  if (Panic.is(cause) || UnhandledException.is(cause)) return cause.cause
  return cause
}

const preserveAttemptCause = (attempt: AttemptState, cause: unknown): void => {
  if (!attempt.timedOut && !attempt.failureCauseSet) {
    attempt.failureCause = cause
    attempt.failureCauseSet = true
  }
}

const failOutcome = (recordedAt: number): SettlementOutcome => ({
  type: 'fail',
  failure: makeFailure({
    kind: 'defect',
    code: 'handler-defect',
    message: 'Job handler failed',
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
  recordedAt: number,
  retryable: boolean,
  job: ActiveJobSnapshot,
  random: WorkerRandom
): SettlementOutcome =>
  retryOrFail(
    makeFailure({
      kind: 'defect',
      code: 'handler-defect',
      message: 'Job handler failed',
      retryable,
      recordedAt
    }),
    recordedAt,
    retryable,
    job,
    random
  )

const timeoutOutcome = (
  _cause: unknown,
  recordedAt: number,
  job: ActiveJobSnapshot,
  enabled = true,
  random: WorkerRandom = Math.random
): SettlementOutcome =>
  retryOrFail(
    makeFailure({
      kind: 'timeout',
      code: 'job-timeout',
      message: 'Job execution timed out',
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

const runStoreOperation = async <Value>(
  executor: AnyExecutor,
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
      const store = resolvedStore ?? (await executor.run(() => ServiceRuntime.resolve(token)))
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
  let cancelDeadline: (() => void) | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<ResultType<Value, unknown>>((resolve) => {
    const finish = (cause: StoreOperationTimeoutError): void => {
      cancelDeadline?.()
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
      resolve(Result.err(cause) as ResultType<Value, unknown>)
    }
    cancelDeadline = scheduleDeadline(timeoutMs, () =>
      finish(new StoreOperationTimeoutError(operation))
    )
    if (signal !== undefined) {
      onAbort = () => finish(new StoreOperationTimeoutError(operation))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
  })
  const result = await Promise.race([pending, interrupted])
  cancelDeadline?.()
  if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  return result
}

const cancellableDelay = (delay: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    let cancelDeadline: (() => void) | undefined
    const done = (): void => {
      cancelDeadline?.()
      signal?.removeEventListener('abort', done)
      resolve()
    }
    cancelDeadline = scheduleDeadline(delay, done)
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

const flowRouteKey = (flowName: string, parentStoreKey: string): string =>
  `${flowName}\u0000${parentStoreKey}`

const enqueueRequestFromPrepared = (
  request: import('../job/prepared').PreparedEnqueue
): import('../store').EnqueueRequest => {
  const { protocolVersion: _protocolVersion, ...enqueue } = request
  return enqueue
}

const makeFlowRoutes = (registrations: readonly WorkerFlowRegistration[]): readonly FlowRoute[] => {
  const routes: FlowRoute[] = []

  for (const registration of registrations) {
    const flow = Flow.is(registration) ? registration : registration.flow
    const parentStore = flow.parent.store
    const stores = new Map<string, AnyJobStoreToken>()
    stores.set(parentStore.serviceTag, parentStore)
    for (const child of flow.children) stores.set(child.store.serviceTag, child.store)

    const sourceFlowStores = [...stores.values()].map(
      (store) => FlowStore.for(store) as AnyFlowStoreToken
    )
    routes.push({
      key: flowRouteKey(flow.name, parentStore.serviceTag),
      flowName: flow.name,
      parentStoreKey: parentStore.serviceTag,
      definition: flow,
      handler: Flow.is(registration) ? undefined : registration,
      parentFlowStore: sourceFlowStores[0]!,
      sourceFlowStores: Object.freeze(sourceFlowStores),
      childStores: stores
    })
  }

  return Object.freeze(routes)
}

const isAnyJobDefinition = (value: unknown): value is AnyJobDefinition => Job.is(value)

const readFlowContext = (
  metadata: Readonly<Record<string, string>>
): ResultType<FlowMetadata, JobDefinitionError> => {
  const flowName = metadata[flowMetadataKeys.flowName]
  const flowIdValue = metadata[flowMetadataKeys.flowId]
  const childKey = metadata[flowMetadataKeys.childKey]
  const parentStoreKey = metadata[flowMetadataKeys.parentStoreKey]
  const depthValue = metadata[flowMetadataKeys.depth]
  const chainValue = metadata[flowMetadataKeys.chain]
  const anyPresent = [flowName, flowIdValue, childKey, parentStoreKey, depthValue, chainValue].some(
    (value) => value !== undefined
  )
  if (!anyPresent) {
    return Result.ok({
      flowName: '',
      flowId: JobId.make('root').unwrap(),
      childKey: '',
      parentStoreKey: '',
      depth: 0,
      chain: []
    })
  }
  if (
    flowName === undefined ||
    flowIdValue === undefined ||
    childKey === undefined ||
    parentStoreKey === undefined ||
    depthValue === undefined ||
    chainValue === undefined
  ) {
    return Result.err(
      new JobDefinitionError({
        field: 'flow.metadata',
        message: 'contains incomplete flow context'
      })
    )
  }
  const flowId = makeJobId(flowIdValue)
  if (Result.isError(flowId)) return Result.err(flowId.error)
  const depth = Number(depthValue)
  if (!Number.isSafeInteger(depth) || depth < 1) {
    return Result.err(
      new JobDefinitionError({
        field: 'flow.metadata.depth',
        message: 'must be a positive integer'
      })
    )
  }
  let chain: unknown
  try {
    chain = JSON.parse(chainValue)
  } catch {
    return Result.err(
      new JobDefinitionError({ field: 'flow.metadata.chain', message: 'must be JSON' })
    )
  }
  if (
    !Array.isArray(chain) ||
    chain.some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    return Result.err(
      new JobDefinitionError({ field: 'flow.metadata.chain', message: 'must be a string array' })
    )
  }
  return Result.ok({
    flowName,
    flowId: flowId.value,
    childKey,
    parentStoreKey,
    depth,
    chain: Object.freeze(chain as string[])
  })
}

const makeFlowChildMetadata = (
  route: FlowRoute,
  flowId: JobId,
  childKey: string,
  depth: number,
  chain: readonly string[],
  supplied: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> =>
  Object.freeze({
    ...supplied,
    [flowMetadataKeys.flowName]: route.flowName,
    [flowMetadataKeys.flowId]: flowId,
    [flowMetadataKeys.childKey]: childKey,
    [flowMetadataKeys.parentStoreKey]: route.parentStoreKey,
    [flowMetadataKeys.depth]: String(depth),
    [flowMetadataKeys.chain]: JSON.stringify(chain)
  })

const flowFailureForParent = (failure: SerializedJobFailure | undefined): unknown => {
  if (failure?.kind === 'typed' && failure.data !== undefined) return failure.data
  return new Error(failure?.message ?? 'Flow child failed')
}

const decodeFlowValue = async (
  codec: CodecLike | undefined,
  value: JsonValue | undefined
): Promise<ResultType<unknown, unknown>> => {
  if (value === undefined) return Result.ok(undefined)
  if (codec === undefined) {
    return Result.err(new JobDefinitionError({ field: 'flow.results', message: 'missing codec' }))
  }
  try {
    const decoded = await Promise.resolve(codec.decode(value as never))
    if (!isResultLike(decoded)) {
      return Result.err(
        new JobDefinitionError({
          field: 'flow.results',
          message: 'codec returned an invalid Result'
        })
      )
    }
    return Result.isError(decoded) ? Result.err(decoded.error) : Result.ok(decoded.value)
  } catch (cause) {
    return Result.err(cause)
  }
}

const makeFlowResults = (
  route: FlowRoute,
  flowId: JobId,
  executor: AnyExecutor,
  defaultPageSize: number,
  initial: import('../store').FlowSnapshot,
  resolvedStore?: FlowStoreV2
): import('../flow').FlowResults<any> => {
  const load = async (): Promise<ResultType<import('../store').FlowSnapshot, unknown>> => {
    try {
      const token = route.parentFlowStore
      const store =
        resolvedStore ?? ((await executor.run(() => ServiceRuntime.resolve(token))) as FlowStoreV2)
      const value = await Promise.resolve(store.getFlow({ flowId }))
      if (!isResultLike(value))
        return Result.err(new Error('FlowStore operation did not return a Result'))
      if (Result.isError(value)) return Result.err(value.error)
      if (value.value === undefined) return Result.err(new JobNotFoundError({ jobId: flowId }))
      return Result.ok(value.value)
    } catch (cause) {
      return Result.err(new WorkerRuntimeOwnershipError(cause))
    }
  }

  const definitionFor = (child: FlowChildRecord): AnyJobDefinition | undefined =>
    route.definition.children.find(
      (candidate) =>
        candidate.name === child.name &&
        candidate.version === child.version &&
        candidate.store.serviceTag === child.storeKey
    )

  const settledChild = async (
    child: FlowChildRecord
  ): Promise<ResultType<import('../flow').FlowSettledChild<any>, unknown>> => {
    const definition = definitionFor(child)
    if (definition === undefined) {
      return Result.err(
        new JobDefinitionError({
          field: 'flow.results',
          message: `unknown child definition ${child.name}@${child.version}`
        })
      )
    }
    const result = await decodeFlowValue(definition.result, child.result)
    if (Result.isError(result)) return Result.err(result.error)
    const failure =
      child.failure?.kind === 'typed'
        ? await decodeFlowValue(definition.failure, child.failure.data)
        : Result.ok(undefined)
    if (Result.isError(failure)) return Result.err(failure.error)
    return Result.ok({
      childKey: child.childKey,
      definition,
      outcome: child.status as 'completed' | 'failed' | 'cancelled',
      result: result.value as never,
      failure: failure.value as never
    } as import('../flow').FlowSettledChild<any>)
  }

  const readPage = async (options: {
    readonly cursor?: string
    readonly limit?: number
  }): Promise<ResultType<import('../flow').FlowChildPage<any>, unknown>> => {
    const limit = options.limit ?? defaultPageSize
    if (!Number.isSafeInteger(limit) || limit < 1) {
      return Result.err(
        new JobDefinitionError({ field: 'results.page.limit', message: 'must be positive' })
      )
    }
    const current = await load()
    if (Result.isError(current)) return Result.err(current.error)
    const children = current.value.children
    const cursorIndex =
      options.cursor === undefined
        ? -1
        : children.findIndex((child) => child.childKey === options.cursor)
    const start = cursorIndex < 0 ? 0 : cursorIndex + 1
    const selected = children.slice(start, start + limit)
    const items: import('../flow').FlowSettledChild<any>[] = []
    for (const child of selected) {
      const settled = await settledChild(child)
      if (Result.isError(settled)) return Result.err(settled.error)
      items.push(settled.value)
    }
    return Result.ok({
      items: Object.freeze(items),
      nextCursor:
        start + selected.length < children.length && selected.length > 0
          ? selected.at(-1)!.childKey
          : undefined
    })
  }

  const page = (options: { readonly cursor?: string; readonly limit?: number } = {}) =>
    Program.named('better-effect-mq/flow/results/page', (async () =>
      readPage(options)) as unknown as import('better-effect').Effect.Program<
      import('../flow').FlowChildPage<any>,
      import('../store').FlowStoreV2Error,
      import('better-effect').AnyService
    >) as import('better-effect').Effect.Program<
      import('../flow').FlowChildPage<any>,
      import('../store').FlowStoreV2Error,
      never
    >

  const all = (options: { readonly maxItems?: number } = {}) =>
    Program.named('better-effect-mq/flow/results/all', (async () => {
      const maxItems = options.maxItems
      if (maxItems !== undefined && (!Number.isSafeInteger(maxItems) || maxItems < 0)) {
        return Result.err(
          new JobDefinitionError({ field: 'results.all.maxItems', message: 'must be non-negative' })
        )
      }
      const values: import('../flow').FlowSettledChild<any>[] = []
      let cursor: string | undefined
      while (true) {
        const current = await readPage(
          cursor === undefined ? { limit: defaultPageSize } : { cursor, limit: defaultPageSize }
        )
        if (Result.isError(current)) return current
        values.push(...current.value.items)
        if (maxItems !== undefined && values.length >= maxItems) {
          values.length = maxItems
          break
        }
        if (current.value.nextCursor === undefined) break
        cursor = current.value.nextCursor
      }
      return Result.ok(Object.freeze(values))
    }) as unknown as import('better-effect').Effect.Program<
      readonly import('../flow').FlowSettledChild<any>[],
      import('../store').FlowStoreV2Error,
      import('better-effect').AnyService
    >) as import('better-effect').Effect.Program<
      readonly import('../flow').FlowSettledChild<any>[],
      import('../store').FlowStoreV2Error,
      never
    >

  const forEach = (
    fn: (
      child: import('../flow').FlowSettledChild<any>
    ) => import('better-effect').Effect.Program<void, unknown, import('better-effect').AnyService>,
    options: { readonly pageSize?: number; readonly concurrency?: number } = {}
  ) =>
    Program.named('better-effect-mq/flow/results/forEach', (async () => {
      const concurrency = options.concurrency ?? 1
      if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        return Result.err(
          new JobDefinitionError({
            field: 'results.forEach.concurrency',
            message: 'must be positive'
          })
        )
      }
      const values = await readPage({ limit: options.pageSize ?? defaultPageSize })
      if (Result.isError(values)) return values
      let cursor = values.value.nextCursor
      const process = async (items: readonly import('../flow').FlowSettledChild<any>[]) => {
        let next = 0
        let firstError: unknown
        const run = async (): Promise<void> => {
          while (firstError === undefined) {
            const index = next++
            if (index >= items.length) return
            try {
              const result = (await executor.run(
                () => fn(items[index]!)() as never
              )) as UnknownResult
              if (!isResultLike(result)) {
                if (firstError === undefined)
                  firstError = new Error('Flow callback returned an invalid Result')
              } else if (Result.isError(result) && firstError === undefined) {
                firstError = result.error
              }
            } catch (cause) {
              if (firstError === undefined) firstError = cause
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()))
        if (firstError !== undefined) return Result.err(firstError)
        return Result.ok(undefined)
      }
      let processed = await process(values.value.items)
      if (Result.isError(processed)) return processed
      while (cursor !== undefined) {
        const next = await readPage(
          cursor === undefined
            ? { limit: options.pageSize ?? defaultPageSize }
            : { cursor, limit: options.pageSize ?? defaultPageSize }
        )
        if (Result.isError(next)) return next
        processed = await process(next.value.items)
        if (Result.isError(processed)) return processed
        cursor = next.value.nextCursor
      }
      return Result.ok(undefined)
    }) as unknown as import('better-effect').Effect.Program<
      void,
      import('../store').FlowStoreV2Error,
      import('better-effect').AnyService
    >) as import('better-effect').Effect.Program<void, import('../store').FlowStoreV2Error, never>

  return {
    counts: initial.parent.flow,
    page,
    all,
    forEach
  }
}

const observationForChild = (
  childKey: string,
  job: JobRecord | undefined
): FlowChildObservation => {
  if (job === undefined) return { childKey, state: 'missing' }

  switch (job.state) {
    case 'waiting':
    case 'delayed':
    case 'active':
      return { childKey, state: job.state }
    case 'completed':
    case 'failed':
    case 'cancelled':
      return {
        childKey,
        state: job.state,
        ...(job.result === undefined ? {} : { result: job.result }),
        ...(job.failure === undefined ? {} : { failure: job.failure })
      }
  }
}

const isTerminalJobState = (state: JobRecord['state']): boolean =>
  state === 'completed' || state === 'failed' || state === 'cancelled'

const normalizeFlowSweepIds = (value: unknown): readonly JobId[] => {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) {
    throw new JobDefinitionError({ field: 'flowSweepFlowIds', message: 'must be an array' })
  }

  const seen = new Set<JobId>()
  const ids: JobId[] = []
  for (const [index, candidate] of value.entries()) {
    const id = makeJobId(candidate)
    if (Result.isError(id)) {
      throw new JobDefinitionError({
        field: `flowSweepFlowIds[${index}]`,
        message: id.error.message
      })
    }
    if (seen.has(id.value)) {
      throw new JobDefinitionError({
        field: `flowSweepFlowIds[${index}]`,
        message: `duplicate flow id ${id.value}`
      })
    }
    seen.add(id.value)
    ids.push(id.value)
  }
  return Object.freeze(ids)
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
      waiter.timer = scheduleDeadline(options.timeoutMs, () =>
        waiter.reject(new WorkerAwaitIdleError('timeout', 'Worker awaitIdle timed out'))
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
    waiter.timer()
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
