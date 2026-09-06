// oxlint-disable anti-slop/no-runtime-typeof -- publisher options and adapter outcomes cross public JavaScript boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- callbacks and persisted adapter values are intentionally untyped at this boundary.
// oxlint-disable anti-slop/no-unknown-returns -- Result and rejected operation outcomes are normalized before use.
// oxlint-disable anti-slop/no-chained-type-assertions -- heterogeneous Service and adapter values are erased only at validated boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below are confined to token and Result boundaries.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional event and failure fields are omitted from snapshots.

import { Layer, Runtime, Service, ServiceRuntime } from 'better-effect'
import type {
  AnyService,
  AnyServiceToken,
  Layer as LayerType,
  RuntimeExecutor,
  ServiceRequirement,
  ServiceToken
} from 'better-effect'
import {
  JobDefinitionError,
  JobStoreFailure,
  assertJobStoreProtocolCompatible,
  type EnqueueRequest,
  type EnqueueResult,
  type JobStoreContract,
  type JobStoreError,
  type JobStoreOperation,
  type PreparedEnqueue
} from 'better-effect-mq'
import { Result, type Result as ResultType } from 'better-result'

import { makeSerializedOutboxFailure } from './OutboxRecord'
import { validatePreparedEnqueue } from 'better-effect-mq'
import type { OutboxFailureKind, SerializedOutboxFailure } from './OutboxRecord'
import {
  OutboxDefinitionError,
  OutboxLeaseLostError,
  OutboxRouteMissingError,
  OutboxStoreFailure
} from './errors'
import type { OutboxStoreError } from './errors'
import { makeOutboxWorkerId } from './identity'
import type { OutboxWorkerId } from './identity'
import { OutboxRoutes } from './routing'
import type { OutboxRouteMap, OutboxRouteStores } from './routing'
import type { LeasedOutboxRecord, OutboxOperation, OutboxStore } from './OutboxStore'

export type OutboxStoreTokenLike = (abstract new (...args: never[]) => OutboxStore & AnyService) & {
  readonly serviceTag: string
  readonly [Symbol.iterator]: AnyServiceToken[typeof Symbol.iterator]
}
export type AnyOutboxStoreTokenLike = OutboxStoreTokenLike

export type OutboxPublisherClock =
  | (() => number | Date)
  | {
      readonly now: () => number | Date
    }

export type OutboxPublisherErrorHandler = (cause: unknown) => void | PromiseLike<void>

export type OutboxPublisherEvent =
  | {
      readonly type: 'publisher-started' | 'publisher-stopping' | 'publisher-stopped'
      readonly recordedAt: number
      readonly workerId: OutboxWorkerId
    }
  | {
      readonly type: 'claimed'
      readonly recordedAt: number
      readonly workerId: OutboxWorkerId
      readonly outboxId: string
      readonly target: string
      readonly attempt: number
    }
  | {
      readonly type: 'enqueued'
      readonly recordedAt: number
      readonly workerId: OutboxWorkerId
      readonly outboxId: string
      readonly target: string
      readonly duplicate: boolean
    }
  | {
      readonly type: 'route-missing'
      readonly recordedAt: number
      readonly workerId: OutboxWorkerId
      readonly outboxId: string
      readonly target: string
    }
  | {
      readonly type: 'retry-scheduled'
      readonly recordedAt: number
      readonly workerId: OutboxWorkerId
      readonly outboxId: string
      readonly target: string
      readonly retryAt: number
      readonly kind: OutboxFailureKind
    }
  | {
      readonly type: 'failed'
      readonly recordedAt: number
      readonly workerId: OutboxWorkerId
      readonly outboxId: string
      readonly target: string
      readonly kind: OutboxFailureKind
    }
  | {
      readonly type: 'lease-lost'
      readonly recordedAt: number
      readonly workerId: OutboxWorkerId
      readonly outboxId: string
      readonly target: string
      readonly reason: string
    }

export interface OutboxPublisherObserver {
  readonly onEvent: (event: OutboxPublisherEvent) => void | PromiseLike<void>
}

export interface OutboxPublisherReliabilityOptions {
  readonly leaseDurationMs?: number
  readonly heartbeatIntervalMs?: number
  readonly pollIntervalMs?: number
  readonly retryBaseDelayMs?: number
  readonly retryMaxDelayMs?: number
}

