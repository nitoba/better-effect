// oxlint-disable anti-slop/no-unknown-parameters -- protocol validators are untyped persistence boundaries.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- fixed protocol fields are assembled after validation.
// oxlint-disable anti-slop/no-runtime-typeof -- validators narrow external protocol values before use.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- counters are narrowed by validateCounters.

import { Result, type Result as ResultType } from 'better-result'

import { parseJsonValue, readObjectFields } from '../internal/json'
import {
  validateCounterValue,
  validatePositiveIntegerValue,
  validateTextValue,
  validateTimestampValue
} from '../internal/validation'
import { validatePreparedEnqueue } from '../job/prepared'

import { makeJobId } from './brands'
import { JobDefinitionError } from './errors'
import { validateSerializedJobFailure } from './failures'
import { validateJobRecord } from './records'
import type {
  AttemptOutcome,
  AttemptRecord,
  JobRecord,
  JobState,
  JsonValue,
  SerializedJobFailure,
  SettlementOutcome
} from './types'
import type { JobId } from './brands'
import type { PreparedEnqueue } from '../job/prepared'

export const protocolVersionV2 = 2 as const
export type ProtocolVersionV2 = typeof protocolVersionV2

export const flowLayoutVersion = 1 as const
export type FlowLayoutVersion = typeof flowLayoutVersion

export type FlowMigrationStatus = 'not-required' | 'required' | 'in-progress' | 'complete'

export interface FlowMigration {
  readonly status: FlowMigrationStatus
  readonly from: number | string | undefined
  readonly to: number | string
}

export const defaultFlowMaxChildren = 10_000 as const
export const hardFlowMaxChildren = 100_000 as const
export const defaultFlowMaxDepth = 8 as const
export const hardFlowMaxDepth = 32 as const
export const maxFlowNameLength = 128 as const
export const maxFlowChildKeyLength = 512 as const
export const maxFlowStoreKeyLength = 512 as const
export const maxFlowChildIdLength = 1_024 as const

export type JobStateV2 = JobState | 'waiting-children'

/** v2 extends the settlement ledger without changing the v1 validator. */
export type AttemptOutcomeV2 = AttemptOutcome | 'fanned-out'

export type AttemptRecordV2 = Omit<AttemptRecord, 'outcome'> & {
  readonly outcome: AttemptOutcomeV2
}

export interface ParentEnvelope {
  readonly flowName: string
  readonly flowId: JobId
  readonly childKey: string
  readonly parentStoreKey: string
  readonly depth: number
}

export interface FlowState {
  readonly flowName: string
  readonly failFast: boolean
  readonly pending: number
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
}

export interface FlowChildSpec {
  readonly childKey: string
  readonly name: string
  readonly version: number
  readonly storeKey: string
  readonly childJobId: JobId
  readonly request: PreparedEnqueue
}

export type FlowChildStatus = 'pending' | 'completed' | 'failed' | 'cancelled'

export interface FlowChildRecord {
  readonly flowId: JobId
  readonly childKey: string
  readonly name: string
  readonly version: number
  readonly storeKey: string
  readonly childJobId: JobId
  readonly status: FlowChildStatus
  readonly result: JsonValue | undefined
  readonly failure: SerializedJobFailure | undefined
  readonly cascaded: boolean
  readonly pendingSinceMs: number
}

export type FlowChildReportOutcome = Exclude<FlowChildStatus, 'pending'>

export interface FlowChildReport {
  readonly flowId: JobId
  readonly childKey: string
  readonly outcome: FlowChildReportOutcome
  readonly result: JsonValue | undefined
  readonly failure: SerializedJobFailure | undefined
}

export interface FlowOutboxEntry {
  readonly id: string
  readonly flowName: string
  readonly parentStoreKey: string
  readonly report: FlowChildReport
}

const flowOutboxEntryFields = ['id', 'flowName', 'parentStoreKey', 'report'] as const

