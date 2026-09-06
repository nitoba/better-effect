// oxlint-disable anti-slop/no-runtime-typeof -- scheduler options and Layer factories are public JavaScript boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- store and factory values are validated at the erased boundary.
// oxlint-disable anti-slop/no-unknown-returns -- Result values are normalized before entering the supervisor.
// oxlint-disable anti-slop/no-chained-type-assertions -- heterogeneous registry and Service details are erased once.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below follow validation or generic erasure.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- scheduler option objects are validated before their fields are consumed.

import { Layer, Runtime, Service, ServiceRuntime } from 'better-effect'
import type { AnyService, RuntimeExecutor, ServiceRequirement } from 'better-effect'
import { Clock } from 'better-effect/standard-services'
import { Result, UnhandledException } from 'better-result'
import type { Result as ResultType } from 'better-result'

import type { AnyJobStoreToken } from '../store'
import type {
  AnyJobSchedulesDefinition,
  JobSchedulesStoreTokens,
  ResolvedJobScheduleStore
} from './schedules'
import { reconcileResolved, scheduleStoreTokens } from './schedules'
import { nextCronOccurrence } from './cron'
import { nextEveryMsOccurrence } from './every-ms'
import { JobScheduleStore } from './store'
import type {
  ScheduleReconcileError,
  ScheduleReconcileOptions,
  ScheduleRecord,
  ScheduleStoreError,
  ScheduleTickDecision,
  TickScheduleResult
} from './types'
import { JobDefinitionError } from '../protocol'

type SchedulerFactoryValue<Registries extends readonly AnyJobSchedulesDefinition[]> = () =>
  | JobSchedulerOptions<Registries>
  | PromiseLike<JobSchedulerOptions<Registries>>

type SchedulerFactoryGenerator<
  Registries extends readonly AnyJobSchedulesDefinition[],
  Yield extends ServiceRequirement<unknown>
> = () =>
  | Generator<Yield, JobSchedulerOptions<Registries>, unknown>
  | AsyncGenerator<Yield, JobSchedulerOptions<Registries>, unknown>

type SchedulerFactoryInput<
  Registries extends readonly AnyJobSchedulesDefinition[],
  Yield extends ServiceRequirement<unknown>
> = SchedulerFactoryGenerator<Registries, Yield> | SchedulerFactoryValue<Registries>

type SchedulerFactoryYieldRequirements<Yield extends ServiceRequirement<unknown>> =
  Yield extends ServiceRequirement<infer Requirement>
    ? Requirement extends AnyService
      ? Requirement
      : never
    : never

type RegistryStoreTokens<Registries extends readonly AnyJobSchedulesDefinition[]> =
  Registries[number] extends infer Registry
    ? Registry extends AnyJobSchedulesDefinition
      ? JobSchedulesStoreTokens<Registry>
      : never
    : never

type RegistryStoreInstances<Registries extends readonly AnyJobSchedulesDefinition[]> =
  RegistryStoreTokens<Registries> extends infer Store
    ? Store extends AnyJobStoreToken
      ? InstanceType<Store>
      : never
    : never

type RegistryScheduleStoreInstances<Registries extends readonly AnyJobSchedulesDefinition[]> =
  RegistryStoreTokens<Registries> extends infer Store
    ? Store extends AnyJobStoreToken
      ? import('./store').JobScheduleStoreInstance<Store>
      : never
    : never

export type JobSchedulerRequirements<
  Registries extends readonly AnyJobSchedulesDefinition[],
  Yield extends ServiceRequirement<unknown>
> =
  | InstanceType<typeof Clock>
  | RegistryStoreInstances<Registries>
  | RegistryScheduleStoreInstances<Registries>
  | SchedulerFactoryYieldRequirements<Yield>

export type JobSchedulerState = 'running' | 'quiescing' | 'draining' | 'stopped'

export type JobSchedulerError = ScheduleReconcileError | JobDefinitionError

export type JobSchedulerErrorHandler = (cause: JobSchedulerError) => void | PromiseLike<void>

