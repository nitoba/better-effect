// oxlint-disable anti-slop/no-runtime-typeof -- the kit validates adapter and clock boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- failures and factory boundaries accept user values.

import type { Result as ResultType } from 'better-result'
import { validatePreparedEnqueue } from 'better-effect-mq'

import {
  makeOutboxRecord,
  makeSerializedOutboxFailure,
  type OutboxRecord,
  type OutboxRecordInput,
  type OutboxFailureKind
} from '../OutboxRecord'
import type {
  LeasedOutboxRecord,
  OutboxAppendStore,
  OutboxOperation,
  OutboxStore
} from '../OutboxStore'
import {
  OutboxId,
  OutboxLeaseToken,
  OutboxWorkerId,
  type OutboxId as OutboxIdType,
  type OutboxLeaseToken as OutboxLeaseTokenType,
  type OutboxWorkerId as OutboxWorkerIdType
} from '../identity'
import type { OutboxStoreError } from '../errors'

export type OutboxStoreContract = OutboxStore & OutboxAppendStore

export type OutboxStoreContractMaybePromise<Value> = Value | PromiseLike<Value>

export interface OutboxStoreContractClock {
  now(): number | Date
  advance(milliseconds: number): void
}

export type OutboxStoreContractClockFactory = () => OutboxStoreContractClock

export interface OutboxStoreContractScenarioInfo {
  readonly id: string
  readonly name: string
  readonly category: string
}

export interface OutboxStoreContractScenario extends OutboxStoreContractScenarioInfo {
  readonly run: () => Promise<void>
}

export type ContractScenario = OutboxStoreContractScenario

export interface OutboxStoreContractReport {
  readonly version: 1
  readonly protocolVersion: 1
  readonly executed: readonly string[]
  readonly passed: readonly string[]
  readonly failed: readonly string[]
}

export type OutboxStoreContractSuite = readonly OutboxStoreContractScenario[] & {
  readonly report: () => OutboxStoreContractReport
}

export interface OutboxStoreContractOptions<
  Store extends OutboxStoreContract = OutboxStoreContract
> {
  readonly makeOutboxStore: (name?: string) => OutboxStoreContractMaybePromise<Store>
  readonly clock: OutboxStoreContractClock | OutboxStoreContractClockFactory
  readonly disposeOutboxStore?: (store: Store) => OutboxStoreContractMaybePromise<void>
}

type ScenarioContext<Store extends OutboxStoreContract> = {
  readonly scenario: OutboxStoreContractScenarioInfo
  readonly clock: OutboxStoreContractClock
  readonly store: Store
  readonly openStore: (name?: string) => Promise<Store>
}

type ScenarioBody<Store extends OutboxStoreContract> = (
  context: ScenarioContext<Store>
) => Promise<void>

type ScenarioDefinition<Store extends OutboxStoreContract> = OutboxStoreContractScenarioInfo & {
  readonly body: ScenarioBody<Store>
}

type ReportState = {
  readonly executed: Set<string>
  readonly passed: Set<string>
  readonly failed: Set<string>
}

type RecordOverrides = {
  readonly id?: OutboxIdType
  readonly target?: string
  readonly payload?: { readonly value: string }
  readonly attemptsMax?: number
  readonly runAtMs?: number
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)

const isObject = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const hasTag = (value: unknown, tag: string): boolean => {
  if (!isObject(value) || !('_tag' in value)) return false
  return value._tag === tag
}

const fail = (
  context: OutboxStoreContractScenarioInfo,
  invariant: string,
  detail: string,
  cause?: unknown
): never => {
  throw new Error(`${context.id} (${context.name}) [${invariant}]: ${detail}`, { cause })
}

const ensure = (
  condition: boolean,
  context: OutboxStoreContractScenarioInfo,
  invariant: string,
  detail: string
): void => {
  if (!condition) fail(context, invariant, detail)
}

const clockValue = (
  clock: OutboxStoreContractClock,
  context: OutboxStoreContractScenarioInfo
): number => {
  const value = clock.now()
  const milliseconds = value instanceof Date ? value.getTime() : value
  ensure(
    Number.isSafeInteger(milliseconds) && milliseconds >= 0,
    context,
    'controlled clock',
    `clock.now() must return a non-negative safe integer, received ${String(value)}`
  )
  return milliseconds
}