export const validateFlowOutboxEntry = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- outbox records cross a persistence boundary.
  value: unknown
): ResultType<FlowOutboxEntry, JobDefinitionError> => {
  const fields = readObjectFields(value, flowOutboxEntryFields, 'outbox')
  if (Result.isError(fields)) return fields

  for (const field of flowOutboxEntryFields) {
    const present = required(fields.value, field)
    if (Result.isError(present)) return invalid(field, present.error.message)
  }

  const id = validateBoundedText(fields.value.id, 'id', maxFlowChildIdLength)
  const flowName = validateBoundedText(fields.value.flowName, 'flowName', maxFlowNameLength)
  const parentStoreKey = validateBoundedText(
    fields.value.parentStoreKey,
    'parentStoreKey',
    maxFlowStoreKeyLength
  )
  const report = validateFlowChildReport(fields.value.report)
  if (Result.isError(id)) return id
  if (Result.isError(flowName)) return flowName
  if (Result.isError(parentStoreKey)) return parentStoreKey
  if (Result.isError(report)) return report

  return Result.ok(
    Object.freeze({
      id: id.value,
      flowName: flowName.value,
      parentStoreKey: parentStoreKey.value,
      report: report.value
    })
  )
}

export interface FanOutOutcome {
  readonly type: 'FanOut'
  readonly failFast: boolean
  readonly children: readonly FlowChildSpec[]
}

export type SettlementOutcomeV2 = SettlementOutcome | FanOutOutcome

export type JobRecordV2 = Omit<JobRecord, 'state'> & {
  readonly state: JobStateV2
  readonly parent: ParentEnvelope | undefined
  readonly flow: FlowState | undefined
}

export interface FlowLimits {
  readonly maxChildren: number
  readonly maxDepth: number
}

export const defaultFlowLimits: FlowLimits = Object.freeze({
  maxChildren: defaultFlowMaxChildren,
  maxDepth: defaultFlowMaxDepth
})

const parentEnvelopeFields = ['flowName', 'flowId', 'childKey', 'parentStoreKey', 'depth'] as const
const flowStateFields = [
  'flowName',
  'failFast',
  'pending',
  'completed',
  'failed',
  'cancelled'
] as const
const flowChildSpecFields = [
  'childKey',
  'name',
  'version',
  'storeKey',
  'childJobId',
  'request'
] as const
const flowChildRecordFields = [
  'flowId',
  'childKey',
  'name',
  'version',
  'storeKey',
  'childJobId',
  'status',
  'result',
  'failure',
  'cascaded',
  'pendingSinceMs'
] as const
const flowChildReportFields = ['flowId', 'childKey', 'outcome', 'result', 'failure'] as const
const fanOutFields = ['type', 'failFast', 'children'] as const
const flowLimitsFields = ['maxChildren', 'maxDepth'] as const
const migrationFields = ['status', 'from', 'to'] as const
const jobRecordV2Fields = [
  'id',
  'name',
  'version',
  'queue',
  'dispatchKey',
  'state',
  'payload',
  'metadata',
  'priority',
  'runAt',
  'orderingSequence',
  'attemptsMax',
  'attemptsMade',
  'attemptSequence',
  'deliveryCount',
  'stalledCount',
  'backoff',
  'timeoutMs',
  'idempotencyKey',
  'createdAt',
  'updatedAt',
  'processedAt',
  'finishedAt',
  'leaseOwner',
  'leaseToken',
  'leaseExpiresAt',
  'cancellationRequestedAt',
  'result',
  'failure',
  'parent',
  'flow'
] as const

const invalid = <Value>(field: string, message: string): ResultType<Value, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

const required = (
  fields: Readonly<Record<string, unknown>>,
  field: string
): ResultType<unknown, JobDefinitionError> =>
  Object.prototype.hasOwnProperty.call(fields, field)
    ? Result.ok(fields[field])
    : invalid(field, 'is required')

const validateBoundedText = (
  value: unknown,
  field: string,
  maximum: number
): ResultType<string, JobDefinitionError> => {
  const text = validateTextValue(value, field)
  if (Result.isError(text)) return text

  return text.value.length <= maximum
    ? text
    : invalid(field, `must not exceed ${maximum} characters`)
}

const validateBoolean = (value: unknown, field: string): ResultType<boolean, JobDefinitionError> =>
  value === true || value === false ? Result.ok(value) : invalid(field, 'must be a boolean')

const validateFlowStatus = (value: unknown): ResultType<FlowChildStatus, JobDefinitionError> => {
  switch (value) {
    case 'pending':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return Result.ok(value)
    default:
      return invalid('status', 'must be pending, completed, failed, or cancelled')
  }
}

const validateReportOutcome = (
  value: unknown
): ResultType<FlowChildReportOutcome, JobDefinitionError> => {
  switch (value) {
    case 'completed':
    case 'failed':
    case 'cancelled':
      return Result.ok(value)
    default:
      return invalid('outcome', 'must be completed, failed, or cancelled')
  }
}