export type JobSchedulerStartupReconcile =
  | boolean
  | (ScheduleReconcileOptions & { readonly enabled?: boolean })

export interface JobSchedulerOptions<
  Registries extends readonly AnyJobSchedulesDefinition[] = readonly AnyJobSchedulesDefinition[]
> {
  readonly registries: Registries
  readonly sweepIntervalMs?: number
  readonly batchSize?: number
  readonly startupReconcile?: JobSchedulerStartupReconcile
  readonly onError?: JobSchedulerErrorHandler
  readonly maxStoreRetries?: number
  readonly retryDelayMs?: number
}

export interface JobSchedulerHandle extends AsyncDisposable {
  readonly state: JobSchedulerState
  readonly activeTickCount: number
  quiesce(): void
  sweep(): Promise<void>
  stop(): Promise<void>
}

export type JobSchedulerServiceInstance<Tag extends string> = JobSchedulerHandle &
  import('better-effect').Service.Identity<Tag>

type SchedulerServiceLayerMethod<Tag extends string> = {
  <
    const Registries extends readonly AnyJobSchedulesDefinition[],
    Yield extends ServiceRequirement<unknown>
  >(
    factory: SchedulerFactoryGenerator<Registries, Yield>
  ): Layer<JobSchedulerServiceInstance<Tag>, JobSchedulerRequirements<Registries, Yield>>
  <const Registries extends readonly AnyJobSchedulesDefinition[]>(
    factory: SchedulerFactoryValue<Registries>
  ): Layer<JobSchedulerServiceInstance<Tag>, JobSchedulerRequirements<Registries, never>>
}

export type JobSchedulerServiceToken<Tag extends string> = import('better-effect').ServiceToken<
  Tag,
  JobSchedulerServiceInstance<Tag>
> & {
  readonly [Symbol.iterator]: () => Generator<
    ServiceRequirement<JobSchedulerServiceInstance<Tag>>,
    JobSchedulerServiceInstance<Tag>,
    unknown
  >
  readonly [Symbol.asyncIterator]: () => AsyncGenerator<
    ServiceRequirement<JobSchedulerServiceInstance<Tag>>,
    JobSchedulerServiceInstance<Tag>,
    unknown
  >
  readonly layer: SchedulerServiceLayerMethod<Tag>
}

type NormalizedSchedulerOptions = {
  readonly registries: readonly AnyJobSchedulesDefinition[]
  readonly sweepIntervalMs: number
  readonly batchSize: number
  readonly startupReconcile: false | ScheduleReconcileOptions
  readonly onError: JobSchedulerErrorHandler
  readonly maxStoreRetries: number
  readonly retryDelayMs: number
}

type SchedulerContext = {
  readonly registry: AnyJobSchedulesDefinition
  readonly resolvedStores: readonly ResolvedJobScheduleStore[]
}

type AnyScheduleOperation<Value> =
  | import('./types').ScheduleStoreEffect<Value, ScheduleStoreError>
  | PromiseLike<import('./types').ScheduleStoreEffect<Value, ScheduleStoreError>>

const schedulerTypeId = Symbol.for('better-effect-mq/JobScheduler')
const defaultSweepIntervalMs = 1_000
const defaultBatchSize = 100
const defaultMaxStoreRetries = 3
const defaultRetryDelayMs = 25

const invalid = (field: string, message: string): JobDefinitionError =>
  new JobDefinitionError({ field, message })

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizePositiveInteger = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalid(field, 'must be a positive safe integer')
  }

  return value
}

const normalizeNonNegativeInteger = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(field, 'must be a non-negative safe integer')
  }

  return value
}

const isGenerator = (value: unknown): value is Generator | AsyncGenerator =>
  isObject(value) && typeof value.next === 'function'

const normalizeFactory = <
  Registries extends readonly AnyJobSchedulesDefinition[],
  Yield extends ServiceRequirement<unknown>
