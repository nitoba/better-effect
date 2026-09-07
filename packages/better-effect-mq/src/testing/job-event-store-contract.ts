// oxlint-disable anti-slop/no-runtime-typeof -- the contract validates adapter and hook boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- runner-neutral extensions intentionally cross an unknown boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- Result and structural adapter erasure is restored at checked boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below follow Result and factory checks.

import { Result, type Result as ResultType } from 'better-result'

import {
  JobEventCursorExpiredError,
  JobId,
  JobName,
  MemoryJobEventStore,
  MemoryJobStore,
  QueueName,
  WorkerId
} from '../index'
import type {
  DurableJobEvent,
  JobEventPage,
  JobEventReadOptions,
  JobEventRetention,
  JobEventStoreContract
} from '../index'
import type { JobStoreContract } from '../index'

export interface JobEventStoreContractClock {
  now(): number
  advance(milliseconds: number): void
}

export type JobEventStoreContractMaybePromise<Value> = Value | PromiseLike<Value>

export interface JobEventStoreContractFactoryOptions {
  readonly retention?: JobEventRetention
}

export interface JobEventStoreContractScenarioInfo {
  readonly id: string
  readonly name: string
  readonly category: string
}

export interface JobEventStoreContractScenario extends JobEventStoreContractScenarioInfo {
  readonly run: () => Promise<void>
}

export interface JobEventStoreContractScenarioContext extends JobEventStoreContractScenarioInfo {
  readonly scenario: JobEventStoreContractScenarioInfo
  readonly clock: JobEventStoreContractClock
  readonly eventStore: JobEventStoreContract
  readonly jobStore: JobStoreContract
  checkpoint(point: string): Promise<void>
}

export interface JobEventStoreContractHooks {
  checkpoint?(
    point: string,
    scenario: JobEventStoreContractScenarioInfo
  ): JobEventStoreContractMaybePromise<void>
}

/** Small adapter-owned scenarios for APIs that are not part of JobEventStore itself. */
export interface JobEventStoreContractExtension extends JobEventStoreContractScenarioInfo {
  readonly run: (
    context: JobEventStoreContractScenarioContext
  ) => JobEventStoreContractMaybePromise<void>
}

export interface JobEventStoreContractCapabilities {
  readonly retention: boolean
  readonly cursorExpiry: boolean
  readonly optionalEventStore: boolean
}

export interface JobEventStoreContractSkippedScenario extends JobEventStoreContractScenarioInfo {
  readonly reason: string
}

export interface JobEventStoreContractReport {
  readonly version: 1
  readonly extension: 'better-effect-mq/events'
  readonly executed: readonly string[]
  readonly passed: readonly string[]
  readonly failed: readonly string[]
  readonly skipped: readonly JobEventStoreContractSkippedScenario[]
  readonly capabilities: JobEventStoreContractCapabilities
}

export interface JobEventStoreContractOptions {
  readonly makeEventStore?: (
    options?: JobEventStoreContractFactoryOptions
  ) => JobEventStoreContractMaybePromise<JobEventStoreContract>
  readonly makeJobStore?: (
    eventStore: JobEventStoreContract
  ) => JobEventStoreContractMaybePromise<JobStoreContract>
  /** Used by the optional-extension scenario to prove JobStore works without events. */
  readonly makeJobStoreWithoutEventStore?: () => JobEventStoreContractMaybePromise<JobStoreContract>
  readonly clock?: JobEventStoreContractClock
  readonly setup?: (
    context: JobEventStoreContractScenarioContext
  ) => JobEventStoreContractMaybePromise<void>
  readonly reset?: (
    context: JobEventStoreContractScenarioContext
  ) => JobEventStoreContractMaybePromise<void>
  readonly hooks?: JobEventStoreContractHooks
  readonly capabilities?: Partial<JobEventStoreContractCapabilities>
  readonly extensions?: readonly JobEventStoreContractExtension[]
}

export class JobEventStoreConformanceError extends Error {
  readonly scenarioId: string
  readonly scenarioName: string
  readonly category: string
  readonly invariant: string

