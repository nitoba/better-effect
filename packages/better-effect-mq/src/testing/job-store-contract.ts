// oxlint-disable anti-slop/no-runtime-typeof -- public factories validate untyped adapter boundaries before use.
// oxlint-disable anti-slop/no-unknown-parameters -- the runner-neutral kit validates user-supplied hooks and records.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- generic record guards are confined to boundary validation.
// oxlint-disable anti-slop/no-chained-type-assertions -- assertions restore types after checked public Result boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below are confined to checked adapter boundaries.
// oxlint-disable typescript/unbound-method -- methods are checked for callability and invoked through their owners.

import { ServiceRuntime } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

import {
  Codec,
  JobId,
  JobName,
  JobRegistry,
  JobStore,
  Queue,
  QueueName,
  makeLeaseToken,
  makeWorkerId
} from '../index'

import type {
  ActiveJobSnapshot,
  AnyJobDefinition,
  AnyJobRegistry,
  AnyJobStoreToken,
  AnyQueueDefinition,
  EnqueueRequest,
  JobIdentity,
  JobRecord,
  JobStore as JobStoreNamespace,
  JobStoreCapabilities,
  JobStoreError,
  JobStoreOperation,
  LeaseToken,
  ListJobsRequest,
  SerializedJobFailure,
  WorkerId
} from '../index'

/** A value that may be completed synchronously or by a Promise-like. */
export type JobStoreContractMaybePromise<Value> = Value | PromiseLike<Value>

/** Stable metadata shared by a contract scenario and its extension hooks. */
export interface JobStoreContractScenarioInfo {
  readonly id: string
  readonly name: string
  readonly category: string
}

/** A runner-neutral scenario that can be registered with any test runner. */
export interface JobStoreContractScenario extends JobStoreContractScenarioInfo {
  readonly run: () => Promise<void>
}

/** Short alias for consumers that use the generic contract terminology. */
export type ContractScenario = JobStoreContractScenario

/** Deterministic time source made available to adapter setup and extensions. */
export interface JobStoreContractClock {
  now(): number
  advance(milliseconds: number): void
}

/** Deterministic identity source made available to adapter setup and extensions. */
export interface JobStoreContractIds {
  jobId(label: string): JobId
  leaseToken(label: string): LeaseToken
  workerId(label: string): WorkerId
}

/** Optional gate used by distributed/crash extensions without a timer or container. */
export interface JobStoreContractBarrier {
  wait(name: string): Promise<void>
  release(name: string): void
  reset(name?: string): void
}

/** A hook point for failpoints, client barriers, and crash simulations. */
export interface JobStoreContractHooks {
  checkpoint?(
    point: string,
    scenario: JobStoreContractScenarioInfo
  ): JobStoreContractMaybePromise<void>
}

/** Per-scenario controls. A controls factory is preferred for isolation. */
export interface JobStoreContractControls {
  readonly clock?: JobStoreContractClock
  readonly ids?: JobStoreContractIds
  readonly barrier?: JobStoreContractBarrier
  readonly hooks?: JobStoreContractHooks
}

/** Context passed to setup, runtime factories, reset, and extension clients. */
export interface JobStoreContractContext extends JobStoreContractScenarioInfo {
  readonly scenario: JobStoreContractScenarioInfo
  readonly token: AnyJobStoreToken
  readonly clock: JobStoreContractClock
  readonly ids: JobStoreContractIds
  readonly barrier: JobStoreContractBarrier
  readonly hooks: JobStoreContractHooks
  checkpoint(point: string): Promise<void>
}

/** Public descriptors used by the built-in scenarios and extension hooks. */
export interface JobStoreContractFixtures {
  readonly queue: AnyQueueDefinition
  readonly queueName: QueueName
  readonly otherQueue: AnyQueueDefinition
  readonly otherQueueName: QueueName
  readonly jobName: JobName
  readonly job: AnyJobDefinition
  readonly jobV2: AnyJobDefinition
  readonly otherNameJob: AnyJobDefinition
  readonly otherQueueJob: AnyJobDefinition
  readonly registry: AnyJobRegistry
}

/** One runtime/client owned by the conformance harness. */
export interface JobStoreContractRuntime {
  run<A>(program: () => A | PromiseLike<A>): PromiseLike<Awaited<A>>
  dispose(): PromiseLike<void>
}

/** A resolved public JobStore client supplied to extension scenarios. */
export interface JobStoreContractClient {
  readonly runtime: JobStoreContractRuntime
  readonly store: JobStoreNamespace.Contract
}

/** Context supplied to a custom concurrency or crash extension. */
export interface JobStoreContractScenarioContext extends JobStoreContractContext {
  readonly client: JobStoreContractClient
  readonly store: JobStoreNamespace.Contract
  readonly fixtures: JobStoreContractFixtures
  openClient(): Promise<JobStoreContractClient>
}

/** A custom scenario that shares the same isolated lifecycle as built-ins. */
export interface JobStoreContractExtension extends JobStoreContractScenarioInfo {
  readonly requires?: keyof JobStoreCapabilities
  readonly run: (context: JobStoreContractScenarioContext) => JobStoreContractMaybePromise<void>
}

/** A capability-gated scenario omitted from the returned list when unsupported. */
export interface JobStoreContractSkippedScenario extends JobStoreContractScenarioInfo {
  readonly capability: keyof JobStoreCapabilities
  readonly reason: string
}

/** A detached report of scenario execution and capability coverage. */
export interface JobStoreContractReport {
  readonly capabilities: JobStoreCapabilities
  readonly executed: readonly string[]
  readonly passed: readonly string[]
  readonly failed: readonly string[]
  readonly skipped: readonly JobStoreContractSkippedScenario[]
  readonly capabilitiesNotTested: readonly (keyof JobStoreCapabilities)[]
}

/** Returned array with a read-only report snapshot for runner integrations. */
export type JobStoreContractSuite = readonly JobStoreContractScenario[] & {
  readonly report: () => JobStoreContractReport
}

/** Factory options for the runner-agnostic JobStore contract. */
export interface JobStoreContractOptions {
  /** Create a fresh runtime and its real adapter resources for one scenario. */
  readonly makeRuntime: (
    context: JobStoreContractContext
  ) => JobStoreContractMaybePromise<JobStoreContractRuntime>
  /** Optional schema/fixture setup, called once before each scenario runtime. */
  readonly setup?: (context: JobStoreContractContext) => JobStoreContractMaybePromise<void>
  /** Optional storage reset, called after runtime disposal even when a scenario fails. */
  readonly reset?: (context: JobStoreContractContext) => JobStoreContractMaybePromise<void>
  /** The token provided by the runtime; defaults to the public JobStore token. */
  readonly token?: AnyJobStoreToken
  /** Declared immutable capability flags. Omitted flags are false. */
  readonly capabilities?: Partial<JobStoreCapabilities>
  /** Per-scenario control factory or a deliberately shared control object. */
  readonly controls?:
    | JobStoreContractControls
    | ((
        scenario: JobStoreContractScenarioInfo
      ) => JobStoreContractMaybePromise<JobStoreContractControls>)
  /** Additional concurrency/crash scenarios, run with harness-owned cleanup. */
  readonly extensions?: readonly JobStoreContractExtension[]
}

/** Error thrown by a scenario with its stable invariant and scenario identity. */
export class JobStoreConformanceError extends Error {
  readonly scenarioId: string
  readonly scenarioName: string
  readonly category: string
  readonly invariant: string

  constructor(
    scenario: JobStoreContractScenarioInfo,
    invariant: string,
    detail: string,
    cause?: unknown
  ) {
    super(`${scenario.id} (${scenario.name}) [${invariant}]: ${detail}`, { cause })
    this.name = 'JobStoreConformanceError'
    this.scenarioId = scenario.id
    this.scenarioName = scenario.name
    this.category = scenario.category
    this.invariant = invariant
  }
}

type AnyResult<Value> = ResultType<Value, JobStoreError>
type ErrorResult<Value> = Extract<AnyResult<Value>, { readonly status: 'error' }>

type ScenarioBody = (context: JobStoreContractScenarioContext) => Promise<void>
type ScenarioDefinition = JobStoreContractScenarioInfo & {
  readonly requires?: keyof JobStoreCapabilities
  readonly body: ScenarioBody
}
type EnqueueOverrides = Partial<
  Pick<EnqueueRequest, 'id' | 'idempotencyKey' | 'priority' | 'runAt' | 'attemptsMax'>
>
type ClaimOverrides = Partial<
  Pick<
    JobStoreNamespace.ClaimRequest,
    'accepted' | 'limit' | 'leaseDurationMs' | 'workerId' | 'queue'
  >
>

const capabilityNames = [
  'notifications',
  'batchClaim',
  'transactionalEnqueue',
  'changeFeed'
] as const satisfies readonly (keyof JobStoreCapabilities)[]

const defaultCapabilities: JobStoreCapabilities = Object.freeze({
  notifications: false,
  batchClaim: false,
  transactionalEnqueue: false,
  changeFeed: false
})

const baseTime = 1_700_000_000_000

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)

const isErrorResult = <Value>(result: AnyResult<Value>): result is ErrorResult<Value> =>
  result.status === 'error'

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const hasTag = (value: unknown, tag: string): boolean => isRecord(value) && value['_tag'] === tag

const assertFunction = (value: unknown, field: string): void => {
  if (typeof value !== 'function') {
    throw new TypeError(`jobStoreContract ${field} must be a function`)
  }
}

const assertBoolean = (value: unknown, field: string): void => {
  if (typeof value !== 'boolean') {
    throw new TypeError(`jobStoreContract capabilities.${field} must be boolean`)
  }
}