const validateFlowId = (value: unknown, field: string): ResultType<JobId, JobDefinitionError> => {
  const id = makeJobId(value)
  return Result.isError(id) ? invalid(field, id.error.message) : id
}

const validateVersion = (value: unknown, field: string): ResultType<number, JobDefinitionError> =>
  validatePositiveIntegerValue(value, field)

const validateCounters = (
  fields: Readonly<Record<string, unknown>>,
  names: readonly string[]
): ResultType<Readonly<Record<string, number>>, JobDefinitionError> => {
  const counters: Record<string, number> = {}

  for (const name of names) {
    const counter = validateCounterValue(fields[name], name)
    if (Result.isError(counter)) return invalid(name, counter.error.message)
    counters[name] = counter.value
  }

  return Result.ok(Object.freeze(counters))
}

export const validateFlowLimits = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- public DTO validation boundary.
  value: unknown
): ResultType<FlowLimits, JobDefinitionError> => {
  const fields = readObjectFields(value, flowLimitsFields, 'limits')
  if (Result.isError(fields)) return fields

  const maxChildren = validatePositiveIntegerValue(fields.value.maxChildren, 'maxChildren')
  const maxDepth = validatePositiveIntegerValue(fields.value.maxDepth, 'maxDepth')
  if (Result.isError(maxChildren)) return maxChildren
  if (Result.isError(maxDepth)) return maxDepth
  if (maxChildren.value > hardFlowMaxChildren) {
    return invalid('maxChildren', `must not exceed hard limit ${hardFlowMaxChildren}`)
  }
  if (maxDepth.value > hardFlowMaxDepth) {
    return invalid('maxDepth', `must not exceed hard limit ${hardFlowMaxDepth}`)
  }

  return Result.ok(Object.freeze({ maxChildren: maxChildren.value, maxDepth: maxDepth.value }))
}

const validateMigrationVersion = (
  value: unknown,
  field: string,
  optional: boolean
): ResultType<number | string | undefined, JobDefinitionError> => {
  if (optional && value === undefined) return Result.ok(undefined)
  if (typeof value === 'number') return validatePositiveIntegerValue(value, field)
  return validateBoundedText(value, field, maxFlowNameLength)
}

export const validateFlowMigration = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- migration metadata crosses an adapter boundary.
  value: unknown
): ResultType<FlowMigration, JobDefinitionError> => {
  const fields = readObjectFields(value, migrationFields, 'migration')
  if (Result.isError(fields)) return fields
  for (const field of migrationFields) {
    const present = required(fields.value, field)
    if (Result.isError(present)) return present
  }
  const status = fields.value.status
  if (
    status !== 'not-required' &&
    status !== 'required' &&
    status !== 'in-progress' &&
    status !== 'complete'
  ) {
    return invalid('status', 'must be not-required, required, in-progress, or complete')
  }
  const from = validateMigrationVersion(fields.value.from, 'from', true)
  const to = validateMigrationVersion(fields.value.to, 'to', false)
  if (Result.isError(from)) return from
  if (Result.isError(to)) return to
  return Result.ok(Object.freeze({ status, from: from.value, to: to.value! }))
}

export const validateParentEnvelope = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- persistence DTO boundary.
  value: unknown
): ResultType<ParentEnvelope, JobDefinitionError> => {
  const fields = readObjectFields(value, parentEnvelopeFields, 'parent')
  if (Result.isError(fields)) return fields

  for (const field of parentEnvelopeFields) {
    const present = required(fields.value, field)
    if (Result.isError(present)) return invalid(field, present.error.message)
  }

  const flowName = validateBoundedText(fields.value.flowName, 'flowName', maxFlowNameLength)
  const flowId = validateFlowId(fields.value.flowId, 'flowId')
  const childKey = validateBoundedText(fields.value.childKey, 'childKey', maxFlowChildKeyLength)
  const parentStoreKey = validateBoundedText(
    fields.value.parentStoreKey,
    'parentStoreKey',
    maxFlowStoreKeyLength
  )
  const depth = validatePositiveIntegerValue(fields.value.depth, 'depth')
  if (Result.isError(flowName)) return flowName
  if (Result.isError(flowId)) return flowId
  if (Result.isError(childKey)) return childKey
  if (Result.isError(parentStoreKey)) return parentStoreKey
  if (Result.isError(depth)) return depth
  if (depth.value > hardFlowMaxDepth) {
    return invalid('depth', `must not exceed hard limit ${hardFlowMaxDepth}`)
  }

  return Result.ok(
    Object.freeze({
      flowName: flowName.value,
      flowId: flowId.value,
      childKey: childKey.value,
      parentStoreKey: parentStoreKey.value,
      depth: depth.value
    })
  )
}