  constructor(
    scenario: Pick<JobEventStoreContractScenarioInfo, 'id' | 'category' | 'name'>,
    invariantOrDetail: string,
    detail?: string,
    cause?: unknown
  ) {
    const invariant = detail === undefined ? scenario.category : invariantOrDetail
    const message = detail === undefined ? invariantOrDetail : detail
    super(`${scenario.id} (${scenario.name}) [${invariant}]: ${message}`, { cause })
    this.name = 'JobEventStoreConformanceError'
    this.scenarioId = scenario.id
    this.scenarioName = scenario.name
    this.category = scenario.category
    this.invariant = invariant
  }
}

export type JobEventStoreContractSuite = readonly JobEventStoreContractScenario[] & {
  readonly report: () => JobEventStoreContractReport
}

type ScenarioDefinition = JobEventStoreContractScenarioInfo & {
  readonly requires?: keyof JobEventStoreContractCapabilities
  readonly factoryOptions?: JobEventStoreContractFactoryOptions
  readonly run: (context: JobEventStoreContractScenarioContext) => Promise<void>
}

const optionalExtensionDefinitions = [
  {
    id: 'event-await-result-race',
    name: 'event-driven awaitResult closes the cursor/read race',
    category: 'await-result',
    reason: 'provide an extension that exercises the public awaitResult API'
  },
  {
    id: 'event-wake-lost-poll-fallback',
    name: 'lost event wake falls back to polling',
    category: 'wake',
    reason: 'provide an extension that can disable notification delivery'
  },
  {
    id: 'event-cancel-timeout-shutdown',
    name: 'cancel, timeout, and shutdown do not corrupt the event cursor',
    category: 'lifecycle',
    reason: 'provide an extension for the owning await/consumer lifecycle'
  },
  {
    id: 'event-required-extension',
    name: 'required event extension rejects an old writer',
    category: 'compatibility',
    reason: 'provide an extension for the adapter protocol/layout handshake'
  },
  {
    id: 'event-flow-transitions',
    name: 'flow transitions append events when installed',
    category: 'flow',
    reason: 'provide an installed flow-store extension'
  },
  {
    id: 'event-schedule-transitions',
    name: 'schedule transitions append events when installed',
    category: 'schedule',
    reason: 'provide an installed schedule-store extension'
  }
] as const

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)

const unwrap = async <Value, Failure>(
  operation: ResultType<Value, Failure> | PromiseLike<ResultType<Value, Failure>>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const expectError = async <Value, Failure>(
  operation: ResultType<Value, Failure> | PromiseLike<ResultType<Value, Failure>>
): Promise<Failure> => {
  const result = await operation
  if (Result.isOk(result)) throw new Error('operation unexpectedly succeeded')
  return result.error
}

const defaultClock = (): JobEventStoreContractClock => {
  let current = 0
  return {
    now: () => current,
    advance(milliseconds) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new RangeError('contract clock advances must be non-negative safe integers')
      }
      current += milliseconds
    }
  }
}

const makeQueue = (value: string): QueueName => QueueName.make(value).unwrap()
const makeName = (value: string): JobName => JobName.make(value).unwrap()

const makeFixture = (
  suffix: string,
  now: number,
  queue = 'event-contract',
  name = 'event-job'
) => ({
  id: JobId.make(`event-contract-${suffix}`).unwrap(),
  identity: {
    queue: makeQueue(queue),
    name: makeName(name),
    version: 1
  } as const,
  payload: { value: suffix },
  now,
  runAt: now,
  attemptsMax: 2
})

const makeDefaultFactories = (
  clock: JobEventStoreContractClock
): Required<Pick<JobEventStoreContractOptions, 'makeEventStore' | 'makeJobStore'>> & {
  readonly makeJobStoreWithoutEventStore: () => JobStoreContract
} => ({
  makeEventStore: (options) =>
    options?.retention === undefined
      ? MemoryJobEventStore.make({ clock })
      : MemoryJobEventStore.make({ clock, retention: options.retention }),
  makeJobStore: (eventStore) => MemoryJobStore.make({ eventStore, clock }),
  makeJobStoreWithoutEventStore: () => MemoryJobStore.make({ clock })
})

