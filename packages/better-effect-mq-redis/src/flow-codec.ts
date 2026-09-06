// oxlint-disable anti-slop/no-runtime-typeof -- Redis flow records are untrusted persistence data.
// oxlint-disable anti-slop/no-unknown-parameters -- flow DTOs cross an untyped Redis boundary.
// oxlint-disable anti-slop/no-unknown-returns -- JSON parsing is narrowed by the protocol validators below.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- records are assembled only after validation.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts follow validation.

import { Result, type Result as ResultType } from 'better-result'
import {
  makeJobId,
  makeLeaseToken,
  validateFlowChildReport,
  validateFlowChildRecord,
  validateFlowChildSpec,
  validateFlowState,
  validateParentEnvelope,
  validateSerializedJobFailure,
  type FlowChildRecord,
  type FlowChildSpec,
  type FlowOutboxEntry,
  type FlowParentRecord,
  type JsonValue,
  type SerializedJobFailure
} from 'better-effect-mq'

import { RedisLayoutError } from './errors'
import { hashReply } from './internal/replies'
import { validateKeySegment } from './keys'

export interface RedisFlowChildEntry {
  readonly spec: FlowChildSpec
  readonly record: FlowChildRecord
  readonly reference: string
}

export type RedisFlowDecodeResult<T> = ResultType<T, RedisLayoutError>

const invalid = (field: string, message: string, cause?: unknown): RedisLayoutError =>
  new RedisLayoutError(message, field, 'INVALID_DATA', cause === undefined ? {} : { cause })

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

type CanonicalValue = JsonValue | undefined

const canonicalize = (value: unknown, seen = new Set<object>()): CanonicalValue => {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('flow', 'contains an invalid number')
    return value
  }
  if (typeof value !== 'object') throw invalid('flow', 'contains a non-JSON value')
  if (seen.has(value)) throw invalid('flow', 'contains a cycle')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen) ?? null)
    if (!isPlainObject(value)) throw invalid('flow', 'contains a non-plain object')
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    for (const key of Object.keys(value).sort()) {
      const item = canonicalize(value[key], seen)
      if (item !== undefined) output[key] = item
    }
    return output
  } finally {
    seen.delete(value)
  }
}

export const canonicalFlowJson = (value: unknown): string => {
  const result = JSON.stringify(canonicalize(value) ?? null)
  if (result === undefined) throw invalid('flow', 'could not encode JSON')
  return result
}

const parseJson = (value: string, field: string): JsonValue => {
  try {
    return JSON.parse(value) as JsonValue
  } catch (cause) {
    throw invalid(field, 'contains invalid JSON', cause)
  }
}

const ownFields = (value: Record<string, unknown>, allowed: readonly string[], field: string) => {
  const keys = Object.keys(value)
  if (keys.some((key) => !allowed.includes(key)))
    throw invalid(field, 'contains unsupported fields')
  return value
}

const parentRecordFields = [
  'flowId',
  'flowName',
  'parentStoreKey',
  'depth',
  'state',
  'leaseToken',
  'flow',
  'failure'
] as const

const validateParentRecord = (value: unknown): FlowParentRecord => {
  if (!isPlainObject(value)) throw invalid('parent', 'must be a plain object')
  ownFields(value, parentRecordFields, 'parent')
  const flowId = makeJobId(value.flowId)
  const leaseToken = makeLeaseToken(value.leaseToken)
  const parent = validateParentEnvelope({
    flowName: value.flowName,
    flowId: value.flowId,
    childKey: 'flow-parent',
    parentStoreKey: value.parentStoreKey,
    depth: value.depth
  })
  const flow = validateFlowState(value.flow)
  const failure =
    value.failure === undefined || value.failure === null
      ? Result.ok<SerializedJobFailure | undefined>(undefined)
      : validateSerializedJobFailure(value.failure)
  const states = ['active', 'waiting-children', 'waiting', 'completed', 'failed', 'cancelled']
  if (Result.isError(flowId)) throw invalid('flowId', flowId.error.message)
  if (Result.isError(leaseToken)) throw invalid('leaseToken', leaseToken.error.message)
  if (Result.isError(parent)) throw invalid('parent', parent.error.message)
  if (Result.isError(flow)) throw invalid('flow', flow.error.message)
  if (Result.isError(failure)) throw invalid('failure', failure.error.message)
  if (!states.includes(value.state as string)) throw invalid('state', 'contains an invalid state')
  return Object.freeze({
    flowId: flowId.value,
    flowName: parent.value.flowName,
    parentStoreKey: parent.value.parentStoreKey,
    depth: parent.value.depth,
    state: value.state as FlowParentRecord['state'],
    leaseToken: leaseToken.value,
    flow: flow.value,
    failure: failure.value
  })
}

export const encodeFlowParent = (parent: FlowParentRecord): string =>
  canonicalFlowJson(validateParentRecord(parent))