>(
  factory: SchedulerFactoryInput<Registries, Yield>
): (() => AsyncGenerator<Yield, JobSchedulerOptions<Registries>, unknown>) =>
  async function* () {
    const result = factory()

    if (isGenerator(result)) {
      return yield* result as AsyncGenerator<Yield, JobSchedulerOptions<Registries>, unknown>
    }

    return await result
  }

const normalizeStartup = (value: unknown): false | ScheduleReconcileOptions => {
  if (value === undefined || value === false) return false
  if (value === true) return {}
  if (!isObject(value)) throw invalid('startupReconcile', 'must be a boolean or options object')
  if (value.enabled === false) return false
  return value as ScheduleReconcileOptions
}

const normalizeSchedulerOptions = (value: unknown): NormalizedSchedulerOptions => {
  if (!isObject(value)) throw invalid('options', 'must be an object')
  const registries = value.registries

  if (!Array.isArray(registries)) throw invalid('registries', 'must be an array')

  for (const [index, registry] of registries.entries()) {
    if (
      !isObject(registry) ||
      typeof registry.group !== 'string' ||
      !Array.isArray(registry.schedules)
    ) {
      throw invalid(`registries[${index}]`, 'must be a JobSchedules definition')
    }
  }

  const sweepIntervalMs =
    value.sweepIntervalMs === undefined
      ? defaultSweepIntervalMs
      : normalizePositiveInteger(value.sweepIntervalMs, 'sweepIntervalMs')
  const batchSize =
    value.batchSize === undefined
      ? defaultBatchSize
      : normalizePositiveInteger(value.batchSize, 'batchSize')
  const maxStoreRetries =
    value.maxStoreRetries === undefined
      ? defaultMaxStoreRetries
      : normalizePositiveInteger(value.maxStoreRetries, 'maxStoreRetries')
  const retryDelayMs =
    value.retryDelayMs === undefined
      ? defaultRetryDelayMs
      : normalizeNonNegativeInteger(value.retryDelayMs, 'retryDelayMs')

  if (value.onError !== undefined && typeof value.onError !== 'function') {
    throw invalid('onError', 'must be callable')
  }

  return Object.freeze({
    registries: Object.freeze(registries as AnyJobSchedulesDefinition[]),
    sweepIntervalMs,
    batchSize,
    startupReconcile: normalizeStartup(value.startupReconcile),
    onError: (value.onError ?? (() => {})) as JobSchedulerErrorHandler,
    maxStoreRetries,
    retryDelayMs
  })
}

const operationFailure = <Value>(cause: unknown): ResultType<Value, UnhandledException> =>
  Result.err(new UnhandledException({ cause }))

const resolveOperation = async <Value>(
  operation: AnyScheduleOperation<Value>
): Promise<ResultType<Value, ScheduleStoreError | UnhandledException>> => {
  try {
    const result = await operation
    if (Result.isOk(result)) return Result.ok(result.value)
    if (Result.isError(result)) return Result.err(result.error)
    return operationFailure(new TypeError('Schedule store returned an invalid Result'))
  } catch (cause) {
    return operationFailure(cause)
  }
}

const nextForRecord = (record: ScheduleRecord, afterMs: number): number => {
  if (record.cron !== undefined) {
    return nextCronOccurrence(record.cron, afterMs, record.timeZone ?? 'UTC')
  }

  return nextEveryMsOccurrence(record.everyMs!, afterMs, record.nextRunAtMs)
}

const makeTickDecision = (record: ScheduleRecord, nowMs: number): ScheduleTickDecision => {
  const cadenceNext = (afterMs: number): number => nextForRecord(record, afterMs)
  const overdue = record.nextRunAtMs <= nowMs

  if (!overdue) {
    return { occurrences: [], nextRunAtMs: record.nextRunAtMs }
  }

  if (record.misfire.strategy === 'skip') {
    return {
      occurrences: [],
      skippedSlots: [record.nextRunAtMs],
      skipReason: 'misfire-skip',
      nextRunAtMs: cadenceNext(nowMs)
    }
  }

  if (record.misfire.strategy === 'run-once') {
    return {
      occurrences: [record.nextRunAtMs],
      skippedSlots: [],
      nextRunAtMs: cadenceNext(nowMs)
    }
  }

  const slots: number[] = []
  let slot = record.nextRunAtMs

  while (slot <= nowMs && slots.length < record.misfire.maxOccurrences) {
    slots.push(slot)
    slot = cadenceNext(slot)
  }

  return {
    occurrences: slots,
    nextRunAtMs: slot,
    skippedSlots: []
  }
}

