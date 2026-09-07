import { Result, type Result as ResultType } from 'better-result'

import { JobId, JobName, MemoryJobEventStore, MemoryJobStore, QueueName, WorkerId } from '../index'
import type { JobEventPage, JobEventStoreContract } from '../index'
import type { JobStoreContract } from '../index'

export interface JobEventStoreContractClock {
  now(): number
  advance(milliseconds: number): void
}

export interface JobEventStoreContractScenario {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly run: () => Promise<void>
}

export interface JobEventStoreContractReport {
  readonly version: 1
  readonly extension: 'better-effect-mq/events'
  readonly executed: readonly string[]
  readonly passed: readonly string[]
  readonly failed: readonly string[]
}

export interface JobEventStoreContractOptions {
  readonly makeEventStore?: () => JobEventStoreContract
  readonly makeJobStore?: (eventStore: JobEventStoreContract) => JobStoreContract
  readonly clock?: JobEventStoreContractClock
}

export class JobEventStoreConformanceError extends Error {
  readonly scenarioId: string
  readonly category: string

  constructor(
    scenario: Pick<JobEventStoreContractScenario, 'id' | 'category' | 'name'>,
    detail: string
  ) {
    super(`${scenario.id} (${scenario.name}) [${scenario.category}]: ${detail}`)
    this.name = 'JobEventStoreConformanceError'
    this.scenarioId = scenario.id
    this.category = scenario.category
  }
}