export interface OutboxPublisherOptions<
  Outboxes extends readonly OutboxStoreTokenLike[] = readonly OutboxStoreTokenLike[],
  Routes extends OutboxRouteMap = OutboxRouteMap
> extends OutboxPublisherReliabilityOptions {
  readonly outboxes: Outboxes
  readonly routes: OutboxRoutes<Routes>
  readonly concurrency?: number
  readonly workerId?: OutboxWorkerId
  readonly id?: OutboxWorkerId
  readonly now?: OutboxPublisherClock
  readonly onError?: OutboxPublisherErrorHandler
  readonly observer?: OutboxPublisherObserver
}

export interface OutboxPublisherHandle extends AsyncDisposable {
  readonly id: OutboxWorkerId
  readonly state: 'running' | 'stopping' | 'stopped'
  readonly activeCount: number
  quiesce(): void
  stop(): Promise<void>
}

type PublisherFactoryOptions<
  Outboxes extends readonly OutboxStoreTokenLike[],
  Routes extends OutboxRouteMap
> = OutboxPublisherOptions<Outboxes, Routes>

type PublisherValueFactory<
  Outboxes extends readonly OutboxStoreTokenLike[],
  Routes extends OutboxRouteMap
> = () =>
  | PublisherFactoryOptions<Outboxes, Routes>
  | PromiseLike<PublisherFactoryOptions<Outboxes, Routes>>

export type OutboxPublisherGeneratorFactory<
  Outboxes extends readonly OutboxStoreTokenLike[],
  Routes extends OutboxRouteMap,
  Yield extends ServiceRequirement<unknown>
> = () =>
  | Generator<Yield, PublisherFactoryOptions<Outboxes, Routes>, unknown>
  | AsyncGenerator<Yield, PublisherFactoryOptions<Outboxes, Routes>, unknown>

type PublisherFactoryResult<
  Outboxes extends readonly OutboxStoreTokenLike[],
  Routes extends OutboxRouteMap,
  Yield extends ServiceRequirement<unknown>
> =
  | PublisherFactoryOptions<Outboxes, Routes>
  | PromiseLike<PublisherFactoryOptions<Outboxes, Routes>>
  | Generator<Yield, PublisherFactoryOptions<Outboxes, Routes>, unknown>
  | AsyncGenerator<Yield, PublisherFactoryOptions<Outboxes, Routes>, unknown>

type PublisherFactoryInput<
  Outboxes extends readonly OutboxStoreTokenLike[],
  Routes extends OutboxRouteMap,
  Yield extends ServiceRequirement<unknown>
> = () => PublisherFactoryResult<Outboxes, Routes, Yield>

type FactoryYieldRequirements<Yield extends ServiceRequirement<unknown>> =
  Yield extends ServiceRequirement<infer Requirement>
    ? Requirement extends AnyService
      ? Requirement
      : never
    : never

type ServiceInstanceOf<Token> = Token extends abstract new (...args: never[]) => infer Instance
  ? Instance
  : never

type TokenInstances<Tokens extends readonly unknown[]> = ServiceInstanceOf<Tokens[number]>

export type OutboxPublisherRequirements<
  Outboxes extends readonly OutboxStoreTokenLike[],
  Routes extends OutboxRouteMap
> = TokenInstances<Outboxes> | InstanceType<OutboxRouteStores<Routes>>

export type OutboxPublisherLayerRequirements<
  Outboxes extends readonly OutboxStoreTokenLike[],
  Routes extends OutboxRouteMap,
  Yield extends ServiceRequirement<unknown>
> = OutboxPublisherRequirements<Outboxes, Routes> | FactoryYieldRequirements<Yield>

export type OutboxPublisherServiceTag<Tag extends string> = string extends Tag
  ? never
  : Tag extends ''
    ? never
    : Tag

export type OutboxPublisherServiceInstance<Tag extends string> = OutboxPublisherHandle &
  Service.Identity<Tag>

export type OutboxPublisherServiceToken<Tag extends string> = ServiceToken<
  Tag,
  OutboxPublisherServiceInstance<Tag>