const assertScenario: (
  condition: boolean,
  scenario: JobEventStoreContractScenarioInfo,
  invariant: string,
  detail: string
) => asserts condition = (condition, scenario, invariant, detail) => {
  if (!condition) throw new JobEventStoreConformanceError(scenario, invariant, detail)
}

const readEvents = async (
  store: JobEventStoreContract,
  options: JobEventReadOptions = {}
): Promise<JobEventPage> => unwrap(store.read(options))

const eventIds = (events: readonly DurableJobEvent[]): readonly string[] =>
  events.map((event) => event.jobId).filter((id): id is NonNullable<typeof id> => id !== undefined)

const scenarioDefinitions = (): readonly ScenarioDefinition[] => [
  {
    id: 'event-enqueue-append',
    name: 'enqueue appends one durable event',
    category: 'atomicity',
    run: async (context) => {
      const fixture = makeFixture('append', context.clock.now())
      const created = await unwrap(context.jobStore.enqueue(fixture))
      const page = await readEvents(context.eventStore)
      assertScenario(
        page.events.length === 1 && page.events[0]?.type === 'job-enqueued',
        context,
        'atomic append',
        'enqueue did not append exactly one job-enqueued event'
      )
      assertScenario(
        page.events[0]?.jobId === created.job.id && page.events[0]?.duplicate === false,
        context,
        'event identity',
        'enqueue event did not identify the created job and duplicate flag'
      )
    }
  },
  {
    id: 'event-transition-append',
    name: 'claim and settlement append canonical transition events',
    category: 'atomicity',
    run: async (context) => {
      const fixture = makeFixture('transition', context.clock.now())
      const created = await unwrap(context.jobStore.enqueue(fixture))
      const claim = await unwrap(
        context.jobStore.claim({
          queue: fixture.identity.queue,
          accepted: [fixture.identity],
          limit: 1,
          workerId: WorkerId.make('event-contract-worker').unwrap(),
          leaseDurationMs: 100,
          now: context.clock.now()
        })
      )
      const active = claim.jobs[0]
      assertScenario(active !== undefined, context, 'atomic append', 'claim did not return the job')
      await unwrap(
        context.jobStore.settle({
          jobId: created.job.id,
          leaseToken: active!.leaseToken,
          outcome: { type: 'complete' },
          now: context.clock.now()
        })
      )
      const page = await readEvents(context.eventStore)
      assertScenario(
        page.events.map((event) => event.type).join('|') ===
          'job-enqueued|job-claimed|job-completed',
        context,
        'atomic append',
        'claim/settlement events were not appended in canonical order'
      )
    }
  },
  {
    id: 'event-rollback-no-event',
    name: 'failed transitions append no event and leave the store usable',
    category: 'rollback',
    run: async (context) => {
      const invalid = { ...makeFixture('rollback', context.clock.now()), runAt: -1 }
      await expectError(context.jobStore.enqueue(invalid))
      const empty = await readEvents(context.eventStore)
      assertScenario(
        empty.events.length === 0,
        context,
        'rollback',
        'a rejected enqueue left a durable event behind'
      )
      await unwrap(context.jobStore.enqueue(makeFixture('rollback-recovery', context.clock.now())))
      const recovered = await readEvents(context.eventStore)
      assertScenario(
        recovered.events.length === 1,
        context,
        'rollback',
        'the store was not usable after the rejected transition'
      )
    }
  },
  {
    id: 'event-response-loss-retry',
    name: 'idempotent retry after response loss does not duplicate events',
    category: 'idempotency',
    run: async (context) => {
      const fixture = makeFixture('response-loss', context.clock.now())
      const first = await unwrap(context.jobStore.enqueue(fixture))
      const duplicate = await unwrap(context.jobStore.enqueue(fixture))
      assertScenario(
        duplicate.duplicate,
        context,
        'idempotency',
        'duplicate enqueue was not reported'
      )
      const claim = await unwrap(
        context.jobStore.claim({
          queue: fixture.identity.queue,
          accepted: [fixture.identity],
          limit: 1,
          workerId: WorkerId.make('event-contract-retry').unwrap(),
          leaseDurationMs: 100,
          now: context.clock.now()
        })
      )
      const settlement = {
        jobId: first.job.id,
        leaseToken: claim.jobs[0]!.leaseToken,
        outcome: { type: 'complete' as const },
        now: context.clock.now()
      }
      await unwrap(context.jobStore.settle(settlement))
      const replay = await unwrap(context.jobStore.settle(settlement))
      const page = await readEvents(context.eventStore)
      assertScenario(
        replay.status === 'already-applied' &&
          page.events.map((event) => event.type).join('|') ===
            'job-enqueued|job-claimed|job-completed',
        context,
        'idempotency',
        'replaying an already-applied transition appended a duplicate event'
      )
    }
  },
  {
    id: 'event-cursor-order-pagination',
    name: 'cursors are opaque, ordered, exclusive, and paginable',
    category: 'cursor',
    run: async (context) => {
      const before = await unwrap(context.eventStore.tailCursor())
      for (let index = 0; index < 5; index += 1) {
        await unwrap(context.jobStore.enqueue(makeFixture(`page-${index}`, context.clock.now())))
      }
      const first = await readEvents(context.eventStore, { after: before, limit: 2 })
      assertScenario(
        first.events.length === 2 && first.nextCursor !== undefined,
        context,
        'cursor pagination',
        'first page did not return two events and an exclusive cursor'
      )
      const second = await readEvents(context.eventStore, {
        after: first.nextCursor,
        limit: 2
      })
      assertScenario(
        second.nextCursor !== undefined,
        context,
        'cursor pagination',
        'second page did not return an exclusive cursor'
      )
      const third = await readEvents(context.eventStore, {
        after: second.nextCursor,
        limit: 2
      })
      const all = [...first.events, ...second.events, ...third.events]
      assertScenario(
        all.length === 5 && new Set(all.map((event) => event.cursor)).size === 5,
        context,
        'cursor pagination',
        'pagination overlapped or lost events'
      )
      assertScenario(
        eventIds(all).join('|') ===
          Array.from({ length: 5 }, (_, index) => `event-contract-page-${index}`).join('|'),
        context,
        'cursor order',
        'events were not returned in cursor order'
      )
    }
  },
  {
    id: 'event-filters-preserve-progress',
    name: 'filters do not block cursor progress through non-matching events',
    category: 'cursor',
    run: async (context) => {
      const firstQueue = makeQueue('event-filter-a')
      const secondQueue = makeQueue('event-filter-b')
      await unwrap(
        context.jobStore.enqueue(makeFixture('filter-a1', context.clock.now(), firstQueue))
      )
      await unwrap(
        context.jobStore.enqueue(makeFixture('filter-b1', context.clock.now(), secondQueue))
      )
      await unwrap(
        context.jobStore.enqueue(makeFixture('filter-a2', context.clock.now(), firstQueue))
      )
      const first = await readEvents(context.eventStore, {
        queues: [firstQueue],
        types: ['job-enqueued'],
        limit: 1
      })
      assertScenario(
        first.events.length === 1 && first.nextCursor !== undefined,
        context,
        'filter progress',
        'the first filtered page did not return a cursor'
      )
      const second = await readEvents(context.eventStore, {
        after: first.nextCursor,
        queues: [firstQueue],
        types: ['job-enqueued'],
        limit: 1
      })
      assertScenario(
        second.events.length === 1,
        context,
        'filter progress',
        'queue/type filters did not return both matching events'
      )
      assertScenario(
        first.nextCursor !== second.nextCursor && second.nextCursor === second.events[0]?.cursor,
        context,
        'filter progress',
        'the filtered reader did not advance over the non-matching event'
      )
    }
  },
  {
    id: 'event-concurrent-writers-total-order',
    name: 'concurrent writers produce one total cursor order',
    category: 'concurrency',
    run: async (context) => {
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          Promise.resolve(
            context.jobStore.enqueue(makeFixture(`concurrent-${index}`, context.clock.now()))
          )
        )
      )
      assertScenario(
        results.every((result) => !Result.isError(result)),
        context,
        'concurrency',
        'a concurrent enqueue failed'
      )
      const page = await readEvents(context.eventStore, { limit: 100 })
      assertScenario(
        page.events.length === 16 && new Set(page.events.map((event) => event.cursor)).size === 16,
        context,
        'concurrency',
        'concurrent writers produced duplicate or missing cursors'
      )
    }
  },
  {
    id: 'event-retention-age-count',
    name: 'retention applies the minimum of age and count bounds',
    category: 'retention',
    requires: 'retention',
    factoryOptions: { retention: { ageMs: 10, count: 2 } },
    run: async (context) => {
      await unwrap(context.jobStore.enqueue(makeFixture('retained-0', context.clock.now())))
      const firstTail = await unwrap(context.eventStore.tailCursor())
      await unwrap(context.jobStore.enqueue(makeFixture('retained-1', context.clock.now())))
      await unwrap(context.jobStore.enqueue(makeFixture('retained-2', context.clock.now())))
      const thirdTail = await unwrap(context.eventStore.tailCursor())
      let page = await readEvents(context.eventStore, { after: firstTail })
      assertScenario(
        page.events.length === 2,
        context,
        'retention',
        'count retention did not keep exactly the newest two events'
      )
      context.clock.advance(11)
      await unwrap(context.jobStore.enqueue(makeFixture('retained-new', context.clock.now())))
      page = await readEvents(context.eventStore, { after: thirdTail })
      assertScenario(
        page.events.length === 1 && page.events[0]?.jobId?.endsWith('retained-new') === true,
        context,
        'retention',
        'age retention did not remove events older than the configured bound'
      )
    }
  },
  {
    id: 'event-cursor-expired',
    name: 'retention reports an explicit expired cursor',
    category: 'retention',
    requires: 'cursorExpiry',
    factoryOptions: { retention: { count: 1 } },
    run: async (context) => {
      const old = await unwrap(context.eventStore.tailCursor())
      await unwrap(context.jobStore.enqueue(makeFixture('expired-1', context.clock.now())))
      await unwrap(context.jobStore.enqueue(makeFixture('expired-2', context.clock.now())))
      const error = await expectError(context.eventStore.read({ after: old }))
      assertScenario(
        error instanceof JobEventCursorExpiredError,
        context,
        'cursor expiration',
        'an evicted cursor did not return JobEventCursorExpiredError'
      )
    }
  },
  {
    id: 'event-await-wake',
    name: 'awaitEvents wakes for a matching queue and ignores other queues',
    category: 'wake',
    run: async (context) => {
      const wanted = makeQueue('event-wake-wanted')
      const other = makeQueue('event-wake-other')
      const controller = new AbortController()
      let settled = false
      const waiting = Promise.resolve(
        context.eventStore.awaitEvents({
          after: await unwrap(context.eventStore.tailCursor()),
          queues: [wanted],
          signal: controller.signal
        })
      ).then((result) => {
        settled = true
        return result
      })
      await unwrap(context.jobStore.enqueue(makeFixture('wake-other', context.clock.now(), other)))
      await Promise.resolve()
      assertScenario(!settled, context, 'wake filtering', 'a non-matching queue woke the waiter')
      controller.abort()
      await expectError(waiting)

      const matchingController = new AbortController()
      const matching = context.eventStore.awaitEvents({
        after: await unwrap(context.eventStore.tailCursor()),
        queues: [wanted],
        signal: matchingController.signal
      })
      await unwrap(
        context.jobStore.enqueue(makeFixture('wake-wanted', context.clock.now(), wanted))
      )
      await unwrap(matching)
      matchingController.abort()
    }
  },
  {
    id: 'event-control-transitions',
    name: 'queue pause and resume append exactly one control event',
    category: 'control',
    run: async (context) => {
      const queue = makeQueue('event-control')
      await unwrap(context.jobStore.pause({ queue, now: context.clock.now() }))
      await unwrap(context.jobStore.pause({ queue, now: context.clock.now() }))
      await unwrap(context.jobStore.resume({ queue, now: context.clock.now() }))
      await unwrap(context.jobStore.resume({ queue, now: context.clock.now() }))
      const page = await readEvents(context.eventStore)
      assertScenario(
        page.events.map((event) => event.type).join('|') === 'queue-paused|queue-resumed',
        context,
        'control transitions',
        'idempotent pause/resume operations appended duplicate events'
      )
    }
  },
  {
    id: 'event-optional-job-store',
    name: 'an optional EventStore does not corrupt JobStore transitions',
    category: 'compatibility',
    requires: 'optionalEventStore',
    run: async (context) => {
      const fixture = makeFixture('optional', context.clock.now())
      const created = await unwrap(context.jobStore.enqueue(fixture))
      const claim = await unwrap(
        context.jobStore.claim({
          queue: fixture.identity.queue,
          accepted: [fixture.identity],
          limit: 1,
          workerId: WorkerId.make('event-contract-optional').unwrap(),
          leaseDurationMs: 100,
          now: context.clock.now()
        })
      )
      await unwrap(
        context.jobStore.settle({
          jobId: created.job.id,
          leaseToken: claim.jobs[0]!.leaseToken,
          outcome: { type: 'complete' },
          now: context.clock.now()
        })
      )
      const job = await unwrap(context.jobStore.getJob({ jobId: created.job.id }))
      assertScenario(
        job?.state === 'completed',
        context,
        'optional extension',
        'JobStore did not settle without EventStore'
      )
      assertScenario(
        (await readEvents(context.eventStore)).events.length === 0,
        context,
        'optional extension',
        'the detached EventStore was unexpectedly mutated'
      )
    }
  },
  {
    id: 'event-safe-record',
    name: 'durable events omit payload, result, failure data, and metadata',
    category: 'redaction',
    run: async (context) => {
      const fixture = {
        ...makeFixture('safe', context.clock.now()),
        payload: { email: 'redacted@example.com', result: 'private-result' },
        metadata: { secret: 'must-not-leak' },
        dispatchKey: 'private-dispatch-key',
        idempotencyKey: 'private-idempotency-key'
      }
      await unwrap(context.jobStore.enqueue(fixture))
      const event = (await readEvents(context.eventStore)).events[0]
      assertScenario(event !== undefined, context, 'redaction', 'enqueue did not produce an event')
      assertScenario(
        !Object.prototype.hasOwnProperty.call(event, 'payload') &&
          !Object.prototype.hasOwnProperty.call(event, 'result') &&
          !Object.prototype.hasOwnProperty.call(event, 'metadata'),
        context,
        'redaction',
        'event record exposed a sensitive field'
      )
      const serialized = JSON.stringify(event)
      assertScenario(
        !serialized.includes('redacted@example.com') &&
          !serialized.includes('private-result') &&
          !serialized.includes('must-not-leak') &&
          !serialized.includes('private-dispatch-key') &&
          !serialized.includes('private-idempotency-key'),
        context,
        'redaction',
        'event record leaked sensitive field data'
      )
    }
  }
]

