// oxlint-disable anti-slop/no-runtime-typeof -- BSON documents and public flow requests are validated at this persistence boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- optional MongoDB driver replies are narrowed before use.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- fixed flow documents are assembled as BSON records.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to validated driver and Service boundaries.

import { Layer, type ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  defaultFlowLimits,
  FlowStore,
  flowLayoutVersion,
  hardFlowMaxChildren,
  makeFlowChildId,
  makeFlowMigration,
  makeJobId,
  makeLeaseToken,
  maxFlowChildIdLength,
  maxFlowStoreKeyLength,
  protocolVersionV2,
  JobDefinitionError,
  JobNotFoundError,
  JobStore,
  JobStoreFailure,
  LeaseLostError,
  SettlementConflictError,
  validateFanOutOutcome,
  validateFlowChildRecord,
  validateFlowChildReport,
  validateFlowChildSpec,
  validateFlowOutboxEntry,
  validateFlowLimits,
  validateFlowState,
  validateParentEnvelope,
  validateSerializedJobFailure,
  type AnyFlowStoreToken,
  type AnyJobStoreToken,
  type AppendChildReportRequest,
  type AppendChildReportResult,
  type AckOutboxRequest,
  type AckOutboxResult,
  type CancelFlowRequest,
  type CancelFlowResult,
  type FlowChildObservation,
  type FlowChildRecord,
  type FlowChildReport,
  type FlowChildSpec,
  type FlowFanOutRequest,
  type FlowFanOutResult,
  type FlowOutboxEntry,
  type FlowOutboxPage,
  type FlowParentRecord,
  type FlowSnapshot,
  type FlowStoreV2,
  type FlowStoreV2Descriptor,
  type FlowStoreV2Error,
  type GetFlowRequest,
  type MarkCascadedRequest,
  type MarkCascadedResult,
  type PeekOutboxRequest,
  type ReconcileFlowRequest,
  type ReconcileFlowResult,
  type RecordChildResultsRequest,
  type RecordChildResultsResult,
  type SerializedJobFailure
} from 'better-effect-mq'
import { MongoFlowMigrator, type MongoMigrationOptions } from './migrator'
import { mongoCollections, namespaceId, type MongoCollections } from './collections'
import { MongoJobStoreClient } from './client'
import type { MongoJobStoreConfig, MongoJobStoreConnectionConfig, MongoSession } from './config'
import { MongoJobStoreTopologyError } from './errors'

type Doc = Record<string, unknown>
type FlowResult<Value> = ResultType<Value, FlowStoreV2Error>
type TxBody<Value> = (session: MongoSession) => Promise<Value>
type FlowChildDocument = {
  readonly _id: string
  readonly namespace: string
  readonly flowId: string
  readonly childKey: string
  readonly name: string
  readonly version: number
  readonly storeKey: string
  readonly childJobId: string
  readonly request: FlowChildSpec['request']
  readonly status: FlowChildRecord['status']
  readonly result?: FlowChildRecord['result']
  readonly failure?: FlowChildRecord['failure']
  readonly cascaded: boolean
  readonly pendingSinceMs: number
}
type MutableFlowChildDocument = {
  _id: string
  namespace: string
  flowId: string
  childKey: string
  name: string
  version: number
  storeKey: string
  childJobId: string
  request: FlowChildSpec['request']
  status: FlowChildRecord['status']
  result?: FlowChildRecord['result']
  failure?: FlowChildRecord['failure']
  cascaded: boolean
  pendingSinceMs: number
}
type FlowChildUpdate = {
  $set: {
    status: FlowChildReport['outcome']
    result?: FlowChildReport['result']
    failure?: FlowChildReport['failure']
  }
  $unset?: { result?: ''; failure?: '' }
}
type FlowParentUpdate = {
  $set: {
    state: FlowParentRecord['state']
    flow: FlowParentRecord['flow']
    updatedAtMs: number
    finishedAtMs?: number
    failure?: SerializedJobFailure
  }
  $unset?: { failure: '' }
}
type FlowOutboxDocument = {
  readonly _id: string
  readonly namespace: string
  readonly id: string
  readonly flowName: string
  readonly parentStoreKey: string
  readonly report: FlowChildReport
  readonly sequence: number
  readonly createdAtMs: number
}
type FlowOutboxFilter = {
  namespace: string
  parentStoreKey?: string
  sequence?: { $gt: number }
}

const flowDescriptor: FlowStoreV2Descriptor = Object.freeze({
  protocolVersion: protocolVersionV2,
  layoutVersion: flowLayoutVersion,
  migration: makeFlowMigration({ status: 'complete', from: undefined, to: flowLayoutVersion })
})

const ok = <Value>(value: Value): FlowResult<Value> => Result.ok(value) as FlowResult<Value>
const tagged = new Set([
  'JobStoreFailure',
  'JobDefinitionError',
  'JobNotFoundError',
  'LeaseLostError',
  'SettlementConflictError',
  'InvalidJobTransitionError'
])
const isTagged = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  typeof (cause as { readonly _tag?: unknown })._tag === 'string' &&
  tagged.has((cause as { readonly _tag: string })._tag)
const fail = <Value>(operation: string, cause: unknown): FlowResult<Value> =>
  Result.err(
    isTagged(cause)
      ? cause
      : new JobStoreFailure({
          operation: `flow.${operation}`,
          retryable: true,
          message: `MongoDB flow ${operation} failed`
        })
  ) as FlowResult<Value>
