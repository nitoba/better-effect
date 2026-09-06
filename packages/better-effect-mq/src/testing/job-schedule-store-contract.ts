// oxlint-disable anti-slop/no-runtime-typeof -- the contract validates adapter factories at its public boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- extension hooks intentionally accept runner-neutral input.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- the record guard is only used to validate adapter boundaries.
// oxlint-disable anti-slop/no-chained-type-assertions -- assertions are confined to erased contract boundaries.
// oxlint-disable typescript/unbound-method -- clock methods are checked for callability at a public boundary.
// oxlint-disable anti-slop/no-known-value-widening -- arbitrary setup/adapter failures must be preserved as primary causes.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts restore types after Result checks.

import { Effect, Layer, Runtime } from 'better-effect'
import { Clock, ClockTest } from 'better-effect/standard-services'
import { Result, type Result as ResultType } from 'better-result'
import type { AnyService } from 'better-effect'

import {
  Codec,
  JobScheduleStore,
  JobSchedules,
  JobStore,
  Queue,
  QueueName,
  makeJobId,
  makeScheduleOccurrenceId,
  makeWorkerId,
  nextCronOccurrence
} from '../index'

import type {
  AnyJobDefinition,
  AnyJobScheduleStoreToken,
  DefaultJobScheduleStoreToken,
  JobScheduleStoreToken,
  AnyJobSchedulesDefinition,
  ScheduleAddress,
  ScheduleReconcileError,
  ScheduleRecord,
  ScheduleReconcileOptions,
  ScheduleReconcileReport,
  ScheduleSelector,
  ScheduleStoreError,
  ScheduleStoreOperation,
  TickScheduleCommand,
  JobScheduleStoreContract as JobScheduleStoreContractType
} from '../index'
import type { JobStore as JobStoreNamespace } from '../store'

/** A value that may complete synchronously or asynchronously. */
export type JobScheduleStoreContractMaybePromise<Value> = Value | PromiseLike<Value>

/** Stable metadata shared by a schedule contract scenario and its extensions. */
export interface JobScheduleStoreContractScenarioInfo {
  readonly id: string
  readonly name: string
  readonly category: string
}

/** A runner-neutral schedule contract scenario. */
export interface JobScheduleStoreContractScenario extends JobScheduleStoreContractScenarioInfo {
  readonly run: () => Promise<void>
}

/** Generic alias for integrations that call all conformance cases contracts. */
export type ScheduleContractScenario = JobScheduleStoreContractScenario

/** Deterministic clock supplied to factories and scenario extensions. */
export type JobScheduleStoreContractClock = ClockTest

/** Factory context for the associated JobStore. */
export interface JobScheduleStoreContractStoreContext<
  Token extends AnyJobScheduleStoreToken = AnyJobScheduleStoreToken
> extends JobScheduleStoreContractScenarioInfo {
  readonly scenario: JobScheduleStoreContractScenarioInfo
  readonly token: Token['jobStore']
  readonly scheduleToken: Token
  readonly clock: JobScheduleStoreContractClock
}

/** Factory context for the schedule extension. */
export interface JobScheduleStoreContractScheduleContext<
  Token extends AnyJobScheduleStoreToken = AnyJobScheduleStoreToken
> extends JobScheduleStoreContractStoreContext<Token> {
  readonly jobStore: JobStoreNamespace.Contract
}

/** A context-independent setup/reset hook. */
export interface JobScheduleStoreContractContext<
  Token extends AnyJobScheduleStoreToken = AnyJobScheduleStoreToken
> extends JobScheduleStoreContractScenarioInfo {
  readonly scenario: JobScheduleStoreContractScenarioInfo
  readonly token: Token
  readonly jobStoreToken: Token['jobStore']
  readonly clock: JobScheduleStoreContractClock
  readonly hooks: JobScheduleStoreContractHooks
  checkpoint(point: string): Promise<void>
}

/** Optional deterministic hook used by adapter-specific crash/response-loss tests. */
export interface JobScheduleStoreContractHooks {
  checkpoint?(
    point: string,
    scenario: JobScheduleStoreContractScenarioInfo
  ): JobScheduleStoreContractMaybePromise<void>
}

/** Public fixtures shared with extensions. */
export interface JobScheduleStoreContractFixtures<
  _Token extends AnyJobScheduleStoreToken = AnyJobScheduleStoreToken
> {
  readonly queueName: QueueName
  readonly job: AnyJobDefinition
  readonly jobV2: AnyJobDefinition
  readonly otherJob: AnyJobDefinition
  readonly record: ScheduleRecord
}

/** A directly opened schedule/job store pair. */
export interface JobScheduleStoreContractClient<
  Token extends AnyJobScheduleStoreToken = AnyJobScheduleStoreToken
> {
  readonly token: Token
  readonly jobStoreToken: Token['jobStore']
  readonly store: JobScheduleStoreContractType
  readonly jobStore: JobStoreNamespace.Contract
  readonly clock: JobScheduleStoreContractClock
}

/** The three stable schedule and JobStore tokens used by named-store coverage. */
export interface JobScheduleStoreContractMultiStoreTokens {
  readonly default: DefaultJobScheduleStoreToken
  readonly first: JobScheduleStoreToken<JobStoreNamespace.Token<'contract-schedule-a'>>
  readonly second: JobScheduleStoreToken<JobStoreNamespace.Token<'contract-schedule-b'>>
}

/** Stores opened together for named-store isolation. */
export interface JobScheduleStoreContractMultiStoreClient {
  readonly tokens: JobScheduleStoreContractMultiStoreTokens
  readonly jobStores: {
    readonly default: JobStoreNamespace.Contract
    readonly first: JobStoreNamespace.Contract
    readonly second: JobStoreNamespace.Contract
  }
  readonly stores: {
    readonly default: JobScheduleStoreContractType
    readonly first: JobScheduleStoreContractType
    readonly second: JobScheduleStoreContractType
  }
}

/** Scenario context supplied to extensions. */
export interface JobScheduleStoreContractScenarioContext<
  Token extends AnyJobScheduleStoreToken = AnyJobScheduleStoreToken