> & {
  readonly [Symbol.iterator]: () => Generator<
    ServiceRequirement<OutboxPublisherServiceInstance<Tag>>,
    OutboxPublisherServiceInstance<Tag>,
    unknown
  >
  readonly [Symbol.asyncIterator]: () => AsyncGenerator<
    ServiceRequirement<OutboxPublisherServiceInstance<Tag>>,
    OutboxPublisherServiceInstance<Tag>,
    unknown
  >
  readonly layer: OutboxPublisherServiceLayerMethod<Tag>
}

type OutboxPublisherServiceLayerMethod<Tag extends string> = {
  <
    const Outboxes extends readonly OutboxStoreTokenLike[],
    const Routes extends OutboxRouteMap,
    Yield extends ServiceRequirement<unknown>
  >(
    factory: OutboxPublisherGeneratorFactory<Outboxes, Routes, Yield>
  ): LayerType<
    OutboxPublisherServiceInstance<Tag>,
    OutboxPublisherLayerRequirements<Outboxes, Routes, Yield>
  >
  <const Outboxes extends readonly OutboxStoreTokenLike[], const Routes extends OutboxRouteMap>(
    factory: PublisherValueFactory<Outboxes, Routes>
  ): LayerType<OutboxPublisherServiceInstance<Tag>, OutboxPublisherRequirements<Outboxes, Routes>>
}

type OperationOutcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: unknown }

type EnqueueFailureClassification = {
  readonly kind: OutboxFailureKind
  readonly retryable: boolean
}

type ResolvedOutbox = {
  readonly token: OutboxStoreTokenLike
  readonly store: OutboxStore
}

type NormalizedPublisherOptions = {
  readonly id: OutboxWorkerId
  readonly outboxes: readonly ResolvedOutbox[]
  readonly routes: OutboxRoutes<OutboxRouteMap>
  readonly routeStores: ReadonlyMap<string, JobStoreContract>
  readonly concurrency: number
  readonly leaseDurationMs: number
  readonly heartbeatIntervalMs: number
  readonly pollIntervalMs: number
  readonly retryBaseDelayMs: number
  readonly retryMaxDelayMs: number
  readonly now: () => number
  readonly onError: OutboxPublisherErrorHandler
  readonly observer: OutboxPublisherObserver | undefined
}

type ActivePublish = {
  readonly key: string
  readonly outbox: ResolvedOutbox
  readonly record: LeasedOutboxRecord
  promise: Promise<void>
  lost: boolean
}

const minimumLeaseDurationMs = 10
const defaultConcurrency = 1
const defaultLeaseDurationMs = 30_000
const defaultPollIntervalMs = 100
const defaultRetryBaseDelayMs = 100
const defaultRetryMaxDelayMs = 30_000
const maximumSettlementAttempts = 3

const noOpErrorHandler: OutboxPublisherErrorHandler = () => undefined
const noOpObserver: OutboxPublisherObserver = Object.freeze({ onEvent: () => undefined })

const awaitOperation = async <Value>(
  operation: OutboxOperation<Value, OutboxStoreError> | JobStoreOperation<Value, JobStoreError>
): Promise<OperationOutcome<Value>> => {
  try {
    const result = await operation
    const checked = result as ResultType<Value, unknown>
    if (Result.isError(checked)) return { ok: false, error: checked.error }
    return { ok: true, value: checked.value }
  } catch (error) {
    return { ok: false, error }
  }
}

class OutboxPublisherSupervisor implements OutboxPublisherHandle {
  private currentState: OutboxPublisherHandle['state'] = 'running'
  private quiesced = false
  private stopPromise: Promise<void> | undefined
  private claimTask: Promise<void> | undefined
  private heartbeatTask: Promise<void> | undefined
  private readonly claimController = new AbortController()
  private readonly supervisionController = new AbortController()
  private readonly active = new Map<string, ActivePublish>()
  private readonly compensationTasks = new Set<Promise<void>>()

  constructor(private readonly options: NormalizedPublisherOptions) {}

  get id(): OutboxWorkerId {
    return this.options.id
  }

  get state(): OutboxPublisherHandle['state'] {
    return this.currentState
  }

  get activeCount(): number {
    return this.active.size
  }