export const validateFlowState = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- persistence DTO boundary.
  value: unknown
): ResultType<FlowState, JobDefinitionError> => {
  const fields = readObjectFields(value, flowStateFields, 'flow')
  if (Result.isError(fields)) return fields

  const flowName = validateBoundedText(fields.value.flowName, 'flowName', maxFlowNameLength)
  const failFast = validateBoolean(fields.value.failFast, 'failFast')
  const counters = validateCounters(fields.value, ['pending', 'completed', 'failed', 'cancelled'])
  if (Result.isError(flowName)) return flowName
  if (Result.isError(failFast)) return failFast
  if (Result.isError(counters)) return counters

  // SAFETY: validateCounters populated every requested counter before returning Ok.
  const pending = counters.value.pending as number
  const completed = counters.value.completed as number
  const failed = counters.value.failed as number
  const cancelled = counters.value.cancelled as number
  const total = pending + completed + failed + cancelled
  if (!Number.isSafeInteger(total)) return invalid('flow', 'counters exceed safe integer range')

  return Result.ok(
    Object.freeze({
      flowName: flowName.value,
      failFast: failFast.value,
      pending,
      completed,
      failed,
      cancelled
    })
  )
}

/** Validate a v2 Job snapshot while keeping the v1 record validator unchanged. */
export const validateJobRecordV2 = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- records cross an adapter boundary.
  value: unknown
): ResultType<JobRecordV2, JobDefinitionError> => {
  const fields = readObjectFields(value, jobRecordV2Fields, 'record')
  if (Result.isError(fields)) return fields

  const parent =
    fields.value.parent === undefined
      ? Result.ok<ParentEnvelope | undefined>(undefined)
      : validateParentEnvelope(fields.value.parent)
  const flow =
    fields.value.flow === undefined
      ? Result.ok<FlowState | undefined>(undefined)
      : validateFlowState(fields.value.flow)
  if (Result.isError(parent)) return invalid('parent', parent.error.message)
  if (Result.isError(flow)) return invalid('flow', flow.error.message)

  // The v1 reducer is intentionally unaware of waiting-children. Validate the
  // shared snapshot using its waiting representation, then restore the v2 state.
  const legacyFields: Record<string, unknown> = {}
  for (const field of jobRecordV2Fields) {
    if (field === 'parent' || field === 'flow') continue
    if (Object.prototype.hasOwnProperty.call(fields.value, field)) {
      legacyFields[field] = fields.value[field]
    }
  }
  if (fields.value.state === 'waiting-children') legacyFields.state = 'waiting'
  const legacy = validateJobRecord(legacyFields)
  if (Result.isError(legacy)) return legacy
  if (fields.value.state === 'waiting-children' && flow.value === undefined) {
    return invalid('flow', 'waiting-children records must contain flow metadata')
  }
  if (fields.value.state === 'waiting-children' && flow.value?.pending === 0) {
    return invalid('flow.pending', 'waiting-children records must have pending children')
  }
  if (
    fields.value.state !== 'waiting-children' &&
    flow.value !== undefined &&
    flow.value.pending > 0
  ) {
    return invalid('state', 'records with pending children must be waiting-children')
  }

  return Result.ok(
    Object.freeze({
      ...legacy.value,
      state: fields.value.state as JobStateV2,
      parent: parent.value,
      flow: flow.value
    })
  )
}