const advance = (context: ScenarioContext<OutboxStoreContract>, milliseconds: number): void => {
  ensure(
    Number.isSafeInteger(milliseconds) && milliseconds >= 0,
    context.scenario,
    'controlled clock',
    'clock advances require a non-negative safe integer'
  )
  const before = clockValue(context.clock, context.scenario)
  context.clock.advance(milliseconds)
  const after = clockValue(context.clock, context.scenario)
  ensure(
    after >= before,
    context.scenario,
    'controlled clock',
    'clock.advance must not move time backwards'
  )
}

const makeIdentity = <Value>(
  value: ResultType<Value, OutboxStoreError>,
  context: OutboxStoreContractScenarioInfo,
  field: string
): Value => {
  if (value.isErr()) fail(context, 'fixture identity', `${field} could not be created`, value.error)
  return value.unwrap()
}

const worker = (context: OutboxStoreContractScenarioInfo, label: string): OutboxWorkerIdType =>
  makeIdentity(OutboxWorkerId.make(`${context.id}-${label}`), context, 'owner')

const leaseToken = (
  context: OutboxStoreContractScenarioInfo,
  label: string
): OutboxLeaseTokenType =>
  makeIdentity(OutboxLeaseToken.make(`${context.id}-${label}`), context, 'leaseToken')

const record = <Store extends OutboxStoreContract>(
  context: ScenarioContext<Store>,
  label: string,
  overrides: RecordOverrides = {}
): OutboxRecord => {
  const nowMs = clockValue(context.clock, context.scenario)
  const prepared = validatePreparedEnqueue({
    protocolVersion: 1,
    identity: { queue: 'contract', name: 'outbox-conformance', version: 1 },
    payload: overrides.payload ?? { value: label },
    metadata: { scenario: context.scenario.id, label },
    priority: 0,
    runAt: overrides.runAtMs ?? nowMs,
    attemptsMax: overrides.attemptsMax ?? 3,
    now: nowMs
  })
  if (prepared.isErr()) {
    fail(
      context.scenario,
      'fixture record',
      'prepared enqueue could not be created',
      prepared.error
    )
  }

  const input: OutboxRecordInput = {
    id:
      overrides.id ??
      makeIdentity(OutboxId.make(`${context.scenario.id}:${label}`), context.scenario, 'id'),
    target: overrides.target ?? 'contract-target',
    request: prepared.unwrap(),
    attemptsMax: overrides.attemptsMax ?? 3,
    runAtMs: overrides.runAtMs ?? nowMs,
    nowMs
  }
  const created = makeOutboxRecord(input)
  if (created.isErr()) {
    fail(context.scenario, 'fixture record', 'outbox record could not be created', created.error)
  }
  return created.unwrap()
}

const succeed = async <Value, Failure extends OutboxStoreError>(
  operation: OutboxOperation<Value, Failure>,
  context: OutboxStoreContractScenarioInfo,
  operationName: string
): Promise<Value> => {
  let result: Awaited<OutboxOperation<Value, Failure>>
  try {
    result = await operation
  } catch (cause) {
    throw new Error(
      `${context.id} (${context.name}) [${operationName} result boundary]: operation rejected instead of returning Result`,
      { cause }
    )
  }
  if (result.status === 'error') {
    fail(context, operationName, `received ${describe(result.error)}`, result.error)
  }
  return result.unwrap()
}

const expectFailure = async <Value, Failure extends OutboxStoreError>(
  operation: OutboxOperation<Value, Failure>,
  context: OutboxStoreContractScenarioInfo,
  operationName: string,
  tag: string
): Promise<Failure> => {
  let result: Awaited<OutboxOperation<Value, Failure>>
  try {
    result = await operation
  } catch (cause) {
    throw new Error(
      `${context.id} (${context.name}) [${operationName} result boundary]: operation rejected instead of returning Result`,
      { cause }
    )
  }
  if (result.status === 'ok') {
    fail(context, operationName, `expected ${tag}, received a successful Result`)
  }
  const error = result.match({
    ok: () => fail(context, operationName, `expected ${tag}, received a successful Result`),
    err: (value) => value
  })
  ensure(hasTag(error, tag), context, operationName, `expected ${tag}, received ${describe(error)}`)
  return error
}