const normalizeCapabilities = (
  value: Partial<JobStoreCapabilities> | undefined
): JobStoreCapabilities => {
  if (value === undefined) {
    return defaultCapabilities
  }

  const copy = {
    notifications: value.notifications ?? false,
    batchClaim: value.batchClaim ?? false,
    transactionalEnqueue: value.transactionalEnqueue ?? false,
    changeFeed: value.changeFeed ?? false
  }

  for (const name of capabilityNames) {
    assertBoolean(copy[name], name)
  }

  return Object.freeze(copy)
}

const assertScenarioInfo = (scenario: JobStoreContractScenarioInfo): void => {
  if (
    typeof scenario.id !== 'string' ||
    scenario.id.length === 0 ||
    typeof scenario.name !== 'string' ||
    scenario.name.length === 0 ||
    typeof scenario.category !== 'string' ||
    scenario.category.length === 0
  ) {
    throw new TypeError('jobStoreContract scenarios require non-empty id, name, and category')
  }
}

const makeScenarioError = (
  context: JobStoreContractScenarioInfo,
  invariant: string,
  detail: string,
  cause?: unknown
): JobStoreConformanceError => new JobStoreConformanceError(context, invariant, detail, cause)

const fail = (
  context: JobStoreContractScenarioInfo,
  invariant: string,
  detail: string,
  cause?: unknown
): never => {
  throw makeScenarioError(context, invariant, detail, cause)
}

const ensure = (
  condition: boolean,
  context: JobStoreContractScenarioInfo,
  invariant: string,
  detail: string
): void => {
  if (!condition) {
    fail(context, invariant, detail)
  }
}

const unwrapBrand = <Value, Failure>(value: ResultType<Value, Failure>): Value => {
  if (Result.isError(value)) {
    throw value.error
  }

  return value.value
}

class DefaultClock implements JobStoreContractClock {
  private current = baseTime

  now(): number {
    return this.current
  }

  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError('contract clock advances require a non-negative safe integer')
    }

    const next = this.current + milliseconds

    if (!Number.isSafeInteger(next)) {
      throw new RangeError('contract clock cannot advance beyond safe integer range')
    }

    this.current = next
  }
}

class DefaultIds implements JobStoreContractIds {
  private readonly jobs = new Map<string, JobId>()
  private readonly leases = new Map<string, LeaseToken>()
  private readonly workers = new Map<string, WorkerId>()

  jobId(label: string): JobId {
    return this.get(this.jobs, label, (value) => unwrapBrand(JobId.make(`contract-job-${value}`)))
  }

  leaseToken(label: string): LeaseToken {
    return this.get(this.leases, label, (value) =>
      unwrapBrand(makeLeaseToken(`contract-lease-${value}`))
    )
  }

  workerId(label: string): WorkerId {
    return this.get(this.workers, label, (value) =>
      unwrapBrand(makeWorkerId(`contract-worker-${value}`))
    )
  }

  private get<Value>(
    map: Map<string, Value>,
    label: string,
    make: (value: string) => Value
  ): Value {
    if (typeof label !== 'string' || label.length === 0) {
      throw new TypeError('contract identity labels must be non-empty strings')
    }

    const existing = map.get(label)

    if (existing !== undefined) {
      return existing
    }

    const value = make(label)
    map.set(label, value)
    return value
  }
}

class DefaultBarrier implements JobStoreContractBarrier {
  wait(_name: string): Promise<void> {
    return Promise.resolve()
  }

  release(_name: string): void {}

  reset(_name?: string): void {}
}

const defaultHooks: JobStoreContractHooks = Object.freeze({})

const controlsFor = async (
  options: JobStoreContractOptions,
  scenario: JobStoreContractScenarioInfo
): Promise<JobStoreContractControls> => {
  const controls = options.controls
  const value = typeof controls === 'function' ? await controls(scenario) : controls

  return value ?? {}
}

const makeContext = async (
  options: JobStoreContractOptions,
  scenario: JobStoreContractScenarioInfo,
  token: AnyJobStoreToken
): Promise<JobStoreContractContext> => {
  const controls = await controlsFor(options, scenario)
  const clock = controls.clock ?? new DefaultClock()
  const ids = controls.ids ?? new DefaultIds()
  const barrier = controls.barrier ?? new DefaultBarrier()
  const hooks = controls.hooks ?? defaultHooks

  assertFunction(clock.now, 'controls.clock.now')
  assertFunction(clock.advance, 'controls.clock.advance')
  assertFunction(ids.jobId, 'controls.ids.jobId')
  assertFunction(ids.leaseToken, 'controls.ids.leaseToken')
  assertFunction(ids.workerId, 'controls.ids.workerId')
  assertFunction(barrier.wait, 'controls.barrier.wait')
  assertFunction(barrier.release, 'controls.barrier.release')
  assertFunction(barrier.reset, 'controls.barrier.reset')

  const context: JobStoreContractContext = {
    ...scenario,
    scenario,
    token,
    clock,
    ids,
    barrier,
    hooks,
    async checkpoint(point: string): Promise<void> {
      if (typeof point !== 'string' || point.length === 0) {
        throw makeScenarioError(scenario, 'extension hook', 'checkpoint names must be non-empty')
      }

      try {
        await hooks.checkpoint?.(point, scenario)
        await barrier.wait(point)
      } catch (cause) {
        throw makeScenarioError(scenario, `checkpoint:${point}`, 'checkpoint failed', cause)
      }
    }
  }

  return Object.freeze(context)
}

const makeFixtures = (token: AnyJobStoreToken): JobStoreContractFixtures => {
  const payload = Codec.json<{ readonly value: string }>()
  const queue = Queue.define('contract-main')
  const otherQueue = Queue.define('contract-other')
  const job = queue.job('contract-job', { version: 1, payload, store: token })
  const jobV2 = queue.job('contract-job', { version: 2, payload, store: token })
  const otherNameJob = queue.job('contract-other-job', { version: 1, payload, store: token })
  const otherQueueJob = otherQueue.job('contract-job', { version: 1, payload, store: token })
  const registry = JobRegistry.make([job, jobV2, otherNameJob, otherQueueJob] as const)

  return Object.freeze({
    queue,
    queueName: unwrapBrand(QueueName.make(queue.queue)),
    otherQueue,
    otherQueueName: unwrapBrand(QueueName.make(otherQueue.queue)),
    jobName: unwrapBrand(JobName.make(job.name)),
    job,
    jobV2,
    otherNameJob,
    otherQueueJob,
    registry
  })
}

const resolveStore = async (
  runtime: JobStoreContractRuntime,
  token: AnyJobStoreToken,
  scenario: JobStoreContractScenarioInfo
): Promise<JobStoreNamespace.Contract> => {
  try {
    const store = await runtime.run(() => ServiceRuntime.resolve(token))

    // SAFETY: the runtime resolves the public JobStore token supplied to this factory.
    return store as JobStoreNamespace.Contract
  } catch (cause) {
    throw makeScenarioError(
      scenario,
      'runtime wiring',
      'could not resolve the declared JobStore',
      cause
    )
  }
}

const makeClient = async (
  options: JobStoreContractOptions,
  context: JobStoreContractContext,
  runtimes: Set<JobStoreContractRuntime>
): Promise<JobStoreContractClient> => {
  let runtime: JobStoreContractRuntime

  try {
    runtime = await options.makeRuntime(context)
  } catch (cause) {
    throw makeScenarioError(context, 'runtime lifecycle', 'makeRuntime failed', cause)
  }

  if (
    !isRecord(runtime) ||
    typeof runtime.run !== 'function' ||
    typeof runtime.dispose !== 'function'
  ) {
    throw makeScenarioError(
      context,
      'runtime lifecycle',
      'makeRuntime must return { run, dispose } functions'
    )
  }

  runtimes.add(runtime)
  const store = await resolveStore(runtime, context.token, context)

  return Object.freeze({ runtime, store })
}

const resolveOperation = async <Value>(
  operation: JobStoreOperation<Value, JobStoreError>,
  context: JobStoreContractScenarioInfo,
  operationName: string
): Promise<AnyResult<Value>> => {
  try {
    const result = await Promise.resolve(operation)

    if (
      !isRecord(result) ||
      (result['status'] !== 'ok' && result['status'] !== 'error') ||
      typeof result['isOk'] !== 'function' ||
      typeof result['isErr'] !== 'function'
    ) {
      throw makeScenarioError(
        context,
        `${operationName} result boundary`,
        'operation did not return a better-result Result'
      )
    }

    // SAFETY: the shape guard above establishes the public completed Result contract.
    return result as AnyResult<Value>
  } catch (cause) {
    throw makeScenarioError(
      context,
      `${operationName} result boundary`,
      'operation rejected instead of returning its declared Result',
      cause
    )
  }
}

const succeed = async <Value>(
  operation: JobStoreOperation<Value, JobStoreError>,
  context: JobStoreContractScenarioInfo,
  operationName: string,
  invariant = `${operationName} succeeds`
): Promise<Value> => {
  const result = await resolveOperation(operation, context, operationName)

  if (result.isErr()) {
    throw makeScenarioError(context, invariant, `received ${describe(result.error)}`)
  }

  return result.unwrap()
}

const reject = async <Value>(
  operation: JobStoreOperation<Value, JobStoreError>,
  context: JobStoreContractScenarioInfo,
  operationName: string,
  invariant: string,
  expectedTag?: string
): Promise<JobStoreError> => {
  const result = await resolveOperation(operation, context, operationName)

  if (result.isOk()) {
    fail(context, invariant, `expected ${operationName} to return an error`)
  }

  const error = result as unknown as { readonly error: JobStoreError }

  if (expectedTag !== undefined && !hasTag(error.error, expectedTag)) {
    fail(context, invariant, `expected ${expectedTag}, received ${describe(error.error)}`)
  }

  return error.error
}

const operation = <Value>(
  run: () => JobStoreOperation<Value, JobStoreError>
): JobStoreOperation<Value, JobStoreError> => run()

const now = (context: JobStoreContractScenarioContext): number => {
  const value = context.clock.now()

  ensure(
    Number.isSafeInteger(value) && value >= 0,
    context,
    'controlled clock',
    `clock.now() must return a non-negative safe integer, received ${String(value)}`
  )

  return value
}