const validateScenarioInfo = (scenario: JobEventStoreContractScenarioInfo): void => {
  if (
    typeof scenario.id !== 'string' ||
    scenario.id.length === 0 ||
    typeof scenario.name !== 'string' ||
    scenario.name.length === 0 ||
    typeof scenario.category !== 'string' ||
    scenario.category.length === 0
  ) {
    throw new TypeError('jobEventStoreContract scenarios require non-empty id, name, and category')
  }
}

const normalizeCapabilities = (
  options: JobEventStoreContractOptions
): JobEventStoreContractCapabilities => {
  const defaults = {
    retention: options.makeEventStore === undefined,
    cursorExpiry: options.makeEventStore === undefined,
    optionalEventStore:
      options.makeJobStoreWithoutEventStore !== undefined || options.makeJobStore === undefined
  }
  const capabilities = {
    retention: options.capabilities?.retention ?? defaults.retention,
    cursorExpiry: options.capabilities?.cursorExpiry ?? defaults.cursorExpiry,
    optionalEventStore: options.capabilities?.optionalEventStore ?? defaults.optionalEventStore
  }
  for (const [name, value] of Object.entries(capabilities)) {
    if (typeof value !== 'boolean') {
      throw new TypeError(`jobEventStoreContract capabilities.${name} must be boolean`)
    }
  }
  return Object.freeze(capabilities)
}

