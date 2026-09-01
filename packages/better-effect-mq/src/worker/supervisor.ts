// oxlint-disable anti-slop/no-runtime-typeof -- Worker validates handler, clock, and store results at JavaScript boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- store and handler adapters are intentionally untyped at this erased boundary.
// oxlint-disable anti-slop/no-unknown-returns -- Result and codec values are normalized immediately after crossing a boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- heterogeneous handlers and store operations are erased in one module.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below are localized to checked runtime boundaries.

import { Effect, Runtime } from 'better-effect'
import { Result, UnhandledException, type Result as ResultType } from 'better-result'

import { type AnyJobDefinition, type CodecLike } from '../job'
import { parseJsonValue } from '../internal/json'
import {
  JobDefinitionError,
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
  JobStoreContract,
  JobStoreOperation
} from '../store'

import { JobContext } from './context'
import { WorkerAwaitIdleError } from './errors'
import type {
  AnyWorkerHandler,
  WorkerAwaitIdleOptions,
  WorkerErrorHandler,
  WorkerHandle,
  WorkerOptions,
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

type AttemptState = {
  readonly key: string
  readonly entry: HandlerEntry
  readonly job: ActiveJobSnapshot
  readonly controller: AbortController
  promise: Promise<void>
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

const defaultConcurrency = 1
const defaultLeaseDurationMs = 30_000
const defaultPollIntervalMs = 100

export class WorkerSupervisor implements WorkerHandle {
  private readonly workerId: NormalizedWorkerOptions['id']

  private currentState: WorkerHandle['state'] = 'running'
  private stopPromise: Promise<void> | undefined
  private active = 0
  private reserved = 0
  private readonly reservedByQueue = new Map<string, number>()
  private readonly activeByHandler = new Map<string, number>()
  private readonly activeAttempts = new Map<string, AttemptState>()
  private readonly groupTasks = new Set<Promise<void>>()
  private readonly slotWaiters = new Set<() => void>()
  private readonly idleWaiters = new Set<Waiter>()
  private readonly claimController = new AbortController()
  private readonly groups: readonly ClaimGroup[]
  private readonly runtime: AnyRuntime
  private readonly workerOptions: NormalizedWorkerOptions

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
    this.claimController.abort()

    if (normalizedOptions.abortActive === true) {
      this.abortActiveAttempts()
    }

    this.stopPromise = this.finishStop()
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

  private async finishStop(): Promise<void> {
    await Promise.allSettled(this.groupTasks)
    await Promise.allSettled([...this.activeAttempts.values()].map((attempt) => attempt.promise))
    this.currentState = 'stopped'
    this.notifySlots()
    this.notifyIdle()
  }

  private abortActiveAttempts(): void {
    for (const attempt of this.activeAttempts.values()) {
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
    const now = this.readNow()
    const request = {
      queue: plan.group.queue,
      accepted: plan.handlers.map((entry) => entry.definition.identity),
      limit: plan.limit,
      workerId: this.id,
      leaseDurationMs: this.workerOptions.leaseDurationMs,
      now
    }

    return runStoreOperation<ClaimResult>(this.runtime, plan.group.store, (store) =>
      store.claim(request)
    )
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
      promise: Promise.resolve()
    }

    this.active += 1
    increment(this.activeByHandler, entry.identityKey)
    this.activeAttempts.set(key, attempt)

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
    const startedAt = this.readNow()
    let outcome: SettlementOutcome

    try {
      const result = await this.executeProgram(attempt, context)
      outcome = await this.makeOutcome(attempt.entry.definition, result)
    } catch (cause) {
      this.report(cause)
      outcome = failOutcome(safeCauseMessage(cause), this.readNow())
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

  private async makeOutcome(
    definition: AnyJobDefinition,
    result: unknown
  ): Promise<SettlementOutcome> {
    const recordedAt = this.readNow()

    if (!isResultLike(result)) {
      return failOutcome('Handler did not return a Result', recordedAt)
    }

    if (Result.isError(result)) {
      if (result.error instanceof DecodeOutcome) {
        return decodeOutcome(result.error.cause, recordedAt)
      }

      return typedFailureOutcome(definition, result.error, recordedAt)
    }

    return completeOutcome(definition, result.value, recordedAt)
  }

  private async settleJob(
    group: ClaimGroup,
    job: ActiveJobSnapshot,
    outcome: SettlementOutcome,
    startedAt: number
  ): Promise<void> {
    const result = await runStoreOperation(this.runtime, group.store, (store) =>
      store.settle({
        jobId: job.id,
        leaseToken: job.leaseToken,
        outcome,
        now: this.readNow(),
        startedAt
      })
    )

    if (Result.isError(result)) {
      this.report(result.error)
    }
  }

  private async releaseJob(group: ClaimGroup, job: ActiveJobSnapshot): Promise<void> {
    const result = await runStoreOperation(this.runtime, group.store, (store) =>
      store.release({ jobId: job.id, leaseToken: job.leaseToken, now: this.readNow() })
    )

    if (Result.isError(result)) {
      this.report(result.error)
    }
  }

  private finishAttempt(attempt: AttemptState): void {
    this.active -= 1
    decrement(this.activeByHandler, attempt.entry.identityKey)
    this.activeAttempts.delete(attempt.key)
    this.notifySlots()
    this.notifyIdle()
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
  readonly pollIntervalMs: number
  readonly now: () => number
  readonly onError: WorkerErrorHandler | undefined
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
  const leaseDurationMs = positiveInteger(
    readOption(options, 'leaseDurationMs') ?? defaultLeaseDurationMs,
    'leaseDurationMs'
  )
  const pollIntervalMs = nonNegativeInteger(
    readOption(options, 'pollIntervalMs') ?? defaultPollIntervalMs,
    'pollIntervalMs'
  )
  const id = normalizeWorkerId(readOption(options, 'id'), readOption(options, 'workerId'))
  const queueLimits = normalizeQueueLimits(readOption(options, 'queueConcurrency'), concurrency)
  const now = normalizeClock(readOption(options, 'now'))
  const onError = readOption(options, 'onError')

  if (onError !== undefined && typeof onError !== 'function') {
    throw new JobDefinitionError({ field: 'onError', message: 'must be callable' })
  }

  return {
    id,
    concurrency,
    queueLimit: (queue) => queueLimits.named.get(queue) ?? queueLimits.defaultLimit,
    leaseDurationMs,
    pollIntervalMs,
    now,
    onError: onError as WorkerErrorHandler | undefined
  }
}

const makeGroups = (
  handlers: readonly AnyWorkerHandler[],
  options: NormalizedWorkerOptions
): readonly ClaimGroup[] => {
  const groups = new Map<
    string,
    {
      readonly queue: JobRecord['queue']
      readonly store: AnyJobStoreToken
      handlers: HandlerEntry[]
    }
  >()

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
    const key = JSON.stringify([definition.store.serviceTag, queue.value])
    const group = groups.get(key)

    if (group === undefined) {
      groups.set(key, { queue: queue.value, store: definition.store, handlers: [entry] })
    } else {
      group.handlers.push(entry)
    }
  }

  return [...groups.entries()].map(([key, group]) => ({
    key,
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
      : failOutcome('Result codec is not configured', recordedAt)
  }

  const encoded = await encodeCodec(definition.result, value)
  return encoded.ok
    ? { type: 'complete', result: encoded.value }
    : failOutcome(safeCauseMessage(encoded.cause), recordedAt)
}

const typedFailureOutcome = async (
  definition: AnyJobDefinition,
  failure: unknown,
  recordedAt: number
): Promise<SettlementOutcome> => {
  if (definition.failure === undefined) {
    return failOutcome('Failure codec is not configured', recordedAt)
  }

  const encoded = await encodeCodec(definition.failure, failure)

  if (!encoded.ok) {
    return failOutcome(safeCauseMessage(encoded.cause), recordedAt)
  }

  return {
    type: 'fail',
    failure: makeFailure({
      kind: 'typed',
      code: 'handler-failure',
      message: 'Handler returned a typed failure',
      data: encoded.value,
      retryable: false,
      recordedAt
    })
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
  operation: (store: JobStoreContract) => StoreOperation<Value>
): Promise<ResultType<Value, unknown>> =>
  runtime.run(
    () =>
      Effect.gen(async function* () {
        const store = yield* token
        const value = yield* Result.await(Promise.resolve(operation(store)))
        return Result.ok(value)
      }) as never
  ) as Promise<ResultType<Value, unknown>>

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