const append = async <Store extends OutboxStoreContract>(
  context: ScenarioContext<Store>,
  value: OutboxRecord
) => succeed(context.store.append(value), context.scenario, 'append')

const claimOne = async <Store extends OutboxStoreContract>(
  context: ScenarioContext<Store>,
  owner: string,
  leaseDurationMs = 10,
  limit = 1
): Promise<LeasedOutboxRecord> => {
  const claimed = await succeed(
    context.store.claim({
      owner: worker(context.scenario, owner),
      limit,
      leaseDurationMs,
      nowMs: clockValue(context.clock, context.scenario)
    }),
    context.scenario,
    'claim'
  )
  const first = claimed[0]
  if (first === undefined) {
    throw new Error(
      `${context.scenario.id} (${context.scenario.name}) [claim creates an active lease]: claim returned no record`
    )
  }
  return first
}

const failure = <Store extends OutboxStoreContract>(
  context: ScenarioContext<Store>,
  kind: OutboxFailureKind,
  code: string
) => {
  const created = makeSerializedOutboxFailure({
    kind,
    code,
    message: `contract failure ${code}`,
    retryable: kind === 'store-transient',
    recordedAtMs: clockValue(context.clock, context.scenario)
  })
  if (created.isErr()) {
    fail(
      context.scenario,
      'fixture failure',
      'serialized failure could not be created',
      created.error
    )
  }
  return created.unwrap()
}

const scenarioDefinitions = <
  Store extends OutboxStoreContract