> extends JobScheduleStoreContractContext<Token> {
  readonly client: JobScheduleStoreContractClient<Token>
  readonly store: JobScheduleStoreContractType
  readonly jobStore: JobStoreNamespace.Contract
  readonly fixtures: JobScheduleStoreContractFixtures<Token>
  openMultiStore(): Promise<JobScheduleStoreContractMultiStoreClient>
}

/** Additional adapter-specific scenario sharing the contract lifecycle. */
export interface JobScheduleStoreContractExtension<
  Token extends AnyJobScheduleStoreToken = AnyJobScheduleStoreToken
> extends JobScheduleStoreContractScenarioInfo {
  readonly run: (
    context: JobScheduleStoreContractScenarioContext<Token>
  ) => JobScheduleStoreContractMaybePromise<void>
}

/** Runtime-neutral factory options for the schedule conformance suite. */
export interface JobScheduleStoreContractOptions<
  Token extends AnyJobScheduleStoreToken = DefaultJobScheduleStoreToken
> {
  /** Make the JobStore associated with the schedule token. */
  readonly makeStore: (
    context: JobScheduleStoreContractStoreContext<Token>
  ) => JobScheduleStoreContractMaybePromise<JobStoreNamespace.Contract>
  /** Make the schedule extension over the associated JobStore. */
  readonly makeScheduleStore: (
    context: JobScheduleStoreContractScheduleContext<Token>
  ) => JobScheduleStoreContractMaybePromise<JobScheduleStoreContractType>
  /** Use a fresh clock per scenario when supplied as a factory. */
  readonly clock?: JobScheduleStoreContractClock | (() => JobScheduleStoreContractClock)
  /** Called before each pair of stores is created. */
  readonly setup?: (
    context: JobScheduleStoreContractContext<Token>
  ) => JobScheduleStoreContractMaybePromise<void>
  /** Called after each scenario, including setup/factory failures. */
  readonly reset?: (
    context: JobScheduleStoreContractContext<Token>
  ) => JobScheduleStoreContractMaybePromise<void>
  /** Optional hooks for deterministic adapter-specific failure injection. */
  readonly hooks?: JobScheduleStoreContractHooks
  /** Additional adapter-specific scenarios. */
  readonly extensions?: readonly JobScheduleStoreContractExtension<Token>[]
  /** The schedule token provided by the factories; defaults to JobScheduleStore. */
  readonly token?: Token
}

/** Detached report of the schedule extension coverage. */
export interface JobScheduleStoreContractReport {
  readonly version: 1
  readonly extensionVersion: 1
  readonly jobStoreProtocolVersion: 1
  readonly descriptor: JobScheduleStoreContractType['descriptor'] | undefined
  readonly executed: readonly string[]
  readonly passed: readonly string[]
  readonly failed: readonly string[]
}

/** Returned scenarios with a stable report snapshot. */
export type JobScheduleStoreContractSuite = readonly JobScheduleStoreContractScenario[] & {
  readonly report: () => JobScheduleStoreContractReport
}

/** Error identifying the schedule invariant that failed. */
export class JobScheduleStoreConformanceError extends Error {
  readonly scenarioId: string
  readonly scenarioName: string
  readonly category: string
  readonly invariant: string

  constructor(
    scenario: JobScheduleStoreContractScenarioInfo,
    invariant: string,
    detail: string,
    cause?: unknown
  ) {
    super(`${scenario.id} (${scenario.name}) [${invariant}]: ${detail}`, { cause })
    this.name = 'JobScheduleStoreConformanceError'
    this.scenarioId = scenario.id
    this.scenarioName = scenario.name
    this.category = scenario.category
    this.invariant = invariant
  }
}

type AnyScheduleResult<Value> = ResultType<Value, ScheduleStoreError>

type ScenarioBody<Token extends AnyJobScheduleStoreToken = AnyJobScheduleStoreToken> = (
  context: JobScheduleStoreContractScenarioContext<Token>
) => Promise<void>

type ScenarioDefinition<Token extends AnyJobScheduleStoreToken = AnyJobScheduleStoreToken> =
  JobScheduleStoreContractScenarioInfo & { readonly body: ScenarioBody<Token> }

type ReportState = {
  descriptor: JobScheduleStoreContractType['descriptor'] | undefined
  readonly executed: Set<string>
  readonly passed: Set<string>
  readonly failed: Set<string>
}

const baseTime = 1_700_000_000_000
const cadence = 1_000
const descriptor = Object.freeze({
  extension: 'better-effect-mq/schedules' as const,
  extensionVersion: 1 as const,
  jobStoreProtocolVersion: 1 as const
})

const multiTokens: JobScheduleStoreContractMultiStoreTokens = Object.freeze({
  default: JobScheduleStore,
  first: JobScheduleStore.for(JobStore.named('contract-schedule-a')),
  second: JobScheduleStore.for(JobStore.named('contract-schedule-b'))
})

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)

