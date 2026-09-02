// oxlint-disable anti-slop/no-chained-type-assertions -- Layer erasure restores the named JobStore instance at one public provider boundary.

import { Layer } from 'better-effect'
import { Clock, ClockTest, IdGeneratorTest } from 'better-effect/standard-services'
import { Result, type Result as ResultType } from 'better-result'

import { Job, observeJob } from '../job'
import type { AnyJobDefinition } from '../job'
import { RecordedJobObserver } from './recorded-job-observer'
import { JobStore, MemoryJobStore } from '../store'
import type {
  ClaimRequest,
  ClaimResult,
  JobCounts,
  JobStoreOperation,
  JobStoreError,
  DefaultJobStoreToken,
  JobStoreToken,
  AnyJobStoreToken,
  ReleaseRequest,
  ReleaseResult,
  SettleRequest,
  SettlementResult
} from '../store'
import { makeJobId, makeJobName, makeQueueName } from '../protocol'
import type { AttemptRecord, JobId, JobRecord, QueueName } from '../protocol'

/** Options for an isolated {@link TestJobStore}. */
export type TestJobStoreOptions<Name extends string | undefined = undefined> = {
  /** The default token is used when omitted. */
  readonly token?: JobStore.Token<Name>
  /** Defaults to a clock starting at Unix epoch. */
  readonly clock?: ClockTest
  /** Defaults to an unbounded deterministic factory (`test-id-0`, ...). */
  readonly ids?: IdGeneratorTest
  /** Compatibility alias for callers that name the underlying service. */
  readonly idGenerator?: IdGeneratorTest
}

type TokenFor<Name extends string | undefined> = Name extends undefined
  ? DefaultJobStoreToken
  : JobStoreToken<Extract<Name, string>>
type Definition = AnyJobDefinition

const unwrap = async <Value, Failure extends JobStoreError>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this helper consumes the typed Result operation returned by the public JobStore contract.
  operation: JobStoreOperation<Value, Failure>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const defaultIds = (): IdGeneratorTest => IdGeneratorTest.from((index) => `test-id-${index}`)

/**
 * A small, isolated harness around the public in-memory JobStore contract.
 *
 * The harness never reaches into MemoryJobStore state: inspection and lifecycle
 * operations go through the same public requests used by application code.
 */
export class TestJobStore<Name extends string | undefined = undefined> {
  readonly token: TokenFor<Name>
  readonly clock: ClockTest
  readonly idGenerator: IdGeneratorTest
  readonly store: JobStore.Contract
  readonly layer: Layer<InstanceType<TokenFor<Name>>, never>
  readonly clockLayer: ReturnType<typeof ClockTest.layer>
  readonly idGeneratorLayer: ReturnType<typeof IdGeneratorTest.layer>
  readonly observer: RecordedJobObserver

  private constructor(options: TestJobStoreOptions<Name> = {}) {
    // SAFETY: an omitted token selects the default token; a supplied token is the exact generic token carried by the options.
    this.token = (options.token ?? JobStore) as TokenFor<Name>
    this.clock = options.clock ?? new ClockTest()
    if (options.ids !== undefined && options.idGenerator !== undefined) {
      throw new TypeError('TestJobStore accepts either ids or idGenerator, not both')
    }
    this.idGenerator = options.ids ?? options.idGenerator ?? defaultIds()
    this.store = MemoryJobStore.make({ clock: this.clock, idGenerator: this.idGenerator })
    // SAFETY: the store is created from the same contract as the supplied token;
    // Layer's heterogeneous provider boundary widens the structural instance.
    this.layer = Layer.succeed(this.token as AnyJobStoreToken, this.store) as unknown as Layer<
      InstanceType<TokenFor<Name>>,
      never
    >
    this.clockLayer = Layer.succeed(Clock, this.clock)
    this.idGeneratorLayer = IdGeneratorTest.layer(this.idGenerator)
    this.observer = RecordedJobObserver.make()
  }