const enqueueRequest = (
  context: JobStoreContractScenarioContext,
  definition: AnyJobDefinition,
  label: string,
  overrides: EnqueueOverrides = {}
): EnqueueRequest => {
  const request = {
    job: definition.identity,
    payload: { value: label },
    metadata: { scenario: context.id, label },
    priority: overrides.priority ?? 0,
    runAt: overrides.runAt ?? now(context),
    attemptsMax: overrides.attemptsMax ?? 3,
    now: now(context)
  }

  if (overrides.id !== undefined) {
    return { ...request, id: overrides.id }
  }

  if (overrides.idempotencyKey !== undefined) {
    return { ...request, idempotencyKey: overrides.idempotencyKey }
  }

  return request
}

const claimRequest = (
  context: JobStoreContractScenarioContext,
  fixtures: JobStoreContractFixtures,
  overrides: ClaimOverrides = {}
): JobStoreNamespace.ClaimRequest => ({
  queue: overrides.queue ?? fixtures.queueName,
  accepted: overrides.accepted ?? fixtures.registry.accepted,
  limit: overrides.limit ?? 10,
  workerId: overrides.workerId ?? context.ids.workerId('primary'),
  leaseDurationMs: overrides.leaseDurationMs ?? 100,
  now: now(context)
})

const activeJob = async (
  context: JobStoreContractScenarioContext,
  definition = context.fixtures.job,
  label = 'active'
): Promise<ActiveJobSnapshot> => {
  await succeed(
    operation(() => context.store.enqueue(enqueueRequest(context, definition, label))),
    context,
    'enqueue'
  )
  const claimed = await succeed(
    operation(() => context.store.claim(claimRequest(context, context.fixtures))),
    context,
    'claim',
    'claim creates an active lease'
  )

  ensure(
    claimed.jobs.length === 1,
    context,
    'claim creates an active lease',
    `expected one active job, received ${claimed.jobs.length}`
  )

  const job = claimed.jobs[0]

  if (job === undefined) {
    fail(context, 'claim creates an active lease', 'claim returned no active snapshot')
  }

  return job!
}

const payloadValue = (job: JobRecord): string | undefined => {
  const payload = job.payload

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined
  }

  const value = (payload as { readonly value?: unknown })['value']
  return typeof value === 'string' ? value : undefined
}

const failure = (context: JobStoreContractScenarioContext, code: string): SerializedJobFailure => ({
  kind: 'typed',
  code,
  message: `contract failure ${code}`,
  retryable: true,
  recordedAt: now(context)
})

const sameIdentity = (left: JobRecord, right: JobRecord): boolean =>
  left.id === right.id &&
  left.queue === right.queue &&
  left.name === right.name &&
  left.version === right.version

const makeScenario = (
  definition: ScenarioDefinition,
  options: JobStoreContractOptions,
  token: AnyJobStoreToken,
  report: ReportState
): JobStoreContractScenario => {
  const run = async (): Promise<void> => {
    report.executed.add(definition.id)
    const runtimes = new Set<JobStoreContractRuntime>()
    let context: JobStoreContractContext | undefined
    let primary: unknown
    let hasPrimary = false

    try {
      const baseContext = await makeContext(options, definition, token)
      context = baseContext
      await options.setup?.(baseContext)
      const client = await makeClient(options, baseContext, runtimes)
      const fixtures = makeFixtures(token)
      const scenarioContext: JobStoreContractScenarioContext = Object.freeze({
        ...baseContext,
        client,
        store: client.store,
        fixtures,
        async openClient(): Promise<JobStoreContractClient> {
          return makeClient(options, baseContext, runtimes)
        }
      })
      await definition.body(scenarioContext)
      report.passed.add(definition.id)
    } catch (cause) {
      primary = cause
      hasPrimary = true
      report.failed.add(definition.id)
    } finally {
      const cleanupFailures: unknown[] = []

      for (const runtime of [...runtimes].reverse()) {
        try {
          await runtime.dispose()
        } catch (cause) {
          cleanupFailures.push(cause)
        }
      }

      if (context !== undefined) {
        try {
          await options.reset?.(context)
        } catch (cause) {
          cleanupFailures.push(cause)
        }
      }

      if (!hasPrimary && cleanupFailures.length > 0) {
        primary = makeScenarioError(
          definition,
          'cleanup',
          `cleanup failed: ${cleanupFailures.map(describe).join('; ')}`,
          cleanupFailures.length === 1 ? cleanupFailures[0] : new AggregateError(cleanupFailures)
        )
        hasPrimary = true
      }

      if (hasPrimary) {
        report.passed.delete(definition.id)
        report.failed.add(definition.id)
      }
    }

    if (hasPrimary) {
      throw primary
    }
  }

  return Object.freeze({
    id: definition.id,
    name: definition.name,
    category: definition.category,
    run
  })
}

type ReportState = {
  readonly capabilities: JobStoreCapabilities
  readonly executed: Set<string>
  readonly passed: Set<string>
  readonly failed: Set<string>
  readonly skipped: readonly JobStoreContractSkippedScenario[]
  readonly capabilitiesNotTested: readonly (keyof JobStoreCapabilities)[]
}

const reportSnapshot = (state: ReportState): JobStoreContractReport =>
  Object.freeze({
    capabilities: state.capabilities,
    executed: Object.freeze([...state.executed]),
    passed: Object.freeze([...state.passed]),
    failed: Object.freeze([...state.failed]),
    skipped: state.skipped,
    capabilitiesNotTested: state.capabilitiesNotTested
  })

const definition = (
  id: string,
  name: string,
  category: string,
  body: ScenarioBody,
  requires?: keyof JobStoreCapabilities
): ScenarioDefinition => {
  const scenario =
    requires === undefined ? { id, name, category, body } : { id, name, category, body, requires }
  assertScenarioInfo(scenario)
  return Object.freeze(scenario)
}

const listAll = async (
  context: JobStoreContractScenarioContext,
  request: ListJobsRequest
): Promise<readonly JobRecord[]> => {
  const jobs: JobRecord[] = []
  let cursor = request.cursor

  for (let page = 0; page < 100; page += 1) {
    const pageRequest = cursor === undefined ? request : { ...request, cursor }
    const result = await succeed(
      operation(() => context.store.list(pageRequest)),
      context,
      'list'
    )
    jobs.push(...result.jobs)

    if (result.nextCursor === undefined) {
      return jobs
    }

    if (
      cursor !== undefined &&
      cursor.createdAt === result.nextCursor.createdAt &&
      cursor.orderingSequence === result.nextCursor.orderingSequence &&
      cursor.id === result.nextCursor.id
    ) {
      fail(context, 'keyset pagination', 'the next cursor did not advance')
    }

    cursor = result.nextCursor
  }

  fail(context, 'keyset pagination', 'pagination exceeded 100 pages')
  return []
}

const enqueueMany = async (
  context: JobStoreContractScenarioContext,
  requests: readonly EnqueueRequest[]
): Promise<readonly JobStoreNamespace.EnqueueResult[]> =>
  succeed(
    operation(() => context.store.enqueueMany(requests)),
    context,
    'enqueueMany'
  )