const ensure = (
  condition: boolean,
  scenario: JobScheduleStoreContractScenarioInfo,
  invariant: string,
  detail: string
): void => {
  if (!condition) throw new JobScheduleStoreConformanceError(scenario, invariant, detail)
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const assertFunction = (value: unknown, field: string): void => {
  if (typeof value !== 'function') {
    throw new TypeError(`jobScheduleStoreContract ${field} must be a function`)
  }
}

const resolveOperation = async <Value>(
  operation: ScheduleStoreOperation<Value, ScheduleStoreError>,
  context: JobScheduleStoreContractScenarioInfo,
  name: string
): Promise<AnyScheduleResult<Value>> => {
  try {
    const result = await operation
    if (Result.isOk(result) || Result.isError(result)) return result as AnyScheduleResult<Value>
    throw new TypeError(`${name} did not return a better-result Result`)
  } catch (cause) {
    throw new JobScheduleStoreConformanceError(
      context,
      `${name} result boundary`,
      'operation rejected or returned an invalid Result',
      cause
    )
  }
}

const succeed = async <Value>(
  operation: ScheduleStoreOperation<Value, ScheduleStoreError>,
  context: JobScheduleStoreContractScenarioInfo,
  name: string,
  invariant = `${name} succeeds`
): Promise<Value> => {
  const result = await resolveOperation(operation, context, name)
  if (Result.isError(result)) {
    throw new JobScheduleStoreConformanceError(context, invariant, describe(result.error))
  }
  return result.value
}

const expectError = async (
  operation: ScheduleStoreOperation<unknown, ScheduleStoreError>,
  context: JobScheduleStoreContractScenarioInfo,
  name: string,
  invariant: string
): Promise<void> => {
  const result = await resolveOperation(operation, context, name)
  ensure(Result.isError(result), context, invariant, `${name} unexpectedly succeeded`)
}

const makeContext = <Token extends AnyJobScheduleStoreToken>(
  options: JobScheduleStoreContractOptions<Token>,
  scenario: JobScheduleStoreContractScenarioInfo,
  token: Token
): JobScheduleStoreContractContext<Token> => {
  const supplied = options.clock
  const clock =
    typeof supplied === 'function'
      ? supplied()
      : supplied === undefined
        ? new ClockTest(baseTime)
        : supplied

  if (!isRecord(clock)) throw new TypeError('jobScheduleStoreContract clock must be a ClockTest')
  assertFunction(clock.now, 'clock.now')
  assertFunction(clock.advance, 'clock.advance')
  assertFunction(clock.sleep, 'clock.sleep')

  const hooks = options.hooks ?? {}
  assertFunction(hooks.checkpoint ?? (() => {}), 'hooks.checkpoint')

  const context: JobScheduleStoreContractContext<Token> = {
    ...scenario,
    scenario,
    token,
    jobStoreToken: token.jobStore,
    clock,
    hooks,
    async checkpoint(point: string): Promise<void> {
      if (typeof point !== 'string' || point.length === 0) {
        throw new JobScheduleStoreConformanceError(
          scenario,
          'extension hook',
          'checkpoint names must be non-empty'
        )
      }
      try {
        await hooks.checkpoint?.(point, scenario)
      } catch (cause) {
        throw new JobScheduleStoreConformanceError(
          scenario,
          `checkpoint:${point}`,
          'checkpoint failed',
          cause
        )
      }
    }
  }

  return Object.freeze(context)
}

const makeFixtures = <Token extends AnyJobScheduleStoreToken>(
  token: Token,
  scenario: JobScheduleStoreContractScenarioInfo
): JobScheduleStoreContractFixtures<Token> => {
  const payload = Codec.json<{ readonly value: string }>()
  const queue = Queue.define('schedule-contract')
  const job = queue.job('scheduled-job', { version: 1, payload, store: token.jobStore })
  const jobV2 = queue.job('scheduled-job', { version: 2, payload, store: token.jobStore })
  const otherJob = queue.job('other-job', { version: 1, payload, store: token.jobStore })
  const queueName = QueueName.make(queue.queue).unwrap()
  const record: ScheduleRecord = {
    key: 'contract-schedule',
    group: 'contract-group',
    job: job.identity,
    queue: queueName,
    cron: undefined,
    everyMs: cadence,
    timeZone: 'UTC',
    payload: { value: scenario.id },
    metadata: { source: 'job-schedule-store-contract' },
    priority: 0,
    attemptsMax: 1,
    backoff: undefined,
    timeoutMs: undefined,
    misfire: { strategy: 'run-once' },
    overlap: 'allow',
    paused: false,
    revision: 0,
    nextRunAtMs: baseTime + cadence,
    lastScheduledAtMs: undefined,
    lastJobId: undefined,
    createdAtMs: baseTime,
    updatedAtMs: baseTime
  }

  return Object.freeze({ queueName, job, jobV2, otherJob, record })
}

const makeStoreContext = <Token extends AnyJobScheduleStoreToken>(
  context: JobScheduleStoreContractContext<Token>,
  token: Token
): JobScheduleStoreContractStoreContext<Token> =>
  Object.freeze({
    ...context,
    token: token.jobStore,
    scheduleToken: token
  })

const makeClient = async <Token extends AnyJobScheduleStoreToken>(
  options: JobScheduleStoreContractOptions<Token>,
  context: JobScheduleStoreContractContext<Token>,
  token: Token
): Promise<JobScheduleStoreContractClient<Token>> => {
  const storeContext = makeStoreContext(context, token)
  let jobStore: JobStoreNamespace.Contract
  try {
    jobStore = await options.makeStore(storeContext)
  } catch (cause) {
    throw new JobScheduleStoreConformanceError(
      context,
      'factory lifecycle',
      'makeStore failed',
      cause
    )
  }
  if (!isRecord(jobStore) || !isRecord(jobStore.descriptor)) {
    throw new JobScheduleStoreConformanceError(
      context,
      'factory lifecycle',
      'makeStore must return a JobStore contract'
    )
  }

  let store: JobScheduleStoreContractType
  try {
    store = await options.makeScheduleStore({ ...storeContext, jobStore })
  } catch (cause) {
    throw new JobScheduleStoreConformanceError(
      context,
      'factory lifecycle',
      'makeScheduleStore failed',
      cause
    )
  }
  if (!isRecord(store) || !isRecord(store.descriptor)) {
    throw new JobScheduleStoreConformanceError(
      context,
      'factory lifecycle',
      'makeScheduleStore must return a JobScheduleStore contract'
    )
  }

  ensure(
    store.descriptor.extension === descriptor.extension &&
      store.descriptor.extensionVersion === descriptor.extensionVersion &&
      store.descriptor.jobStoreProtocolVersion === descriptor.jobStoreProtocolVersion,
    context,
    'descriptor compatibility',
    'the resolved schedule store does not implement schedules extension v1 over JobStore v1'
  )

  return Object.freeze({
    token,
    jobStoreToken: token.jobStore,
    store,
    jobStore,
    clock: context.clock
  })
}

const openMultiStore = async <Token extends AnyJobScheduleStoreToken>(
  options: JobScheduleStoreContractOptions<Token>,
  context: JobScheduleStoreContractContext<Token>
): Promise<JobScheduleStoreContractMultiStoreClient> => {
  const open = async <Current extends AnyJobScheduleStoreToken>(
    token: Current
  ): Promise<JobScheduleStoreContractClient<Current>> =>
    // SAFETY: named-store coverage intentionally opens the same factory with a different associated token.
    makeClient(
      options as unknown as JobScheduleStoreContractOptions<Current>,
      context as unknown as JobScheduleStoreContractContext<Current>,
      token
    )

  const clients = await Promise.all([
    open(multiTokens.default),
    open(multiTokens.first),
    open(multiTokens.second)
  ])

  return Object.freeze({
    tokens: multiTokens,
    jobStores: Object.freeze({
      default: clients[0].jobStore,
      first: clients[1].jobStore,
      second: clients[2].jobStore
    }),
    stores: Object.freeze({
      default: clients[0].store,
      first: clients[1].store,
      second: clients[2].store
    })
  })
}

const recordWith = (
  fixtures: JobScheduleStoreContractFixtures,
  overrides: Partial<ScheduleRecord> = {}
): ScheduleRecord => ({ ...fixtures.record, ...overrides })

const addressOf = (record: Pick<ScheduleRecord, 'group' | 'key'>): ScheduleAddress => ({
  group: record.group,
  key: record.key
})

const selectorOf = (record: Pick<ScheduleRecord, 'group' | 'key'>): ScheduleSelector =>
  addressOf(record)

const tick = (
  record: ScheduleRecord,
  nowMs: number,
  occurrences: readonly number[],
  nextRunAtMs: number,
  skippedSlots?: readonly number[]
): TickScheduleCommand => ({
  key: selectorOf(record),
  expectedRevision: record.revision,
  expectedRunAtMs: record.nextRunAtMs,
  nowMs,
  decision:
    skippedSlots === undefined
      ? { occurrences, nextRunAtMs }
      : { occurrences, nextRunAtMs, skippedSlots }
})

const runReconcile = async <Token extends AnyJobScheduleStoreToken>(
  client: JobScheduleStoreContractClient<Token>,
  definition: AnyJobSchedulesDefinition,
  options: ScheduleReconcileOptions
): Promise<ResultType<ScheduleReconcileReport, ScheduleReconcileError>> => {
  // SAFETY: this internal test layer supplies the exact contracts carried by the client;
  // the associated named-token relationship is erased only while constructing the runtime.
  const layer = Layer.merge(
    Layer.succeed(client.jobStoreToken as never, client.jobStore as never),
    Layer.merge(
      Layer.succeed(client.token as never, client.store as never),
      Layer.succeed(Clock, client.clock)
    )
  ) as never
  const runtime = await Runtime.make(layer)
  try {
    // SAFETY: the layer above supplies all services required by this erased definition;
    // the assertion is limited to the internal reconciliation test runner.
    const run = runtime.run.bind(runtime) as Runtime<AnyService>['run']
    return await run(() =>
      Effect.gen(async function* () {
        const report = yield* JobSchedules.reconcile(definition, options)
        return Result.ok(report)
      })
    )
  } finally {
    await runtime.dispose()
  }
}

const definition = (
  id: string,
  name: string,
  category: string,
  body: ScenarioBody
): ScenarioDefinition => Object.freeze({ id, name, category, body })

const builtInScenarios = (): readonly ScenarioDefinition[] => [
  definition(
    'validation-cadence-and-timezone',
    'invalid cadence and timezone are rejected at the store boundary',
    'validation',
    async ({ store, fixtures, scenario }) => {
      const both = recordWith(fixtures, {
        cron: '* * * * *',
        everyMs: cadence,
        key: 'both'
      })
      const neither = recordWith(fixtures, { cron: undefined, everyMs: undefined, key: 'neither' })
      const invalidZone = recordWith(fixtures, { timeZone: 'Not/A-Timezone', key: 'timezone' })

      await expectError(store.upsertSchedule(both), scenario, 'upsert', 'exactly one cadence')
      await expectError(store.upsertSchedule(neither), scenario, 'upsert', 'exactly one cadence')
      await expectError(store.upsertSchedule(invalidZone), scenario, 'upsert', 'valid timezone')
      const listed = await succeed(store.listSchedules(), scenario, 'list')
      ensure(
        listed.length === 0,
        scenario,
        'invalid input is atomic',
        'an invalid record was persisted'
      )
    }
  ),
  definition(
    'upsert-idempotent-cadence',
    'unchanged upserts preserve position and cadence changes advance revision',
    'upsert',
    async ({ store, fixtures, scenario }) => {
      const first = await succeed(store.upsertSchedule(fixtures.record), scenario, 'upsert')
      const unchanged = await succeed(
        store.upsertSchedule({ ...first.record, updatedAtMs: baseTime + 50 }),
        scenario,
        'upsert'
      )
      ensure(
        !unchanged.created && !unchanged.changed,
        scenario,
        'idempotent upsert',
        'upsert changed an equal schedule'
      )
      ensure(
        unchanged.record.revision === first.record.revision &&
          unchanged.record.nextRunAtMs === first.record.nextRunAtMs &&
          unchanged.record.updatedAtMs === first.record.updatedAtMs,
        scenario,
        'idempotent upsert',
        'equal cadence did not preserve revision, nextRunAtMs, and timestamps'
      )

      const changed = await succeed(
        store.upsertSchedule({
          ...first.record,
          cron: '*/5 * * * *',
          everyMs: undefined,
          nextRunAtMs: baseTime + 5_000,
          updatedAtMs: baseTime + 100
        }),
        scenario,
        'upsert'
      )
      ensure(
        changed.changed && changed.record.revision === first.record.revision + 1,
        scenario,
        'cadence revision',
        'cadence change did not advance revision'
      )
      ensure(
        changed.record.nextRunAtMs === baseTime + 5_000,
        scenario,
        'cadence position',
        'cadence change discarded the supplied next occurrence'
      )
    }
  ),
  definition(
    'cas-concurrent-occurrence',
    'concurrent ticks allow one winner and one stale result',
    'atomicity',
    async ({ store, jobStore, fixtures, scenario }) => {
      const created = await succeed(store.upsertSchedule(fixtures.record), scenario, 'upsert')
      const command = tick(
        created.record,
        baseTime + cadence,
        [created.record.nextRunAtMs],
        baseTime + 2 * cadence
      )
      const results = await Promise.all([store.tickSchedule(command), store.tickSchedule(command)])
      const fired = results.find((result) => Result.isOk(result) && result.value.status === 'fired')
      const stale = results.find((result) => Result.isOk(result) && result.value.status === 'stale')
      ensure(
        fired !== undefined && stale !== undefined,
        scenario,
        'schedule CAS',
        'concurrent ticks did not split into fired and stale'
      )
      if (fired !== undefined && Result.isOk(fired)) {
        ensure(
          fired.value.jobs.length === 1,
          scenario,
          'schedule CAS',
          'the winning tick created more than one job'
        )
      }
      const jobCounts = await jobStore.counts()
      if (Result.isError(jobCounts)) throw jobCounts.error
      ensure(
        jobCounts.value.total === 1,
        scenario,
        'schedule CAS',
        'the losing tick duplicated the occurrence'
      )
    }
  ),
  definition(
    'response-loss-retry',
    'retrying a committed tick does not refire its deterministic occurrence',
    'atomicity',
    async ({ store, jobStore, fixtures, scenario }) => {
      const created = await succeed(store.upsertSchedule(fixtures.record), scenario, 'upsert')
      const command = tick(
        created.record,
        baseTime + cadence,
        [created.record.nextRunAtMs],
        baseTime + 2 * cadence
      )
      const first = await succeed(store.tickSchedule(command), scenario, 'tickSchedule')
      const retry = await succeed(store.tickSchedule(command), scenario, 'tickSchedule')
      ensure(
        first.status === 'fired' && retry.status === 'stale',
        scenario,
        'response-loss retry',
        'a replayed committed command was not stale'
      )
      const total = await jobStore.counts()
      if (Result.isError(total)) throw total.error
      ensure(
        total.value.total === 1,
        scenario,
        'response-loss retry',
        'retry created a duplicate job'
      )
    }
  ),
  definition(
    'deterministic-occurrence-id',
    'occurrence IDs are stable, bounded, and collision-free for encoded keys',
    'identity',
    async ({ store, fixtures, scenario }) => {
      const first = recordWith(fixtures, { key: 'billing/invoices' })
      const created = await succeed(store.upsertSchedule(first), scenario, 'upsert')
      const slot = created.record.nextRunAtMs
      const command = tick(created.record, slot, [slot], slot + cadence)
      const result = await succeed(store.tickSchedule(command), scenario, 'tickSchedule')
      const expected = makeJobId(makeScheduleOccurrenceId(first.key, slot)).unwrap()
      ensure(
        result.jobs[0]?.id === expected,
        scenario,
        'deterministic identity',
        'the job ID did not encode schedule key and slot'
      )
      ensure(
        expected.length <= 512 && !expected.includes('/billing/invoices/'),
        scenario,
        'deterministic identity',
        'the occurrence ID was not safely encoded'
      )
    }
  ),
  definition(
    'misfire-skip',
    'skip misfires advance without creating jobs and report skipped slots',
    'misfire',
    async ({ store, fixtures, scenario }) => {
      const record = recordWith(fixtures, { key: 'skip', misfire: { strategy: 'skip' } })
      const created = await succeed(store.upsertSchedule(record), scenario, 'upsert')
      const result = await succeed(
        store.tickSchedule(
          tick(created.record, baseTime + 10_000, [], baseTime + 11_000, [
            created.record.nextRunAtMs
          ])
        ),
        scenario,
        'tickSchedule'
      )
      ensure(
        result.status === 'skipped' && result.jobs.length === 0 && result.skippedSlots.length === 1,
        scenario,
        'misfire skip',
        'skip policy fired or lost skipped slots'
      )
    }
  ),
  definition(
    'misfire-run-once',
    'run-once misfires create exactly the overdue occurrence',
    'misfire',
    async ({ store, fixtures, scenario }) => {
      const record = recordWith(fixtures, { key: 'run-once', misfire: { strategy: 'run-once' } })
      const created = await succeed(store.upsertSchedule(record), scenario, 'upsert')
      const result = await succeed(
        store.tickSchedule(
          tick(created.record, baseTime + 10_000, [created.record.nextRunAtMs], baseTime + 11_000)
        ),
        scenario,
        'tickSchedule'
      )
      ensure(
        result.status === 'fired' && result.jobs.length === 1,
        scenario,
        'misfire run-once',
        'run-once did not enqueue one occurrence'
      )
    }
  ),
  definition(
    'misfire-catch-up-bounded',
    'catch-up progresses in bounded batches while remaining overdue',
    'misfire',
    async ({ store, jobStore, fixtures, scenario }) => {
      const record = recordWith(fixtures, {
        key: 'catch-up',
        misfire: { strategy: 'catch-up', maxOccurrences: 2 }
      })
      const created = await succeed(store.upsertSchedule(record), scenario, 'upsert')
      const first = await succeed(
        store.tickSchedule(
          tick(
            created.record,
            baseTime + 10_000,
            [baseTime + 1_000, baseTime + 2_000],
            baseTime + 3_000
          )
        ),
        scenario,
        'tickSchedule'
      )
      const second = await succeed(
        store.tickSchedule(
          tick(
            first.schedule,
            baseTime + 10_000,
            [baseTime + 3_000, baseTime + 4_000],
            baseTime + 5_000
          )
        ),
        scenario,
        'tickSchedule'
      )
      const total = await jobStore.counts()
      if (Result.isError(total)) throw total.error
      ensure(
        first.jobs.length === 2 && second.jobs.length === 2,
        scenario,
        'catch-up bound',
        'catch-up did not respect the two-occurrence batch bound'
      )
      ensure(
        total.value.total === 4 && second.schedule.nextRunAtMs <= baseTime + 10_000,
        scenario,
        'catch-up progress',
        'catch-up lost progress or stopped before the overdue suffix'
      )
    }
  ),
  definition(
    'overlap-allow',
    'allow overlap enqueues every decided occurrence',
    'overlap',
    async ({ store, fixtures, scenario }) => {
      const record = recordWith(fixtures, { key: 'allow', overlap: 'allow' })
      const created = await succeed(store.upsertSchedule(record), scenario, 'upsert')
      const result = await succeed(
        store.tickSchedule(
          tick(
            created.record,
            baseTime + 2_000,
            [baseTime + 1_000, baseTime + 2_000],
            baseTime + 3_000
          )
        ),
        scenario,
        'tickSchedule'
      )
      ensure(
        result.status === 'fired' && result.jobs.length === 2,
        scenario,
        'overlap allow',
        'allow overlap dropped an occurrence'
      )
    }
  ),
  definition(
    'overlap-skip',
    'skip overlap suppresses a new occurrence while the previous job is active',
    'overlap',
    async ({ store, fixtures, scenario }) => {
      const record = recordWith(fixtures, { key: 'skip-overlap', overlap: 'skip' })
      const created = await succeed(store.upsertSchedule(record), scenario, 'upsert')
      const first = await succeed(
        store.tickSchedule(
          tick(created.record, baseTime + 1_000, [baseTime + 1_000], baseTime + 2_000)
        ),
        scenario,
        'tickSchedule'
      )
      const second = await succeed(
        store.tickSchedule(
          tick(first.schedule, baseTime + 2_000, [baseTime + 2_000], baseTime + 3_000)
        ),
        scenario,
        'tickSchedule'
      )
      ensure(
        first.jobs.length === 1 && second.status === 'skipped' && second.jobs.length === 0,
        scenario,
        'overlap skip',
        'an active previous occurrence did not suppress the next one'
      )
      ensure(
        second.skippedSlots[0] === baseTime + 2_000,
        scenario,
        'overlap skip',
        'suppressed slot was not observable'
      )
    }
  ),
  definition(
    'pause-resume',
    'paused schedules are not due and resume without losing their position',
    'lifecycle',
    async ({ store, fixtures, scenario }) => {
      const record = recordWith(fixtures, { key: 'paused', paused: true })
      const created = await succeed(store.upsertSchedule(record), scenario, 'upsert')
      const due = await succeed(
        store.dueSchedules({ nowMs: baseTime + 10_000 }),
        scenario,
        'dueSchedules'
      )
      const paused = await succeed(
        store.tickSchedule(
          tick(created.record, baseTime + 10_000, [created.record.nextRunAtMs], baseTime + 11_000)
        ),
        scenario,
        'tickSchedule'
      )
      ensure(
        due.length === 0 && paused.status === 'paused' && paused.jobs.length === 0,
        scenario,
        'pause',
        'paused schedule was due or fired'
      )
      await succeed(store.resumeSchedule(selectorOf(created.record)), scenario, 'resumeSchedule')
      const resumed = await succeed(
        store.getSchedule(selectorOf(created.record)),
        scenario,
        'getSchedule'
      )
      ensure(resumed?.paused === false, scenario, 'resume', 'resume did not clear paused state')
    }
  ),
  definition(
    'named-store-isolation',
    'default and named schedule stores keep records and jobs isolated',
    'namespace',
    async ({ scenario, client, fixtures, openMultiStore }) => {
      const multi = await openMultiStore()
      ensure(
        String(multi.tokens.default.serviceTag) !== String(multi.tokens.first.serviceTag),
        scenario,
        'named store identity',
        'default and named schedule tokens share a tag'
      )
      const firstRecord = recordWith(fixtures, { key: 'same-key', group: 'same-group' })
      const secondRecord = recordWith(fixtures, { key: 'same-key', group: 'same-group' })
      await succeed(multi.stores.first.upsertSchedule(firstRecord), scenario, 'upsert')
      await succeed(multi.stores.second.upsertSchedule(secondRecord), scenario, 'upsert')
      const first = await succeed(multi.stores.first.listSchedules(), scenario, 'listSchedules')
      const second = await succeed(multi.stores.second.listSchedules(), scenario, 'listSchedules')
      const defaultRecords = await succeed(
        multi.stores.default.listSchedules(),
        scenario,
        'listSchedules'
      )
      ensure(
        first.length === 1 && second.length === 1 && defaultRecords.length === 0,
        scenario,
        'named store isolation',
        'schedule records crossed namespace boundaries'
      )
      const firstTick = await succeed(
        multi.stores.first.tickSchedule(
          tick(firstRecord, baseTime + 1_000, [firstRecord.nextRunAtMs], baseTime + 2_000)
        ),
        scenario,
        'tickSchedule'
      )
      const firstCounts = await multi.jobStores.first.counts()
      const secondCounts = await multi.jobStores.second.counts()
      if (Result.isError(firstCounts) || Result.isError(secondCounts))
        throw new Error('named store count failed')
      ensure(
        firstTick.jobs.length === 1 &&
          firstCounts.value.total === 1 &&
          secondCounts.value.total === 0,
        scenario,
        'named job store isolation',
        'jobs crossed associated store boundaries'
      )
      void client
    }
  ),
  definition(
    'reconcile-warn-group-grace',
    'reconcile warns, removes by group, and honors a Clock-driven grace window',
    'reconciliation',
    async ({ client, fixtures, scenario }) => {
      const stale = recordWith(fixtures, { key: 'stale', group: 'contract-group' })
      const foreign = recordWith(fixtures, { key: 'foreign', group: 'other-group' })
      await succeed(client.store.upsertSchedule(stale), scenario, 'upsertSchedule')
      await succeed(client.store.upsertSchedule(foreign), scenario, 'upsertSchedule')
      const desiredSchedule = JobSchedules.schedule(fixtures.job, 'desired', {
        everyMs: cadence,
        payload: { value: 'desired' }
      })
      const desired = JobSchedules.define({
        group: 'contract-group',
        schedules: [desiredSchedule],
        stores: [client.jobStoreToken]
      })

      const warned = await runReconcile(client, desired, { nowMs: baseTime, removal: 'warn' })
      ensure(Result.isOk(warned), scenario, 'reconcile warn', 'warn reconciliation failed')
      if (Result.isOk(warned)) {
        ensure(
          warned.value.created.length === 1 &&
            warned.value.warned.some((item) => item.key === 'stale'),
          scenario,
          'reconcile warn',
          'warn did not report drift without deleting it'
        )
      }
      ensure(
        (await succeed(client.store.getSchedule('stale'), scenario, 'getSchedule')) !== undefined,
        scenario,
        'reconcile warn',
        'warn removed a stale record'
      )

      const grouped = await runReconcile(client, desired, { nowMs: baseTime, removal: 'group' })
      ensure(Result.isOk(grouped), scenario, 'reconcile group', 'group reconciliation failed')
      if (Result.isOk(grouped))
        ensure(
          grouped.value.removed.some((item) => item.key === 'stale'),
          scenario,
          'reconcile group',
          'group removal did not remove same-group drift'
        )
      ensure(
        (await succeed(client.store.getSchedule('foreign'), scenario, 'getSchedule')) !== undefined,
        scenario,
        'reconcile group',
        'group removal crossed ownership groups'
      )

      await succeed(client.store.upsertSchedule(stale), scenario, 'upsertSchedule')
      const pending = runReconcile(
        client,
        JobSchedules.define({
          group: 'contract-group',
          schedules: [],
          stores: [client.jobStoreToken]
        }),
        { nowMs: baseTime, removal: 'group', removeAfterMs: 100 }
      )
      // Remote adapters may need several event-loop turns before the reconcile
      // operation reaches its deterministic Clock sleep.
      for (let index = 0; index < 500 && client.clock.pendingSleeps === 0; index += 1)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (client.clock.pendingSleeps === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
      ensure(
        client.clock.pendingSleeps === 1,
        scenario,
        'reconcile grace',
        'grace did not use the supplied deterministic Clock'
      )
      client.clock.advance(100)
      const graced = await pending
      ensure(Result.isOk(graced), scenario, 'reconcile grace', 'grace reconciliation failed')
      ensure(
        (await succeed(client.store.getSchedule('stale'), scenario, 'getSchedule')) === undefined,
        scenario,
        'reconcile grace',
        'grace window did not remove still-missing drift'
      )
    }
  ),
  definition(
    'timezone-dst',
    'cron uses deterministic timezone, DST, month, leap-year, and step semantics',
    'cron',
    async ({ scenario }) => {
      ensure(
        nextCronOccurrence('30 2 * * *', Date.UTC(2024, 2, 9, 8), 'America/New_York') ===
          Date.UTC(2024, 2, 11, 6, 30),
        scenario,
        'DST spring-forward',
        'a nonexistent local time was not skipped'
      )
      const fold = nextCronOccurrence('30 1 * * *', Date.UTC(2024, 10, 2, 8), 'America/New_York')
      ensure(
        fold === Date.UTC(2024, 10, 3, 5, 30),
        scenario,
        'DST fall-back',
        'the earlier repeated local time was not selected'
      )
      ensure(
        nextCronOccurrence('0 0 29 2 *', Date.UTC(2023, 0, 1)) === Date.UTC(2024, 1, 29),
        scenario,
        'leap year',
        'February 29 was not calculated'
      )
      ensure(
        nextCronOccurrence('*/15 9-10 1,15 * 1-5', Date.UTC(2024, 5, 1, 8, 59)) ===
          Date.UTC(2024, 5, 1, 9),
        scenario,
        'cron ranges/lists/steps',
        'five-field cron syntax was not honored'
      )
    }
  ),
  definition(
    'invalid-payload-no-partial',
    'invalid payloads fail before a schedule record is partially persisted',
    'validation',
    async ({ store, fixtures, scenario }) => {
      const invalid = recordWith(fixtures, {
        key: 'invalid-payload',
        payload: { value: undefined } as never
      })
      await expectError(
        store.upsertSchedule(invalid),
        scenario,
        'upsertSchedule',
        'payload validation'
      )
      const listed = await succeed(
        store.listSchedules({ group: invalid.group }),
        scenario,
        'listSchedules'
      )
      ensure(
        listed.length === 0,
        scenario,
        'payload atomicity',
        'invalid payload left a partial schedule'
      )
    }
  ),
  definition(
    'atomic-tick-enqueue-wake',
    'a tick makes enqueue and queue wake visible as one operation',
    'atomicity',
    async ({ store, jobStore, fixtures, scenario }) => {
      const created = await succeed(
        store.upsertSchedule(fixtures.record),
        scenario,
        'upsertSchedule'
      )
      const empty = await jobStore.claim({
        queue: fixtures.queueName,
        accepted: [fixtures.job.identity],
        limit: 1,
        workerId: makeWorkerId('schedule-contract-worker').unwrap(),
        leaseDurationMs: 100,
        now: baseTime
      })
      if (Result.isError(empty)) throw empty.error
      const controller = new AbortController()
      const wake = jobStore.awaitWake({
        queues: [fixtures.queueName],
        wakeToken: empty.value.wakeToken,
        signal: controller.signal
      })
      const result = await succeed(
        store.tickSchedule(
          tick(
            created.record,
            baseTime + cadence,
            [created.record.nextRunAtMs],
            baseTime + 2 * cadence
          )
        ),
        scenario,
        'tickSchedule'
      )
      const delivered = await wake
      controller.abort()
      ensure(
        Result.isOk(delivered) && result.jobs.length === 1,
        scenario,
        'tick/enqueue/wake atomicity',
        'the tick did not enqueue one occurrence and wake the queue'
      )
      const job = await jobStore.getJob({ jobId: result.jobs[0]!.id })
      if (Result.isError(job)) throw job.error
      ensure(
        job.value?.id === result.jobs[0]!.id,
        scenario,
        'tick/enqueue/wake atomicity',
        'wake was observable before the enqueued job was readable'
      )
    }
  )
]

const extensionDefinitions = <Token extends AnyJobScheduleStoreToken>(
  extensions: readonly JobScheduleStoreContractExtension<Token>[] | undefined
): readonly ScenarioDefinition<Token>[] =>
  (extensions ?? []).map((extension) =>
    Object.freeze({
      id: extension.id,
      name: extension.name,
      category: extension.category,
      body: async (context: JobScheduleStoreContractScenarioContext<Token>): Promise<void> => {
        await extension.run(context)
      }
    })
  )

const reportSnapshot = (state: ReportState): JobScheduleStoreContractReport =>
  Object.freeze({
    version: 1,
    extensionVersion: 1,
    jobStoreProtocolVersion: 1,
    descriptor: state.descriptor,
    executed: Object.freeze([...state.executed]),
    passed: Object.freeze([...state.passed]),
    failed: Object.freeze([...state.failed])
  })

const makeScenario = <Token extends AnyJobScheduleStoreToken>(
  item: ScenarioDefinition<Token>,
  options: JobScheduleStoreContractOptions<Token>,
  token: Token,
  report: ReportState
): JobScheduleStoreContractScenario => {
  const run = async (): Promise<void> => {
    report.executed.add(item.id)
    const context = makeContext(options, item, token)
    // SAFETY: arbitrary setup/adapter failures are intentionally preserved as the primary cause.
    let primary: unknown
    let hasPrimary = false

    try {
      await options.setup?.(context)
      const client = await makeClient(options, context, token)
      if (report.descriptor === undefined) report.descriptor = client.store.descriptor
      const fixtures = makeFixtures(token, item)
      const scenarioContext: JobScheduleStoreContractScenarioContext<Token> = Object.freeze({
        ...context,
        client,
        store: client.store,
        jobStore: client.jobStore,
        fixtures,
        openMultiStore: () => openMultiStore(options, context)
      })
      await item.body(scenarioContext)
      report.passed.add(item.id)
    } catch (cause) {
      primary = cause
      hasPrimary = true
      report.failed.add(item.id)
    } finally {
      try {
        await options.reset?.(context)
      } catch (cause) {
        if (!hasPrimary) {
          primary = new JobScheduleStoreConformanceError(
            item,
            'cleanup',
            `reset failed: ${describe(cause)}`,
            cause
          )
          hasPrimary = true
          report.failed.add(item.id)
        }
      }
    }

    if (hasPrimary) throw primary
  }

  return Object.freeze({ id: item.id, name: item.name, category: item.category, run })
}

const validateOptions = <Token extends AnyJobScheduleStoreToken>(
  options: JobScheduleStoreContractOptions<Token>,
  token: Token
): void => {
  if (!isRecord(options)) throw new TypeError('jobScheduleStoreContract options must be an object')
  assertFunction(options.makeStore, 'makeStore')
  assertFunction(options.makeScheduleStore, 'makeScheduleStore')
  if (options.setup !== undefined) assertFunction(options.setup, 'setup')
  if (options.reset !== undefined) assertFunction(options.reset, 'reset')
  if (
    options.clock !== undefined &&
    typeof options.clock !== 'function' &&
    !isRecord(options.clock)
  ) {
    throw new TypeError('jobScheduleStoreContract clock must be a ClockTest or factory')
  }
  if (options.hooks !== undefined && !isRecord(options.hooks)) {
    throw new TypeError('jobScheduleStoreContract hooks must be an object')
  }
  if (options.extensions !== undefined && !Array.isArray(options.extensions)) {
    throw new TypeError('jobScheduleStoreContract extensions must be an array')
  }
  if (!isRecord(token) || typeof token.serviceTag !== 'string') {
    throw new TypeError('jobScheduleStoreContract token must be a JobScheduleStore token')
  }
}

/**
 * Build runner-agnostic conformance scenarios for `JobScheduleStore` v1.
 *
 * Adapters provide direct JobStore and schedule-store factories. The returned
 * scenarios own no runner state and may be registered with Bun, node:test,
 * Vitest, or another test runner. Reconciliation is executed through an
 * internal test Runtime only to exercise its public yieldable API; adapters do
 * not receive or construct a Runtime as part of this contract.
 */
export function jobScheduleStoreContract(
  options: JobScheduleStoreContractOptions<DefaultJobScheduleStoreToken>
): JobScheduleStoreContractSuite
export function jobScheduleStoreContract<Token extends AnyJobScheduleStoreToken>(
  options: JobScheduleStoreContractOptions<Token> & { readonly token: Token }
): JobScheduleStoreContractSuite
export function jobScheduleStoreContract<Token extends AnyJobScheduleStoreToken>(
  options: JobScheduleStoreContractOptions<Token>
): JobScheduleStoreContractSuite {
  if (!isRecord(options)) throw new TypeError('jobScheduleStoreContract options must be an object')
  const token = (options.token ?? JobScheduleStore) as Token
  validateOptions(options, token)
  const definitions = [
    ...builtInScenarios(),
    ...extensionDefinitions(options.extensions)
  ] as readonly ScenarioDefinition<Token>[]
  const seen = new Set<string>()
  for (const item of definitions) {
    if (seen.has(item.id))
      throw new TypeError(`jobScheduleStoreContract scenario id is duplicated: ${item.id}`)
    seen.add(item.id)
    if (item.id.length === 0 || item.name.length === 0 || item.category.length === 0) {
      throw new TypeError(`jobScheduleStoreContract scenario ${item.id} has invalid metadata`)
    }
  }

  const state: ReportState = {
    descriptor: undefined,
    executed: new Set(),
    passed: new Set(),
    failed: new Set()
  }
  const scenarios = definitions.map((item) => makeScenario(item, options, token, state))
  const suite = scenarios as JobScheduleStoreContractScenario[] & {
    report?: () => JobScheduleStoreContractReport
  }
  Object.defineProperty(suite, 'report', {
    configurable: false,
    enumerable: true,
    value: (): JobScheduleStoreContractReport => reportSnapshot(state),
    writable: false
  })
  return Object.freeze(suite) as JobScheduleStoreContractSuite
}

/** Versioned identity of the runner-neutral contract. */
export namespace jobScheduleStoreContract {
  export const version = 1 as const
  export const extensionVersion = 1 as const
  export const jobStoreProtocolVersion = 1 as const
}

export type {
  AnyJobDefinition,
  AnyJobScheduleStoreToken,
  DefaultJobScheduleStoreToken,
  JobScheduleStoreToken,
  ScheduleStoreError,
  ScheduleStoreOperation,
  AnyJobSchedulesDefinition
}