  start(): void {
    this.claimTask = this.runClaimLoop()
    this.heartbeatTask = this.runHeartbeatLoop()
    this.observeTask(this.claimTask)
    this.observeTask(this.heartbeatTask)
    this.emit({ type: 'publisher-started', recordedAt: this.readNow(), workerId: this.id })
  }

  quiesce(): void {
    if (this.quiesced) return
    this.quiesced = true
    this.claimController.abort()
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
    this.currentState = 'stopping'
    this.emit({ type: 'publisher-stopping', recordedAt: this.readNow(), workerId: this.id })
    this.quiesce()
    this.stopPromise = this.finishStop()
    return this.stopPromise
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop()
  }

  private async finishStop(): Promise<void> {
    await Promise.allSettled(this.claimTask === undefined ? [] : [this.claimTask])
    await Promise.allSettled(this.compensationTasks)
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((active) => active.promise))
    }
    this.supervisionController.abort()
    await Promise.allSettled(this.heartbeatTask === undefined ? [] : [this.heartbeatTask])
    this.currentState = 'stopped'
    this.emit({ type: 'publisher-stopped', recordedAt: this.readNow(), workerId: this.id })
  }

  private async runClaimLoop(): Promise<void> {
    while (!this.quiesced && this.currentState === 'running') {
      const capacity = this.options.concurrency - this.active.size
      if (capacity <= 0) {
        await this.sleep(this.options.pollIntervalMs, this.claimController.signal)
        continue
      }

      let claimed = 0
      for (const outbox of this.options.outboxes) {
        if (this.quiesced || this.currentState !== 'running' || claimed >= capacity) break
        const outcome = await awaitOperation<readonly LeasedOutboxRecord[]>(
          outbox.store.claim({
            owner: this.id,
            limit: capacity - claimed,
            leaseDurationMs: this.options.leaseDurationMs,
            nowMs: this.readNow()
          })
        )
        if (!outcome.ok) {
          this.report(outcome.error)
          continue
        }
        claimed += outcome.value.length
        for (const record of outcome.value) {
          if (this.quiesced || this.currentState !== 'running') {
            await this.releaseClaim(outbox, record)
          } else {
            this.admit(outbox, record)
          }
        }
      }

      if (claimed === 0) await this.sleep(this.options.pollIntervalMs, this.claimController.signal)
    }
  }

  private async runHeartbeatLoop(): Promise<void> {
    while (!this.supervisionController.signal.aborted) {
      await this.sleep(this.options.heartbeatIntervalMs, this.supervisionController.signal)
      if (this.supervisionController.signal.aborted) return
      await Promise.allSettled([...this.active.values()].map((active) => this.heartbeat(active)))
    }
  }

  private admit(outbox: ResolvedOutbox, record: LeasedOutboxRecord): void {
    const key = `${outbox.token.serviceTag}\u0000${record.id}`
    if (this.active.has(key)) {
      const task = this.releaseClaim(outbox, record)
      this.compensationTasks.add(task)
      this.observeTask(task)
      void task.then(
        () => this.compensationTasks.delete(task),
        () => this.compensationTasks.delete(task)
      )
      return
    }

    const active: ActivePublish = {
      key,
      outbox,
      record,
      promise: Promise.resolve(),
      lost: false
    }
    this.active.set(key, active)
    this.emit({
      type: 'claimed',
      recordedAt: this.readNow(),
      workerId: this.id,
      outboxId: record.id,
      target: record.target,
      attempt: record.attemptsMade
    })
    const task = this.publish(active)
    active.promise = task
    this.observeTask(task, () => this.active.delete(key))
  }

  private async publish(active: ActivePublish): Promise<void> {
    const prepared = validatePreparedEnqueue(active.record.request)
    if (Result.isError(prepared)) {
      await this.settleFailure(active, 'request-invalid', false, prepared.error)
      return
    }

    const routeToken = this.options.routes.get(active.record.target)
    const routeStore =
      routeToken === undefined ? undefined : this.options.routeStores.get(routeToken.serviceTag)
    if (routeToken === undefined || routeStore === undefined) {
      const missing = new OutboxRouteMissingError({
        target: active.record.target,
        outboxId: active.record.id
      })
      this.emit({
        type: 'route-missing',
        recordedAt: this.readNow(),
        workerId: this.id,
        outboxId: active.record.id,
        target: active.record.target
      })
      await this.settleFailure(active, 'target-missing', true, missing)
      return
    }

    const request = toEnqueueRequest(prepared.value)
    const enqueued = await awaitOperation<EnqueueResult>(routeStore.enqueue(request))
    if (!enqueued.ok) {
      const failure = classifyEnqueueFailure(enqueued.error)
      await this.settleFailure(active, failure.kind, failure.retryable, enqueued.error)
      return
    }

    this.emit({
      type: 'enqueued',
      recordedAt: this.readNow(),
      workerId: this.id,
      outboxId: active.record.id,
      target: active.record.target,
      duplicate: enqueued.value.duplicate
    })
    await this.markPublished(active)
  }

  private async heartbeat(active: ActivePublish): Promise<void> {
    if (active.lost) return
    const outcome = await awaitOperation(
      active.outbox.store.heartbeat({
        id: active.record.id,
        leaseToken: active.record.leaseToken,
        leaseDurationMs: this.options.leaseDurationMs,
        nowMs: this.readNow()
      })
    )
    if (outcome.ok) return
    if (OutboxLeaseLostError.is(outcome.error)) {
      active.lost = true
      this.emit({
        type: 'lease-lost',
        recordedAt: this.readNow(),
        workerId: this.id,
        outboxId: active.record.id,
        target: active.record.target,
        reason: outcome.error.reason
      })
      return
    }
    this.report(outcome.error)
  }

  private async markPublished(active: ActivePublish): Promise<void> {
    if (active.lost) return
    for (let attempt = 0; attempt < maximumSettlementAttempts; attempt += 1) {
      if (active.lost) return
      const outcome = await awaitOperation(
        active.outbox.store.markPublished({
          id: active.record.id,
          leaseToken: active.record.leaseToken,
          nowMs: this.readNow()
        })
      )
      if (outcome.ok) return
      if (OutboxLeaseLostError.is(outcome.error)) {
        active.lost = true
        this.emit({
          type: 'lease-lost',
          recordedAt: this.readNow(),
          workerId: this.id,
          outboxId: active.record.id,
          target: active.record.target,
          reason: outcome.error.reason
        })
        return
      }
      this.report(outcome.error)
      if (!isRetryableOutboxFailure(outcome.error)) return
      await this.sleep(this.retryDelay(attempt + 1), this.supervisionController.signal)
    }

    await this.settleFailure(
      active,
      'settlement-uncertain',
      true,
      new OutboxStoreFailure({ operation: 'markPublished', retryable: true })
    )
  }

  private async settleFailure(
    active: ActivePublish,
    kind: OutboxFailureKind,
    retryable: boolean,
    cause: unknown
  ): Promise<void> {
    if (active.lost) return
    this.report(cause)
    const nowMs = this.readNow()
    const failure = serializeFailure(kind, retryable, cause, nowMs)
    if (retryable && active.record.attemptsMade < active.record.attemptsMax) {
      const retryAt = nowMs + this.retryDelay(active.record.attemptsMade)
      const retried = await awaitOperation(
        active.outbox.store.markRetry({
          id: active.record.id,
          leaseToken: active.record.leaseToken,
          nowMs,
          runAtMs: retryAt,
          failure
        })
      )
      if (retried.ok) {
        this.emit({
          type: 'retry-scheduled',
          recordedAt: nowMs,
          workerId: this.id,
          outboxId: active.record.id,
          target: active.record.target,
          retryAt,
          kind
        })
      } else {
        this.report(retried.error)
      }
      return
    }

    const failed = await awaitOperation(
      active.outbox.store.markFailed({
        id: active.record.id,
        leaseToken: active.record.leaseToken,
        nowMs,
        failure: serializeFailure(kind, false, cause, nowMs)
      })
    )
    if (failed.ok) {
      this.emit({
        type: 'failed',
        recordedAt: nowMs,
        workerId: this.id,
        outboxId: active.record.id,
        target: active.record.target,
        kind
      })
    } else {
      this.report(failed.error)
    }
  }

  private async releaseClaim(outbox: ResolvedOutbox, record: LeasedOutboxRecord): Promise<void> {
    const released = await awaitOperation(
      outbox.store.release({ id: record.id, leaseToken: record.leaseToken, nowMs: this.readNow() })
    )
    if (!released.ok) this.report(released.error)
  }

  private retryDelay(attempt: number): number {
    return Math.min(
      this.options.retryMaxDelayMs,
      exponentialDelay(this.options.retryBaseDelayMs, attempt)
    )
  }

  private readNow(): number {
    return this.options.now()
  }

  private async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
    })
  }

  private observeTask(task: Promise<void>, onSettled?: () => void): void {
    void task.then(
      () => onSettled?.(),
      (cause) => {
        onSettled?.()
        this.report(cause)
      }
    )
  }

  private emit(event: OutboxPublisherEvent): void {
    const observer = this.options.observer ?? noOpObserver
    try {
      const result = observer.onEvent(Object.freeze(event))
      if (result !== undefined) void Promise.resolve(result).catch(() => undefined)
    } catch {
      // Observability must not affect claiming, delivery, or settlement.
    }
  }

  private report(cause: unknown): void {
    try {
      const result = this.options.onError(cause)
      if (result !== undefined) void Promise.resolve(result).catch(() => undefined)
    } catch {
      // Error hooks are process-local diagnostics and cannot stop the supervisor.
    }
  }
}