const isRetryable = (cause: unknown): boolean =>
  ScheduleStoreFailureRuntime.is(cause) && cause.retryable

import { ScheduleStoreFailure as ScheduleStoreFailureRuntime } from './errors'

class JobSchedulerSupervisor implements JobSchedulerHandle {
  private currentState: JobSchedulerState = 'stopped'
  private readonly stopController = new AbortController()
  private readonly activeSweeps = new Set<Promise<void>>()
  private readonly activeTicks = new Set<Promise<void>>()
  private loopPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined
  private contexts: readonly SchedulerContext[] = []

  constructor(
    private readonly options: NormalizedSchedulerOptions,
    private readonly clock: InstanceType<typeof Clock>,
    private readonly executor: RuntimeExecutor<AnyService>,
    private readonly onError: (cause: JobSchedulerError) => void
  ) {}

  get state(): JobSchedulerState {
    return this.currentState
  }

  get activeTickCount(): number {
    return this.activeTicks.size
  }

  async start(): Promise<void> {
    if (this.currentState !== 'stopped') return

    this.contexts = await this.resolveContexts()

    if (this.options.startupReconcile !== false) {
      for (const context of this.contextsByRegistry()) {
        const result = await reconcileResolved(
          context.registry,
          context.resolvedStores,
          this.options.startupReconcile,
          this.clock,
          this.stopController.signal
        )

        if (Result.isError(result)) {
          this.reportError(result.error)
          throw result.error
        }
      }
    }

    this.currentState = 'running'
    this.loopPromise = this.runLoop()
  }

  quiesce(): void {
    if (this.currentState !== 'running') return
    this.currentState = 'quiescing'
    this.stopController.abort(new Error('Job scheduler is quiescing'))
  }

  sweep(): Promise<void> {
    if (this.currentState !== 'running') return Promise.resolve()
    return this.runTrackedSweep()
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise

    if (this.currentState === 'running') this.quiesce()
    if (this.currentState === 'stopped') return Promise.resolve()

    this.currentState = 'draining'
    this.stopPromise = this.finishStop()
    return this.stopPromise
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop()
  }

  private async resolveContexts(): Promise<readonly SchedulerContext[]> {
    const contexts: SchedulerContext[] = []
    const stores = new Map<string, ResolvedJobScheduleStore>()

    for (const registry of this.options.registries) {
      for (const token of scheduleStoreTokens(registry)) {
        if (stores.has(token.serviceTag)) continue
        const scheduleStoreToken = JobScheduleStore.for(token)
        const scheduleStore = await this.executor.run(() =>
          ServiceRuntime.resolve(scheduleStoreToken)
        )
        stores.set(token.serviceTag, { token, store: scheduleStore })
      }
    }

    for (const registry of this.options.registries) {
      contexts.push({
        registry,
        resolvedStores: Object.freeze(
          scheduleStoreTokens(registry)
            .map((token) => stores.get(token.serviceTag))
            .filter((entry): entry is ResolvedJobScheduleStore => entry !== undefined)
        )
      })
    }

    return Object.freeze(contexts)
  }

  private contextsByRegistry(): readonly SchedulerContext[] {
    return this.contexts
  }

  private async runLoop(): Promise<void> {
    while (this.currentState === 'running' && !this.stopController.signal.aborted) {
      await this.runTrackedSweep()

      if (this.currentState !== 'running' || this.stopController.signal.aborted) break

      try {
        await this.clock.sleep(this.options.sweepIntervalMs, { signal: this.stopController.signal })
      } catch {
        break
      }
    }
  }