const builtInScenarios = (): readonly ScenarioDefinition[] => [
  definition(
    'enqueue-immediate-waiting',
    'immediate enqueue enters waiting',
    'enqueue',
    async (context) => {
      const result = await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'immediate'))
        ),
        context,
        'enqueue'
      )
      ensure(
        result.duplicate === false,
        context,
        'enqueue identity',
        'first enqueue was marked duplicate'
      )
      ensure(
        result.job.state === 'waiting',
        context,
        'immediate scheduling',
        `received state ${result.job.state}`
      )
      ensure(
        result.job.runAt <= result.job.updatedAt,
        context,
        'immediate scheduling',
        'waiting job is not due'
      )
    }
  ),
  definition(
    'enqueue-future-delayed',
    'future enqueue enters delayed',
    'enqueue',
    async (context) => {
      const runAt = now(context) + 100
      const result = await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'future', { runAt }))
        ),
        context,
        'enqueue'
      )
      ensure(
        result.job.state === 'delayed',
        context,
        'future scheduling',
        `received state ${result.job.state}`
      )
      ensure(result.job.runAt === runAt, context, 'future scheduling', 'runAt was changed')
    }
  ),
  definition(
    'enqueue-explicit-id-duplicate',
    'duplicate explicit IDs are idempotent no-ops',
    'enqueue',
    async (context) => {
      const request = enqueueRequest(context, context.fixtures.job, 'explicit', {
        id: context.ids.jobId('explicit')
      })
      const first = await succeed(
        operation(() => context.store.enqueue(request)),
        context,
        'enqueue'
      )
      const second = await succeed(
        operation(() => context.store.enqueue(request)),
        context,
        'enqueue'
      )
      ensure(
        second.duplicate,
        context,
        'explicit ID uniqueness',
        'duplicate enqueue was not reported'
      )
      ensure(
        sameIdentity(first.job, second.job),
        context,
        'explicit ID uniqueness',
        'duplicate returned another job'
      )
      const counts = await succeed(
        operation(() => context.store.counts()),
        context,
        'counts'
      )
      ensure(
        counts.total === 1,
        context,
        'explicit ID uniqueness',
        `expected one job, received ${counts.total}`
      )
    }
  ),
  definition(
    'enqueue-idempotency-concurrent',
    'concurrent idempotency keys create one job',
    'enqueue',
    async (context) => {
      const make = () =>
        context.store.enqueue({
          ...enqueueRequest(context, context.fixtures.job, 'idempotent'),
          idempotencyKey: 'contract-idempotency'
        })
      const results = await Promise.all([
        resolveOperation(make(), context, 'enqueue'),
        resolveOperation(make(), context, 'enqueue')
      ])
      ensure(
        results.every((result) => !isErrorResult(result)),
        context,
        'idempotency uniqueness',
        'a concurrent enqueue failed'
      )
      const successes = results.filter(
        (
          result
        ): result is AnyResult<JobStoreNamespace.EnqueueResult> & {
          readonly value: JobStoreNamespace.EnqueueResult
        } => !isErrorResult(result)
      )
      const duplicateCount = successes.filter((result) => result.value.duplicate).length
      ensure(
        duplicateCount === 1,
        context,
        'idempotency uniqueness',
        `expected one duplicate, received ${duplicateCount}`
      )
      ensure(
        successes.length === 2,
        context,
        'idempotency uniqueness',
        'a concurrent enqueue result was lost'
      )
      ensure(
        successes[0]!.value.job.id === successes[1]!.value.job.id,
        context,
        'idempotency uniqueness',
        'concurrent callers observed different jobs'
      )
    }
  ),
  definition(
    'enqueue-generated-id-unique',
    'generated IDs do not collide with explicit IDs',
    'enqueue',
    async (context) => {
      const explicit = await succeed(
        operation(() =>
          context.store.enqueue(
            enqueueRequest(context, context.fixtures.job, 'explicit-id', {
              id: context.ids.jobId('generated-explicit')
            })
          )
        ),
        context,
        'enqueue'
      )
      const generated = await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'generated'))
        ),
        context,
        'enqueue'
      )
      ensure(
        !generated.duplicate,
        context,
        'generated ID uniqueness',
        'generated enqueue was duplicate'
      )
      ensure(
        generated.job.id !== explicit.job.id,
        context,
        'generated ID uniqueness',
        'generated ID collided with explicit ID'
      )
    }
  ),
  definition(
    'enqueue-many-order',
    'enqueueMany preserves input order and result alignment',
    'enqueue',
    async (context) => {
      const requests = [
        enqueueRequest(context, context.fixtures.job, 'batch-a'),
        enqueueRequest(context, context.fixtures.jobV2, 'batch-b'),
        enqueueRequest(context, context.fixtures.otherNameJob, 'batch-c')
      ]
      const results = await enqueueMany(context, requests)
      ensure(
        results.length === requests.length,
        context,
        'batch alignment',
        'batch result length changed'
      )
      results.forEach((result, index) => {
        const request = requests[index]
        const expectedName = request?.job?.name ?? request?.identity?.name
        ensure(
          result.job.name === expectedName,
          context,
          'batch alignment',
          `result ${index} changed identity`
        )
      })
    }
  ),
  definition(
    'enqueue-many-independent-replay',
    'enqueueMany keeps independently replayable duplicate units',
    'enqueue',
    async (context) => {
      const first = enqueueRequest(context, context.fixtures.job, 'batch-duplicate', {
        id: context.ids.jobId('batch-duplicate')
      })
      const requests = [
        first,
        first,
        enqueueRequest(context, context.fixtures.jobV2, 'batch-fresh')
      ]
      const results = await enqueueMany(context, requests)
      ensure(
        results.length === 3,
        context,
        'batch partial semantics',
        'batch did not return one result per input'
      )
      ensure(
        results[0]?.duplicate === false,
        context,
        'batch partial semantics',
        'first unit was not inserted'
      )
      ensure(
        results[1]?.duplicate === true,
        context,
        'batch partial semantics',
        'replayed unit was not a duplicate'
      )
      ensure(
        results[2]?.duplicate === false,
        context,
        'batch partial semantics',
        'later independent unit was lost'
      )
    }
  ),
  definition(
    'enqueue-round-trip',
    'metadata and identity version round-trip through getJob',
    'enqueue',
    async (context) => {
      const result = await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.jobV2, 'round-trip'))
        ),
        context,
        'enqueue'
      )
      const found = await succeed(
        operation(() => context.store.getJob({ jobId: result.job.id })),
        context,
        'getJob'
      )
      ensure(
        found !== undefined,
        context,
        'public snapshot round-trip',
        'getJob returned no record'
      )
      if (found === undefined) return
      ensure(
        found.version === 2,
        context,
        'public snapshot round-trip',
        'version was not persisted'
      )
      ensure(
        found.metadata.label === 'round-trip',
        context,
        'public snapshot round-trip',
        'metadata was not persisted'
      )
      ensure(
        JSON.stringify(found.payload) === JSON.stringify({ value: 'round-trip' }),
        context,
        'public snapshot round-trip',
        'payload was not persisted'
      )
    }
  ),
  definition(
    'claim-priority-order',
    'claim orders higher priority first',
    'claim',
    async (context) => {
      await enqueueMany(context, [
        enqueueRequest(context, context.fixtures.job, 'low', { priority: 1 }),
        enqueueRequest(context, context.fixtures.job, 'high', { priority: 5 }),
        enqueueRequest(context, context.fixtures.job, 'medium', { priority: 3 })
      ])
      const result = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      ensure(
        result.jobs.map((job) => job.priority).join(',') === '5,3,1',
        context,
        'claim ordering',
        'priority order was not descending'
      )
    }
  ),
  definition(
    'claim-fifo-tiebreak',
    'claim preserves FIFO within equal priority and runAt',
    'claim',
    async (context) => {
      await enqueueMany(context, [
        enqueueRequest(context, context.fixtures.job, 'first', { priority: 2 }),
        enqueueRequest(context, context.fixtures.job, 'second', { priority: 2 }),
        enqueueRequest(context, context.fixtures.job, 'third', { priority: 2 })
      ])
      const result = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      ensure(
        result.jobs.map((job) => String(payloadValue(job))).join(',') === 'first,second,third',
        context,
        'claim FIFO ordering',
        'equal-priority jobs changed insertion order'
      )
    }
  ),
  definition('claim-queue-isolation', 'claim isolates queues', 'claim', async (context) => {
    await enqueueMany(context, [
      enqueueRequest(context, context.fixtures.job, 'main'),
      enqueueRequest(context, context.fixtures.otherQueueJob, 'other-queue')
    ])
    const result = await succeed(
      operation(() => context.store.claim(claimRequest(context, context.fixtures))),
      context,
      'claim'
    )
    ensure(
      result.jobs.length === 1 && result.jobs[0]?.queue === context.fixtures.queueName,
      context,
      'queue isolation',
      'claim returned a different queue'
    )
  }),
  definition(
    'claim-accepted-identity-filter',
    'claim filters by accepted job identity',
    'claim',
    async (context) => {
      await enqueueMany(context, [
        enqueueRequest(context, context.fixtures.job, 'v1'),
        enqueueRequest(context, context.fixtures.jobV2, 'v2')
      ])
      const result = await succeed(
        operation(() =>
          context.store.claim(
            claimRequest(context, context.fixtures, { accepted: [context.fixtures.jobV2.identity] })
          )
        ),
        context,
        'claim'
      )
      ensure(
        result.jobs.length === 1 && result.jobs[0]?.version === 2,
        context,
        'accepted identity filter',
        'claim delivered an unaccepted version'
      )
    }
  ),
  definition('claim-respects-limit', 'claim never exceeds its limit', 'claim', async (context) => {
    await enqueueMany(context, [
      enqueueRequest(context, context.fixtures.job, 'limit-a'),
      enqueueRequest(context, context.fixtures.job, 'limit-b'),
      enqueueRequest(context, context.fixtures.job, 'limit-c')
    ])
    const result = await succeed(
      operation(() => context.store.claim(claimRequest(context, context.fixtures, { limit: 2 }))),
      context,
      'claim'
    )
    ensure(
      result.jobs.length === 2,
      context,
      'claim limit',
      `expected two jobs, received ${result.jobs.length}`
    )
  }),
  definition(
    'claim-concurrent-exclusive',
    'concurrent claims do not share a current lease',
    'claim',
    async (context) => {
      await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'exclusive'))
        ),
        context,
        'enqueue'
      )
      const [first, second] = await Promise.all([
        resolveOperation(
          context.store.claim(
            claimRequest(context, context.fixtures, { workerId: context.ids.workerId('one') })
          ),
          context,
          'claim'
        ),
        resolveOperation(
          context.store.claim(
            claimRequest(context, context.fixtures, { workerId: context.ids.workerId('two') })
          ),
          context,
          'claim'
        )
      ])
      ensure(
        !isErrorResult(first) && !isErrorResult(second),
        context,
        'claim atomicity',
        'concurrent claim failed'
      )
      const claimed = [first, second]
        .filter(
          (
            result
          ): result is AnyResult<JobStoreNamespace.ClaimResult> & {
            readonly value: JobStoreNamespace.ClaimResult
          } => !isErrorResult(result)
        )
        .flatMap((result) => result.value.jobs)
      ensure(
        claimed.length === 1,
        context,
        'claim atomicity',
        `expected one claim, received ${claimed.length}`
      )
    }
  ),
  definition(
    'claim-promotes-due-delayed',
    'claim promotes delayed work when its runAt is due',
    'claim',
    async (context) => {
      const runAt = now(context) + 100
      await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'due', { runAt }))
        ),
        context,
        'enqueue'
      )
      context.clock.advance(100)
      const result = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      ensure(
        result.jobs.length === 1 && result.jobs[0]?.state === 'active',
        context,
        'delayed promotion',
        'due delayed job was not claimed'
      )
    }
  ),
  definition(
    'claim-empty-wake-token',
    'empty claim returns coherent nextRunAt and wakeToken',
    'claim',
    async (context) => {
      const runAt = now(context) + 100
      await succeed(
        operation(() =>
          context.store.enqueue(
            enqueueRequest(context, context.fixtures.job, 'next-run', { runAt })
          )
        ),
        context,
        'enqueue'
      )
      const request = claimRequest(context, context.fixtures)
      const first = await succeed(
        operation(() => context.store.claim(request)),
        context,
        'claim'
      )
      const second = await succeed(
        operation(() => context.store.claim(request)),
        context,
        'claim'
      )
      ensure(
        first.jobs.length === 0 && second.jobs.length === 0,
        context,
        'empty claim',
        'empty claim returned work'
      )
      ensure(
        first.nextRunAt === runAt && second.nextRunAt === runAt,
        context,
        'empty claim timing',
        'nextRunAt was not the earliest due job'
      )
      ensure(
        first.wakeToken.length > 0 && first.wakeToken === second.wakeToken,
        context,
        'wake token coherence',
        'wakeToken changed without a mutation'
      )
    }
  ),
  definition(
    'claim-paused-queue',
    'paused queues do not deliver work',
    'claim',
    async (context) => {
      await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'paused'))
        ),
        context,
        'enqueue'
      )
      await succeed(
        operation(() =>
          context.store.pause({ queue: context.fixtures.queueName, now: now(context) })
        ),
        context,
        'pause'
      )
      const paused = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      ensure(paused.jobs.length === 0, context, 'pause delivery', 'paused queue delivered a job')
      await succeed(
        operation(() =>
          context.store.resume({ queue: context.fixtures.queueName, now: now(context) })
        ),
        context,
        'resume'
      )
      const resumed = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      ensure(
        resumed.jobs.length === 1,
        context,
        'pause delivery',
        'resumed queue did not deliver work'
      )
    }
  ),
  definition(
    'lease-claim-fields',
    'claim creates owner, token, expiry, and delivery fields',
    'lease',
    async (context) => {
      const job = await activeJob(context)
      ensure(
        job.leaseOwner === context.ids.workerId('primary'),
        context,
        'lease creation',
        'lease owner was not recorded'
      )
      ensure(
        job.leaseToken.length > 0 && job.leaseExpiresAt === now(context) + 100,
        context,
        'lease creation',
        'lease token or expiry was not recorded'
      )
      ensure(
        job.deliveryCount === 1 && job.attemptsMade === 0,
        context,
        'delivery accounting',
        'claim counters were changed incorrectly'
      )
    }
  ),
  definition(
    'lease-heartbeat-current-token',
    'heartbeat renews only the current lease token',
    'lease',
    async (context) => {
      const job = await activeJob(context)
      const result = await succeed(
        operation(() =>
          context.store.heartbeat({
            leases: [{ jobId: job.id, leaseToken: job.leaseToken }],
            leaseDurationMs: 200,
            now: now(context)
          })
        ),
        context,
        'heartbeat'
      )
      ensure(
        result.renewed.length === 1 && result.renewed[0]?.leaseExpiresAt === now(context) + 200,
        context,
        'heartbeat fencing',
        'current lease was not extended'
      )
      ensure(
        result.lost.length === 0,
        context,
        'heartbeat fencing',
        'current lease was reported lost'
      )
    }
  ),
  definition(
    'lease-fencing-rejects-old-token',
    'old settlement tokens fail without mutation',
    'lease',
    async (context) => {
      const job = await activeJob(context)
      const before = await succeed(
        operation(() => context.store.getJob({ jobId: job.id })),
        context,
        'getJob'
      )
      await reject(
        operation(() =>
          context.store.settle({
            jobId: job.id,
            leaseToken: context.ids.leaseToken('old'),
            now: now(context),
            outcome: { type: 'complete' }
          })
        ),
        context,
        'settle',
        'fencing',
        'LeaseLostError'
      )
      const after = await succeed(
        operation(() => context.store.getJob({ jobId: job.id })),
        context,
        'getJob'
      )
      ensure(
        before !== undefined &&
          after !== undefined &&
          JSON.stringify(before) === JSON.stringify(after),
        context,
        'fencing immutability',
        'old token changed the job'
      )
    }
  ),
  definition(
    'lease-release-no-attempt',
    'current release returns waiting without consuming a handler attempt',
    'lease',
    async (context) => {
      const job = await activeJob(context)
      const result = await succeed(
        operation(() =>
          context.store.release({ jobId: job.id, leaseToken: job.leaseToken, now: now(context) })
        ),
        context,
        'release'
      )
      ensure(
        result.record.state === 'waiting' &&
          result.record.attemptsMade === 0 &&
          result.record.deliveryCount === 1,
        context,
        'release accounting',
        'release changed attempt accounting'
      )
      ensure(
        result.attempt?.outcome === 'released',
        context,
        'release ledger',
        'release did not expose a released ledger entry'
      )
    }
  ),
  definition(
    'lease-release-old-token',
    'an old release token fails after redelivery',
    'lease',
    async (context) => {
      const first = await activeJob(context, context.fixtures.job, 'release-old')
      await succeed(
        operation(() =>
          context.store.release({
            jobId: first.id,
            leaseToken: first.leaseToken,
            now: now(context)
          })
        ),
        context,
        'release'
      )
      const second = await succeed(
        operation(() =>
          context.store.claim(
            claimRequest(context, context.fixtures, { workerId: context.ids.workerId('second') })
          )
        ),
        context,
        'claim'
      )
      const current = second.jobs[0]
      if (current === undefined)
        fail(context, 'release fencing', 'redelivery did not claim the released job')
      const currentJob = current!
      await reject(
        operation(() =>
          context.store.release({
            jobId: currentJob.id,
            leaseToken: first.leaseToken,
            now: now(context)
          })
        ),
        context,
        'release',
        'release fencing',
        'LeaseLostError'
      )
      const found = await succeed(
        operation(() => context.store.getJob({ jobId: currentJob.id })),
        context,
        'getJob'
      )
      ensure(
        found?.state === 'active' && found.leaseToken === currentJob.leaseToken,
        context,
        'release fencing',
        'old release mutated the current lease'
      )
    }
  ),
  definition(
    'lease-recover-expired',
    'expired leases are recovered and recorded as stalled',
    'lease',
    async (context) => {
      const job = await activeJob(context)
      context.clock.advance(100)
      const result = await succeed(
        operation(() => context.store.recoverStalled({ maxStalledCount: 3, now: now(context) })),
        context,
        'recoverStalled'
      )
      ensure(
        result.recovered === 1 && result.transitions[0]?.record.state === 'waiting',
        context,
        'stalled recovery',
        'expired lease was not requeued'
      )
      ensure(
        result.transitions[0]?.record.stalledCount === 1 &&
          result.transitions[0]?.attempt?.outcome === 'stalled',
        context,
        'stalled ledger',
        'stalled recovery was not recorded'
      )
      void job
    }
  ),
  definition(
    'lease-does-not-recover-valid',
    'valid leases are not recovered',
    'lease',
    async (context) => {
      await activeJob(context)
      const result = await succeed(
        operation(() => context.store.recoverStalled({ maxStalledCount: 3, now: now(context) })),
        context,
        'recoverStalled'
      )
      ensure(
        result.recovered === 0 && result.transitions.length === 0,
        context,
        'stalled recovery fencing',
        'a valid lease was recovered'
      )
    }
  ),
  definition(
    'lease-stall-policy',
    'repeated stalls eventually terminalize according to maxStalledCount',
    'lease',
    async (context) => {
      await activeJob(context, context.fixtures.job, 'stall-one')
      context.clock.advance(100)
      const first = await succeed(
        operation(() => context.store.recoverStalled({ maxStalledCount: 1, now: now(context) })),
        context,
        'recoverStalled'
      )
      ensure(
        first.transitions[0]?.record.state === 'waiting',
        context,
        'stall policy',
        'first allowed stall was terminal'
      )
      const claimed = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      const job = claimed.jobs[0]
      if (job === undefined) fail(context, 'stall policy', 'job disappeared after first stall')
      context.clock.advance(100)
      const second = await succeed(
        operation(() => context.store.recoverStalled({ maxStalledCount: 1, now: now(context) })),
        context,
        'recoverStalled'
      )
      ensure(
        second.transitions[0]?.record.state === 'failed',
        context,
        'stall policy',
        'stall budget did not terminalize the job'
      )
      ensure(
        second.transitions[0]?.record.failure?.kind === 'stalled',
        context,
        'stall policy',
        'terminal stall was not marked stalled'
      )
    }
  ),
  definition(
    'lease-cancellation-request',
    'active cancellation requests retain the lease until the next exit',
    'lease',
    async (context) => {
      const job = await activeJob(context)
      const requested = await succeed(
        operation(() => context.store.requestCancellation({ jobId: job.id, now: now(context) })),
        context,
        'requestCancellation'
      )
      ensure(
        requested.record.state === 'active' &&
          requested.record.leaseToken === job.leaseToken &&
          requested.record.cancellationRequestedAt !== undefined,
        context,
        'cancellation fencing',
        'cancellation stole the active lease'
      )
      const heartbeat = await succeed(
        operation(() =>
          context.store.heartbeat({
            leases: [{ jobId: job.id, leaseToken: job.leaseToken }],
            leaseDurationMs: 100,
            now: now(context)
          })
        ),
        context,
        'heartbeat'
      )
      ensure(
        heartbeat.cancellationRequested.some((id) => id === job.id),
        context,
        'cancellation notification',
        'heartbeat did not report cancellation'
      )
      const settled = await succeed(
        operation(() =>
          context.store.settle({
            jobId: job.id,
            leaseToken: job.leaseToken,
            now: now(context),
            outcome: { type: 'complete' }
          })
        ),
        context,
        'settle'
      )
      ensure(
        settled.record.state === 'cancelled',
        context,
        'cancellation settlement',
        'requested cancellation did not win'
      )
    }
  ),
  definition(
    'settle-complete-ledger',
    'complete persists result and one completed attempt',
    'settlement',
    async (context) => {
      const job = await activeJob(context)
      const result = await succeed(
        operation(() =>
          context.store.settle({
            jobId: job.id,
            leaseToken: job.leaseToken,
            now: now(context),
            outcome: { type: 'complete', result: { value: 'done' } }
          })
        ),
        context,
        'settle'
      )
      ensure(
        result.record.state === 'completed' &&
          JSON.stringify(result.record.result) === JSON.stringify({ value: 'done' }),
        context,
        'complete settlement',
        'result or state was not persisted'
      )
      ensure(
        result.attempt.outcome === 'completed' && result.attempt.attempt === 1,
        context,
        'complete ledger',
        'completed attempt was not recorded once'
      )
    }
  ),
  definition(
    'settle-retry-ledger',
    'retry persists failure and a future runAt',
    'settlement',
    async (context) => {
      const job = await activeJob(context)
      const runAt = now(context) + 100
      const result = await succeed(
        operation(() =>
          context.store.settle({
            jobId: job.id,
            leaseToken: job.leaseToken,
            now: now(context),
            outcome: { type: 'retry', runAt, failure: failure(context, 'TEMPORARY') }
          })
        ),
        context,
        'settle'
      )
      ensure(
        result.record.state === 'delayed' && result.record.runAt === runAt,
        context,
        'retry scheduling',
        'retry did not preserve the future runAt'
      )
      ensure(
        result.record.failure?.code === 'TEMPORARY' && result.attempt.outcome === 'retried',
        context,
        'retry ledger',
        'retry failure was not recorded'
      )
    }
  ),
  definition(
    'settle-fail-terminal',
    'fail is terminal and records a failed attempt',
    'settlement',
    async (context) => {
      const job = await activeJob(context)
      const result = await succeed(
        operation(() =>
          context.store.settle({
            jobId: job.id,
            leaseToken: job.leaseToken,
            now: now(context),
            outcome: { type: 'fail', failure: failure(context, 'PERMANENT') }
          })
        ),
        context,
        'settle'
      )
      ensure(
        result.record.state === 'failed' && result.attempt.outcome === 'failed',
        context,
        'terminal failure',
        'fail did not terminalize the job'
      )
      const claimed = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      ensure(
        claimed.jobs.length === 0,
        context,
        'terminal failure',
        'failed job was claimed without redrive'
      )
    }
  ),
  definition(
    'settle-cancelled-terminal',
    'cancelled settlement is terminal and consumes one attempt',
    'settlement',
    async (context) => {
      const job = await activeJob(context)
      const result = await succeed(
        operation(() =>
          context.store.settle({
            jobId: job.id,
            leaseToken: job.leaseToken,
            now: now(context),
            outcome: { type: 'cancelled' }
          })
        ),
        context,
        'settle'
      )
      ensure(
        result.record.state === 'cancelled' &&
          result.record.attemptsMade === 1 &&
          result.attempt.outcome === 'cancelled',
        context,
        'cancelled settlement',
        'cancelled settlement accounting was incorrect'
      )
    }
  ),
  definition(
    'settle-duplicate-no-reapply',
    'duplicate settlement does not apply a second transition',
    'settlement',
    async (context) => {
      const job = await activeJob(context)
      await succeed(
        operation(() =>
          context.store.settle({
            jobId: job.id,
            leaseToken: job.leaseToken,
            now: now(context),
            outcome: { type: 'complete' }
          })
        ),
        context,
        'settle'
      )
      const duplicate = await resolveOperation(
        context.store.settle({
          jobId: job.id,
          leaseToken: job.leaseToken,
          now: now(context),
          outcome: { type: 'complete' }
        }),
        context,
        'settle'
      )
      if (!isErrorResult(duplicate)) {
        ensure(
          duplicate.value.attempt.attempt === 1,
          context,
          'duplicate settlement',
          'duplicate settlement returned a new attempt'
        )
      }
      const attempts = await succeed(
        operation(() => context.store.getAttempts({ jobId: job.id })),
        context,
        'getAttempts'
      )
      ensure(
        attempts.length === 1,
        context,
        'duplicate settlement',
        `duplicate settlement created ${attempts.length} attempts`
      )
    }
  ),
  definition(
    'settle-attempt-once',
    'settlement increments attemptsMade exactly once',
    'settlement',
    async (context) => {
      const job = await activeJob(context)
      const result = await succeed(
        operation(() =>
          context.store.settle({
            jobId: job.id,
            leaseToken: job.leaseToken,
            now: now(context),
            outcome: { type: 'complete' }
          })
        ),
        context,
        'settle'
      )
      ensure(
        result.record.attemptsMade === 1 && result.attempt.attempt === 1,
        context,
        'attempt accounting',
        'settlement incremented the attempt more than once'
      )
    }
  ),
  definition(
    'redrive-preserves-ledger',
    'administrative redrive preserves prior delivery and attempt history',
    'settlement',
    async (context) => {
      const job = await activeJob(context)
      await succeed(
        operation(() =>
          context.store.settle({
            jobId: job.id,
            leaseToken: job.leaseToken,
            now: now(context),
            outcome: { type: 'fail', failure: failure(context, 'REDRIVE') }
          })
        ),
        context,
        'settle'
      )
      const before = await succeed(
        operation(() => context.store.getAttempts({ jobId: job.id })),
        context,
        'getAttempts'
      )
      const redriven = await succeed(
        operation(() =>
          context.store.redrive({ jobId: job.id, runAt: now(context), now: now(context) })
        ),
        context,
        'redrive'
      )
      ensure(
        redriven.record.state === 'waiting',
        context,
        'redrive',
        'failed job was not redriven to waiting'
      )
      ensure(
        redriven.record.deliveryCount === 1,
        context,
        'redrive history',
        'redrive reset delivery history'
      )
      const after = await succeed(
        operation(() => context.store.getAttempts({ jobId: job.id })),
        context,
        'getAttempts'
      )
      ensure(
        after.length === before.length,
        context,
        'redrive history',
        'redrive discarded the attempt ledger'
      )
    }
  ),
  definition(
    'release-stalled-ledger',
    'release and stalled recovery do not fake handler attempts',
    'settlement',
    async (context) => {
      const released = await activeJob(context, context.fixtures.job, 'released-ledger')
      const releasedResult = await succeed(
        operation(() =>
          context.store.release({
            jobId: released.id,
            leaseToken: released.leaseToken,
            now: now(context)
          })
        ),
        context,
        'release'
      )
      ensure(
        releasedResult.record.attemptsMade === 0 && releasedResult.attempt?.outcome === 'released',
        context,
        'release ledger',
        'release consumed a handler attempt'
      )
      const claimed = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      const active = claimed.jobs[0]
      if (active === undefined)
        fail(context, 'stalled ledger', 'released job could not be claimed again')
      const activeSnapshot = active!
      context.clock.advance(100)
      const recovered = await succeed(
        operation(() => context.store.recoverStalled({ maxStalledCount: 3, now: now(context) })),
        context,
        'recoverStalled'
      )
      const transition = recovered.transitions.find((item) => item.record.id === activeSnapshot.id)
      ensure(
        transition?.record.attemptsMade === 0 && transition.attempt?.outcome === 'stalled',
        context,
        'stalled ledger',
        'stalled recovery consumed or faked a handler attempt'
      )
    }
  ),
  definition(
    'admin-cancel-waiting-delayed',
    'administrative cancel handles waiting and delayed jobs',
    'admin',
    async (context) => {
      const waiting = await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'cancel-waiting'))
        ),
        context,
        'enqueue'
      )
      const delayed = await succeed(
        operation(() =>
          context.store.enqueue(
            enqueueRequest(context, context.fixtures.jobV2, 'cancel-delayed', {
              runAt: now(context) + 100
            })
          )
        ),
        context,
        'enqueue'
      )
      const first = await succeed(
        operation(() => context.store.cancel({ jobId: waiting.job.id, now: now(context) })),
        context,
        'cancel'
      )
      const second = await succeed(
        operation(() => context.store.cancel({ jobId: delayed.job.id, now: now(context) })),
        context,
        'cancel'
      )
      ensure(
        first.record.state === 'cancelled' && second.record.state === 'cancelled',
        context,
        'admin cancel',
        'waiting or delayed cancel did not terminalize'
      )
    }
  ),
  definition(
    'admin-cancel-terminal-rejected',
    'administrative cancel rejects terminal jobs',
    'admin',
    async (context) => {
      const job = await activeJob(context)
      await succeed(
        operation(() =>
          context.store.settle({
            jobId: job.id,
            leaseToken: job.leaseToken,
            now: now(context),
            outcome: { type: 'complete' }
          })
        ),
        context,
        'settle'
      )
      await reject(
        operation(() => context.store.cancel({ jobId: job.id, now: now(context) })),
        context,
        'cancel',
        'terminal cancellation',
        'JobNotCancellableError'
      )
    }
  ),
  definition(
    'admin-promote-delayed',
    'promote makes delayed work waiting without claiming it',
    'admin',
    async (context) => {
      const result = await succeed(
        operation(() =>
          context.store.enqueue(
            enqueueRequest(context, context.fixtures.job, 'promote', { runAt: now(context) + 100 })
          )
        ),
        context,
        'enqueue'
      )
      const promoted = await succeed(
        operation(() => context.store.promote({ jobId: result.job.id, now: now(context) })),
        context,
        'promote'
      )
      ensure(
        promoted.record.state === 'waiting' &&
          promoted.record.runAt === now(context) &&
          promoted.record.deliveryCount === 0,
        context,
        'promotion',
        'promote claimed or retained the future schedule'
      )
    }
  ),
  definition(
    'admin-promote-state-rejected',
    'promote rejects non-delayed jobs',
    'admin',
    async (context) => {
      const result = await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'not-delayed'))
        ),
        context,
        'enqueue'
      )
      await reject(
        operation(() => context.store.promote({ jobId: result.job.id, now: now(context) })),
        context,
        'promote',
        'promotion precondition',
        'JobNotPromotableError'
      )
    }
  ),
  definition(
    'admin-redrive-failed-only',
    'redrive is available only for terminal retryable states',
    'admin',
    async (context) => {
      const failed = await activeJob(context, context.fixtures.job, 'redrive-failed')
      await succeed(
        operation(() =>
          context.store.settle({
            jobId: failed.id,
            leaseToken: failed.leaseToken,
            now: now(context),
            outcome: { type: 'fail', failure: failure(context, 'REDRIVE-ONLY') }
          })
        ),
        context,
        'settle'
      )
      const redriven = await succeed(
        operation(() =>
          context.store.redrive({ jobId: failed.id, runAt: now(context) + 100, now: now(context) })
        ),
        context,
        'redrive'
      )
      ensure(
        redriven.record.state === 'delayed',
        context,
        'redrive precondition',
        'failed job was not redriven to a delayed state'
      )
      const completed = await activeJob(context, context.fixtures.jobV2, 'redrive-completed')
      await succeed(
        operation(() =>
          context.store.settle({
            jobId: completed.id,
            leaseToken: completed.leaseToken,
            now: now(context),
            outcome: { type: 'complete' }
          })
        ),
        context,
        'settle'
      )
      await reject(
        operation(() =>
          context.store.redrive({ jobId: completed.id, runAt: now(context), now: now(context) })
        ),
        context,
        'redrive',
        'redrive precondition',
        'JobNotRetryableError'
      )
    }
  ),
  definition(
    'admin-pause-resume',
    'pause and resume are durable store state',
    'admin',
    async (context) => {
      await succeed(
        operation(() =>
          context.store.pause({ queue: context.fixtures.queueName, now: now(context) })
        ),
        context,
        'pause'
      )
      const paused = await succeed(
        operation(() => context.store.pausedQueues()),
        context,
        'pausedQueues'
      )
      ensure(
        paused.some((queue) => queue === context.fixtures.queueName),
        context,
        'pause durability',
        'pausedQueues omitted the paused queue'
      )
      await succeed(
        operation(() =>
          context.store.resume({ queue: context.fixtures.queueName, now: now(context) })
        ),
        context,
        'resume'
      )
      const resumed = await succeed(
        operation(() => context.store.pausedQueues()),
        context,
        'pausedQueues'
      )
      ensure(
        !resumed.some((queue) => queue === context.fixtures.queueName),
        context,
        'resume durability',
        'resume did not clear the paused queue'
      )
    }
  ),
  definition(
    'admin-remove-active-rejected',
    'remove refuses active jobs',
    'admin',
    async (context) => {
      const job = await activeJob(context)
      await reject(
        operation(() =>
          context.store.remove({ jobId: job.id, now: now(context), expectedState: 'active' })
        ),
        context,
        'remove',
        'active removal precondition',
        'InvalidJobTransitionError'
      )
    }
  ),
  definition(
    'admin-counts-coherent',
    'counts remain coherent across state transitions',
    'admin',
    async (context) => {
      const waiting = await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'count-complete'))
        ),
        context,
        'enqueue'
      )
      const cancelled = await succeed(
        operation(() =>
          context.store.enqueue(
            enqueueRequest(context, context.fixtures.jobV2, 'count-cancel', {
              runAt: now(context) + 100
            })
          )
        ),
        context,
        'enqueue'
      )
      const claimed = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      const job = claimed.jobs[0]
      if (job === undefined) fail(context, 'counts', 'count fixture did not claim waiting job')
      const claimedJob = job!
      await succeed(
        operation(() =>
          context.store.settle({
            jobId: claimedJob.id,
            leaseToken: claimedJob.leaseToken,
            now: now(context),
            outcome: { type: 'complete' }
          })
        ),
        context,
        'settle'
      )
      await succeed(
        operation(() => context.store.cancel({ jobId: cancelled.job.id, now: now(context) })),
        context,
        'cancel'
      )
      const counts = await succeed(
        operation(() => context.store.counts()),
        context,
        'counts'
      )
      ensure(
        counts.total === 2 &&
          counts.completed === 1 &&
          counts.cancelled === 1 &&
          counts.waiting === 0 &&
          counts.delayed === 0 &&
          counts.active === 0,
        context,
        'counts coherence',
        JSON.stringify(counts)
      )
      void waiting
    }
  ),
  definition(
    'list-filters',
    'list supports the portable queue, name, and state filters',
    'listing',
    async (context) => {
      await enqueueMany(context, [
        enqueueRequest(context, context.fixtures.job, 'list-v1'),
        enqueueRequest(context, context.fixtures.jobV2, 'list-v2'),
        enqueueRequest(context, context.fixtures.otherNameJob, 'list-other-name'),
        enqueueRequest(context, context.fixtures.otherQueueJob, 'list-other-queue')
      ])
      const v2 = await succeed(
        operation(() =>
          context.store.list({
            queue: context.fixtures.queueName,
            name: context.fixtures.jobName,
            state: 'waiting',
            limit: 10
          })
        ),
        context,
        'list'
      )
      ensure(
        v2.jobs.length === 2 &&
          v2.jobs.every(
            (job) =>
              job.queue === context.fixtures.queueName && job.name === context.fixtures.jobName
          ),
        context,
        'list filters',
        'queue/name filters returned an unrelated job'
      )
      ensure(
        v2.jobs.some((job) => job.version === 2 && job.metadata.label === 'list-v2'),
        context,
        'list filters',
        'version or metadata fields were not preserved'
      )
      const states = await succeed(
        operation(() =>
          context.store.list({
            queue: context.fixtures.queueName,
            state: ['waiting', 'delayed'],
            limit: 10
          })
        ),
        context,
        'list'
      )
      ensure(
        states.jobs.every(
          (job) =>
            job.queue === context.fixtures.queueName &&
            (job.state === 'waiting' || job.state === 'delayed')
        ),
        context,
        'list state filter',
        'state filter returned an unrelated state'
      )
    }
  ),
  definition(
    'list-empty',
    'empty list states return no jobs and no cursor',
    'listing',
    async (context) => {
      const result = await succeed(
        operation(() => context.store.list({ limit: 10 })),
        context,
        'list'
      )
      ensure(
        result.jobs.length === 0 && result.nextCursor === undefined,
        context,
        'empty listing',
        'empty list returned jobs or a cursor'
      )
    }
  ),
  definition(
    'list-keyset-pagination',
    'keyset pagination has no overlap or loss',
    'listing',
    async (context) => {
      await enqueueMany(context, [
        enqueueRequest(context, context.fixtures.job, 'page-a'),
        enqueueRequest(context, context.fixtures.job, 'page-b'),
        enqueueRequest(context, context.fixtures.job, 'page-c'),
        enqueueRequest(context, context.fixtures.job, 'page-d'),
        enqueueRequest(context, context.fixtures.job, 'page-e')
      ])
      const all = await listAll(context, { limit: 2 })
      const ids = all.map((job) => job.id)
      ensure(
        ids.length === 5 && new Set(ids).size === ids.length,
        context,
        'keyset pagination',
        `expected five unique jobs, received ${ids.length}`
      )
    }
  ),
  definition(
    'list-timestamp-tie',
    'equal timestamps use a deterministic insertion tiebreaker',
    'listing',
    async (context) => {
      const requests = [
        enqueueRequest(context, context.fixtures.job, 'tie-one', {
          id: context.ids.jobId('tie-one')
        }),
        enqueueRequest(context, context.fixtures.job, 'tie-two', {
          id: context.ids.jobId('tie-two')
        }),
        enqueueRequest(context, context.fixtures.job, 'tie-three', {
          id: context.ids.jobId('tie-three')
        })
      ]
      await enqueueMany(context, requests)
      const result = await succeed(
        operation(() => context.store.list({ queue: context.fixtures.queueName, limit: 10 })),
        context,
        'list'
      )
      ensure(
        result.jobs.map((job) => String(payloadValue(job))).join(',') ===
          'tie-one,tie-two,tie-three',
        context,
        'listing tiebreak',
        'equal timestamp order was not deterministic'
      )
    }
  ),
  definition(
    'list-get-fields',
    'getJob and list expose the same public record fields',
    'listing',
    async (context) => {
      const inserted = await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'same-fields'))
        ),
        context,
        'enqueue'
      )
      const found = await succeed(
        operation(() => context.store.getJob({ jobId: inserted.job.id })),
        context,
        'getJob'
      )
      const listed = await succeed(
        operation(() => context.store.list({ queue: context.fixtures.queueName, limit: 10 })),
        context,
        'list'
      )
      const fromList = listed.jobs.find((job) => job.id === inserted.job.id)
      ensure(
        found !== undefined &&
          fromList !== undefined &&
          JSON.stringify(found) === JSON.stringify(fromList),
        context,
        'public snapshot parity',
        'getJob and list disagree'
      )
    }
  ),
  definition(
    'list-cursor-options',
    'cursor reuse with incompatible filters fails explicitly',
    'listing',
    async (context) => {
      await enqueueMany(context, [
        enqueueRequest(context, context.fixtures.job, 'cursor-one'),
        enqueueRequest(context, context.fixtures.job, 'cursor-two')
      ])
      const first = await succeed(
        operation(() => context.store.list({ queue: context.fixtures.queueName, limit: 1 })),
        context,
        'list'
      )
      ensure(
        first.nextCursor !== undefined,
        context,
        'cursor options',
        'list did not return a cursor'
      )
      const cursor = first.nextCursor
      if (cursor === undefined) return
      const incompatible = {
        queue: context.fixtures.otherQueueName,
        limit: 1,
        cursor
      }
      await reject(
        operation(() => context.store.list(incompatible)),
        context,
        'list',
        'cursor options',
        'UnsupportedJobStoreOperationError'
      )
    }
  ),
  definition(
    'list-support-matrix',
    'unsupported list filters fail instead of triggering a hidden scan',
    'listing',
    async (context) => {
      const request = {
        queue: context.fixtures.queueName,
        limit: 10,
        metadata: { label: 'unsupported' }
      } as unknown as ListJobsRequest
      await reject(
        operation(() => context.store.list(request)),
        context,
        'list',
        'query support matrix',
        'UnsupportedJobStoreOperationError'
      )
    }
  ),
  definition(
    'validation-rejects-invalid-duration',
    'invalid durations fail at the public request boundary',
    'validation',
    async (context) => {
      await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'invalid-duration'))
        ),
        context,
        'enqueue'
      )
      await reject(
        operation(() =>
          context.store.claim(claimRequest(context, context.fixtures, { leaseDurationMs: 0 }))
        ),
        context,
        'claim',
        'duration validation',
        'JobDefinitionError'
      )
    }
  ),
  definition(
    'clock-controlled-delay',
    'clock advancement reproduces delayed claim behavior',
    'time',
    async (context) => {
      const runAt = now(context) + 250
      await succeed(
        operation(() =>
          context.store.enqueue(
            enqueueRequest(context, context.fixtures.job, 'clock-delay', { runAt })
          )
        ),
        context,
        'enqueue'
      )
      const before = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      ensure(
        before.jobs.length === 0 && before.nextRunAt === runAt,
        context,
        'controlled time',
        'future work was claimed before clock advancement'
      )
      context.clock.advance(250)
      const after = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      ensure(
        after.jobs.length === 1 && after.jobs[0]?.runAt === runAt,
        context,
        'controlled time',
        'clock advancement did not make delayed work claimable'
      )
    }
  ),
  definition(
    'wake-abort',
    'awaitWake respects AbortSignal and returns its typed error',
    'wake',
    async (context) => {
      const empty = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      const controller = new AbortController()
      controller.abort()
      await reject(
        operation(() =>
          context.store.awaitWake({
            queues: [context.fixtures.queueName],
            wakeToken: empty.wakeToken,
            signal: controller.signal
          })
        ),
        context,
        'awaitWake',
        'wake abort',
        'JobStoreWakeAbortedError'
      )
    }
  ),
  definition(
    'wake-token-change',
    'a token change wakes a notification-capable store',
    'wake',
    async (context) => {
      const empty = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'wake'))
        ),
        context,
        'enqueue'
      )
      await succeed(
        operation(() =>
          context.store.awaitWake({
            queues: [context.fixtures.queueName],
            wakeToken: empty.wakeToken,
            signal: new AbortController().signal
          })
        ),
        context,
        'awaitWake'
      )
    },
    'notifications'
  ),
  definition(
    'wake-enqueue-notifies-waiter',
    'enqueue wakes a waiter registered on the same queue',
    'wake',
    async (context) => {
      const empty = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      let resolved = false
      const waiting = resolveOperation(
        context.store.awaitWake({
          queues: [context.fixtures.queueName],
          wakeToken: empty.wakeToken,
          signal: new AbortController().signal
        }),
        context,
        'awaitWake'
      ).then(() => {
        resolved = true
      })
      await Promise.resolve()
      await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'wake-waiter'))
        ),
        context,
        'enqueue'
      )
      await waiting
      ensure(resolved, context, 'wake notification', 'enqueue did not resolve the queue waiter')
    },
    'notifications'
  ),
  definition(
    'wake-queue-filter',
    'wake notifications do not cross queue boundaries',
    'wake',
    async (context) => {
      const empty = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      let resolved = false
      const waiting = resolveOperation(
        context.store.awaitWake({
          queues: [context.fixtures.queueName],
          wakeToken: empty.wakeToken,
          signal: new AbortController().signal
        }),
        context,
        'awaitWake'
      ).then(() => {
        resolved = true
      })
      await Promise.resolve()
      await succeed(
        operation(() =>
          context.store.enqueue(
            enqueueRequest(context, context.fixtures.otherQueueJob, 'other-queue-wake')
          )
        ),
        context,
        'enqueue'
      )
      await Promise.resolve()
      // Spurious wakes are allowed; require a relevant enqueue only when the waiter is still pending.
      if (!resolved) {
        await succeed(
          operation(() =>
            context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'main-queue-wake'))
          ),
          context,
          'enqueue'
        )
      }
      await waiting
    },
    'notifications'
  ),
  definition(
    'wake-occurs-before-wait',
    'a wake between empty claim and wait is observed by its token',
    'wake',
    async (context) => {
      const empty = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures))),
        context,
        'claim'
      )
      await succeed(
        operation(() =>
          context.store.enqueue(enqueueRequest(context, context.fixtures.job, 'pre-wait-wake'))
        ),
        context,
        'enqueue'
      )
      await succeed(
        operation(() =>
          context.store.awaitWake({
            queues: [context.fixtures.queueName],
            wakeToken: empty.wakeToken,
            signal: new AbortController().signal
          })
        ),
        context,
        'awaitWake'
      )
    },
    'notifications'
  ),
  definition(
    'batch-claim-order',
    'declared batch claiming returns one ordered batch',
    'claim',
    async (context) => {
      await enqueueMany(context, [
        enqueueRequest(context, context.fixtures.job, 'batch-claim-a'),
        enqueueRequest(context, context.fixtures.job, 'batch-claim-b')
      ])
      const result = await succeed(
        operation(() => context.store.claim(claimRequest(context, context.fixtures, { limit: 2 }))),
        context,
        'claim'
      )
      ensure(
        result.jobs.length === 2 && payloadValue(result.jobs[0]!) === 'batch-claim-a',
        context,
        'batch claim',
        'batch claim order was not preserved'
      )
    },
    'batchClaim'
  )
]