const toEnqueueRequest = (prepared: PreparedEnqueue): EnqueueRequest => {
  const { protocolVersion: _protocolVersion, ...request } = prepared
  return request
}

const classifyEnqueueFailure = (cause: unknown): EnqueueFailureClassification => {
  if (JobStoreFailure.is(cause)) {
    return {
      kind: cause.retryable ? 'store-transient' : 'store-permanent',
      retryable: cause.retryable
    }
  }
  if (JobDefinitionError.is(cause)) return { kind: 'store-permanent', retryable: false }
  return { kind: 'store-transient', retryable: true }
}

const isRetryableOutboxFailure = (cause: unknown): boolean =>
  OutboxStoreFailure.is(cause) && cause.retryable

const serializeFailure = (
  kind: OutboxFailureKind,
  retryable: boolean,
  cause: unknown,
  recordedAtMs: number
): SerializedOutboxFailure => {
  const code = codeOf(cause)
  const result = makeSerializedOutboxFailure({
    kind,
    message: messageOf(cause),
    retryable,
    recordedAtMs,
    ...(code === undefined ? {} : { code })
  })
  if (Result.isError(result)) throw result.error
  return result.value
}

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  if (typeof cause === 'string' && cause.length > 0) return cause
  return 'Outbox publisher operation failed'
}