const invalid = <Value>(field: string, message: string): FlowResult<Value> =>
  Result.err(new JobDefinitionError({ field, message })) as FlowResult<Value>

const canonicalJson = (value: unknown): string => {
  const seen = new Set<object>()
  const visit = (current: unknown): string => {
    if (current === undefined) return 'undefined'
    if (current === null || typeof current !== 'object') {
      const encoded = JSON.stringify(current)
      if (encoded === undefined) throw new TypeError('value is not JSON encodable')
      return encoded
    }
    if (seen.has(current)) throw new TypeError('value is cyclic')
    seen.add(current)
    try {
      if (Array.isArray(current)) return `[${current.map(visit).join(',')}]`
      return `{${Object.keys(current)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit((current as Doc)[key])}`)
        .join(',')}}`
    } finally {
      seen.delete(current)
    }
  }
  return visit(value)
}

const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const findOneResult = (value: unknown): Doc | undefined => {
  if (value === null || value === undefined || typeof value !== 'object') return undefined
  if ('lastErrorObject' in value && 'value' in value) {
    const document = (value as { readonly value?: unknown }).value
    return document === null || typeof document !== 'object' ? undefined : (document as Doc)
  }
  return value as Doc
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`invalid ${field}`)
  return value
}
const number = (value: unknown, field: string, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new TypeError(`invalid ${field}`)
  return value
}

const encodeChild = (
  namespace: string,
  child: FlowChildRecord,
  spec: FlowChildSpec
): FlowChildDocument => {
  const document: MutableFlowChildDocument = {
    _id: namespaceId(namespace, child.flowId, child.childKey),
    namespace,
    flowId: child.flowId,
    childKey: child.childKey,
    name: child.name,
    version: child.version,
    storeKey: child.storeKey,
    childJobId: child.childJobId,
    request: spec.request,
    status: child.status,
    cascaded: child.cascaded,
    pendingSinceMs: child.pendingSinceMs
  }
  if (child.result !== undefined) document.result = child.result
  if (child.failure !== undefined) document.failure = child.failure
  return document
}

const decodeChild = (document: Doc): FlowChildRecord => {
  const checked = validateFlowChildRecord({
    flowId: text(document.flowId, 'flowId'),
    childKey: text(document.childKey, 'childKey'),
    name: text(document.name, 'name'),
    version: number(document.version, 'version', 1),
    storeKey: text(document.storeKey, 'storeKey'),
    childJobId: text(document.childJobId, 'childJobId'),
    status: document.status,
    result: document.result,
    failure: document.failure,
    cascaded: document.cascaded,
    pendingSinceMs: number(document.pendingSinceMs, 'pendingSinceMs')
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const decodeSpec = (document: Doc): FlowChildSpec => {
  const checked = validateFlowChildSpec({
    childKey: text(document.childKey, 'childKey'),
    name: text(document.name, 'name'),
    version: number(document.version, 'version', 1),
    storeKey: text(document.storeKey, 'storeKey'),
    childJobId: text(document.childJobId, 'childJobId'),
    request: document.request
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const decodeOutbox = (document: Doc): FlowOutboxEntry => {
  const checked = validateFlowOutboxEntry({
    id: text(document.id, 'id'),
    flowName: text(document.flowName, 'flowName'),
    parentStoreKey: text(document.parentStoreKey, 'parentStoreKey'),
    report: document.report
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const decodeParent = (document: Doc): FlowParentRecord => {
  const flowId = makeJobId(document.id)
  const leaseToken = makeLeaseToken(document.flowLeaseToken ?? document.leaseToken)
  const envelope = validateParentEnvelope({
    flowName: document.flowName,
    flowId: document.id,
    childKey: 'flow-root',
    parentStoreKey: document.flowParentStoreKey,
    depth: document.flowDepth
  })
  const flow = validateFlowState(document.flow)
  if (Result.isError(flowId)) throw flowId.error
  if (Result.isError(leaseToken)) throw leaseToken.error
  if (Result.isError(envelope)) throw envelope.error
  if (Result.isError(flow)) throw flow.error
  const state = document.state
  if (
    state !== 'active' &&
    state !== 'waiting-children' &&
    state !== 'waiting' &&
    state !== 'completed' &&
    state !== 'failed' &&
    state !== 'cancelled'
  )
    throw new TypeError('invalid flow parent state')
  let failure: SerializedJobFailure | undefined
  if (document.failure !== undefined && document.failure !== null) {
    const checked = validateSerializedJobFailure(document.failure)
    if (Result.isError(checked)) throw checked.error
    failure = checked.value
  }
  return Object.freeze({
    flowId: flowId.value,
    flowName: envelope.value.flowName,
    parentStoreKey: envelope.value.parentStoreKey,
    depth: envelope.value.depth,
    state,
    leaseToken: leaseToken.value,
    flow: flow.value,
    failure
  })
}

const flowDigest = (request: {
  readonly flowId: string
  readonly flowName: string
  readonly parentStoreKey: string
  readonly depth: number
  readonly failFast: boolean
  readonly children: readonly FlowChildSpec[]
}): string =>
  canonicalJson({
    children: [...request.children].sort((left, right) =>
      left.childKey.localeCompare(right.childKey)
    ),
    depth: request.depth,
    failFast: request.failFast,
    flowId: request.flowId,
    flowName: request.flowName,
    parentStoreKey: request.parentStoreKey
  })

const normalizeFanOut = (
  request: FlowFanOutRequest
): ResultType<FlowFanOutRequest, FlowStoreV2Error> => {
  const flowId = makeJobId(request.flowId)
  const leaseToken = makeLeaseToken(request.leaseToken)
  const parent = validateParentEnvelope({
    flowName: request.flowName,
    flowId: request.flowId,
    childKey: 'flow-root',
    parentStoreKey: request.parentStoreKey,
    depth: request.depth
  })
  const limits = validateFlowLimits({
    maxChildren: request.maxChildren ?? defaultFlowLimits.maxChildren,
    maxDepth: defaultFlowLimits.maxDepth
  })
  const outcome = validateFanOutOutcome(
    { type: 'FanOut', failFast: request.failFast, children: request.children },
    Result.isError(limits) ? defaultFlowLimits : limits.value
  )
  if (Result.isError(flowId)) return flowId
  if (Result.isError(leaseToken)) return leaseToken
  if (Result.isError(parent)) return parent
  if (Result.isError(limits)) return limits
  if (Result.isError(outcome)) return outcome
  for (const child of outcome.value.children) {
    const expected = makeFlowChildId({
      parentStoreKey: parent.value.parentStoreKey,
      flowId: parent.value.flowId,
      childKey: child.childKey
    })
    if (Result.isError(expected) || expected.value !== child.childJobId)
      return Result.err(
        new JobStoreFailure({
          operation: 'flow.fanOut',
          retryable: false,
          message: 'child ID is not deterministic'
        })
      )
  }
  return Result.ok({
    ...request,
    flowId: flowId.value,
    leaseToken: leaseToken.value,
    children: outcome.value.children
  })
}

const readChildren = async (
  collections: MongoCollections,
  namespace: string,
  flowId: string,
  session?: MongoSession
): Promise<Map<string, { readonly record: FlowChildRecord; readonly spec: FlowChildSpec }>> => {
  const rows = await collections.flowChildren
    .find(
      { namespace, flowId },
      session === undefined ? { sort: { childKey: 1 } } : { sort: { childKey: 1 }, session }
    )
    .toArray()
  return new Map(
    rows.map((row) => [
      text(row.childKey, 'childKey'),
      { record: decodeChild(row), spec: decodeSpec(row) }
    ])
  )
}

const readSnapshot = async (
  collections: MongoCollections,
  namespace: string,
  flowId: string,
  session?: MongoSession
): Promise<FlowSnapshot> => {
  const parentDocument = await collections.jobs.findOne(
    { _id: namespaceId(namespace, flowId) },
    session === undefined ? undefined : { session }
  )
  if (parentDocument === null) throw new Error('flow parent was not found')
  const children = await readChildren(collections, namespace, flowId, session)
  const outboxRows = await collections.flowOutbox
    .find(
      { namespace, 'report.flowId': flowId },
      session === undefined
        ? { sort: { sequence: 1, id: 1 }, limit: hardFlowMaxChildren }
        : { sort: { sequence: 1, id: 1 }, limit: hardFlowMaxChildren, session }
    )
    .toArray()
  const outbox = outboxRows.map(decodeOutbox).filter((entry) => entry.report.flowId === flowId)
  return Object.freeze({
    parent: decodeParent(parentDocument),
    children: Object.freeze([...children.values()].map(({ record }) => record)),
    outbox: Object.freeze(outbox)
  })
}

const transaction = async <Value>(
  client: MongoJobStoreClient,
  operation: string,
  body: TxBody<Value>
): Promise<FlowResult<Value>> => {
  const session = client.client.startSession()
  let value: Value | undefined
  try {
    await session.withTransaction(
      async () => {
        value = await body(session)
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
    )
    return ok(value as Value)
  } catch (cause) {
    return fail(operation, cause)
  } finally {
    try {
      await session.endSession()
    } catch {
      /* preserve the primary flow operation result */
    }
  }
}

class MongoFlowStoreImplementation implements MongoFlowStoreInstance {
  readonly descriptor = flowDescriptor
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly client: MongoJobStoreClient) {}

  private get collections(): MongoCollections {
    return mongoCollections(this.client.db, this.client.collectionPrefix)
  }

  async fanOut(request: FlowFanOutRequest): Promise<FlowResult<FlowFanOutResult>> {
    const checked = normalizeFanOut(request)
    if (Result.isError(checked)) return checked
    if (this.disposed) return fail('fanOut', new Error('store is disposed'))
    const normalized = checked.value
    const digest = flowDigest(normalized)
    return transaction(this.client, 'fanOut', async (session) => {
      const parent = await this.collections.jobs.findOne(
        { _id: namespaceId(this.client.namespace, normalized.flowId) },
        { session }
      )
      if (parent === null) throw new JobNotFoundError({ jobId: normalized.flowId })
      if (parent.flow !== undefined && parent.flow !== null) {
        if (parent.flowManifestDigest === digest) {
          const snapshot = await readSnapshot(
            this.collections,
            this.client.namespace,
            normalized.flowId,
            session
          )
          return { status: 'already-applied', parent: snapshot.parent, children: snapshot.children }
        }
        throw new SettlementConflictError({
          jobId: normalized.flowId,
          leaseToken: normalized.leaseToken
        })
      }
      if (parent.state !== 'active' || parent.leaseToken !== normalized.leaseToken)
        throw new LeaseLostError({
          jobId: normalized.flowId,
          leaseToken: normalized.leaseToken,
          reason: 'mismatched-token'
        })
      const flow = Object.freeze({
        flowName: normalized.flowName,
        failFast: normalized.failFast,
        pending: normalized.children.length,
        completed: 0,
        failed: 0,
        cancelled: 0
      })
      for (const spec of normalized.children) {
        const child: FlowChildRecord = Object.freeze({
          flowId: normalized.flowId,
          childKey: spec.childKey,
          name: spec.name,
          version: spec.version,
          storeKey: spec.storeKey,
          childJobId: spec.childJobId,
          status: 'pending',
          result: undefined,
          failure: undefined,
          cascaded: false,
          pendingSinceMs: normalized.now
        })
        await this.collections.flowChildren.insertOne(
          encodeChild(this.client.namespace, child, spec),
          { session }
        )
      }
      const updated = await this.collections.jobs.updateOne(
        {
          _id: namespaceId(this.client.namespace, normalized.flowId),
          state: 'active',
          leaseToken: normalized.leaseToken,
          flow: { $exists: false }
        },
        {
          $set: {
            state: normalized.children.length === 0 ? 'waiting' : 'waiting-children',
            flow,
            flowManifestDigest: digest,
            flowLeaseToken: normalized.leaseToken,
            flowName: normalized.flowName,
            flowParentStoreKey: normalized.parentStoreKey,
            flowDepth: normalized.depth,
            updatedAtMs: normalized.now,
            processedAtMs: normalized.now
          },
          $unset: {
            leaseOwner: '',
            leaseToken: '',
            leaseExpiresAtMs: '',
            cancelRequested: '',
            cancellationRequestedAtMs: ''
          }
        },
        { session }
      )
      if (updated.matchedCount !== 1)
        throw new JobStoreFailure({
          operation: 'flow.fanOut',
          retryable: true,
          message: 'MongoDB flow parent lease changed during fan-out'
        })
      const snapshot = await readSnapshot(
        this.collections,
        this.client.namespace,
        normalized.flowId,
        session
      )
      return { status: 'applied', parent: snapshot.parent, children: snapshot.children }
    })
  }

  async recordChildResults(
    request: RecordChildResultsRequest
  ): Promise<FlowResult<RecordChildResultsResult>> {
    const flowId = makeJobId(request.flowId)
    if (Result.isError(flowId)) return fail('recordChildResults', flowId.error)
    if (this.disposed) return fail('recordChildResults', new Error('store is disposed'))
    if (!Array.isArray(request.reports) || request.reports.length > hardFlowMaxChildren)
      return invalid('reports', 'must be an array within the hard child limit')
    if (!validTimestamp(request.now)) return invalid('now', 'must be a non-negative safe integer')
    const reports: FlowChildReport[] = []
    const seen = new Map<string, string>()
    for (const report of request.reports) {
      const checked = validateFlowChildReport(report)
      if (Result.isError(checked)) return fail('recordChildResults', checked.error)
      if (checked.value.flowId !== flowId.value)
        return fail(
          'recordChildResults',
          new JobStoreFailure({
            operation: 'flow.recordChildResults',
            retryable: false,
            message: 'report flowId mismatch'
          })
        )
      const digest = canonicalJson(checked.value)
      const previous = seen.get(checked.value.childKey)
      if (previous !== undefined && previous !== digest)
        return fail(
          'recordChildResults',
          new JobStoreFailure({
            operation: 'flow.recordChildResults',
            retryable: false,
            message: 'conflicting duplicate child report'
          })
        )
      if (previous === undefined) {
        seen.set(checked.value.childKey, digest)
        reports.push(checked.value)
      }
    }
    return transaction(this.client, 'recordChildResults', async (session) => {
      const children = await readChildren(
        this.collections,
        this.client.namespace,
        flowId.value,
        session
      )
      if (children.size === 0) throw new JobNotFoundError({ jobId: flowId.value })
      for (const report of reports)
        if (!children.has(report.childKey))
          throw new JobStoreFailure({
            operation: 'flow.recordChildResults',
            retryable: false,
            message: 'unknown child key'
          })
      const parentDocument = await this.collections.jobs.findOne(
        { _id: namespaceId(this.client.namespace, flowId.value) },
        { session }
      )
      if (parentDocument === null) throw new JobNotFoundError({ jobId: flowId.value })
      const currentParent = decodeParent(parentDocument)
      let flow = currentParent.flow
      let applied = 0
      let firstFailure: FlowChildReport | undefined
      for (const report of reports) {
        const child = children.get(report.childKey)!
        if (child.record.status !== 'pending') continue
        const changed = await this.collections.flowChildren.updateOne(
          {
            _id: namespaceId(this.client.namespace, flowId.value, report.childKey),
            status: 'pending'
          },
          (() => {
            const $set: FlowChildUpdate['$set'] = { status: report.outcome }
            const $unset: NonNullable<FlowChildUpdate['$unset']> = {}
            if (report.result === undefined) $unset.result = ''
            else $set.result = report.result
            if (report.failure === undefined) $unset.failure = ''
            else $set.failure = report.failure
            const update: FlowChildUpdate = { $set }
            if (Object.keys($unset).length > 0) update.$unset = $unset
            return update
          })(),
          { session }
        )
        if (changed.matchedCount !== 1)
          throw new JobStoreFailure({
            operation: 'flow.recordChildResults',
            retryable: true,
            message: 'MongoDB flow child changed during report'
          })
        applied += 1
        if (firstFailure === undefined && report.outcome === 'failed') firstFailure = report
        flow = Object.freeze({
          ...flow,
          pending: flow.pending - 1,
          completed: flow.completed + (report.outcome === 'completed' ? 1 : 0),
          failed: flow.failed + (report.outcome === 'failed' ? 1 : 0),
          cancelled: flow.cancelled + (report.outcome === 'cancelled' ? 1 : 0)
        })
      }
      let state = currentParent.state
      let failure = currentParent.failure
      let parentSettled = false
      if (state === 'waiting-children' && flow.failFast && firstFailure !== undefined) {
        const reported = new Set(reports.map((report) => report.childKey))
        const remaining = [...children.values()].filter(
          (child) => child.record.status === 'pending' && !reported.has(child.record.childKey)
        )
        for (const child of remaining) {
          const changed = await this.collections.flowChildren.updateOne(
            {
              _id: namespaceId(this.client.namespace, flowId.value, child.record.childKey),
              childKey: child.record.childKey,
              status: 'pending'
            },
            { $set: { status: 'cancelled', cascaded: false }, $unset: { result: '', failure: '' } },
            { session }
          )
          if (changed.matchedCount !== 1)
            throw new JobStoreFailure({
              operation: 'flow.recordChildResults',
              retryable: true,
              message: 'MongoDB flow cascade changed during fail-fast settlement'
            })
        }
        flow = Object.freeze({ ...flow, pending: 0, cancelled: flow.cancelled + remaining.length })
        state = 'failed'
        failure = firstFailure.failure
        parentSettled = true
      } else if (state === 'waiting-children' && flow.pending === 0) {
        state = 'waiting'
        parentSettled = true
      }
      const parentUpdate: FlowParentUpdate = { $set: { state, flow, updatedAtMs: request.now } }
      if (failure === undefined) parentUpdate.$unset = { failure: '' }
      else parentUpdate.$set.failure = failure
      if (state === 'failed') parentUpdate.$set.finishedAtMs = request.now
      const parentChanged = await this.collections.jobs.updateOne(
        { _id: namespaceId(this.client.namespace, flowId.value) },
        parentUpdate,
        { session }
      )
      if (parentChanged.matchedCount !== 1)
        throw new JobStoreFailure({
          operation: 'flow.recordChildResults',
          retryable: true,
          message: 'MongoDB flow parent changed during report'
        })
      const snapshot = await readSnapshot(
        this.collections,
        this.client.namespace,
        flowId.value,
        session
      )
      return { applied, parentSettled, parent: snapshot.parent, children: snapshot.children }
    })
  }

  async cancel(request: CancelFlowRequest): Promise<FlowResult<CancelFlowResult>> {
    const flowId = makeJobId(request.flowId)
    if (Result.isError(flowId)) return fail('cancel', flowId.error)
    if (this.disposed) return fail('cancel', new Error('store is disposed'))
    if (!validTimestamp(request.now)) return invalid('now', 'must be a non-negative safe integer')
    return transaction(this.client, 'cancel', async (session) => {
      const children = await readChildren(
        this.collections,
        this.client.namespace,
        flowId.value,
        session
      )
      const parent = await this.collections.jobs.findOne(
        { _id: namespaceId(this.client.namespace, flowId.value) },
        { session }
      )
      if (parent === null) throw new JobNotFoundError({ jobId: flowId.value })
      const checkedFlow = validateFlowState(parent.flow)
      if (Result.isError(checkedFlow)) throw checkedFlow.error
      if (parent.state !== 'waiting-children') {
        const snapshot = await readSnapshot(
          this.collections,
          this.client.namespace,
          flowId.value,
          session
        )
        return {
          cancelled: 0,
          parentSettled: false,
          parent: snapshot.parent,
          children: snapshot.children
        }
      }
      const pending = [...children.values()].filter(({ record }) => record.status === 'pending')
      for (const child of pending) {
        const changed = await this.collections.flowChildren.updateOne(
          {
            _id: namespaceId(this.client.namespace, flowId.value, child.record.childKey),
            childKey: child.record.childKey,
            status: 'pending'
          },
          { $set: { status: 'cancelled', cascaded: false }, $unset: { result: '', failure: '' } },
          { session }
        )
        if (changed.matchedCount !== 1)
          throw new JobStoreFailure({
            operation: 'flow.cancel',
            retryable: true,
            message: 'MongoDB flow child changed during cancellation'
          })
      }
      const flow = Object.freeze({
        ...checkedFlow.value,
        pending: 0,
        cancelled: checkedFlow.value.cancelled + pending.length
      })
      const changed = await this.collections.jobs.updateOne(
        { _id: namespaceId(this.client.namespace, flowId.value), state: 'waiting-children' },
        { $set: { state: 'cancelled', flow, finishedAtMs: request.now, updatedAtMs: request.now } },
        { session }
      )
      if (changed.matchedCount !== 1)
        throw new JobStoreFailure({
          operation: 'flow.cancel',
          retryable: true,
          message: 'MongoDB flow parent changed during cancellation'
        })
      const snapshot = await readSnapshot(
        this.collections,
        this.client.namespace,
        flowId.value,
        session
      )
      return {
        cancelled: pending.length,
        parentSettled: true,
        parent: snapshot.parent,
        children: snapshot.children
      }
    })
  }

  async reconcile(request: ReconcileFlowRequest): Promise<FlowResult<ReconcileFlowResult>> {
    const flowId = makeJobId(request.flowId)
    if (Result.isError(flowId)) return fail('reconcile', flowId.error)
    if (this.disposed) return fail('reconcile', new Error('store is disposed'))
    if (!Array.isArray(request.observations) || request.observations.length > hardFlowMaxChildren)
      return invalid('observations', 'must be an array within the hard child limit')
    if (!validTimestamp(request.now)) return invalid('now', 'must be a non-negative safe integer')
    if (
      request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > hardFlowMaxChildren)
    )
      return invalid('limit', 'must be a positive safe integer within the hard limit')
    const observations = request.observations.slice(0, request.limit ?? request.observations.length)
    return transaction(this.client, 'reconcile', async (session) => {
      const children = await readChildren(
        this.collections,
        this.client.namespace,
        flowId.value,
        session
      )
      if (children.size === 0) throw new JobNotFoundError({ jobId: flowId.value })
      const seen = new Set<string>()
      for (const [index, observation] of observations.entries()) {
        const candidate = observation as FlowChildObservation
        if (
          typeof candidate.childKey !== 'string' ||
          candidate.childKey.length === 0 ||
          candidate.childKey.length > 256
        )
          throw new JobDefinitionError({
            field: `observations[${index}].childKey`,
            message: 'must be bounded text'
          })
        if (seen.has(candidate.childKey))
          throw new JobDefinitionError({ field: 'observations', message: 'duplicate childKey' })
        seen.add(candidate.childKey)
        if (
          ![
            'missing',
            'waiting',
            'delayed',
            'active',
            'waiting-children',
            'completed',
            'failed',
            'cancelled'
          ].includes(candidate.state)
        )
          throw new JobDefinitionError({
            field: `observations[${index}].state`,
            message: 'invalid child state'
          })
        if (!children.has(candidate.childKey))
          throw new JobStoreFailure({
            operation: 'flow.reconcile',
            retryable: false,
            message: 'unknown child key'
          })
      }
      const enqueue: FlowChildSpec[] = []
      const reports: FlowChildReport[] = []
      const cascade: FlowChildSpec[] = []
      const cascadeLimit = request.limit ?? hardFlowMaxChildren
      for (const observation of observations) {
        const candidate = observation as FlowChildObservation
        const child = children.get(candidate.childKey)!
        if (child.record.status === 'pending') {
          const changed = await this.collections.flowChildren.updateOne(
            {
              _id: namespaceId(this.client.namespace, flowId.value, candidate.childKey),
              status: 'pending'
            },
            { $set: { pendingSinceMs: request.now } },
            { session }
          )
          if (changed.matchedCount !== 1)
            throw new JobStoreFailure({
              operation: 'flow.reconcile',
              retryable: true,
              message: 'MongoDB flow child changed during reconciliation'
            })
          if (candidate.state === 'missing') enqueue.push(child.spec)
          if (
            candidate.state === 'completed' ||
            candidate.state === 'failed' ||
            candidate.state === 'cancelled'
          ) {
            const checked = validateFlowChildReport({
              flowId: flowId.value,
              childKey: candidate.childKey,
              outcome: candidate.state,
              result: candidate.result,
              failure: candidate.failure
            })
            if (Result.isError(checked)) throw checked.error
            reports.push(checked.value)
          }
        }
        if (
          child.record.status === 'cancelled' &&
          !child.record.cascaded &&
          cascade.length < cascadeLimit
        )
          cascade.push(child.spec)
      }
      for (const child of children.values())
        if (
          child.record.status === 'cancelled' &&
          !child.record.cascaded &&
          !cascade.some((spec) => spec.childKey === child.record.childKey) &&
          cascade.length < cascadeLimit
        )
          cascade.push(child.spec)
      return {
        enqueue: Object.freeze(enqueue),
        reports: Object.freeze(reports),
        cascade: Object.freeze(cascade)
      }
    })
  }

  async markCascaded(request: MarkCascadedRequest): Promise<FlowResult<MarkCascadedResult>> {
    const flowId = makeJobId(request.flowId)
    if (Result.isError(flowId)) return fail('markCascaded', flowId.error)
    if (this.disposed) return fail('markCascaded', new Error('store is disposed'))
    if (!Array.isArray(request.childKeys) || request.childKeys.length > hardFlowMaxChildren)
      return invalid('childKeys', 'must be an array within the hard child limit')
    const requested = new Set<string>()
    for (const [index, childKey] of request.childKeys.entries()) {
      if (typeof childKey !== 'string' || childKey.length === 0 || childKey.length > 256)
        return invalid(`childKeys[${index}]`, 'must be bounded text')
      if (requested.has(childKey)) return invalid('childKeys', 'duplicate childKey')
      requested.add(childKey)
    }
    return transaction(this.client, 'markCascaded', async (session) => {
      const children = await readChildren(
        this.collections,
        this.client.namespace,
        flowId.value,
        session
      )
      if (children.size === 0) throw new JobNotFoundError({ jobId: flowId.value })
      let marked = 0
      for (const child of children.values()) {
        if (
          !requested.has(child.record.childKey) ||
          child.record.status !== 'cancelled' ||
          child.record.cascaded
        )
          continue
        const changed = await this.collections.flowChildren.updateOne(
          {
            _id: namespaceId(this.client.namespace, flowId.value, child.record.childKey),
            status: 'cancelled',
            cascaded: false
          },
          { $set: { cascaded: true } },
          { session }
        )
        if (changed.matchedCount === 1) marked += 1
      }
      const snapshot = await readSnapshot(
        this.collections,
        this.client.namespace,
        flowId.value,
        session
      )
      return { marked, children: snapshot.children }
    })
  }

  async appendChildReport(
    request: AppendChildReportRequest
  ): Promise<FlowResult<AppendChildReportResult>> {
    const checked = validateFlowOutboxEntry(request)
    if (Result.isError(checked)) return fail('appendChildReport', checked.error)
    if (this.disposed) return fail('appendChildReport', new Error('store is disposed'))
    const entry = checked.value
    return transaction(this.client, 'appendChildReport', async (session) => {
      const existing = await this.collections.flowOutbox.findOne(
        { _id: namespaceId(this.client.namespace, entry.id) },
        { session }
      )
      if (existing !== null) {
        const stored = decodeOutbox(existing)
        if (canonicalJson(stored) !== canonicalJson(entry))
          throw new SettlementConflictError({
            jobId: entry.report.flowId,
            leaseToken: makeLeaseToken('outbox-conflict').unwrap()
          })
        return { status: 'already-applied', entry: stored }
      }
      const sequenceReply = await this.collections.counters.findOneAndUpdate(
        {
          _id: namespaceId(this.client.namespace, 'flow-outbox-sequence'),
          $or: [{ value: { $lt: Number.MAX_SAFE_INTEGER } }, { value: { $exists: false } }]
        },
        {
          $setOnInsert: { namespace: this.client.namespace, name: 'flow-outbox-sequence' },
          $inc: { value: 1 }
        },
        { upsert: true, returnDocument: 'after', session }
      )
      const sequence = number(findOneResult(sequenceReply)?.value, 'flow outbox sequence', 1)
      const document: FlowOutboxDocument = {
        _id: namespaceId(this.client.namespace, entry.id),
        namespace: this.client.namespace,
        id: entry.id,
        flowName: entry.flowName,
        parentStoreKey: entry.parentStoreKey,
        report: entry.report,
        sequence,
        createdAtMs: 0
      }
      const inserted = await this.collections.flowOutbox.findOneAndUpdate(
        { _id: document._id },
        { $setOnInsert: document },
        { upsert: true, returnDocument: 'after', session }
      )
      const storedDocument = findOneResult(inserted)
      if (storedDocument === undefined) throw new Error('flow outbox row was not stored')
      const stored = decodeOutbox(storedDocument)
      if (canonicalJson(stored) !== canonicalJson(entry))
        throw new SettlementConflictError({
          jobId: entry.report.flowId,
          leaseToken: makeLeaseToken('outbox-conflict').unwrap()
        })
      return { status: 'applied', entry: stored }
    })
  }

  async peekOutbox(request: PeekOutboxRequest): Promise<FlowResult<FlowOutboxPage>> {
    const limit = request.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > hardFlowMaxChildren)
      return invalid('limit', 'must be a positive safe integer within the hard limit')
    if (
      request.cursor !== undefined &&
      (typeof request.cursor !== 'string' ||
        request.cursor.length === 0 ||
        request.cursor.length > maxFlowChildIdLength)
    )
      return invalid('cursor', 'must be a bounded non-empty string')
    if (
      request.parentStoreKey !== undefined &&
      (typeof request.parentStoreKey !== 'string' ||
        request.parentStoreKey.length === 0 ||
        request.parentStoreKey.length > maxFlowStoreKeyLength)
    )
      return invalid('parentStoreKey', 'must be a bounded non-empty string')
    try {
      const collections = this.collections
      const cursorDocument =
        request.cursor === undefined
          ? undefined
          : findOneResult(
              await collections.flowOutbox.findOne({
                _id: namespaceId(this.client.namespace, request.cursor)
              })
            )
      const cursor =
        cursorDocument === undefined ? 0 : number(cursorDocument.sequence, 'outbox cursor', 1)
      const filter: FlowOutboxFilter = { namespace: this.client.namespace }
      if (request.parentStoreKey !== undefined) filter.parentStoreKey = request.parentStoreKey
      if (cursor > 0) filter.sequence = { $gt: cursor }
      const rows = await collections.flowOutbox
        .find(filter, { sort: { sequence: 1, id: 1 }, limit: limit + 1 })
        .toArray()
      const all = rows.map(decodeOutbox)
      const hasMore = all.length > limit
      const entries = Object.freeze(all.slice(0, limit))
      return ok({
        entries,
        cursor: hasMore && entries.length > 0 ? entries.at(-1)!.id : undefined,
        hasMore
      })
    } catch (cause) {
      return fail('peekOutbox', cause)
    }
  }

  async ackOutbox(request: AckOutboxRequest): Promise<FlowResult<AckOutboxResult>> {
    if (!Array.isArray(request.entries) || request.entries.length > hardFlowMaxChildren)
      return invalid('entries', 'must be an array within the hard child limit')
    const entries: FlowOutboxEntry[] = []
    const seen = new Map<string, string>()
    for (const [index, value] of request.entries.entries()) {
      const checked = validateFlowOutboxEntry(value)
      if (Result.isError(checked)) return invalid(`entries[${index}]`, checked.error.message)
      const digest = canonicalJson(checked.value)
      const previous = seen.get(checked.value.id)
      if (previous !== undefined && previous !== digest)
        return invalid('entries', 'contains conflicting duplicate outbox entries')
      if (previous === undefined) {
        seen.set(checked.value.id, digest)
        entries.push(checked.value)
      }
    }
    return transaction(this.client, 'ackOutbox', async (session) => {
      let acknowledged = 0
      let skipped = 0
      for (const entry of entries) {
        const document = await this.collections.flowOutbox.findOne(
          { _id: namespaceId(this.client.namespace, entry.id) },
          { session }
        )
        if (document === null) {
          skipped += 1
          continue
        }
        const stored = decodeOutbox(document)
        if (canonicalJson(stored) !== canonicalJson(entry)) {
          skipped += 1
          continue
        }
        const removed = await this.collections.flowOutbox.deleteOne(
          { _id: namespaceId(this.client.namespace, entry.id) },
          { session }
        )
        if (removed.deletedCount === 1) acknowledged += 1
        else skipped += 1
      }
      return { acknowledged, skipped }
    })
  }

  async getFlow(request: GetFlowRequest): Promise<FlowResult<FlowSnapshot | undefined>> {
    const flowId = makeJobId(request.flowId)
    if (Result.isError(flowId)) return fail('getFlow', flowId.error)
    if (this.disposed) return fail('getFlow', new Error('store is disposed'))
    try {
      const parent = await this.collections.jobs.findOne({
        _id: namespaceId(this.client.namespace, flowId.value)
      })
      if (parent === null || parent.flow === undefined || parent.flow === null) return ok(undefined)
      return ok(await readSnapshot(this.collections, this.client.namespace, flowId.value))
    } catch (cause) {
      return fail('getFlow', cause)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = this.client.dispose()
    return this.disposal
  }
}

export type MongoFlowStoreInstance = FlowStoreV2 & {
  readonly descriptor: FlowStoreV2Descriptor
  dispose(): Promise<void>
}

const verifyTopology = async (client: MongoJobStoreClient): Promise<void> => {
  const hello = await client.db.admin().command({ hello: 1 })
  if (
    typeof hello.logicalSessionTimeoutMinutes !== 'number' ||
    (typeof hello.setName !== 'string' && hello.msg !== 'isdbgrid')
  )
    throw new MongoJobStoreTopologyError(
      'standalone',
      'MongoDB FlowStore requires a replica set or a transaction-capable mongos deployment'
    )
}

const open = async (
  client: MongoJobStoreClient,
  ownsClient: boolean
): Promise<MongoFlowStoreInstance> => {
  try {
    await verifyTopology(client)
    if (client.validateLayout) {
      await MongoFlowMigrator.validate(client.db, client.collectionPrefix)
    }
    return new MongoFlowStoreImplementation(client)
  } catch (cause) {
    if (ownsClient) await client.dispose().catch(() => undefined)
    throw cause
  }
}

const namespaceFor = (token: AnyJobStoreToken, namespace: string): string =>
  token.serviceTag === JobStore.serviceTag ? namespace : `${namespace}:store-${token.serviceTag}`

const provideFlowService = <Token extends AnyFlowStoreToken>(
  store: MongoFlowStoreInstance
): ServiceContract<InstanceType<Token>> => {
  const provided = FlowStore.of(store as never)
  const erased: unknown = provided
  return erased as ServiceContract<InstanceType<Token>>
}

const disposeFlowService = async (value: unknown): Promise<void> => {
  const store = value as MongoFlowStoreInstance
  await store.dispose()
}

const makeLayer = <Token extends AnyFlowStoreToken>(
  token: Token,
  acquire: () => Promise<MongoJobStoreClient>
): Layer<InstanceType<Token>, never> =>
  Layer.scoped(
    token,
    async () => {
      const client = await acquire()
      const store = await open(client, client.ownsClient)
      return provideFlowService<Token>(store)
    },
    disposeFlowService
  ) as Layer<InstanceType<Token>, never>

export const MongoFlowStore = Object.freeze({
  migrate(options: MongoMigrationOptions) {
    return MongoFlowMigrator.migrate(options)
  },
  async make(config: MongoJobStoreConfig): Promise<MongoFlowStoreInstance> {
    return open(MongoJobStoreClient.fromDb(config), false)
  },
  async makeFromConfig(config: MongoJobStoreConnectionConfig): Promise<MongoFlowStoreInstance> {
    const client = await MongoJobStoreClient.fromConfig(config)
    return open(client, true)
  },
  layer(config: MongoJobStoreConfig) {
    return makeLayer(FlowStore, () => Promise.resolve(MongoJobStoreClient.fromDb(config)))
  },
  layerFor<T extends AnyJobStoreToken>(token: T, config: MongoJobStoreConfig) {
    return makeLayer(FlowStore.for(token), () =>
      Promise.resolve(
        MongoJobStoreClient.fromDb({
          ...config,
          namespace: namespaceFor(token, config.namespace ?? 'default')
        })
      )
    )
  },
  layerFromConfig(config: MongoJobStoreConnectionConfig) {
    return makeLayer(FlowStore, () => MongoJobStoreClient.fromConfig(config))
  },
  layerFromConfigFor<T extends AnyJobStoreToken>(token: T, config: MongoJobStoreConnectionConfig) {
    return makeLayer(FlowStore.for(token), () =>
      MongoJobStoreClient.fromConfig({
        ...config,
        namespace: namespaceFor(token, config.namespace ?? 'default')
      })
    )
  }
})