  private runTrackedSweep(): Promise<void> {
    const sweep = this.runSweep()
    this.activeSweeps.add(sweep)
    void sweep.then(
      () => this.activeSweeps.delete(sweep),
      () => this.activeSweeps.delete(sweep)
    )
    return sweep
  }

  private async runSweep(): Promise<void> {
    if (this.currentState !== 'running') return

    const tasks: Promise<void>[] = []

    for (const context of this.contexts) {
      for (const resolved of context.resolvedStores) {
        const task = this.sweepStore(context.registry.group, resolved)
        tasks.push(task)
      }
    }

    await Promise.allSettled(tasks)
  }

  private async sweepStore(group: string, resolved: ResolvedJobScheduleStore): Promise<void> {
    const nowMs = this.clock.now().getTime()
    const due = await this.withRetry<readonly ScheduleRecord[]>(() =>
      resolved.store.dueSchedules({ nowMs, group, limit: this.options.batchSize })
    )

    if (Result.isError(due)) {
      this.reportError(due.error)
      return
    }

    for (const record of due.value) {
      if (this.currentState !== 'running') return

      const tick = this.tickRecord(resolved, record, nowMs)
      this.activeTicks.add(tick)
      void tick.then(
        () => this.activeTicks.delete(tick),
        () => this.activeTicks.delete(tick)
      )
      await tick
    }
  }

  private tickRecord(
    resolved: ResolvedJobScheduleStore,
    record: ScheduleRecord,
    nowMs: number
  ): Promise<void> {
    return (async () => {
      if (this.currentState !== 'running') return
      let decision: ScheduleTickDecision

      try {
        decision = makeTickDecision(record, nowMs)
      } catch (cause) {
        this.reportError(cause as JobSchedulerError)
        return
      }

      if (this.currentState !== 'running') return

      const result = await this.withRetry<TickScheduleResult>(() =>
        resolved.store.tickSchedule({
          key: { group: record.group, key: record.key },
          expectedRevision: record.revision,
          expectedRunAtMs: record.nextRunAtMs,
          nowMs,
          decision
        })
      )

      if (Result.isError(result)) {
        this.reportError(result.error)
        return
      }

      this.observeTick(result.value)
    })()
  }

  private observeTick(_result: TickScheduleResult): void {
    // Tick results are intentionally not retained. Durable state is the source of truth.
  }

  private async withRetry<Value>(
    operation: () => AnyScheduleOperation<Value>
  ): Promise<ResultType<Value, ScheduleStoreError | UnhandledException>> {
    let attempt = 0

    while (true) {
      let pending: AnyScheduleOperation<Value>

      try {
        pending = operation()
      } catch (cause) {
        return operationFailure(cause)
      }

      const result = await resolveOperation(pending)
      if (
        Result.isOk(result) ||
        !isRetryable(result.error) ||
        attempt >= this.options.maxStoreRetries - 1
      ) {
        return result
      }

      attempt += 1
      if (this.currentState !== 'running') return result

      try {
        await this.clock.sleep(this.options.retryDelayMs, { signal: this.stopController.signal })
      } catch {
        return result
      }
    }
  }

  private async finishStop(): Promise<void> {
    this.stopController.abort(new Error('Job scheduler stopped'))
    await Promise.allSettled(this.loopPromise === undefined ? [] : [this.loopPromise])
    await Promise.allSettled(this.activeSweeps)
    await Promise.allSettled(this.activeTicks)
    this.currentState = 'stopped'
  }

  private reportError(cause: JobSchedulerError): void {
    this.reportErrorSafely(cause)
  }

  private reportErrorSafely(cause: JobSchedulerError): void {
    try {
      const result = this.onError(cause)
      if (result !== undefined && typeof (result as PromiseLike<void>).then === 'function') {
        void Promise.resolve(result).catch(() => {})
      }
    } catch {
      // Observability must not terminate the supervisor or alter store semantics.
    }
  }
}