export const validateFlowChildSpec = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- persistence DTO boundary.
  value: unknown
): ResultType<FlowChildSpec, JobDefinitionError> => {
  const fields = readObjectFields(value, flowChildSpecFields, 'child')
  if (Result.isError(fields)) return fields

  for (const field of flowChildSpecFields) {
    const present = required(fields.value, field)
    if (Result.isError(present)) return invalid(field, present.error.message)
  }

  const childKey = validateBoundedText(fields.value.childKey, 'childKey', maxFlowChildKeyLength)
  const name = validateBoundedText(fields.value.name, 'name', maxFlowNameLength)
  const version = validateVersion(fields.value.version, 'version')
  const storeKey = validateBoundedText(fields.value.storeKey, 'storeKey', maxFlowStoreKeyLength)
  const childJobId = validateFlowId(fields.value.childJobId, 'childJobId')
  const request = validatePreparedEnqueue(fields.value.request)
  if (Result.isError(childKey)) return childKey
  if (Result.isError(name)) return name
  if (Result.isError(version)) return version
  if (Result.isError(storeKey)) return storeKey
  if (Result.isError(childJobId)) return childJobId
  if (Result.isError(request)) return invalid('request', request.error.message)
  if (request.value.id !== childJobId.value) {
    return invalid('childJobId', 'must match request.id')
  }
  if (
    request.value.identity.name !== name.value ||
    request.value.identity.version !== version.value
  ) {
    return invalid('request', 'identity must match child name and version')
  }

  return Result.ok(
    Object.freeze({
      childKey: childKey.value,
      name: name.value,
      version: version.value,
      storeKey: storeKey.value,
      childJobId: childJobId.value,
      request: request.value
    })
  )
}

export const validateFlowManifest = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- persistence DTO boundary.
  value: unknown,
  limits: FlowLimits = defaultFlowLimits
): ResultType<readonly FlowChildSpec[], JobDefinitionError> => {
  const checkedLimits = validateFlowLimits(limits)
  if (Result.isError(checkedLimits)) return checkedLimits
  if (!Array.isArray(value)) return invalid('children', 'must be a finite array')
  if (value.length > checkedLimits.value.maxChildren) {
    return invalid('children', `must not exceed maxChildren ${checkedLimits.value.maxChildren}`)
  }
  if (value.length > hardFlowMaxChildren) {
    return invalid('children', `must not exceed hard limit ${hardFlowMaxChildren}`)
  }

  const children: FlowChildSpec[] = []
  const keys = new Set<string>()
  for (const [index, child] of value.entries()) {
    const checked = validateFlowChildSpec(child)
    if (Result.isError(checked)) return invalid(`children[${index}]`, checked.error.message)
    if (keys.has(checked.value.childKey)) {
      return invalid('children', `duplicate childKey "${checked.value.childKey}"`)
    }
    keys.add(checked.value.childKey)
    children.push(checked.value)
  }

  return Result.ok(Object.freeze(children))
}

export const validateFlowChildRecord = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- persistence DTO boundary.
  value: unknown
): ResultType<FlowChildRecord, JobDefinitionError> => {
  const fields = readObjectFields(value, flowChildRecordFields, 'child')
  if (Result.isError(fields)) return fields

  for (const field of flowChildRecordFields) {
    const present = required(fields.value, field)
    if (Result.isError(present)) return invalid(field, present.error.message)
  }

  const flowId = validateFlowId(fields.value.flowId, 'flowId')
  const childKey = validateBoundedText(fields.value.childKey, 'childKey', maxFlowChildKeyLength)
  const name = validateBoundedText(fields.value.name, 'name', maxFlowNameLength)
  const version = validateVersion(fields.value.version, 'version')
  const storeKey = validateBoundedText(fields.value.storeKey, 'storeKey', maxFlowStoreKeyLength)
  const childJobId = validateFlowId(fields.value.childJobId, 'childJobId')
  const status = validateFlowStatus(fields.value.status)
  const result =
    fields.value.result === undefined
      ? Result.ok<JsonValue | undefined>(undefined)
      : parseJsonValue(fields.value.result, 'result')
  const failure =
    fields.value.failure === undefined
      ? Result.ok<SerializedJobFailure | undefined>(undefined)
      : validateSerializedJobFailure(fields.value.failure)
  const cascaded = validateBoolean(fields.value.cascaded, 'cascaded')
  const pendingSinceMs = validateTimestampValue(fields.value.pendingSinceMs, 'pendingSinceMs')
  if (Result.isError(flowId)) return flowId
  if (Result.isError(childKey)) return childKey
  if (Result.isError(name)) return name
  if (Result.isError(version)) return version
  if (Result.isError(storeKey)) return storeKey
  if (Result.isError(childJobId)) return childJobId
  if (Result.isError(status)) return status
  if (Result.isError(result)) return invalid('result', result.error.message)
  if (Result.isError(failure)) return invalid('failure', failure.error.message)
  if (Result.isError(cascaded)) return cascaded
  if (Result.isError(pendingSinceMs)) return pendingSinceMs
  if (status.value === 'pending' && (result.value !== undefined || failure.value !== undefined)) {
    return invalid('status', 'pending children cannot have a result or failure')
  }
  if (status.value === 'failed' && failure.value === undefined) {
    return invalid('failure', 'failed children must have a failure')
  }
  if (status.value === 'completed' && failure.value !== undefined) {
    return invalid('failure', 'completed children cannot have a failure')
  }

  return Result.ok(
    Object.freeze({
      flowId: flowId.value,
      childKey: childKey.value,
      name: name.value,
      version: version.value,
      storeKey: storeKey.value,
      childJobId: childJobId.value,
      status: status.value,
      result: result.value,
      failure: failure.value,
      cascaded: cascaded.value,
      pendingSinceMs: pendingSinceMs.value
    })
  )
}

