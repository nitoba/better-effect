// oxlint-disable anti-slop/no-runtime-typeof -- MemoryFlowStore validates untrusted protocol DTOs.
// oxlint-disable anti-slop/no-unknown-parameters -- public flow requests cross a persistence boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- canonical snapshots are populated after validation.
// oxlint-disable anti-slop/no-chained-type-assertions -- validated protocol snapshots are narrowed at the store boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Result and JSON values are narrowed at validated boundaries.

import { Result, type Result as ResultType } from 'better-result'

import { parseJsonValue, readObjectFields } from '../internal/json'
import {
  validatePositiveIntegerValue,
  validateTimestampValue,
  validateTextValue
} from '../internal/validation'
import {
  defaultFlowLimits,
  flowLayoutVersion,
  hardFlowMaxChildren,
  makeFlowChildId,
  makeFlowMigration,
  maxFlowChildKeyLength,
  protocolVersionV2,
  validateFanOutOutcome,
  validateFlowChildRecord,
  validateFlowChildReport,
  validateFlowOutboxEntry,
  validateFlowLimits,
  validateParentEnvelope,
  validateSerializedJobFailure
} from '../protocol'
import {
  JobDefinitionError,
  JobNotFoundError,
  makeJobId,
  makeLeaseToken,
  SettlementConflictError
} from '../protocol'
import type {
  FlowChildRecord,
  FlowChildReport,
  FlowChildSpec,
  FlowOutboxEntry,
  ParentEnvelope,
  JsonValue,
  SerializedJobFailure
} from '../protocol'
import type { JobId } from '../protocol'
import type {
  CancelFlowRequest,
  CancelFlowResult,
  AckOutboxRequest,
  AckOutboxResult,
  AppendChildReportRequest,
  AppendChildReportResult,
  FlowChildObservation,
  FlowChildObservationState,
  FlowFanOutRequest,
  FlowFanOutResult,
  FlowParentRecord,
  FlowOutboxPage,
  FlowSnapshot,
  FlowStoreV2,
  FlowStoreV2Descriptor,
  FlowStoreV2Error,
  FlowStoreV2Operation,
  GetFlowRequest,
  MarkCascadedRequest,
  MarkCascadedResult,
  PeekOutboxRequest,
  ReconcileFlowRequest,
  ReconcileFlowResult,
  RecordChildResultsRequest,
  RecordChildResultsResult
} from './flow-v2'

type StoredFlow = {
  readonly parent: FlowParentRecord
  readonly specs: Map<string, FlowChildSpec>
  readonly children: Map<string, FlowChildRecord>
  readonly fanOutDigest: string
}

type NormalizedFanOutRequest = FlowFanOutRequest & {
  readonly children: readonly FlowChildSpec[]
}

type NormalizedReportsRequest = {
  readonly flowId: JobId
  readonly reports: readonly FlowChildReport[]
  readonly now: number
}

type MutableFlowChildObservation = {
  childKey: string
  state: FlowChildObservationState
  result?: JsonValue
  failure?: SerializedJobFailure
}

const fanOutFields = [
  'flowId',
  'flowName',
  'parentStoreKey',
  'depth',
  'leaseToken',
  'failFast',
  'children',
  'now',
  'maxChildren'
] as const
const reportRequestFields = ['flowId', 'reports', 'now'] as const
const cancelFields = ['flowId', 'now'] as const
const reconcileFields = ['flowId', 'observations', 'now', 'limit'] as const
const observationFields = ['childKey', 'state', 'result', 'failure'] as const
const cascadeFields = ['flowId', 'childKeys'] as const
const getFlowFields = ['flowId'] as const
const outboxPeekFields = ['cursor', 'limit', 'parentStoreKey'] as const
const outboxAckFields = ['entries'] as const

const ok = <Value>(value: Value): FlowStoreV2Operation<Value> =>
  Result.ok(value) as FlowStoreV2Operation<Value>

const fail = <Value>(error: FlowStoreV2Error): FlowStoreV2Operation<Value> =>
  Result.err(error) as FlowStoreV2Operation<Value>