const runScenario = async (
  definition: ScenarioDefinition,
  options: JobEventStoreContractOptions,
  clock: JobEventStoreContractClock,
  eventStore: JobEventStoreContract,
  jobStore: JobStoreContract,
  hooks: JobEventStoreContractHooks
): Promise<void> => {
  const context: JobEventStoreContractScenarioContext = {
    ...definition,
    scenario: definition,
    clock,
    eventStore,
    jobStore,
    checkpoint: async (point) => {
      await hooks.checkpoint?.(point, definition)
    }
  }
  try {
    await options.setup?.(context)
    await definition.run(context)
  } finally {
    await options.reset?.(context)
  }
}

const makeExtensionDefinition = (
  extension: JobEventStoreContractExtension
): ScenarioDefinition => ({
  id: extension.id,
  name: extension.name,
  category: extension.category,
  run: async (context) => {
    await extension.run(context)
  }
})

export const jobEventStoreContract = (
  options: JobEventStoreContractOptions = {}
): JobEventStoreContractSuite => {
  const clock = options.clock ?? defaultClock()
  const defaults = makeDefaultFactories(clock)
  const makeEventStore = options.makeEventStore ?? defaults.makeEventStore
  const makeJobStore = options.makeJobStore ?? defaults.makeJobStore
  const makeJobStoreWithoutEventStore =
    options.makeJobStoreWithoutEventStore ?? defaults.makeJobStoreWithoutEventStore
  const capabilities = normalizeCapabilities(options)
  const extensions = options.extensions ?? []
  const extensionById = new Map<string, JobEventStoreContractExtension>()
  for (const extension of extensions) {
    validateScenarioInfo(extension)
    if (extensionById.has(extension.id)) {
      throw new TypeError(`jobEventStoreContract has duplicate scenario id ${extension.id}`)
    }
    extensionById.set(extension.id, extension)
  }

  const executed = new Set<string>()
  const passed = new Set<string>()
  const failed = new Set<string>()
  const skipped: JobEventStoreContractSkippedScenario[] = []
  const definitions: ScenarioDefinition[] = []

  for (const definition of scenarioDefinitions()) {
    if (definition.requires !== undefined && !capabilities[definition.requires]) {
      skipped.push({
        id: definition.id,
        name: definition.name,
        category: definition.category,
        reason: `capability ${definition.requires} was not declared`
      })
      continue
    }
    definitions.push(definition)
  }

  for (const optional of optionalExtensionDefinitions) {
    const extension = extensionById.get(optional.id)
    if (extension === undefined) {
      skipped.push(optional)
      continue
    }
    definitions.push(makeExtensionDefinition(extension))
  }

  for (const extension of extensions) {
    if (optionalExtensionDefinitions.some((optional) => optional.id === extension.id)) continue
    definitions.push(makeExtensionDefinition(extension))
  }

  const scenarios = definitions.map((definition) => ({
    ...definition,
    run: async () => {
      executed.add(definition.id)
      const eventStore = await makeEventStore(definition.factoryOptions)
      const jobStore =
        definition.id === 'event-optional-job-store'
          ? await makeJobStoreWithoutEventStore()
          : await makeJobStore(eventStore)
      try {
        await runScenario(definition, options, clock, eventStore, jobStore, options.hooks ?? {})
        passed.add(definition.id)
      } catch (cause) {
        failed.add(definition.id)
        if (cause instanceof JobEventStoreConformanceError) throw cause
        throw new JobEventStoreConformanceError(
          definition,
          'scenario execution',
          describe(cause),
          cause
        )
      }
    }
  })) as JobEventStoreContractScenario[] & {
    report?: () => JobEventStoreContractReport
  }

  Object.defineProperty(scenarios, 'report', {
    configurable: false,
    enumerable: true,
    value: (): JobEventStoreContractReport =>
      Object.freeze({
        version: 1,
        extension: 'better-effect-mq/events',
        executed: Object.freeze([...executed]),
        passed: Object.freeze([...passed]),
        failed: Object.freeze([...failed]),
        skipped: Object.freeze([...skipped]),
        capabilities
      }),
    writable: false
  })
  return Object.freeze(scenarios) as JobEventStoreContractSuite
}