>(): readonly ScenarioDefinition<Store>[] => [
  {
    id: 'append-idempotency',
    name: 'append is digest-idempotent and rejects conflicting records',
    category: 'append',
    body: async (context) => {
      const first = record(context, 'append')
      const created = await append(context, first)
      const duplicate = await append(context, first)
      ensure(
        !created.duplicate,
        context.scenario,
        'append',
        'first append was reported as duplicate'
      )
      ensure(
        duplicate.duplicate,
        context.scenario,
        'duplicate append',
        'same digest was not reported as duplicate'
      )
      ensure(
        duplicate.record.requestDigest === created.record.requestDigest,
        context.scenario,
        'duplicate append',
        'duplicate returned a different digest'
      )

      const conflicting = record(context, 'append-conflict', {
        id: first.id,
        payload: { value: 'different-request' }
      })
      await expectFailure(
        context.store.append(conflicting),
        context.scenario,
        'conflicting append',
        'OutboxConflictError'
      )
    }
  },
  {
    id: 'claim-ordering-and-fencing',
    name: 'claim orders records and fences expired lease owners',
    category: 'leases',
    body: async (context) => {
      const first = record(context, 'first')
      await append(context, first)
      advance(context, 1)
      const second = record(context, 'second')
      await append(context, second)

      const ordered = await succeed(
        context.store.claim({
          owner: worker(context.scenario, 'ordering-owner'),
          limit: 2,
          leaseDurationMs: 10,
          nowMs: clockValue(context.clock, context.scenario)
        }),
        context.scenario,
        'claim ordering'
      )
      ensure(
        ordered[0]?.id === first.id && ordered[1]?.id === second.id,
        context.scenario,
        'claim ordering',
        'claim did not return records in creation order'
      )

      const fencingStore = await context.openStore('fencing')
      const fencingRecord = record({ ...context, store: fencingStore }, 'fencing')
      await succeed(fencingStore.append(fencingRecord), context.scenario, 'append fencing')
      const initial = await claimOne({ ...context, store: fencingStore }, 'owner-one', 10)
      const firstToken = initial.leaseToken

      advance(context, 10)
      const redelivery = await claimOne({ ...context, store: fencingStore }, 'owner-two', 10)
      ensure(
        redelivery.id === fencingRecord.id,
        context.scenario,
        'lease recovery',
        'expired record was not redelivered'
      )
      ensure(
        redelivery.leaseToken !== firstToken,
        context.scenario,
        'lease fencing',
        'redelivery reused the expired lease token'
      )
      await expectFailure(
        fencingStore.markPublished({
          id: initial.id,
          leaseToken: firstToken,
          nowMs: clockValue(context.clock, context.scenario)
        }),
        context.scenario,
        'stale settlement',
        'OutboxLeaseLostError'
      )
      await succeed(
        fencingStore.release({
          id: redelivery.id,
          leaseToken: redelivery.leaseToken,
          nowMs: clockValue(context.clock, context.scenario)
        }),
        context.scenario,
        'release'
      )
    }
  },
  {
    id: 'heartbeat-and-recovery',
    name: 'heartbeat extends a lease and recovery clears stalled ownership',
    category: 'leases',
    body: async (context) => {
      await append(context, record(context, 'heartbeat'))
      const active = await claimOne(context, 'heartbeat-owner', 5)
      advance(context, 3)
      const heartbeated = await succeed(
        context.store.heartbeat({
          id: active.id,
          leaseToken: active.leaseToken,
          leaseDurationMs: 10,
          nowMs: clockValue(context.clock, context.scenario)
        }),
        context.scenario,
        'heartbeat'
      )
      ensure(
        heartbeated.leaseExpiresAtMs > active.leaseExpiresAtMs,
        context.scenario,
        'heartbeat',
        'heartbeat did not move lease expiry forward'
      )

      advance(context, 9)
      const beforeExpiry = await succeed(
        context.store.recoverStalled({
          maxCount: 1,
          nowMs: clockValue(context.clock, context.scenario)
        }),
        context.scenario,
        'recoverStalled'
      )
      ensure(
        beforeExpiry.length === 0,
        context.scenario,
        'recovery',
        'live lease was recovered too early'
      )

      advance(context, 1)
      const recovered = await succeed(
        context.store.recoverStalled({
          maxCount: 1,
          nowMs: clockValue(context.clock, context.scenario)
        }),
        context.scenario,
        'recoverStalled'
      )
      const recoveredRecord = recovered[0]
      if (recoveredRecord === undefined) {
        throw new Error(
          `${context.scenario.id} (${context.scenario.name}) [recovery]: expired lease was not recovered`
        )
      }
      ensure(
        recoveredRecord.state === 'pending',
        context.scenario,
        'recovery',
        'recovered record was not pending'
      )
      ensure(
        recoveredRecord.leaseToken === undefined,
        context.scenario,
        'recovery',
        'recovered record retained its lease'
      )
    }
  },
  {
    id: 'settlement-and-response-loss',
    name: 'settlement transitions are idempotent across a lost response',
    category: 'settlement',
    body: async (context) => {
      await append(context, record(context, 'published'))
      const publishedActive = await claimOne(context, 'published-owner')
      const published = await succeed(
        context.store.markPublished({
          id: publishedActive.id,
          leaseToken: publishedActive.leaseToken,
          nowMs: clockValue(context.clock, context.scenario)
        }),
        context.scenario,
        'markPublished'
      )
      ensure(
        published.status === 'applied',
        context.scenario,
        'settlement',
        'publish was not applied'
      )
      const acknowledged = await succeed(
        context.store.markPublished({
          id: publishedActive.id,
          leaseToken: leaseToken(context.scenario, 'lost-response'),
          nowMs: clockValue(context.clock, context.scenario)
        }),
        context.scenario,
        'markPublished response retry'
      )
      ensure(
        acknowledged.status === 'already-applied',
        context.scenario,
        'settlement idempotency',
        'repeated publish was not acknowledged as already applied'
      )

      await append(context, record(context, 'retry'))
      const retryActive = await claimOne(context, 'retry-owner')
      const retryAtMs = clockValue(context.clock, context.scenario) + 10
      const retried = await succeed(
        context.store.markRetry({
          id: retryActive.id,
          leaseToken: retryActive.leaseToken,
          nowMs: clockValue(context.clock, context.scenario),
          runAtMs: retryAtMs,
          failure: failure(context, 'store-transient', 'transient')
        }),
        context.scenario,
        'markRetry'
      )
      ensure(
        retried.state === 'pending',
        context.scenario,
        'retry settlement',
        'retry did not requeue the record'
      )
      advance(context, 10)
      const retriedActive = await claimOne(context, 'retry-owner-again')
      await succeed(
        context.store.release({
          id: retriedActive.id,
          leaseToken: retriedActive.leaseToken,
          nowMs: clockValue(context.clock, context.scenario)
        }),
        context.scenario,
        'release'
      )

      await append(context, record(context, 'failed'))
      const failedActive = await claimOne(context, 'failed-owner')
      const failed = await succeed(
        context.store.markFailed({
          id: failedActive.id,
          leaseToken: failedActive.leaseToken,
          nowMs: clockValue(context.clock, context.scenario),
          failure: failure(context, 'store-permanent', 'permanent')
        }),
        context.scenario,
        'markFailed'
      )
      ensure(
        failed.state === 'failed',
        context.scenario,
        'failed settlement',
        'failed record was not terminal'
      )
      ensure(
        failed.leaseToken === undefined,
        context.scenario,
        'failed settlement',
        'failed record retained its lease'
      )
    }
  },
  {
    id: 'poison-failure-persistence',
    name: 'missing targets and poison requests remain inspectable failures',
    category: 'failure-policy',
    body: async (context) => {
      await append(context, record(context, 'missing-route', { target: 'missing-route' }))
      const missingActive = await claimOne(context, 'missing-route-owner')
      await succeed(
        context.store.markFailed({
          id: missingActive.id,
          leaseToken: missingActive.leaseToken,
          nowMs: clockValue(context.clock, context.scenario),
          failure: failure(context, 'target-missing', 'route-missing')
        }),
        context.scenario,
        'markFailed missing route'
      )

      await append(context, record(context, 'poison-request'))
      const poisonActive = await claimOne(context, 'poison-owner')
      await succeed(
        context.store.markFailed({
          id: poisonActive.id,
          leaseToken: poisonActive.leaseToken,
          nowMs: clockValue(context.clock, context.scenario),
          failure: failure(context, 'request-invalid', 'poison-request')
        }),
        context.scenario,
        'markFailed poison request'
      )

      const failed = await succeed(
        context.store.list({ state: 'failed' }),
        context.scenario,
        'list failed'
      )
      ensure(
        failed.length === 2,
        context.scenario,
        'failure inspection',
        'failed records were not retained'
      )
      const kinds = new Set(failed.map((value) => value.failure?.kind))
      ensure(
        kinds.has('target-missing'),
        context.scenario,
        'failure inspection',
        'missing route failure was lost'
      )
      ensure(
        kinds.has('request-invalid'),
        context.scenario,
        'failure inspection',
        'poison failure was lost'
      )
    }
  },
  {
    id: 'inspection-and-redrive',
    name: 'list and counts expose state and retry redrive timing',
    category: 'inspection',
    body: async (context) => {
      const nowMs = clockValue(context.clock, context.scenario)
      await append(
        context,
        record(context, 'future-pending', { target: 'target-a', runAtMs: nowMs + 20 })
      )

      await append(context, record(context, 'published', { target: 'target-b' }))
      const publishedActive = await claimOne(context, 'inspection-published')
      await succeed(
        context.store.markPublished({
          id: publishedActive.id,
          leaseToken: publishedActive.leaseToken,
          nowMs: clockValue(context.clock, context.scenario)
        }),
        context.scenario,
        'markPublished inspection'
      )

      await append(context, record(context, 'failed', { target: 'target-c' }))
      const failedActive = await claimOne(context, 'inspection-failed')
      await succeed(
        context.store.markFailed({
          id: failedActive.id,
          leaseToken: failedActive.leaseToken,
          nowMs: clockValue(context.clock, context.scenario),
          failure: failure(context, 'store-permanent', 'inspection-failed')
        }),
        context.scenario,
        'markFailed inspection'
      )

      await append(context, record(context, 'redrive', { target: 'target-a' }))
      const retryActive = await claimOne(context, 'inspection-retry')
      await succeed(
        context.store.markRetry({
          id: retryActive.id,
          leaseToken: retryActive.leaseToken,
          nowMs: clockValue(context.clock, context.scenario),
          runAtMs: nowMs + 20,
          failure: failure(context, 'store-transient', 'inspection-retry')
        }),
        context.scenario,
        'markRetry inspection'
      )

      const counts = await succeed(context.store.counts(), context.scenario, 'counts')
      ensure(counts.total === 4, context.scenario, 'counts', 'total count is incorrect')
      ensure(counts.pending === 2, context.scenario, 'counts', 'pending count is incorrect')
      ensure(counts.published === 1, context.scenario, 'counts', 'published count is incorrect')
      ensure(counts.failed === 1, context.scenario, 'counts', 'failed count is incorrect')

      const targetA = await succeed(
        context.store.list({ target: 'target-a' }),
        context.scenario,
        'list target'
      )
      ensure(
        targetA.length === 2,
        context.scenario,
        'list target',
        'target filter returned the wrong records'
      )
      const failed = await succeed(
        context.store.list({ state: 'failed', limit: 1 }),
        context.scenario,
        'list failed'
      )
      ensure(
        failed.length === 1 && failed[0]?.state === 'failed',
        context.scenario,
        'list state',
        'state filter failed'
      )

      const beforeRedrive = await succeed(
        context.store.claim({
          owner: worker(context.scenario, 'before-redrive'),
          limit: 10,
          leaseDurationMs: 10,
          nowMs
        }),
        context.scenario,
        'claim before redrive'
      )
      ensure(
        beforeRedrive.length === 0,
        context.scenario,
        'redrive timing',
        'future records were claimed too early'
      )

      advance(context, 20)
      const redriven = await succeed(
        context.store.claim({
          owner: worker(context.scenario, 'after-redrive'),
          limit: 10,
          leaseDurationMs: 10,
          nowMs: clockValue(context.clock, context.scenario)
        }),
        context.scenario,
        'claim after redrive'
      )
      ensure(
        redriven.length === 2,
        context.scenario,
        'redrive',
        'retry records were not claimable at runAtMs'
      )
      for (const active of redriven) {
        await succeed(
          context.store.release({
            id: active.id,
            leaseToken: active.leaseToken,
            nowMs: clockValue(context.clock, context.scenario)
          }),
          context.scenario,
          'release redrive'
        )
      }
    }
  },
  {
    id: 'named-outbox-isolation',
    name: 'named outboxes keep records isolated from the default outbox',
    category: 'namespaces',
    body: async (context) => {
      const named = await context.openStore('contract-named')
      const value = record(context, 'named-value')
      await append(context, value)
      await succeed(named.append(value), context.scenario, 'append named')

      const defaultRecords = await succeed(context.store.list(), context.scenario, 'list default')
      const namedRecords = await succeed(named.list(), context.scenario, 'list named')
      ensure(
        defaultRecords.length === 1,
        context.scenario,
        'named isolation',
        'default outbox record count is incorrect'
      )
      ensure(
        namedRecords.length === 1,
        context.scenario,
        'named isolation',
        'named outbox record count is incorrect'
      )
      ensure(
        defaultRecords[0]?.id === namedRecords[0]?.id,
        context.scenario,
        'named isolation',
        'named fixture did not use the same logical record'
      )

      const another = record(context, 'named-only')
      await succeed(named.append(another), context.scenario, 'append named-only')
      const defaultAfter = await succeed(
        context.store.list(),
        context.scenario,
        'list default after named'
      )
      ensure(
        defaultAfter.length === 1,
        context.scenario,
        'named isolation',
        'named write leaked into default outbox'
      )
    }
  }
]