const invalid = <Value>(field: string, message: string): ResultType<Value, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

const fieldRequired = (
  fields: Readonly<Record<string, unknown>>,
  field: string
): ResultType<unknown, JobDefinitionError> =>
  Object.prototype.hasOwnProperty.call(fields, field)
    ? Result.ok(fields[field])
    : invalid(field, 'is required')

const validateChildKey = (
  value: unknown,
  field: string
): ResultType<string, JobDefinitionError> => {
  const key = validateTextValue(value, field)
  if (Result.isError(key)) return key
  return key.value.length <= maxFlowChildKeyLength
    ? key
    : invalid(field, `must not exceed ${maxFlowChildKeyLength} characters`)
}

const canonicalJson = (value: unknown): string => {
  const seen = new Set<object>()

  const visit = (current: unknown): string => {
    if (current === null || typeof current !== 'object') {
      if (current === undefined) return 'undefined'
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
        .map((key) => `${JSON.stringify(key)}:${visit((current as Record<string, unknown>)[key])}`)
        .join(',')}}`
    } finally {
      seen.delete(current)
    }
  }

  return visit(value)
}

const flowDigest = (request: NormalizedFanOutRequest): string =>
  canonicalJson({
    children: [...request.children].sort((left, right) =>
      left.childKey < right.childKey ? -1 : left.childKey > right.childKey ? 1 : 0
    ),
    depth: request.depth,
    failFast: request.failFast,
    flowId: request.flowId,
    flowName: request.flowName,
    leaseToken: request.leaseToken,
    parentStoreKey: request.parentStoreKey
  })

const cloneParent = (parent: FlowParentRecord): FlowParentRecord =>
  Object.freeze({ ...parent, flow: Object.freeze({ ...parent.flow }) })

const cloneChild = (child: FlowChildRecord): FlowChildRecord => {
  const checked = validateFlowChildRecord(child)
  return checked.isOk() ? checked.value : child
}

const cloneReport = (report: FlowChildReport): FlowChildReport => {
  const checked = validateFlowChildReport(report)
  return checked.isOk() ? checked.value : report
}

const cloneOutboxEntry = (entry: FlowOutboxEntry): FlowOutboxEntry => {
  const checked = validateFlowOutboxEntry(entry)
  return checked.isOk() ? checked.value : entry
}

const childSnapshots = (flow: StoredFlow): readonly FlowChildRecord[] =>
  Object.freeze([...flow.children.values()].map(cloneChild))

const snapshot = (flow: StoredFlow, outbox: readonly FlowOutboxEntry[]): FlowSnapshot =>
  Object.freeze({
    parent: cloneParent(flow.parent),
    children: childSnapshots(flow),
    outbox: Object.freeze(outbox.map(cloneOutboxEntry))
  })

const parentEnvelopeForRequest = (
  request: Readonly<Record<string, unknown>>
): ResultType<ParentEnvelope, JobDefinitionError> =>
  validateParentEnvelope({
    flowName: request.flowName,
    flowId: request.flowId,
    childKey: 'flow-root',
    parentStoreKey: request.parentStoreKey,
    depth: request.depth
  })

const normalizeFanOutRequest = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- request is the public persistence boundary.
  request: unknown
): ResultType<NormalizedFanOutRequest, FlowStoreV2Error> => {
  const fields = readObjectFields(request, fanOutFields, 'request')
  if (Result.isError(fields)) return fields
  for (const field of [
    'flowId',
    'flowName',
    'parentStoreKey',
    'depth',
    'leaseToken',
    'failFast',
    'children',
    'now'
  ] as const) {
    const present = fieldRequired(fields.value, field)
    if (Result.isError(present)) return present
  }

  const parent = parentEnvelopeForRequest(fields.value)
  const leaseToken = makeLeaseToken(fields.value.leaseToken)
  const now = validateTimestampValue(fields.value.now, 'now')
  const maxChildren =
    fields.value.maxChildren === undefined
      ? Result.ok(defaultFlowLimits.maxChildren)
      : validatePositiveIntegerValue(fields.value.maxChildren, 'maxChildren')
  if (Result.isError(parent)) return parent
  if (Result.isError(leaseToken)) return leaseToken
  if (Result.isError(now)) return now
  if (Result.isError(maxChildren)) return maxChildren

  const limits = validateFlowLimits({
    maxChildren: maxChildren.value,
    maxDepth: defaultFlowLimits.maxDepth
  })
  if (Result.isError(limits)) return limits
  const outcome = validateFanOutOutcome(
    { type: 'FanOut', failFast: fields.value.failFast, children: fields.value.children },
    limits.value
  )
  if (Result.isError(outcome)) return outcome

  for (const child of outcome.value.children) {
    const expectedId = makeFlowChildId({
      parentStoreKey: parent.value.parentStoreKey,
      flowId: parent.value.flowId,
      childKey: child.childKey
    })
    if (Result.isError(expectedId)) return expectedId
    if (child.childJobId !== expectedId.value) {
      return invalid('children', `childJobId for "${child.childKey}" is not deterministic`)
    }
  }

  if (fields.value.failFast !== true && fields.value.failFast !== false) {
    return invalid('failFast', 'must be a boolean')
  }

  return Result.ok({
    flowId: parent.value.flowId,
    flowName: parent.value.flowName,
    parentStoreKey: parent.value.parentStoreKey,
    depth: parent.value.depth,
    leaseToken: leaseToken.value,
    failFast: fields.value.failFast,
    children: outcome.value.children,
    now: now.value,
    maxChildren: limits.value.maxChildren
  })
}

const normalizeReportsRequest = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- request is the public persistence boundary.
  request: unknown
): ResultType<NormalizedReportsRequest, FlowStoreV2Error> => {
  const fields = readObjectFields(request, reportRequestFields, 'request')
  if (Result.isError(fields)) return fields
  for (const field of reportRequestFields) {
    const present = fieldRequired(fields.value, field)
    if (Result.isError(present)) return present
  }
  const flowId = makeJobId(fields.value.flowId)
  const now = validateTimestampValue(fields.value.now, 'now')
  if (Result.isError(flowId)) return flowId
  if (Result.isError(now)) return now
  if (!Array.isArray(fields.value.reports)) return invalid('reports', 'must be a finite array')
  if (fields.value.reports.length > hardFlowMaxChildren) {
    return invalid('reports', `must not exceed hard limit ${hardFlowMaxChildren}`)
  }

  const reports: FlowChildReport[] = []
  for (const [index, value] of fields.value.reports.entries()) {
    const report = validateFlowChildReport(value)
    if (Result.isError(report)) return invalid(`reports[${index}]`, report.error.message)
    if (report.value.flowId !== flowId.value) {
      return invalid(`reports[${index}].flowId`, 'must match request.flowId')
    }
    reports.push(report.value)
  }
  return Result.ok({ flowId: flowId.value, reports: Object.freeze(reports), now: now.value })
}

const normalizeFlowIdRequest = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- request is the public persistence boundary.
  request: unknown,
  fields: readonly string[],
  fieldName: string
): ResultType<JobId, FlowStoreV2Error> => {
  const value = readObjectFields(request, fields, fieldName)
  if (Result.isError(value)) return value
  const present = fieldRequired(value.value, 'flowId')
  if (Result.isError(present)) return present
  const flowId = makeJobId(value.value.flowId)
  return Result.isError(flowId) ? flowId : flowId
}

const isObservationState = (value: unknown): value is FlowChildObservationState =>
  value === 'missing' ||
  value === 'waiting' ||
  value === 'delayed' ||
  value === 'active' ||
  value === 'waiting-children' ||
  value === 'completed' ||
  value === 'failed' ||
  value === 'cancelled'

const validateObservation = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- observation is a persistence boundary.
  value: unknown,
  field: string
): ResultType<FlowChildObservation, JobDefinitionError> => {
  const fields = readObjectFields(value, observationFields, field)
  if (Result.isError(fields)) return fields
  for (const name of ['childKey', 'state'] as const) {
    const present = fieldRequired(fields.value, name)
    if (Result.isError(present)) return present
  }
  const childKey = validateChildKey(fields.value.childKey, `${field}.childKey`)
  if (Result.isError(childKey)) return childKey
  if (!isObservationState(fields.value.state))
    return invalid(`${field}.state`, 'unsupported child state')
  const result =
    fields.value.result === undefined
      ? Result.ok<JsonValue | undefined>(undefined)
      : parseJsonValue(fields.value.result, `${field}.result`)
  const failure =
    fields.value.failure === undefined
      ? Result.ok<SerializedJobFailure | undefined>(undefined)
      : validateFlowFailure(fields.value.failure)
  if (Result.isError(result)) return result
  if (Result.isError(failure)) return failure
  const observation: MutableFlowChildObservation = {
    childKey: childKey.value,
    state: fields.value.state
  }
  if (result.value !== undefined) observation.result = result.value
  if (failure.value !== undefined) observation.failure = failure.value
  return Result.ok(observation)
}

const validateFlowFailure = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- failure is a persistence boundary.
  value: unknown
): ResultType<SerializedJobFailure, JobDefinitionError> => {
  const fields = readObjectFields(
    value,
    ['kind', 'code', 'message', 'data', 'retryable', 'recordedAt'],
    'failure'
  )
  if (Result.isError(fields)) return fields
  return validateSerializedJobFailure(fields.value)
}

const flowStoreDescriptor: FlowStoreV2Descriptor = Object.freeze({
  protocolVersion: protocolVersionV2,
  layoutVersion: flowLayoutVersion,
  migration: makeFlowMigration({ status: 'not-required', from: undefined, to: flowLayoutVersion })
})

class MemoryFlowStoreImplementation implements FlowStoreV2 {
  readonly descriptor = flowStoreDescriptor
  private readonly flows = new Map<string, StoredFlow>()
  private readonly outbox = new Map<string, FlowOutboxEntry>()

  fanOut(request: FlowFanOutRequest): FlowStoreV2Operation<FlowFanOutResult> {
    const normalized = normalizeFanOutRequest(request)
    if (Result.isError(normalized)) return fail(normalized.error)
    const existing = this.flows.get(normalized.value.flowId)
    const digest = flowDigest(normalized.value)
    if (existing !== undefined) {
      if (existing.fanOutDigest === digest) {
        return ok({
          status: 'already-applied',
          parent: cloneParent(existing.parent),
          children: childSnapshots(existing)
        })
      }
      return fail(
        new SettlementConflictError({
          jobId: normalized.value.flowId,
          leaseToken: normalized.value.leaseToken
        })
      )
    }

    const flow = Object.freeze({
      flowName: normalized.value.flowName,
      failFast: normalized.value.failFast,
      pending: normalized.value.children.length,
      completed: 0,
      failed: 0,
      cancelled: 0
    })
    const parent = Object.freeze({
      flowId: normalized.value.flowId,
      flowName: normalized.value.flowName,
      parentStoreKey: normalized.value.parentStoreKey,
      depth: normalized.value.depth,
      state:
        normalized.value.children.length === 0
          ? ('waiting' as const)
          : ('waiting-children' as const),
      leaseToken: normalized.value.leaseToken,
      flow,
      failure: undefined
    })
    const specs = new Map<string, FlowChildSpec>()
    const children = new Map<string, FlowChildRecord>()
    for (const spec of normalized.value.children) {
      const child = Object.freeze({
        flowId: normalized.value.flowId,
        childKey: spec.childKey,
        name: spec.name,
        version: spec.version,
        storeKey: spec.storeKey,
        childJobId: spec.childJobId,
        status: 'pending' as const,
        result: undefined,
        failure: undefined,
        cascaded: false,
        pendingSinceMs: normalized.value.now
      })
      specs.set(spec.childKey, spec)
      children.set(spec.childKey, child)
    }
    const stored: StoredFlow = {
      parent,
      specs,
      children,
      fanOutDigest: digest
    }
    this.flows.set(normalized.value.flowId, stored)
    return ok({ status: 'applied', parent: cloneParent(parent), children: childSnapshots(stored) })
  }

  recordChildResults(
    request: RecordChildResultsRequest
  ): FlowStoreV2Operation<RecordChildResultsResult> {
    const normalized = normalizeReportsRequest(request)
    if (Result.isError(normalized)) return fail(normalized.error)
    const stored = this.flows.get(normalized.value.flowId)
    if (stored === undefined) return fail(new JobNotFoundError({ jobId: normalized.value.flowId }))

    const seen = new Map<string, string>()
    const pending: { readonly child: FlowChildRecord; readonly report: FlowChildReport }[] = []
    for (const report of normalized.value.reports) {
      const child = stored.children.get(report.childKey)
      if (child === undefined)
        return fail(new JobDefinitionError({ field: 'reports', message: 'unknown childKey' }))
      const digest = canonicalJson(report)
      const previous = seen.get(report.childKey)
      if (previous !== undefined) {
        if (previous !== digest) {
          return fail(
            new JobDefinitionError({
              field: 'reports',
              message: 'conflicting duplicate child report'
            })
          )
        }
        continue
      }
      seen.set(report.childKey, digest)
      if (child.status === 'pending') pending.push({ child, report })
    }

    const nextChildren = new Map(stored.children)
    let flow = stored.parent.flow
    let firstFailure: SerializedJobFailure | undefined
    for (const entry of pending) {
      const next = Object.freeze({
        ...entry.child,
        status: entry.report.outcome,
        result: entry.report.result,
        failure: entry.report.failure
      })
      const checked = validateFlowChildRecord(next)
      if (Result.isError(checked)) return fail(checked.error)
      nextChildren.set(entry.child.childKey, checked.value)
      flow = Object.freeze({
        ...flow,
        pending: flow.pending - 1,
        completed: flow.completed + (entry.report.outcome === 'completed' ? 1 : 0),
        failed: flow.failed + (entry.report.outcome === 'failed' ? 1 : 0),
        cancelled: flow.cancelled + (entry.report.outcome === 'cancelled' ? 1 : 0)
      })
      if (firstFailure === undefined && entry.report.outcome === 'failed') {
        firstFailure = entry.report.failure
      }
    }

    let state = stored.parent.state
    let failure = stored.parent.failure
    let parentSettled = false
    if (state === 'waiting-children' && stored.parent.flow.failFast && firstFailure !== undefined) {
      for (const child of nextChildren.values()) {
        if (child.status !== 'pending') continue
        nextChildren.set(
          child.childKey,
          Object.freeze({ ...child, status: 'cancelled' as const, cascaded: false })
        )
      }
      const remaining = flow.pending
      flow = Object.freeze({ ...flow, pending: 0, cancelled: flow.cancelled + remaining })
      state = 'failed'
      failure = firstFailure
      parentSettled = true
    } else if (state === 'waiting-children' && flow.pending === 0) {
      state = 'waiting'
      parentSettled = true
    }

    const parent = Object.freeze({ ...stored.parent, state, flow, failure })
    const updated: StoredFlow = { ...stored, parent, children: nextChildren }
    this.flows.set(normalized.value.flowId, updated)
    return ok({
      applied: pending.length,
      parentSettled,
      parent: cloneParent(parent),
      children: childSnapshots(updated)
    })
  }

  cancel(request: CancelFlowRequest): FlowStoreV2Operation<CancelFlowResult> {
    const fields = readObjectFields(request, cancelFields, 'request')
    if (Result.isError(fields)) return fail(fields.error)
    const present = fieldRequired(fields.value, 'flowId')
    if (Result.isError(present)) return fail(present.error)
    const flowId = makeJobId(fields.value.flowId)
    const now = validateTimestampValue(fields.value.now, 'now')
    if (Result.isError(flowId)) return fail(flowId.error)
    if (Result.isError(now)) return fail(now.error)
    const stored = this.flows.get(flowId.value)
    if (stored === undefined) return fail(new JobNotFoundError({ jobId: flowId.value }))
    if (stored.parent.state !== 'waiting-children') {
      return ok({
        cancelled: 0,
        parentSettled: false,
        parent: cloneParent(stored.parent),
        children: childSnapshots(stored)
      })
    }

    const children = new Map(stored.children)
    let cancelled = 0
    for (const child of children.values()) {
      if (child.status !== 'pending') continue
      cancelled += 1
      children.set(
        child.childKey,
        Object.freeze({ ...child, status: 'cancelled' as const, cascaded: false })
      )
    }
    const flow = Object.freeze({
      ...stored.parent.flow,
      pending: 0,
      cancelled: stored.parent.flow.cancelled + cancelled
    })
    const parent = Object.freeze({ ...stored.parent, state: 'cancelled' as const, flow })
    const updated: StoredFlow = { ...stored, parent, children }
    this.flows.set(flowId.value, updated)
    return ok({
      cancelled,
      parentSettled: true,
      parent: cloneParent(parent),
      children: childSnapshots(updated)
    })
  }

  reconcile(request: ReconcileFlowRequest): FlowStoreV2Operation<ReconcileFlowResult> {
    const fields = readObjectFields(request, reconcileFields, 'request')
    if (Result.isError(fields)) return fail(fields.error)
    for (const field of ['flowId', 'observations', 'now'] as const) {
      const present = fieldRequired(fields.value, field)
      if (Result.isError(present)) return fail(present.error)
    }
    const flowId = makeJobId(fields.value.flowId)
    const now = validateTimestampValue(fields.value.now, 'now')
    const limit =
      fields.value.limit === undefined
        ? Result.ok<number | undefined>(undefined)
        : validatePositiveIntegerValue(fields.value.limit, 'limit')
    if (Result.isError(flowId)) return fail(flowId.error)
    if (Result.isError(now)) return fail(now.error)
    if (Result.isError(limit)) return fail(limit.error)
    if (!Array.isArray(fields.value.observations))
      return fail(
        new JobDefinitionError({ field: 'observations', message: 'must be a finite array' })
      )
    if (fields.value.observations.length > hardFlowMaxChildren)
      return fail(
        new JobDefinitionError({ field: 'observations', message: 'must not exceed hard limit' })
      )
    const count = limit.value ?? fields.value.observations.length
    if (count > hardFlowMaxChildren)
      return fail(new JobDefinitionError({ field: 'limit', message: 'must not exceed hard limit' }))

    const observations: FlowChildObservation[] = []
    const keys = new Set<string>()
    for (const [index, value] of fields.value.observations.slice(0, count).entries()) {
      const observation = validateObservation(value, `observations[${index}]`)
      if (Result.isError(observation)) return fail(observation.error)
      if (keys.has(observation.value.childKey))
        return fail(
          new JobDefinitionError({ field: 'observations', message: 'duplicate childKey' })
        )
      keys.add(observation.value.childKey)
      observations.push(observation.value)
    }
    const stored = this.flows.get(flowId.value)
    if (stored === undefined) return fail(new JobNotFoundError({ jobId: flowId.value }))

    const enqueue: FlowChildSpec[] = []
    const reports: FlowChildReport[] = []
    const cascade: FlowChildSpec[] = []
    const cascadeLimit = limit.value ?? hardFlowMaxChildren
    const children = new Map(stored.children)
    for (const observation of observations) {
      const child = children.get(observation.childKey)
      if (child === undefined)
        return fail(new JobDefinitionError({ field: 'observations', message: 'unknown childKey' }))
      if (child.status === 'pending') {
        children.set(child.childKey, Object.freeze({ ...child, pendingSinceMs: now.value }))
        if (observation.state === 'missing') {
          enqueue.push(stored.specs.get(child.childKey)!)
        } else if (
          observation.state === 'completed' ||
          observation.state === 'failed' ||
          observation.state === 'cancelled'
        ) {
          const report = validateFlowChildReport({
            flowId: flowId.value,
            childKey: child.childKey,
            outcome: observation.state,
            result: observation.result,
            failure: observation.failure
          })
          if (Result.isError(report)) return fail(report.error)
          reports.push(report.value)
        }
      }
      if (child.status === 'cancelled' && !child.cascaded && cascade.length < cascadeLimit) {
        cascade.push(stored.specs.get(child.childKey)!)
      }
    }
    const seenCascade = new Set(cascade.map((spec) => spec.childKey))
    for (const child of children.values()) {
      if (
        child.status === 'cancelled' &&
        !child.cascaded &&
        !seenCascade.has(child.childKey) &&
        cascade.length < cascadeLimit
      ) {
        cascade.push(stored.specs.get(child.childKey)!)
      }
    }
    if (children !== stored.children) this.flows.set(flowId.value, { ...stored, children })
    return ok({
      enqueue: Object.freeze(enqueue),
      reports: Object.freeze(reports.map(cloneReport)),
      cascade: Object.freeze(cascade)
    })
  }

  markCascaded(request: MarkCascadedRequest): FlowStoreV2Operation<MarkCascadedResult> {
    const fields = readObjectFields(request, cascadeFields, 'request')
    if (Result.isError(fields)) return fail(fields.error)
    const present = fieldRequired(fields.value, 'flowId')
    if (Result.isError(present)) return fail(present.error)
    const flowId = makeJobId(fields.value.flowId)
    if (Result.isError(flowId)) return fail(flowId.error)
    if (!Array.isArray(fields.value.childKeys))
      return fail(new JobDefinitionError({ field: 'childKeys', message: 'must be a finite array' }))
    if (fields.value.childKeys.length > hardFlowMaxChildren)
      return fail(
        new JobDefinitionError({ field: 'childKeys', message: 'must not exceed hard limit' })
      )
    const stored = this.flows.get(flowId.value)
    if (stored === undefined) return fail(new JobNotFoundError({ jobId: flowId.value }))
    const keys = new Set<string>()
    for (const [index, value] of fields.value.childKeys.entries()) {
      const key = validateChildKey(value, `childKeys[${index}]`)
      if (Result.isError(key)) return fail(key.error)
      keys.add(key.value)
    }
    const children = new Map(stored.children)
    let marked = 0
    for (const key of keys) {
      const child = children.get(key)
      if (child === undefined)
        return fail(
          new JobDefinitionError({ field: 'childKeys', message: `unknown childKey "${key}"` })
        )
      if (child.status === 'cancelled' && !child.cascaded) {
        marked += 1
        children.set(key, Object.freeze({ ...child, cascaded: true }))
      }
    }
    const updated: StoredFlow = { ...stored, children }
    this.flows.set(flowId.value, updated)
    return ok({ marked, children: childSnapshots(updated) })
  }

  appendChildReport(
    request: AppendChildReportRequest
  ): FlowStoreV2Operation<AppendChildReportResult> {
    const fields = readObjectFields(
      request,
      ['id', 'flowName', 'parentStoreKey', 'report'],
      'request'
    )
    if (Result.isError(fields)) return fail(fields.error)
    for (const field of ['id', 'flowName', 'parentStoreKey', 'report'] as const) {
      const present = fieldRequired(fields.value, field)
      if (Result.isError(present)) return fail(present.error)
    }
    const entry = validateFlowOutboxEntry(fields.value)
    if (Result.isError(entry)) return fail(entry.error)
    const digest = canonicalJson(entry.value)
    const existing = this.outbox.get(entry.value.id)
    if (existing !== undefined) {
      if (canonicalJson(existing) !== digest) {
        return fail(
          new SettlementConflictError({
            jobId: entry.value.report.flowId,
            leaseToken: makeLeaseToken('outbox-conflict').unwrap()
          })
        )
      }
      return ok({ status: 'already-applied', entry: cloneOutboxEntry(existing) })
    }
    this.outbox.set(entry.value.id, entry.value)
    return ok({ status: 'applied', entry: cloneOutboxEntry(entry.value) })
  }

  peekOutbox(request: PeekOutboxRequest): FlowStoreV2Operation<FlowOutboxPage> {
    const fields = readObjectFields(request, outboxPeekFields, 'request')
    if (Result.isError(fields)) return fail(fields.error)
    const limit =
      fields.value.limit === undefined
        ? Result.ok(100)
        : validatePositiveIntegerValue(fields.value.limit, 'limit')
    if (Result.isError(limit)) return fail(limit.error)
    if (limit.value > hardFlowMaxChildren)
      return fail(new JobDefinitionError({ field: 'limit', message: 'must not exceed hard limit' }))
    const cursor =
      fields.value.cursor === undefined
        ? Result.ok<string | undefined>(undefined)
        : validateChildKey(fields.value.cursor, 'cursor')
    const parentStoreKey =
      fields.value.parentStoreKey === undefined
        ? Result.ok<string | undefined>(undefined)
        : validateChildKey(fields.value.parentStoreKey, 'parentStoreKey')
    if (Result.isError(cursor)) return fail(cursor.error)
    if (Result.isError(parentStoreKey)) return fail(parentStoreKey.error)

    const entries = [...this.outbox.values()].filter(
      (entry) => parentStoreKey.value === undefined || entry.parentStoreKey === parentStoreKey.value
    )
    const cursorIndex =
      cursor.value === undefined ? -1 : entries.findIndex((entry) => entry.id === cursor.value)
    const start = cursorIndex < 0 ? 0 : cursorIndex + 1
    const page = entries.slice(start, start + limit.value).map(cloneOutboxEntry)
    const hasMore = start + page.length < entries.length
    return ok({
      entries: Object.freeze(page),
      cursor: hasMore && page.length > 0 ? page.at(-1)!.id : undefined,
      hasMore
    })
  }

  ackOutbox(request: AckOutboxRequest): FlowStoreV2Operation<AckOutboxResult> {
    const fields = readObjectFields(request, outboxAckFields, 'request')
    if (Result.isError(fields)) return fail(fields.error)
    const entries = fields.value.entries
    if (!Array.isArray(entries) || entries.length > hardFlowMaxChildren) {
      return fail(
        new JobDefinitionError({
          field: 'entries',
          message: 'must be an array within the hard limit'
        })
      )
    }
    const seen = new Map<string, string>()
    const checkedEntries: FlowOutboxEntry[] = []
    for (const [index, value] of entries.entries()) {
      const checked = validateFlowOutboxEntry(value)
      if (Result.isError(checked))
        return fail(
          new JobDefinitionError({ field: `entries[${index}]`, message: checked.error.message })
        )
      const digest = canonicalJson(checked.value)
      const previous = seen.get(checked.value.id)
      if (previous !== undefined && previous !== digest) {
        return fail(
          new JobDefinitionError({
            field: 'entries',
            message: 'conflicting duplicate outbox entry'
          })
        )
      }
      if (previous === undefined) {
        seen.set(checked.value.id, digest)
        checkedEntries.push(checked.value)
      }
    }
    let acknowledged = 0
    let skipped = 0
    for (const entry of checkedEntries) {
      const existing = this.outbox.get(entry.id)
      if (existing === undefined || canonicalJson(existing) !== canonicalJson(entry)) {
        skipped += 1
        continue
      }
      this.outbox.delete(entry.id)
      acknowledged += 1
    }
    return ok({ acknowledged, skipped })
  }

  getFlow(request: GetFlowRequest): FlowStoreV2Operation<FlowSnapshot | undefined> {
    const flowId = normalizeFlowIdRequest(request, getFlowFields, 'request')
    if (Result.isError(flowId)) return fail(flowId.error)
    const flow = this.flows.get(flowId.value)
    return ok(
      flow === undefined
        ? undefined
        : snapshot(
            flow,
            [...this.outbox.values()].filter((entry) => entry.report.flowId === flowId.value)
          )
    )
  }
}

export const MemoryFlowStore = Object.freeze({
  make(): FlowStoreV2 {
    return new MemoryFlowStoreImplementation()
  }
})