const extensionDefinitions = (
  extensions: readonly JobStoreContractExtension[] | undefined
): readonly ScenarioDefinition[] =>
  (extensions ?? []).map((extension) => {
    assertScenarioInfo(extension)
    assertFunction(extension.run, `extension ${extension.id}.run`)
    const scenario =
      extension.requires === undefined
        ? {
            id: extension.id,
            name: extension.name,
            category: extension.category,
            body: async (context: JobStoreContractScenarioContext): Promise<void> => {
              await extension.run(context)
            }
          }
        : {
            id: extension.id,
            name: extension.name,
            category: extension.category,
            requires: extension.requires,
            body: async (context: JobStoreContractScenarioContext): Promise<void> => {
              await extension.run(context)
            }
          }
    return Object.freeze(scenario)
  })

const makeSkipped = (
  definition: ScenarioDefinition,
  capability: keyof JobStoreCapabilities
): JobStoreContractSkippedScenario =>
  Object.freeze({
    id: definition.id,
    name: definition.name,
    category: definition.category,
    capability,
    reason: `requires declared capability ${capability}`
  })

const validateOptions = (options: JobStoreContractOptions, token: AnyJobStoreToken): void => {
  if (!isRecord(options)) {
    throw new TypeError('jobStoreContract options must be an object')
  }

  assertFunction(options.makeRuntime, 'makeRuntime')

  if (options.setup !== undefined) assertFunction(options.setup, 'setup')
  if (options.reset !== undefined) assertFunction(options.reset, 'reset')
  if (
    options.controls !== undefined &&
    typeof options.controls !== 'function' &&
    !isRecord(options.controls)
  ) {
    throw new TypeError('jobStoreContract controls must be an object or factory')
  }

  if (options.extensions !== undefined && !Array.isArray(options.extensions)) {
    throw new TypeError('jobStoreContract extensions must be an array')
  }

  if (!isRecord(token) || typeof token.serviceTag !== 'string') {
    throw new TypeError('jobStoreContract token must be a JobStore token')
  }
}