const unwrap = async <Value, Failure>(
  operation: ResultType<Value, Failure> | PromiseLike<ResultType<Value, Failure>>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
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

const makeFixture = (suffix: string, now: number) => ({
  id: JobId.make(`event-contract-${suffix}`).unwrap(),
  identity: {
    queue: QueueName.make('event-contract').unwrap(),
    name: JobName.make('event-job').unwrap(),
    version: 1
  } as const,
  payload: { value: suffix },
  now,
  runAt: now,
  attemptsMax: 2
})

const makeDefaultFactories = (
  clock: JobEventStoreContractClock
): Required<Pick<JobEventStoreContractOptions, 'makeEventStore' | 'makeJobStore'>> => ({
  makeEventStore: () => MemoryJobEventStore.make({ clock }),
  makeJobStore: (eventStore) =>
    MemoryJobStore.make({
      eventStore,
      clock
    })
})

const scenarioDefinitions = (): readonly Omit<JobEventStoreContractScenario, 'run'>[] => [
  {
    id: 'event-enqueue-append',
    name: 'enqueue appends one durable event',
    category: 'atomicity'
  },
  {
    id: 'event-transition-append',
    name: 'claim and settlement append canonical transition events',
    category: 'atomicity'
  },
  {
    id: 'event-pagination-filters',
    name: 'cursor pagination and filters preserve progress',
    category: 'reader'
  },
  {
    id: 'event-await-wake',
    name: 'awaitEvents wakes for a matching queue',
    category: 'wake'
  },
  {
    id: 'event-safe-record',
    name: 'durable events omit sensitive job fields',
    category: 'redaction'
  }
]

const runScenario = async (
  scenario: Omit<JobEventStoreContractScenario, 'run'>,
  options: JobEventStoreContractOptions,
  clock: JobEventStoreContractClock
): Promise<void> => {
  const defaults = makeDefaultFactories(clock)
  const makeEventStore = options.makeEventStore ?? defaults.makeEventStore
  const makeJobStore = options.makeJobStore ?? defaults.makeJobStore
  const eventStore = makeEventStore()
  const jobStore = makeJobStore(eventStore)
  const fail = (detail: string): never => {
    throw new JobEventStoreConformanceError(scenario, detail)
  }
  const read = async (
    after?: Parameters<JobEventStoreContract['read']>[0]['after']
  ): Promise<JobEventPage> => unwrap(eventStore.read(after === undefined ? {} : { after }))

  switch (scenario.id) {
    case 'event-enqueue-append': {
      const fixture = makeFixture('append', clock.now())
      await unwrap(jobStore.enqueue(fixture))
      const page = await read()
      if (page.events.length !== 1 || page.events[0]?.type !== 'job-enqueued') {
        fail('enqueue did not append exactly one job-enqueued event')
      }
      if (page.events[0]?.duplicate !== false) fail('enqueue event did not mark duplicate false')
      return
    }
    case 'event-transition-append': {
      const fixture = makeFixture('transition', clock.now())
      const created = await unwrap(jobStore.enqueue(fixture))
      const claim = await unwrap(
        jobStore.claim({
          queue: fixture.identity.queue,
          accepted: [fixture.identity],
          limit: 1,
          workerId: WorkerId.make('event-contract-worker').unwrap(),
          leaseDurationMs: 100,
          now: clock.now()
        })
      )
      const active = claim.jobs[0]
      if (active === undefined) return fail('claim did not return the enqueued job')
      await unwrap(
        jobStore.settle({
          jobId: created.job.id,
          leaseToken: active.leaseToken,
          outcome: { type: 'complete' },
          now: clock.now()
        })
      )
      const page = await read()
      if (
        page.events.map((event) => event.type).join('|') !==
        'job-enqueued|job-claimed|job-completed'
      ) {
        fail('transition event order was not canonical')
      }
      return
    }
    case 'event-pagination-filters': {
      await unwrap(jobStore.enqueue(makeFixture('one', clock.now())))
      await unwrap(jobStore.enqueue(makeFixture('two', clock.now())))
      const first = await unwrap(eventStore.read({ limit: 1 }))
      if (first.events.length !== 1 || first.nextCursor === undefined) {
        return fail('first page did not return a cursor')
      }
      const cursor = first.nextCursor
      const second = await unwrap(eventStore.read({ after: cursor, types: ['job-enqueued'] }))
      if (second.events.length !== 1 || second.events[0]?.type !== 'job-enqueued') {
        fail('filtered pagination did not advance after the first page')
      }
      return
    }
    case 'event-await-wake': {
      const after = await unwrap(eventStore.tailCursor())
      const controller = new AbortController()
      const waiting = eventStore.awaitEvents({
        after,
        queues: [QueueName.make('event-contract').unwrap()],
        signal: controller.signal
      })
      await unwrap(jobStore.enqueue(makeFixture('wake', clock.now())))
      await unwrap(waiting)
      controller.abort()
      return
    }
    case 'event-safe-record': {
      const fixture = makeFixture('safe', clock.now())
      await unwrap(jobStore.enqueue(fixture))
      const page = await read()
      const serialized = JSON.stringify(page.events[0])
      if (
        serialized.includes('payload') ||
        serialized.includes('result') ||
        serialized.includes('failure') ||
        serialized.includes('metadata')
      ) {
        fail('durable event contained a sensitive field')
      }
      return
    }
  }
}

export type JobEventStoreContractSuite = readonly JobEventStoreContractScenario[] & {
  readonly report: () => JobEventStoreContractReport
}

export const jobEventStoreContract = (
  options: JobEventStoreContractOptions = {}
): JobEventStoreContractSuite => {
  const clock = options.clock ?? defaultClock()
  const executed = new Set<string>()
  const passed = new Set<string>()
  const failed = new Set<string>()
  // SAFETY: every mapped definition supplies the required scenario metadata and async runner.
  const scenarios = scenarioDefinitions().map((definition) => ({
    ...definition,
    run: async () => {
      executed.add(definition.id)
      try {
        await runScenario(definition, options, clock)
        passed.add(definition.id)
      } catch (cause) {
        failed.add(definition.id)
        throw cause
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
        failed: Object.freeze([...failed])
      }),
    writable: false
  })
  // SAFETY: the frozen array retains the report property installed immediately above.
  return Object.freeze(scenarios) as JobEventStoreContractSuite
}