export const decodeFlowParent = (fields: unknown): RedisFlowDecodeResult<FlowParentRecord> => {
  try {
    const hash = hashReply(fields)
    if (Object.keys(hash).some((key) => key !== 'record' && key !== 'fanOutDigest')) {
      throw invalid('parent', 'contains unsupported Redis fields')
    }
    if (hash.record === undefined || hash.fanOutDigest === undefined) {
      throw invalid('parent', 'is missing the persisted record')
    }
    if (hash.fanOutDigest.length === 0) throw invalid('parent.fanOutDigest', 'must be non-empty')
    return Result.ok(validateParentRecord(parseJson(hash.record, 'parent.record')))
  } catch (cause) {
    return Result.err(
      cause instanceof RedisLayoutError ? cause : invalid('parent', 'could not decode')
    )
  }
}

export const encodeFlowChildEntry = (
  spec: FlowChildSpec,
  record: FlowChildRecord,
  reference: string
): string => {
  const checkedSpec = validateFlowChildSpec(spec)
  const checkedRecord = validateFlowChildRecord(record)
  if (Result.isError(checkedSpec)) throw invalid('spec', checkedSpec.error.message)
  if (Result.isError(checkedRecord)) throw invalid('record', checkedRecord.error.message)
  if (
    checkedSpec.value.childKey !== checkedRecord.value.childKey ||
    checkedSpec.value.childJobId !== checkedRecord.value.childJobId
  ) {
    throw invalid('child', 'spec and record identities do not match')
  }
  if (typeof reference !== 'string' || reference.length === 0) {
    throw invalid('reference', 'must be a non-empty string')
  }
  return canonicalFlowJson({ spec: checkedSpec.value, record: checkedRecord.value, reference })
}

export const decodeFlowChildEntry = (value: string): RedisFlowDecodeResult<RedisFlowChildEntry> => {
  try {
    const parsed = parseJson(value, 'child')
    if (!isPlainObject(parsed)) throw invalid('child', 'must be a plain object')
    ownFields(parsed, ['spec', 'record', 'reference'], 'child')
    const spec = validateFlowChildSpec(parsed.spec)
    const rawRecord = parsed.record
    if (!isPlainObject(rawRecord)) throw invalid('record', 'must be a plain object')
    const record = validateFlowChildRecord({
      ...rawRecord,
      result:
        rawRecord.status === 'pending' && rawRecord.result === null ? undefined : rawRecord.result,
      failure: rawRecord.failure === null ? undefined : rawRecord.failure
    })
    if (Result.isError(spec)) throw invalid('spec', spec.error.message)
    if (Result.isError(record)) throw invalid('record', record.error.message)
    if (typeof parsed.reference !== 'string' || parsed.reference.length === 0) {
      throw invalid('reference', 'must be a non-empty string')
    }
    if (
      spec.value.childKey !== record.value.childKey ||
      spec.value.childJobId !== record.value.childJobId
    ) {
      throw invalid('child', 'spec and record identities do not match')
    }
    return Result.ok(
      Object.freeze({ spec: spec.value, record: record.value, reference: parsed.reference })
    )
  } catch (cause) {
    return Result.err(
      cause instanceof RedisLayoutError ? cause : invalid('child', 'could not decode')
    )
  }
}

const validateOutboxEntry = (value: unknown): FlowOutboxEntry => {
  if (!isPlainObject(value)) throw invalid('outbox', 'must be a plain object')
  ownFields(value, ['id', 'flowName', 'parentStoreKey', 'report'], 'outbox')
  const id = validateKeySegment(value.id, 'outbox.id')
  if (!isPlainObject(value.report)) throw invalid('outbox.report', 'must be a plain object')
  const rawReport = value.report
  const report = validateFlowChildReport({
    ...rawReport,
    result: rawReport.result,
    failure: rawReport.failure
  })
  if (Result.isError(report)) throw invalid('outbox.report', report.error.message)
  const parent = validateParentEnvelope({
    flowName: value.flowName,
    flowId: report.value.flowId,
    childKey: report.value.childKey,
    parentStoreKey: value.parentStoreKey,
    depth: 1
  })
  if (Result.isError(parent)) throw invalid('outbox', parent.error.message)
  return Object.freeze({
    id,
    flowName: parent.value.flowName,
    parentStoreKey: parent.value.parentStoreKey,
    report: report.value
  })
}

export const encodeFlowOutboxEntry = (entry: FlowOutboxEntry): string =>
  canonicalFlowJson(validateOutboxEntry(entry))

export const decodeFlowOutboxEntry = (value: string): RedisFlowDecodeResult<FlowOutboxEntry> => {
  try {
    const parsed = parseJson(value, 'outbox')
    if (!isPlainObject(parsed)) throw invalid('outbox', 'must be a plain object')
    ownFields(parsed, ['id', 'flowName', 'parentStoreKey', 'report'], 'outbox')
    if (!isPlainObject(parsed.report)) throw invalid('outbox.report', 'must be a plain object')
    const rawReport = parsed.report
    return Result.ok(
      validateOutboxEntry({
        ...parsed,
        report: {
          ...rawReport,
          result: rawReport.result,
          failure: rawReport.failure === null ? undefined : rawReport.failure
        }
      })
    )
  } catch (cause) {
    return Result.err(
      cause instanceof RedisLayoutError ? cause : invalid('outbox', 'could not decode')
    )
  }
}