const codeOf = (cause: unknown): string | undefined => {
  if (cause === null || typeof cause !== 'object') return undefined
  const code = (cause as { readonly code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

const exponentialDelay = (base: number, attempt: number): number => {
  const exponent = Math.max(0, attempt - 1)
  const multiplier = 2 ** Math.min(exponent, 30)
  return Math.min(Number.MAX_SAFE_INTEGER, base * multiplier)
}

const normalizeFactory = <
  Outboxes extends readonly OutboxStoreTokenLike[],
  Routes extends OutboxRouteMap,
  Yield extends ServiceRequirement<unknown>
>(
  factory: PublisherFactoryInput<Outboxes, Routes, Yield>
): (() => AsyncGenerator<Yield, PublisherFactoryOptions<Outboxes, Routes>, unknown>) =>
  async function* () {
    const result = factory()
    if (isGeneratorResult<Outboxes, Routes, Yield>(result)) return yield* result
    return await result
  }

const isGeneratorResult = <
  Outboxes extends readonly OutboxStoreTokenLike[],
  Routes extends OutboxRouteMap,
  Yield extends ServiceRequirement<unknown>
>(
  value: PublisherFactoryResult<Outboxes, Routes, Yield>
): value is
  | Generator<Yield, PublisherFactoryOptions<Outboxes, Routes>, unknown>
  | AsyncGenerator<Yield, PublisherFactoryOptions<Outboxes, Routes>, unknown> =>
  value !== null && typeof value === 'object' && 'next' in value && typeof value.next === 'function'

const startOutboxPublisherWithExecutor = async <
  const Outboxes extends readonly OutboxStoreTokenLike[],
  const Routes extends OutboxRouteMap
>(
  executor: RuntimeExecutor<any>,
  options: OutboxPublisherOptions<Outboxes, Routes>
): Promise<OutboxPublisherSupervisor> => {
  const normalizedOptions = normalizeOptions(options)
  if (options.outboxes.length === 0) {
    throw new OutboxDefinitionError({
      field: 'outboxes',
      message: 'must contain at least one store token'
    })
  }
  const outboxes = await Promise.all(
    options.outboxes.map(async (token) => ({
      token,
      store: await executor.run(() => ServiceRuntime.resolve(token as unknown as AnyServiceToken))
    }))
  )
  const routeStores = new Map<string, JobStoreContract>()
  for (const entry of options.routes.entries) {
    if (routeStores.has(entry.store.serviceTag)) continue
    const store = await executor.run(() => ServiceRuntime.resolve(entry.store))
    assertJobStoreProtocolCompatible(store.descriptor)
    routeStores.set(entry.store.serviceTag, store)
  }
  const supervisor = new OutboxPublisherSupervisor({
    ...normalizedOptions,
    outboxes,
    // SAFETY: the Runtime value retains the exact route map; this cast only erases its generic map for the heterogeneous supervisor.
    routes: options.routes as unknown as OutboxRoutes<OutboxRouteMap>,
    routeStores
  })
  supervisor.start()
  return supervisor
}

const normalizeOptions = <
  Outboxes extends readonly OutboxStoreTokenLike[],
  Routes extends OutboxRouteMap
>(
  options: OutboxPublisherOptions<Outboxes, Routes>
): Omit<NormalizedPublisherOptions, 'outboxes' | 'routes' | 'routeStores'> => {
  validateOptionsObject(options)
  if (!Array.isArray(options.outboxes)) {
    throw new OutboxDefinitionError({
      field: 'outboxes',
      message: 'must be an array of store tokens'
    })
  }
  if (!(options.routes instanceof OutboxRoutes)) {
    throw new OutboxDefinitionError({
      field: 'routes',
      message: 'must be an OutboxRoutes registry'
    })
  }
  const concurrency = positiveOption(options.concurrency, defaultConcurrency, 'concurrency')
  const leaseDurationMs = positiveOption(
    options.leaseDurationMs,
    defaultLeaseDurationMs,
    'leaseDurationMs'
  )
  if (leaseDurationMs < minimumLeaseDurationMs) {
    throw new OutboxDefinitionError({
      field: 'leaseDurationMs',
      message: `must be at least ${minimumLeaseDurationMs}ms`
    })
  }
  const heartbeatIntervalMs = positiveOption(
    options.heartbeatIntervalMs,
    Math.max(1, Math.floor(leaseDurationMs / 3)),
    'heartbeatIntervalMs'
  )
  const pollIntervalMs = positiveOption(
    options.pollIntervalMs,
    defaultPollIntervalMs,
    'pollIntervalMs'
  )
  const retryBaseDelayMs = nonNegativeOption(
    options.retryBaseDelayMs,
    defaultRetryBaseDelayMs,
    'retryBaseDelayMs'
  )
  const retryMaxDelayMs = nonNegativeOption(
    options.retryMaxDelayMs,
    defaultRetryMaxDelayMs,
    'retryMaxDelayMs'
  )
  if (retryMaxDelayMs < retryBaseDelayMs) {
    throw new OutboxDefinitionError({
      field: 'retryMaxDelayMs',
      message: 'must be greater than or equal to retryBaseDelayMs'
    })
  }
  const id = options.workerId ?? options.id ?? makeDefaultWorkerId()
  const clock = options.now ?? Date.now
  const now = () => normalizeNow(typeof clock === 'function' ? clock() : clock.now())
  return {
    id,
    concurrency,
    leaseDurationMs,
    heartbeatIntervalMs,
    pollIntervalMs,
    retryBaseDelayMs,
    retryMaxDelayMs,
    now,
    onError: options.onError ?? noOpErrorHandler,
    observer: options.observer
  }
}

const validateOptionsObject = (options: unknown): void => {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new OutboxDefinitionError({ field: 'options', message: 'must be an object' })
  }
}

const positiveOption = (value: number | undefined, fallback: number, field: string): number => {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new OutboxDefinitionError({ field, message: 'must be a positive safe integer' })
  }
  return selected
}

const nonNegativeOption = (value: number | undefined, fallback: number, field: string): number => {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new OutboxDefinitionError({ field, message: 'must be a non-negative safe integer' })
  }
  return selected
}