const assertFactory = <Store extends OutboxStoreContract>(
  options: OutboxStoreContractOptions<Store>
): void => {
  if (typeof options.makeOutboxStore !== 'function') {
    throw new TypeError('outboxStoreContract makeOutboxStore must be a function')
  }
  if (typeof options.clock !== 'function' && !isObject(options.clock)) {
    throw new TypeError('outboxStoreContract clock must be a clock or factory')
  }
}

const makeClock = <Store extends OutboxStoreContract>(
  options: OutboxStoreContractOptions<Store>,
  context: OutboxStoreContractScenarioInfo
): OutboxStoreContractClock => {
  const clock = typeof options.clock === 'function' ? options.clock() : options.clock
  if (!isClockCandidate(clock)) {
    fail(context, 'clock factory', 'clock must provide now() and advance() methods')
  }
  // SAFETY: isClockCandidate validates the two callable methods at this boundary.
  return clock as OutboxStoreContractClock
}

type ClockCandidate = {
  readonly now: unknown
  readonly advance: unknown
}

const isClockCandidate = (value: unknown): value is ClockCandidate =>
  isObject(value) &&
  'now' in value &&
  'advance' in value &&
  typeof value.now === 'function' &&
  typeof value.advance === 'function'

const verifyStore = <Store extends OutboxStoreContract>(
  store: Store,
  context: OutboxStoreContractScenarioInfo
): void => {
  if (!isObject(store)) fail(context, 'store factory', 'makeOutboxStore did not return a store')
  const methods = [
    'append',
    'claim',
    'heartbeat',
    'markPublished',
    'markRetry',
    'markFailed',
    'release',
    'recoverStalled',
    'get',
    'list',
    'counts'
  ] as const
  for (const method of methods) {
    if (typeof store[method] !== 'function') {
      fail(context, 'store factory', `store is missing ${method}()`)
    }
  }
  if (!isObject(store.descriptor) || store.descriptor.protocolVersion !== 1) {
    fail(context, 'store descriptor', 'store descriptor must advertise protocol version 1')
  }
}