const makeSchedulerLayer = <
  Tag extends string,
  Registries extends readonly AnyJobSchedulesDefinition[],
  Yield extends ServiceRequirement<unknown>
>(
  token: JobSchedulerServiceToken<Tag>,
  factory: SchedulerFactoryInput<Registries, Yield>
): Layer<JobSchedulerServiceInstance<Tag>, JobSchedulerRequirements<Registries, Yield>> => {
  const layer = Layer.scopedGen(
    token,
    async function* () {
      const options = yield* normalizeFactory(factory)()
      const normalized = normalizeSchedulerOptions(options)
      const executor = yield* Runtime.executor<AnyService>()
      const clock = yield* Clock
      const supervisor = new JobSchedulerSupervisor(normalized, clock, executor, normalized.onError)
      await supervisor.start()
      return token.of(supervisor)
    },
    {
      quiesce: (scheduler) => scheduler.quiesce(),
      release: (scheduler) => scheduler.stop()
    }
  )

  // SAFETY: the Layer generator adds the Clock used by the supervisor; Service/registry requirements are restored from the public options type.
  return layer as Layer<
    JobSchedulerServiceInstance<Tag>,
    JobSchedulerRequirements<Registries, Yield>
  >
}

type SchedulerServiceTag<Tag extends string> = string extends Tag
  ? never
  : Tag extends ''
    ? never
    : Tag

const service = <const Tag extends string>(
  tag: SchedulerServiceTag<Tag>
): JobSchedulerServiceToken<Tag> => {
  const base = Service<JobSchedulerServiceInstance<Tag>>()(tag as never)
  const token = class extends (base as unknown as new () => AnyService) {
    constructor() {
      super()
      throw new TypeError('JobScheduler Service tokens are not constructible; use layer')
    }
  }
  const layerToken = token as unknown as JobSchedulerServiceToken<Tag>

  Object.defineProperty(layerToken, schedulerTypeId, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  })

  const layer = <
    const Registries extends readonly AnyJobSchedulesDefinition[],
    Yield extends ServiceRequirement<unknown>
  >(
    factory: SchedulerFactoryInput<Registries, Yield>
  ): Layer<JobSchedulerServiceInstance<Tag>, JobSchedulerRequirements<Registries, Yield>> =>
    makeSchedulerLayer(layerToken, factory)

  Object.defineProperty(layerToken, 'layer', {
    configurable: false,
    enumerable: true,
    value: layer,
    writable: false
  })

  return layerToken
}

export const isJobSchedulerToken = (value: unknown): value is JobSchedulerServiceToken<string> => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false

  try {
    const marker = Object.getOwnPropertyDescriptor(value, schedulerTypeId)
    const candidate = value as {
      readonly serviceTag?: unknown
      readonly layer?: unknown
      readonly of?: unknown
      readonly [Symbol.iterator]?: unknown
      readonly [Symbol.asyncIterator]?: unknown
    }
    return (
      marker !== undefined &&
      'value' in marker &&
      marker.value === true &&
      typeof candidate.serviceTag === 'string' &&
      typeof candidate.layer === 'function' &&
      typeof candidate.of === 'function' &&
      typeof candidate[Symbol.iterator] === 'function' &&
      typeof candidate[Symbol.asyncIterator] === 'function'
    )
  } catch {
    return false
  }
}

export const JobScheduler = Object.freeze({ service }) as {
  readonly service: typeof service
}

export namespace JobScheduler {
  export type Handle = JobSchedulerHandle
  export type Options<
    Registries extends readonly AnyJobSchedulesDefinition[] = readonly AnyJobSchedulesDefinition[]
  > = JobSchedulerOptions<Registries>
  export type ServiceInstance<Tag extends string> = JobSchedulerServiceInstance<Tag>
  export type ServiceToken<Tag extends string> = JobSchedulerServiceToken<Tag>
  export type Requirements<
    Registries extends readonly AnyJobSchedulesDefinition[],
    Yield extends ServiceRequirement<unknown>
  > = JobSchedulerRequirements<Registries, Yield>
  export type Error = JobSchedulerError
}