const normalizeNow = (value: number | Date): number => {
  const timestamp = value instanceof Date ? value.getTime() : value
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new OutboxDefinitionError({
      field: 'now',
      message: 'must be a non-negative safe integer'
    })
  }
  return timestamp
}

const makeDefaultWorkerId = (): OutboxWorkerId => {
  const result = makeOutboxWorkerId(
    `outbox-publisher-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  if (Result.isError(result)) throw result.error
  return result.value
}

/** Create a Runtime-owned, Layer-first outbox publisher Service token. */
export function service<const Tag extends string>(
  tag: OutboxPublisherServiceTag<Tag>
): OutboxPublisherServiceToken<Tag> {
  type Instance = OutboxPublisherServiceInstance<Tag>
  const baseToken = Service<Instance>()(tag)
  const token = class extends (baseToken as unknown as new () => Service.Identity<Tag>) {
    constructor() {
      super()
      throw new TypeError('OutboxPublisher Service tokens are not constructible; use layer')
    }
  }
  const layerToken = token as unknown as ServiceToken<Tag, Instance>

  const makeLayer = <
    const Outboxes extends readonly OutboxStoreTokenLike[],
    const Routes extends OutboxRouteMap,
    Yield extends ServiceRequirement<unknown>
  >(
    factory: PublisherFactoryInput<Outboxes, Routes, Yield>
  ): LayerType<Instance, OutboxPublisherLayerRequirements<Outboxes, Routes, Yield>> => {
    const layer = Layer.scopedGen(
      layerToken,
      async function* () {
        const options = yield* normalizeFactory(factory)()
        const executor = yield* Runtime.executor<AnyService>()
        const publisher = await startOutboxPublisherWithExecutor(executor, options)
        return layerToken.of(publisher)
      },
      {
        quiesce: (publisher) => publisher.quiesce(),
        release: (publisher) => publisher.stop()
      }
    )
    return layer as LayerType<Instance, OutboxPublisherLayerRequirements<Outboxes, Routes, Yield>>
  }

  function layer<
    const Outboxes extends readonly OutboxStoreTokenLike[],
    const Routes extends OutboxRouteMap,
    Yield extends ServiceRequirement<unknown>
  >(
    factory: OutboxPublisherGeneratorFactory<Outboxes, Routes, Yield>
  ): LayerType<Instance, OutboxPublisherLayerRequirements<Outboxes, Routes, Yield>>
  function layer<
    const Outboxes extends readonly OutboxStoreTokenLike[],
    const Routes extends OutboxRouteMap
  >(
    factory: PublisherValueFactory<Outboxes, Routes>
  ): LayerType<Instance, OutboxPublisherRequirements<Outboxes, Routes>>
  function layer(
    factory: PublisherFactoryInput<
      readonly OutboxStoreTokenLike[],
      OutboxRouteMap,
      ServiceRequirement<unknown>
    >
  ): LayerType<Instance, AnyService> {
    return makeLayer(factory)
  }

  Object.defineProperty(token, 'layer', {
    configurable: false,
    enumerable: true,
    value: layer,
    writable: false
  })
  return token as unknown as OutboxPublisherServiceToken<Tag>
}

/** Layer-first outbox publisher entrypoint. */
export const OutboxPublisher = Object.freeze({ service })

export namespace OutboxPublisher {
  export type Handle = OutboxPublisherHandle
  export type Options<
    Outboxes extends readonly OutboxStoreTokenLike[] = readonly OutboxStoreTokenLike[],
    Routes extends OutboxRouteMap = OutboxRouteMap
  > = OutboxPublisherOptions<Outboxes, Routes>
  export type Event = OutboxPublisherEvent
  export type Observer = OutboxPublisherObserver
  export type ServiceInstance<Tag extends string> = OutboxPublisherServiceInstance<Tag>
  export type ServiceToken<Tag extends string> = OutboxPublisherServiceToken<Tag>
}