const reportSnapshot = (state: ReportState): OutboxStoreContractReport =>
  Object.freeze({
    version: 1,
    protocolVersion: 1,
    executed: Object.freeze([...state.executed]),
    passed: Object.freeze([...state.passed]),
    failed: Object.freeze([...state.failed])
  })

const makeStore = async <Store extends OutboxStoreContract>(
  options: OutboxStoreContractOptions<Store>,
  context: OutboxStoreContractScenarioInfo,
  name: string | undefined
): Promise<Store> => {
  try {
    return await options.makeOutboxStore(name)
  } catch (cause) {
    return fail(context, 'store factory', 'makeOutboxStore failed', cause)
  }
}

const makeScenario = <Store extends OutboxStoreContract>(
  definition: ScenarioDefinition<Store>,
  options: OutboxStoreContractOptions<Store>,
  report: ReportState
): OutboxStoreContractScenario => {
  const run = async (): Promise<void> => {
    report.executed.add(definition.id)
    report.passed.delete(definition.id)
    report.failed.delete(definition.id)
    const stores: Store[] = []
    let primary: unknown
    let hasPrimary = false

    try {
      const clock = makeClock(options, definition)
      const openStore = async (name?: string): Promise<Store> => {
        const store = await makeStore(options, definition, name)
        verifyStore(store, definition)
        stores.push(store)
        return store
      }
      const context: ScenarioContext<Store> = {
        scenario: definition,
        clock,
        store: await openStore(),
        openStore
      }
      await definition.body(context)
      report.passed.add(definition.id)
    } catch (cause) {
      primary = cause
      hasPrimary = true
      report.failed.add(definition.id)
    } finally {
      if (options.disposeOutboxStore !== undefined) {
        for (const store of [...stores].reverse()) {
          try {
            await options.disposeOutboxStore(store)
          } catch (cause) {
            if (!hasPrimary) {
              primary = cause
              hasPrimary = true
            }
          }
        }
      }
      if (hasPrimary) {
        report.passed.delete(definition.id)
        report.failed.add(definition.id)
      }
    }

    if (hasPrimary) throw primary
  }

  return Object.freeze({
    id: definition.id,
    name: definition.name,
    category: definition.category,
    run
  })
}

export function outboxStoreContract<Store extends OutboxStoreContract>(
  options: OutboxStoreContractOptions<Store>
): OutboxStoreContractSuite {
  assertFactory(options)
  const report: ReportState = {
    executed: new Set(),
    passed: new Set(),
    failed: new Set()
  }
  const scenarios = scenarioDefinitions<Store>().map((definition) =>
    makeScenario(definition, options, report)
  )
  const suite = Object.assign([...scenarios], {
    report: (): OutboxStoreContractReport => reportSnapshot(report)
  })
  Object.freeze(suite)
  return suite
}