/**
 * Build stable, runner-agnostic JobStore scenarios.
 *
 * Every returned scenario creates controls on invocation, runs setup, creates
 * its runtime, and disposes every opened runtime before calling reset. A
 * scenario's primary
 * assertion or defect is rethrown unchanged; cleanup is reported only when the
 * scenario itself succeeded. Basic scenarios are always returned. Capability
 * flags add scenarios and never remove basic correctness checks.
 */
export const jobStoreContract = (options: JobStoreContractOptions): JobStoreContractSuite => {
  if (!isRecord(options)) {
    throw new TypeError('jobStoreContract options must be an object')
  }

  const token = options.token ?? JobStore
  validateOptions(options, token)
  const capabilities = normalizeCapabilities(options.capabilities)
  const definitions = [...builtInScenarios(), ...extensionDefinitions(options.extensions)]
  const seen = new Set<string>()

  for (const item of definitions) {
    if (seen.has(item.id)) {
      throw new TypeError(`jobStoreContract scenario id is duplicated: ${item.id}`)
    }

    seen.add(item.id)
    if (item.requires !== undefined && !capabilityNames.includes(item.requires)) {
      throw new TypeError(`jobStoreContract scenario ${item.id} uses an unknown capability`)
    }
  }

  const skipped = definitions
    .filter((item) => item.requires !== undefined && !capabilities[item.requires])
    .map((item) => makeSkipped(item, item.requires!))
  const enabled = definitions.filter(
    (item) => item.requires === undefined || capabilities[item.requires]
  )
  const testedCapabilities = new Set<keyof JobStoreCapabilities>()

  for (const item of enabled) {
    if (item.requires !== undefined) testedCapabilities.add(item.requires)
  }

  const state: ReportState = {
    capabilities,
    executed: new Set(),
    passed: new Set(),
    failed: new Set(),
    skipped: Object.freeze(skipped),
    capabilitiesNotTested: Object.freeze(
      capabilityNames.filter((name) => !testedCapabilities.has(name))
    )
  }
  const scenarios = enabled.map((item) => makeScenario(item, options, token, state))
  const suite = scenarios as JobStoreContractScenario[] & {
    report?: () => JobStoreContractReport
  }

  Object.defineProperty(suite, 'report', {
    configurable: false,
    enumerable: true,
    value: (): JobStoreContractReport => reportSnapshot(state),
    writable: false
  })

  return Object.freeze(suite) as JobStoreContractSuite
}

export type {
  AnyJobDefinition,
  AnyJobRegistry,
  AnyQueueDefinition,
  EnqueueRequest,
  JobIdentity,
  JobRecord,
  JobStoreCapabilities,
  JobStoreError,
  JobStoreOperation,
  LeaseToken,
  ListJobsRequest,
  SerializedJobFailure,
  WorkerId
}