export const validateFlowChildReport = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- persistence DTO boundary.
  value: unknown
): ResultType<FlowChildReport, JobDefinitionError> => {
  const fields = readObjectFields(value, flowChildReportFields, 'report')
  if (Result.isError(fields)) return fields

  for (const field of flowChildReportFields) {
    const present = required(fields.value, field)
    if (Result.isError(present)) return invalid(field, present.error.message)
  }

  const flowId = validateFlowId(fields.value.flowId, 'flowId')
  const childKey = validateBoundedText(fields.value.childKey, 'childKey', maxFlowChildKeyLength)
  const outcome = validateReportOutcome(fields.value.outcome)
  const result =
    fields.value.result === undefined
      ? Result.ok<JsonValue | undefined>(undefined)
      : parseJsonValue(fields.value.result, 'result')
  const failure =
    fields.value.failure === undefined
      ? Result.ok<SerializedJobFailure | undefined>(undefined)
      : validateSerializedJobFailure(fields.value.failure)
  if (Result.isError(flowId)) return flowId
  if (Result.isError(childKey)) return childKey
  if (Result.isError(outcome)) return outcome
  if (Result.isError(result)) return invalid('result', result.error.message)
  if (Result.isError(failure)) return invalid('failure', failure.error.message)
  if (outcome.value === 'failed' && failure.value === undefined) {
    return invalid('failure', 'failed reports must have a failure')
  }
  if (outcome.value === 'completed' && failure.value !== undefined) {
    return invalid('failure', 'completed reports cannot have a failure')
  }

  return Result.ok(
    Object.freeze({
      flowId: flowId.value,
      childKey: childKey.value,
      outcome: outcome.value,
      result: result.value,
      failure: failure.value
    })
  )
}

export const validateFanOutOutcome = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- persistence DTO boundary.
  value: unknown,
  limits: FlowLimits = defaultFlowLimits
): ResultType<FanOutOutcome, JobDefinitionError> => {
  const fields = readObjectFields(value, fanOutFields, 'outcome')
  if (Result.isError(fields)) return fields
  const type = fields.value.type
  if (type !== 'FanOut') return invalid('type', 'must be FanOut')
  const failFast = validateBoolean(fields.value.failFast, 'failFast')
  const children = validateFlowManifest(fields.value.children, limits)
  if (Result.isError(failFast)) return failFast
  if (Result.isError(children)) return children

  return Result.ok(
    Object.freeze({ type: 'FanOut', failFast: failFast.value, children: children.value })
  )
}

const lengthPrefixed = (value: string): string => {
  const length = new TextEncoder().encode(value).byteLength
  return `${length}:${value}`
}

export const makeFlowChildId = (input: {
  readonly parentStoreKey: string
  readonly flowId: JobId
  readonly childKey: string
}): ResultType<JobId, JobDefinitionError> => {
  const parentStoreKey = validateBoundedText(
    input.parentStoreKey,
    'parentStoreKey',
    maxFlowStoreKeyLength
  )
  const flowId = validateFlowId(input.flowId, 'flowId')
  const childKey = validateBoundedText(input.childKey, 'childKey', maxFlowChildKeyLength)
  if (Result.isError(parentStoreKey)) return parentStoreKey
  if (Result.isError(flowId)) return flowId
  if (Result.isError(childKey)) return childKey

  const id = `flow-v2/${lengthPrefixed(parentStoreKey.value)}${lengthPrefixed(flowId.value)}${lengthPrefixed(childKey.value)}`
  if (id.length > maxFlowChildIdLength) {
    return invalid('childJobId', `must not exceed ${maxFlowChildIdLength} characters`)
  }

  return makeJobId(id)
}

export const makeFlowMigration = (input: {
  readonly status: FlowMigrationStatus
  readonly from: number | string | undefined
  readonly to: number | string
}): FlowMigration => Object.freeze({ ...input })