  /** Make a fresh harness; no mutable state is shared between instances. */
  static make<const Name extends string | undefined = undefined>(
    options: TestJobStoreOptions<Name> = {}
  ): TestJobStore<Name> {
    return new TestJobStore(options)
  }

  /** Make an isolated harness for a named JobStore token. */
  static makeFor<const Name extends string>(
    token: JobStore.Token<Name>,
    options: Omit<TestJobStoreOptions<Name>, 'token'> = {}
  ): TestJobStore<Name> {
    return new TestJobStore({ ...options, token })
  }

  /** Attach this harness' recorder to a Job definition. */
  observe<Current extends Definition>(definition: Current): Current {
    return observeJob(definition, this.observer)
  }

  /** Jobs currently stored with the definition's exact queue/name/version. */
  async enqueued<Current extends Definition>(definition: Current): Promise<readonly JobRecord[]> {
    const listed = await unwrap(
      this.store.list({
        queue: makeQueueName(definition.queue).unwrap(),
        name: makeJobName(definition.name).unwrap(),
        version: definition.version,
        orderBy: 'enqueuedAt',
        order: 'asc',
        limit: Number.MAX_SAFE_INTEGER
      })
    )
    return listed.jobs
  }

  /** Decode persisted payloads for jobs matching a definition. */
  async enqueuedPayloads<Current extends Definition>(
    definition: Current
  ): Promise<readonly Job.Payload<Current>[]> {
    const jobs = await this.enqueued(definition)
    const payloads: Job.Payload<Current>[] = []
    for (const record of jobs) {
      // SAFETY: Job.Payload<Current> is the value type of the definition's payload codec;
      // the snapshot intentionally erases that codec's implementation details.
      const decode = definition.payload.decode as (
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- codec payloads are persisted as unknown values and decoded at this public helper boundary.
        value: unknown
      ) =>
        | ResultType<Job.Payload<Current>, unknown>
        | PromiseLike<ResultType<Job.Payload<Current>, unknown>>
      const decoded = await decode(record.payload)
      if (Result.isError(decoded)) throw decoded.error
      payloads.push(decoded.value)
    }
    return Object.freeze(payloads)
  }

  /** Read one detached public job snapshot. */
  async job(jobId: JobId | string): Promise<JobRecord | undefined> {
    return unwrap(this.store.getJob({ jobId: this.checkedJobId(jobId) }))
  }

  /** Read the detached attempt ledger for one job. */
  async attempts(jobId: JobId | string): Promise<readonly AttemptRecord[]> {
    return unwrap(this.store.getAttempts({ jobId: this.checkedJobId(jobId) }))
  }

  /** Read counts for all jobs or one queue. */
  async counts(queue?: QueueName | string): Promise<JobCounts> {
    return unwrap(
      this.store.counts(queue === undefined ? undefined : { queue: makeQueueName(queue).unwrap() })
    )
  }

  /** Remove all events recorded by {@link observe}. */
  clearObserver(): void {
    this.observer.clear()
  }

  /** Claim using an explicit public request; `now` defaults to the test clock. */
  async claim(
    request: Omit<ClaimRequest, 'now'> & { readonly now?: number }
  ): Promise<ClaimResult> {
    return unwrap(this.store.claim({ ...request, now: request.now ?? this.now() }))
  }

  /** Settle using the explicit lease token returned by {@link claim}. */
  async settle(
    request: Omit<SettleRequest, 'now'> & { readonly now?: number }
  ): Promise<SettlementResult> {
    return unwrap(this.store.settle({ ...request, now: request.now ?? this.now() }))
  }

  /** Release using the explicit lease token returned by {@link claim}. */
  async release(
    request: Omit<ReleaseRequest, 'now'> & { readonly now?: number }
  ): Promise<ReleaseResult> {
    return unwrap(this.store.release({ ...request, now: request.now ?? this.now() }))
  }

  private now(): number {
    return this.clock.now().getTime()
  }

  private checkedJobId(jobId: JobId | string): JobId {
    return makeJobId(jobId).unwrap()
  }
}
