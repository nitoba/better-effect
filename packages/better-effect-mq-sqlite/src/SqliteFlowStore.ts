// oxlint-disable anti-slop/no-runtime-typeof -- SQLite rows and public flow DTOs are untyped boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- flow requests cross the persistence boundary.
// oxlint-disable anti-slop/no-unknown-returns -- generic JSON rows are validated by their protocol decoder.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- JSON rows are validated before leaving this adapter.
// oxlint-disable anti-slop/no-chained-type-assertions -- the generic associated-token layer has one intentional erased boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to validated SQL rows.

import { Layer } from 'better-effect'
import type { ServiceContract } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  defaultFlowLimits,
  FlowStore,
  flowLayoutVersion,
  hardFlowMaxChildren,
  JobDefinitionError,
  JobNotFoundError,
  JobStoreFailure,
  JobStore,
  makeFlowChildId,
  makeFlowMigration,
  makeJobId,
  makeLeaseToken,
  maxFlowChildIdLength,
  maxFlowChildKeyLength,
  maxFlowStoreKeyLength,
  protocolVersionV2,
  LeaseLostError,
  SettlementConflictError,
  validateFanOutOutcome,
  validateFlowChildRecord,
  validateFlowChildReport,
  validateFlowChildSpec,
  validateFlowOutboxEntry,
  validateFlowState,
  validateParentEnvelope,
  validateSerializedJobFailure,
  type AnyFlowStoreToken,
  type AnyJobStoreToken,
  type FlowChildObservation,
  type FlowChildObservationState,
  type FlowChildRecord,
  type FlowChildReport,
  type FlowChildSpec,
  type FlowFanOutRequest,
  type FlowOutboxEntry,
  type FlowParentRecord,
  type FlowSnapshot,
  type FlowStore as FlowStoreNamespace,
  type FlowStoreV2,
  type FlowStoreV2Descriptor,
  type FlowStoreV2Error,
  type FlowStoreV2Operation,
  type JsonValue,
  type JobId,
  type SerializedJobFailure
} from 'better-effect-mq'
import type {
  AckOutboxRequest,
  AckOutboxResult,
  AppendChildReportRequest,
  AppendChildReportResult,
  CancelFlowRequest,
  CancelFlowResult,
  GetFlowRequest,
  MarkCascadedRequest,
  MarkCascadedResult,
  PeekOutboxRequest,
  ReconcileFlowRequest,
  ReconcileFlowResult,
  RecordChildResultsRequest,
  RecordChildResultsResult
} from 'better-effect-mq'
import { normalizeSqliteJobStoreConfig, type SqliteJobStoreConfig } from './config'
import { SqliteFlowProtocolMismatchError } from './errors'
import { SqliteMigrator } from './migrator'
import { MIGRATION_COMPONENT, SQLITE_TABLES } from './schema'
import type { SqliteDatabase } from './config'
import { withSqliteTransaction } from './internal/transactions'

export interface SqliteFlowStoreConfig extends SqliteJobStoreConfig {}

export type SqliteFlowStoreInstance = FlowStoreV2 & {
  readonly descriptor: FlowStoreV2Descriptor
  dispose(): Promise<void>
}

type Row = Readonly<Record<string, unknown>>
type Operation<Value> = ResultType<Value, FlowStoreV2Error>

const descriptor: FlowStoreV2Descriptor = Object.freeze({
  protocolVersion: protocolVersionV2,
  layoutVersion: flowLayoutVersion,
  migration: makeFlowMigration({ status: 'complete', from: undefined, to: flowLayoutVersion })
})

const flowFields = [
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
const reportFields = ['flowId', 'reports', 'now'] as const
const cancelFields = ['flowId', 'now'] as const
const reconcileFields = ['flowId', 'observations', 'now', 'limit'] as const
const observationFields = ['childKey', 'state', 'result', 'failure'] as const
const cascadeFields = ['flowId', 'childKeys'] as const
const outboxPeekFields = ['cursor', 'limit', 'parentStoreKey'] as const
const outboxAckFields = ['entries'] as const
const getFlowFields = ['flowId'] as const

const ok = <Value>(value: Value): Operation<Value> => Result.ok(value)
const fail = <Value>(error: FlowStoreV2Error): Operation<Value> => Result.err(error)
const invalid = <Value>(field: string, message: string): Operation<Value> =>
  Result.err(new JobDefinitionError({ field, message }))

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const readDto = <Fields extends readonly string[]>(
  value: unknown,
  allowed: Fields,
  required: readonly string[] = []
): ResultType<Record<string, unknown>, JobDefinitionError> => {
  if (!isPlainObject(value))
    return Result.err(new JobDefinitionError({ field: 'request', message: 'must be an object' }))
  try {
    const keys = new Set(allowed)
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !keys.has(key))
        return Result.err(
          new JobDefinitionError({ field: 'request', message: 'contains unsupported fields' })
        )
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (property === undefined || !('value' in property))
        return Result.err(
          new JobDefinitionError({ field: key, message: 'must be a data property' })
        )
      output[key] = property.value
    }
    for (const field of required) {
      if (!Object.prototype.hasOwnProperty.call(output, field))
        return Result.err(new JobDefinitionError({ field, message: 'is required' }))
    }
    return Result.ok(Object.freeze(output))
  } catch {
    return Result.err(
      new JobDefinitionError({ field: 'request', message: 'could not read fields' })
    )
  }
}

const safeInteger = (value: unknown, field: string, positive = false): Operation<number> => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    return invalid(
      field,
      positive ? 'must be a positive safe integer' : 'must be a non-negative safe integer'
    )
  return ok(value)
}

const boundedText = (value: unknown, field: string, maximum: number): Operation<string> => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\u0000')
  )
    return invalid(field, `must be non-empty text of at most ${maximum} characters`)
  return ok(value)
}

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
        .map((key) => `${JSON.stringify(key)}:${visit((current as Record<string, unknown>)[key])}`)
        .join(',')}}`
    } finally {
      seen.delete(current)
    }
  }
  return visit(value)
}

const flowDigest = (request: FlowFanOutRequest): string =>
  canonicalJson({
    children: [...request.children].sort((left, right) =>
      left.childKey < right.childKey ? -1 : left.childKey > right.childKey ? 1 : 0
    ),
    depth: request.depth,
    failFast: request.failFast,
    flowId: request.flowId,
    flowName: request.flowName,
    parentStoreKey: request.parentStoreKey
  })

const parseJson = (value: unknown, field: string): unknown => {
  if (typeof value !== 'string') throw new TypeError(`${field} must be JSON text`)
  return JSON.parse(value)
}

const optionalJson = (value: unknown, field: string): unknown =>
  value === null || value === undefined ? undefined : parseJson(value, field)

const rowString = (row: Row, field: string): string => {
  const value = row[field]
  if (typeof value !== 'string') throw new TypeError(`invalid ${field}`)
  return value
}

const rowNumber = (row: Row, field: string): number => {
  const value = Number(row[field])
  if (!Number.isSafeInteger(value)) throw new TypeError(`invalid ${field}`)
  return value
}

const rowsOf = (rows: readonly (Record<string, unknown> | undefined)[]): readonly Row[] =>
  rows.map((row) => {
    if (row === undefined) throw new TypeError('SQLite row is missing')
    return row
  })

const asFailure = (value: unknown): SerializedJobFailure | undefined => {
  if (value === undefined || value === null) return undefined
  const checked = validateSerializedJobFailure(value)
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const asParent = (row: Row): FlowParentRecord => {
  const flowId = makeJobId(rowString(row, 'flow_id'))
  const leaseToken = makeLeaseToken(rowString(row, 'lease_token'))
  const envelope = validateParentEnvelope({
    flowName: rowString(row, 'flow_name'),
    flowId: rowString(row, 'flow_id'),
    childKey: 'flow-root',
    parentStoreKey: rowString(row, 'parent_store_key'),
    depth: rowNumber(row, 'depth')
  })
  const flow = validateFlowState(optionalJson(row.flow, 'flow'))
  if (Result.isError(flowId)) throw flowId.error
  if (Result.isError(leaseToken)) throw leaseToken.error
  if (Result.isError(envelope)) throw envelope.error
  if (Result.isError(flow)) throw flow.error
  const state = rowString(row, 'state')
  if (
    state !== 'active' &&
    state !== 'waiting-children' &&
    state !== 'waiting' &&
    state !== 'completed' &&
    state !== 'failed' &&
    state !== 'cancelled'
  )
    throw new TypeError(`invalid flow parent state ${state}`)
  return Object.freeze({
    flowId: flowId.value,
    flowName: envelope.value.flowName,
    parentStoreKey: envelope.value.parentStoreKey,
    depth: envelope.value.depth,
    state,
    leaseToken: leaseToken.value,
    flow: flow.value,
    failure: asFailure(optionalJson(row.failure, 'failure'))
  })
}

const asChild = (row: Row): FlowChildRecord => {
  const checked = validateFlowChildRecord({
    flowId: rowString(row, 'flow_id'),
    childKey: rowString(row, 'child_key'),
    name: rowString(row, 'name'),
    version: rowNumber(row, 'version'),
    storeKey: rowString(row, 'store_key'),
    childJobId: rowString(row, 'child_job_id'),
    status: rowString(row, 'status'),
    result: optionalJson(row.result, 'result'),
    failure: optionalJson(row.failure, 'failure'),
    cascaded: Number(row.cascaded) === 1,
    pendingSinceMs: rowNumber(row, 'pending_since_ms')
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const asSpec = (row: Row): FlowChildSpec => {
  const checked = validateFlowChildSpec({
    childKey: rowString(row, 'child_key'),
    name: rowString(row, 'name'),
    version: rowNumber(row, 'version'),
    storeKey: rowString(row, 'store_key'),
    childJobId: rowString(row, 'child_job_id'),
    request: optionalJson(row.request_json, 'request_json')
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const asOutbox = (row: Row): FlowOutboxEntry => {
  const rawReport = optionalJson(row.report_json, 'report_json')
  const report = isPlainObject(rawReport)
    ? { ...rawReport, result: rawReport.result, failure: rawReport.failure }
    : rawReport
  const checked = validateFlowOutboxEntry({
    id: rowString(row, 'id'),
    flowName: rowString(row, 'flow_name'),
    parentStoreKey: rowString(row, 'parent_store_key'),
    report
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const loadSnapshot = (
  database: SqliteDatabase,
  namespace: string,
  flowId: string
): FlowSnapshot => {
  const parentRow = database
    .prepare(
      `SELECT id AS flow_id, state, flow, failure, COALESCE(flow_lease_token, lease_token) AS lease_token,
              flow_name, flow_parent_store_key AS parent_store_key, flow_depth AS depth
         FROM ${SQLITE_TABLES.jobs} WHERE namespace = ? AND id = ?`
    )
    .get(namespace, flowId)
  if (parentRow === undefined || parentRow === null) throw new Error('flow parent was not found')
  const children = database
    .prepare(
      `SELECT flow_id, child_key, name, version, store_key, child_job_id, request_json,
              status, result, failure, cascaded, pending_since_ms
         FROM ${SQLITE_TABLES.flowChildren}
        WHERE namespace = ? AND flow_id = ? ORDER BY child_key COLLATE BINARY ASC`
    )
    .all(namespace, flowId)
  const outbox = database
    .prepare(
      `SELECT id, flow_name, parent_store_key, report_json
         FROM ${SQLITE_TABLES.flowOutbox}
        WHERE namespace = ? AND json_extract(report_json, '$.flowId') = ?
        ORDER BY row_sequence ASC, id COLLATE BINARY ASC`
    )
    .all(namespace, flowId)
  return Object.freeze({
    parent: asParent(parentRow),
    children: Object.freeze(rowsOf(children).map(asChild)),
    outbox: Object.freeze(rowsOf(outbox).map(asOutbox))
  })
}

const storageFailure = (operation: string, cause: unknown): JobStoreFailure =>
  new JobStoreFailure({
    operation: `flow.${operation}`,
    retryable:
      cause !== null &&
      typeof cause === 'object' &&
      'code' in cause &&
      /BUSY|LOCKED/u.test(String((cause as { readonly code?: unknown }).code)),
    message: `SQLite flow ${operation} failed`
  })

const validateFanOut = (request: unknown): ResultType<FlowFanOutRequest, FlowStoreV2Error> => {
  const fields = readDto(request, flowFields, [
    'flowId',
    'flowName',
    'parentStoreKey',
    'depth',
    'leaseToken',
    'failFast',
    'children',
    'now'
  ])
  if (Result.isError(fields)) return fields
  const parent = validateParentEnvelope({
    flowName: fields.value.flowName,
    flowId: fields.value.flowId,
    childKey: 'flow-root',
    parentStoreKey: fields.value.parentStoreKey,
    depth: fields.value.depth
  })
  const leaseToken = makeLeaseToken(fields.value.leaseToken)
  const now = safeInteger(fields.value.now, 'now')
  const maxChildren =
    fields.value.maxChildren === undefined
      ? ok(defaultFlowLimits.maxChildren)
      : safeInteger(fields.value.maxChildren, 'maxChildren', true)
  if (Result.isError(parent)) return parent
  if (Result.isError(leaseToken)) return leaseToken
  if (Result.isError(now)) return now
  if (Result.isError(maxChildren)) return maxChildren
  const limits = { maxChildren: maxChildren.value, maxDepth: defaultFlowLimits.maxDepth }
  const outcome = validateFanOutOutcome(
    { type: 'FanOut', failFast: fields.value.failFast, children: fields.value.children },
    limits
  )
  if (Result.isError(outcome)) return outcome
  for (const child of outcome.value.children) {
    const expected = makeFlowChildId({
      parentStoreKey: parent.value.parentStoreKey,
      flowId: parent.value.flowId,
      childKey: child.childKey
    })
    if (Result.isError(expected) || expected.value !== child.childJobId)
      return invalid('children', `childJobId for "${child.childKey}" is not deterministic`)
  }
  return ok({
    flowId: parent.value.flowId,
    flowName: parent.value.flowName,
    parentStoreKey: parent.value.parentStoreKey,
    depth: parent.value.depth,
    leaseToken: leaseToken.value,
    failFast: outcome.value.failFast,
    children: outcome.value.children,
    now: now.value,
    maxChildren: limits.maxChildren
  })
}

const validateReports = (
  request: unknown
): ResultType<RecordChildResultsRequest, FlowStoreV2Error> => {
  const fields = readDto(request, reportFields, reportFields)
  if (Result.isError(fields)) return fields
  const flowId = makeJobId(fields.value.flowId)
  const now = safeInteger(fields.value.now, 'now')
  if (Result.isError(flowId)) return flowId
  if (Result.isError(now)) return now
  if (!Array.isArray(fields.value.reports) || fields.value.reports.length > hardFlowMaxChildren)
    return invalid('reports', 'must be an array within the hard child limit')
  const reports: FlowChildReport[] = []
  const seen = new Map<string, string>()
  for (const [index, value] of fields.value.reports.entries()) {
    const checked = validateFlowChildReport(value)
    if (Result.isError(checked)) return invalid(`reports[${index}]`, checked.error.message)
    if (checked.value.flowId !== flowId.value)
      return invalid(`reports[${index}].flowId`, 'must match request.flowId')
    const digest = canonicalJson(checked.value)
    const previous = seen.get(checked.value.childKey)
    if (previous !== undefined && previous !== digest)
      return invalid('reports', 'contains conflicting duplicate childKey')
    if (previous === undefined) {
      seen.set(checked.value.childKey, digest)
      reports.push(checked.value)
    }
  }
  return ok({ flowId: flowId.value, reports: Object.freeze(reports), now: now.value })
}

const validateFlowIdRequest = (
  request: unknown,
  fields: readonly string[]
): ResultType<{ readonly flowId: JobId; readonly now?: number }, FlowStoreV2Error> => {
  const checked = readDto(request, fields, ['flowId'])
  if (Result.isError(checked)) return checked
  const flowId = makeJobId(checked.value.flowId)
  if (Result.isError(flowId)) return flowId
  if (Object.prototype.hasOwnProperty.call(checked.value, 'now')) {
    const now = safeInteger(checked.value.now, 'now')
    if (Result.isError(now)) return now
    return ok({ flowId: flowId.value, now: now.value })
  }
  return ok({ flowId: flowId.value })
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

const isJsonValue = (value: unknown, seen = new Set<object>()): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen))
    return isPlainObject(value) && Object.values(value).every((item) => isJsonValue(item, seen))
  } finally {
    seen.delete(value)
  }
}

const validateObservation = (
  value: unknown,
  field: string
): ResultType<FlowChildObservation, FlowStoreV2Error> => {
  const fields = readDto(value, observationFields, ['childKey', 'state'])
  if (Result.isError(fields)) return invalid(field, fields.error.message)
  const childKey = boundedText(fields.value.childKey, `${field}.childKey`, maxFlowChildKeyLength)
  if (Result.isError(childKey)) return childKey
  if (!isObservationState(fields.value.state))
    return invalid(`${field}.state`, 'unsupported child state')
  if (fields.value.result !== undefined && !isJsonValue(fields.value.result))
    return invalid(`${field}.result`, 'must be JSON-compatible')
  const failure =
    fields.value.failure === undefined
      ? ok<SerializedJobFailure | undefined>(undefined)
      : validateSerializedJobFailure(fields.value.failure)
  if (Result.isError(failure)) return failure
  const observation = {
    childKey: childKey.value,
    state: fields.value.state
  } satisfies FlowChildObservation
  if (fields.value.result !== undefined) {
    Object.assign(observation, { result: fields.value.result as JsonValue })
  }
  if (failure.value !== undefined) Object.assign(observation, { failure: failure.value })
  return ok(observation)
}

const validateReconcile = (
  request: unknown
): ResultType<ReconcileFlowRequest, FlowStoreV2Error> => {
  const fields = readDto(request, reconcileFields, ['flowId', 'observations', 'now'])
  if (Result.isError(fields)) return fields
  const flowId = makeJobId(fields.value.flowId)
  const now = safeInteger(fields.value.now, 'now')
  const limit =
    fields.value.limit === undefined
      ? ok<number | undefined>(undefined)
      : safeInteger(fields.value.limit, 'limit', true)
  if (Result.isError(flowId)) return flowId
  if (Result.isError(now)) return now
  if (Result.isError(limit)) return limit
  if (
    !Array.isArray(fields.value.observations) ||
    fields.value.observations.length > hardFlowMaxChildren
  )
    return invalid('observations', 'must be an array within the hard child limit')
  if (limit.value !== undefined && limit.value > hardFlowMaxChildren)
    return invalid('limit', 'must not exceed the hard child limit')
  const observations: FlowChildObservation[] = []
  const seen = new Set<string>()
  for (const [index, value] of fields.value.observations
    .slice(0, limit.value ?? fields.value.observations.length)
    .entries()) {
    const observation = validateObservation(value, `observations[${index}]`)
    if (Result.isError(observation)) return observation
    if (seen.has(observation.value.childKey)) return invalid('observations', 'duplicate childKey')
    seen.add(observation.value.childKey)
    observations.push(observation.value)
  }
  const normalized = {
    flowId: flowId.value,
    observations,
    now: now.value
  } satisfies ReconcileFlowRequest
  if (limit.value !== undefined) Object.assign(normalized, { limit: limit.value })
  return ok(normalized)
}

const namespaceFor = (token: AnyJobStoreToken, namespace: string): string =>
  token.serviceTag === JobStore.serviceTag
    ? namespace
    : `${namespace}:${encodeURIComponent(token.serviceTag)}`

class SqliteFlowStoreImplementation implements SqliteFlowStoreInstance {
  readonly descriptor = descriptor
  private closed = false
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly database: SqliteDatabase,
    private readonly namespace: string
  ) {}

  private write<Value>(
    operation: string,
    callback: () => Operation<Value>
  ): Promise<Operation<Value>> {
    const run = (): Operation<Value> => {
      if (this.closed)
        return fail(
          new JobStoreFailure({
            operation: `flow.${operation}`,
            retryable: false,
            message: 'SQLite flow store is closed'
          })
        )
      try {
        this.database.exec('BEGIN IMMEDIATE')
        const result = callback()
        if (Result.isError(result)) {
          try {
            this.database.exec('ROLLBACK')
          } catch {
            // Preserve the protocol error.
          }
          return result
        }
        this.database.exec('COMMIT')
        return result
      } catch (cause) {
        try {
          this.database.exec('ROLLBACK')
        } catch {
          // Preserve the primary storage error.
        }
        return fail(storageFailure(operation, cause))
      }
    }
    const result = this.chain.then(
      () => withSqliteTransaction(this.database, run),
      () => withSqliteTransaction(this.database, run)
    )
    this.chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  fanOut(
    request: FlowFanOutRequest
  ): FlowStoreV2Operation<import('better-effect-mq').FlowFanOutResult> {
    const checked = validateFanOut(request)
    if (Result.isError(checked)) return checked
    const normalized = checked.value
    const digest = flowDigest(normalized)
    return this.write('fanOut', () => {
      const row = this.database
        .prepare(
          `SELECT id, state, flow, failure, lease_token, flow_lease_token, flow_name,
                  flow_parent_store_key, flow_depth, flow_manifest_digest
             FROM ${SQLITE_TABLES.jobs} WHERE namespace = ? AND id = ?`
        )
        .get(this.namespace, normalized.flowId)
      if (row === undefined || row === null)
        return fail(new JobNotFoundError({ jobId: normalized.flowId }))
      if (row.flow !== null && row.flow !== undefined) {
        if (row.flow_manifest_digest === digest) {
          const snapshot = loadSnapshot(this.database, this.namespace, normalized.flowId)
          return ok({
            status: 'already-applied',
            parent: snapshot.parent,
            children: snapshot.children
          })
        }
        return fail(
          new SettlementConflictError({
            jobId: normalized.flowId,
            leaseToken: normalized.leaseToken
          })
        )
      }
      if (row.state !== 'active' || row.lease_token !== normalized.leaseToken)
        return fail(
          new LeaseLostError({
            jobId: normalized.flowId,
            leaseToken: normalized.leaseToken,
            reason: 'mismatched-token'
          })
        )
      const flow = {
        flowName: normalized.flowName,
        failFast: normalized.failFast,
        pending: normalized.children.length,
        completed: 0,
        failed: 0,
        cancelled: 0
      }
      for (const child of normalized.children) {
        this.database
          .prepare(
            `INSERT INTO ${SQLITE_TABLES.flowChildren}
              (namespace, flow_id, child_key, name, version, store_key, child_job_id, request_json,
               status, result, failure, cascaded, pending_since_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, ?)`
          )
          .run(
            this.namespace,
            normalized.flowId,
            child.childKey,
            child.name,
            child.version,
            child.storeKey,
            child.childJobId,
            JSON.stringify(child.request),
            normalized.now
          )
      }
      const state = normalized.children.length === 0 ? 'waiting' : 'waiting-children'
      this.database
        .prepare(
          `UPDATE ${SQLITE_TABLES.jobs}
              SET state = ?, flow = ?, flow_manifest_digest = ?, flow_lease_token = ?,
                  flow_name = ?, flow_parent_store_key = ?, flow_depth = ?,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL,
                  cancel_requested = 0, cancellation_requested_at_ms = NULL,
                  result = NULL, failure = NULL, updated_at_ms = ?, processed_at_ms = ?
            WHERE namespace = ? AND id = ?`
        )
        .run(
          state,
          JSON.stringify(flow),
          digest,
          normalized.leaseToken,
          normalized.flowName,
          normalized.parentStoreKey,
          normalized.depth,
          normalized.now,
          normalized.now,
          this.namespace,
          normalized.flowId
        )
      this.updateRecordJson(normalized.flowId, state, normalized.now, undefined)
      const snapshot = loadSnapshot(this.database, this.namespace, normalized.flowId)
      return ok({ status: 'applied', parent: snapshot.parent, children: snapshot.children })
    })
  }

  recordChildResults(
    request: RecordChildResultsRequest
  ): FlowStoreV2Operation<RecordChildResultsResult> {
    const checked = validateReports(request)
    if (Result.isError(checked)) return checked
    const normalized = checked.value
    return this.write('recordChildResults', () => {
      // SQLite serializes writers; dependencies are still read and updated before the parent.
      const rows = this.database
        .prepare(
          `SELECT flow_id, child_key, name, version, store_key, child_job_id, request_json,
                  status, result, failure, cascaded, pending_since_ms
             FROM ${SQLITE_TABLES.flowChildren}
            WHERE namespace = ? AND flow_id = ? ORDER BY child_key COLLATE BINARY ASC`
        )
        .all(this.namespace, normalized.flowId)
      if (rows.length === 0) return fail(new JobNotFoundError({ jobId: normalized.flowId }))
      const children = new Map(
        rowsOf(rows).map((row) => [rowString(row, 'child_key'), asChild(row)])
      )
      const parentRow = this.database
        .prepare(
          `SELECT id AS flow_id, state, flow, failure, COALESCE(flow_lease_token, lease_token) AS lease_token,
                  flow_name, flow_parent_store_key AS parent_store_key, flow_depth AS depth, parent
             FROM ${SQLITE_TABLES.jobs} WHERE namespace = ? AND id = ?`
        )
        .get(this.namespace, normalized.flowId)
      if (parentRow === undefined || parentRow === null)
        return fail(new JobNotFoundError({ jobId: normalized.flowId }))
      const flowValue = validateFlowState(optionalJson(parentRow.flow, 'flow'))
      if (Result.isError(flowValue)) return fail(flowValue.error)
      let flow = flowValue.value
      let applied = 0
      let firstFailure: FlowChildReport | undefined
      for (const report of normalized.reports) {
        const child = children.get(report.childKey)
        if (child === undefined) return invalid('reports', 'unknown childKey')
        if (child.status !== 'pending') continue
        applied += 1
        if (firstFailure === undefined && report.outcome === 'failed') firstFailure = report
        flow = Object.freeze({
          ...flow,
          pending: flow.pending - 1,
          completed: flow.completed + (report.outcome === 'completed' ? 1 : 0),
          failed: flow.failed + (report.outcome === 'failed' ? 1 : 0),
          cancelled: flow.cancelled + (report.outcome === 'cancelled' ? 1 : 0)
        })
        this.database
          .prepare(
            `UPDATE ${SQLITE_TABLES.flowChildren}
                SET status = ?, result = ?, failure = ?
              WHERE namespace = ? AND flow_id = ? AND child_key = ? AND status = 'pending'`
          )
          .run(
            report.outcome,
            report.result === undefined ? null : JSON.stringify(report.result),
            report.failure === undefined ? null : JSON.stringify(report.failure),
            this.namespace,
            normalized.flowId,
            report.childKey
          )
      }
      let state = rowString(parentRow, 'state')
      let failure = asFailure(optionalJson(parentRow.failure, 'failure'))
      let parentSettled = false
      if (state === 'waiting-children' && flow.failFast && firstFailure !== undefined) {
        const remaining = [...children.values()].filter(
          (child) =>
            child.status === 'pending' &&
            !normalized.reports.some((report) => report.childKey === child.childKey)
        )
        for (const child of remaining) {
          this.database
            .prepare(
              `UPDATE ${SQLITE_TABLES.flowChildren}
                  SET status = 'cancelled', result = NULL, failure = NULL, cascaded = 0
                WHERE namespace = ? AND flow_id = ? AND child_key = ? AND status = 'pending'`
            )
            .run(this.namespace, normalized.flowId, child.childKey)
        }
        flow = Object.freeze({ ...flow, pending: 0, cancelled: flow.cancelled + remaining.length })
        state = 'failed'
        failure = firstFailure.failure
        parentSettled = true
      } else if (state === 'waiting-children' && flow.pending === 0) {
        state = 'waiting'
        parentSettled = true
      }
      this.database
        .prepare(
          `UPDATE ${SQLITE_TABLES.jobs}
              SET state = ?, flow = ?, failure = ?,
                  finished_at_ms = ?, updated_at_ms = ?
            WHERE namespace = ? AND id = ?`
        )
        .run(
          state,
          JSON.stringify(flow),
          failure === undefined ? null : JSON.stringify(failure),
          state === 'failed' || state === 'cancelled' ? normalized.now : null,
          normalized.now,
          this.namespace,
          normalized.flowId
        )
      this.updateRecordJson(normalized.flowId, state, normalized.now, failure)
      if (parentSettled && (state === 'failed' || state === 'cancelled'))
        this.appendParentReport(
          parentRow,
          normalized.flowId,
          state === 'failed' ? 'failed' : 'cancelled',
          failure,
          normalized.now
        )
      const snapshot = loadSnapshot(this.database, this.namespace, normalized.flowId)
      return ok({ applied, parentSettled, parent: snapshot.parent, children: snapshot.children })
    })
  }

  cancel(request: CancelFlowRequest): FlowStoreV2Operation<CancelFlowResult> {
    const checked = validateFlowIdRequest(request, cancelFields)
    if (Result.isError(checked)) return checked
    const normalized = checked.value
    return this.write('cancel', () => {
      const rows = this.database
        .prepare(
          `SELECT flow_id, child_key, name, version, store_key, child_job_id, request_json,
                  status, result, failure, cascaded, pending_since_ms
             FROM ${SQLITE_TABLES.flowChildren}
            WHERE namespace = ? AND flow_id = ? ORDER BY child_key COLLATE BINARY ASC`
        )
        .all(this.namespace, normalized.flowId)
      const parentRow = this.database
        .prepare(
          `SELECT id AS flow_id, state, flow, failure, COALESCE(flow_lease_token, lease_token) AS lease_token,
                  flow_name, flow_parent_store_key AS parent_store_key, flow_depth AS depth, parent
             FROM ${SQLITE_TABLES.jobs} WHERE namespace = ? AND id = ?`
        )
        .get(this.namespace, normalized.flowId)
      if (parentRow === undefined || parentRow === null)
        return fail(new JobNotFoundError({ jobId: normalized.flowId }))
      const children = rowsOf(rows).map(asChild)
      const flowValue = validateFlowState(optionalJson(parentRow.flow, 'flow'))
      if (Result.isError(flowValue)) return fail(flowValue.error)
      if (parentRow.state !== 'waiting-children') {
        const snapshot = loadSnapshot(this.database, this.namespace, normalized.flowId)
        return ok({
          cancelled: 0,
          parentSettled: false,
          parent: snapshot.parent,
          children: snapshot.children
        })
      }
      const pending = children.filter((child) => child.status === 'pending')
      for (const child of pending)
        this.database
          .prepare(
            `UPDATE ${SQLITE_TABLES.flowChildren}
                SET status = 'cancelled', result = NULL, failure = NULL, cascaded = 0
              WHERE namespace = ? AND flow_id = ? AND child_key = ? AND status = 'pending'`
          )
          .run(this.namespace, normalized.flowId, child.childKey)
      const flow = Object.freeze({
        ...flowValue.value,
        pending: 0,
        cancelled: flowValue.value.cancelled + pending.length
      })
      this.database
        .prepare(
          `UPDATE ${SQLITE_TABLES.jobs}
              SET state = 'cancelled', flow = ?, failure = NULL, finished_at_ms = ?, updated_at_ms = ?
            WHERE namespace = ? AND id = ?`
        )
        .run(
          JSON.stringify(flow),
          normalized.now,
          normalized.now,
          this.namespace,
          normalized.flowId
        )
      this.updateRecordJson(normalized.flowId, 'cancelled', normalized.now!, undefined)
      this.appendParentReport(parentRow, normalized.flowId, 'cancelled', undefined, normalized.now!)
      const snapshot = loadSnapshot(this.database, this.namespace, normalized.flowId)
      return ok({
        cancelled: pending.length,
        parentSettled: true,
        parent: snapshot.parent,
        children: snapshot.children
      })
    })
  }

  reconcile(request: ReconcileFlowRequest): FlowStoreV2Operation<ReconcileFlowResult> {
    const checked = validateReconcile(request)
    if (Result.isError(checked)) return checked
    const normalized = checked.value
    return this.write('reconcile', () => {
      const rows = this.database
        .prepare(
          `SELECT flow_id, child_key, name, version, store_key, child_job_id, request_json,
                  status, result, failure, cascaded, pending_since_ms
             FROM ${SQLITE_TABLES.flowChildren}
            WHERE namespace = ? AND flow_id = ? ORDER BY child_key COLLATE BINARY ASC`
        )
        .all(this.namespace, normalized.flowId)
      if (rows.length === 0) return fail(new JobNotFoundError({ jobId: normalized.flowId }))
      const children = new Map(
        rowsOf(rows).map((row) => [
          rowString(row, 'child_key'),
          { record: asChild(row), spec: asSpec(row) }
        ])
      )
      const enqueue: FlowChildSpec[] = []
      const reports: FlowChildReport[] = []
      const cascade: FlowChildSpec[] = []
      const cascadeLimit = normalized.limit ?? hardFlowMaxChildren
      for (const observation of normalized.observations) {
        const entry = children.get(observation.childKey)
        if (entry === undefined) return invalid('observations', 'unknown childKey')
        if (entry.record.status === 'pending') {
          this.database
            .prepare(
              `UPDATE ${SQLITE_TABLES.flowChildren} SET pending_since_ms = ?
                WHERE namespace = ? AND flow_id = ? AND child_key = ? AND status = 'pending'`
            )
            .run(normalized.now, this.namespace, normalized.flowId, observation.childKey)
          if (observation.state === 'missing') enqueue.push(entry.spec)
          if (
            observation.state === 'completed' ||
            observation.state === 'failed' ||
            observation.state === 'cancelled'
          ) {
            const report = validateFlowChildReport({
              flowId: normalized.flowId,
              childKey: observation.childKey,
              outcome: observation.state,
              result: observation.result,
              failure: observation.failure
            })
            if (Result.isError(report)) return fail(report.error)
            reports.push(report.value)
          }
        }
        if (
          entry.record.status === 'cancelled' &&
          !entry.record.cascaded &&
          cascade.length < cascadeLimit
        )
          cascade.push(entry.spec)
      }
      const seen = new Set(cascade.map((spec) => spec.childKey))
      for (const entry of children.values()) {
        if (
          entry.record.status === 'cancelled' &&
          !entry.record.cascaded &&
          !seen.has(entry.spec.childKey) &&
          cascade.length < cascadeLimit
        )
          cascade.push(entry.spec)
      }
      return ok({
        enqueue: Object.freeze(enqueue),
        reports: Object.freeze(reports),
        cascade: Object.freeze(cascade)
      })
    })
  }

  markCascaded(request: MarkCascadedRequest): FlowStoreV2Operation<MarkCascadedResult> {
    const checked = readDto(request, cascadeFields, ['flowId', 'childKeys'])
    if (Result.isError(checked)) return checked
    const flowId = makeJobId(checked.value.flowId)
    if (Result.isError(flowId)) return flowId
    if (
      !Array.isArray(checked.value.childKeys) ||
      checked.value.childKeys.length > hardFlowMaxChildren
    )
      return invalid('childKeys', 'must be an array within the hard child limit')
    const keys: string[] = []
    const seen = new Set<string>()
    for (const [index, value] of checked.value.childKeys.entries()) {
      const key = boundedText(value, `childKeys[${index}]`, maxFlowChildKeyLength)
      if (Result.isError(key)) return key
      if (seen.has(key.value)) return invalid('childKeys', 'duplicate childKey')
      seen.add(key.value)
      keys.push(key.value)
    }
    return this.write('markCascaded', () => {
      const rows = this.database
        .prepare(
          `SELECT flow_id, child_key, name, version, store_key, child_job_id, request_json,
                  status, result, failure, cascaded, pending_since_ms
             FROM ${SQLITE_TABLES.flowChildren}
            WHERE namespace = ? AND flow_id = ? ORDER BY child_key COLLATE BINARY ASC`
        )
        .all(this.namespace, flowId.value)
      if (rows.length === 0) return fail(new JobNotFoundError({ jobId: flowId.value }))
      const requested = new Set(keys)
      let marked = 0
      for (const row of rowsOf(rows)) {
        const child = asChild(row)
        if (!requested.has(child.childKey) || child.status !== 'cancelled' || child.cascaded)
          continue
        this.database
          .prepare(
            `UPDATE ${SQLITE_TABLES.flowChildren} SET cascaded = 1
              WHERE namespace = ? AND flow_id = ? AND child_key = ? AND status = 'cancelled' AND cascaded = 0`
          )
          .run(this.namespace, flowId.value, child.childKey)
        marked += 1
      }
      const snapshot = loadSnapshot(this.database, this.namespace, flowId.value)
      return ok({ marked, children: snapshot.children })
    })
  }

  appendChildReport(
    request: AppendChildReportRequest
  ): FlowStoreV2Operation<AppendChildReportResult> {
    const checked = validateFlowOutboxEntry(request)
    if (Result.isError(checked)) return fail(checked.error)
    const entry = checked.value
    return this.write('appendChildReport', () => {
      const existing = this.database
        .prepare(
          `SELECT id, flow_name, parent_store_key, report_json FROM ${SQLITE_TABLES.flowOutbox} WHERE namespace = ? AND id = ?`
        )
        .get(this.namespace, entry.id)
      if (existing !== undefined && existing !== null) {
        const stored = asOutbox(existing)
        if (canonicalJson(stored) !== canonicalJson(entry))
          return fail(
            new SettlementConflictError({
              jobId: entry.report.flowId,
              leaseToken: makeLeaseToken('outbox-conflict').unwrap()
            })
          )
        return ok({ status: 'already-applied', entry: stored })
      }
      this.database
        .prepare(
          `INSERT INTO ${SQLITE_TABLES.flowOutbox}(namespace, id, flow_name, parent_store_key, report_json, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          this.namespace,
          entry.id,
          entry.flowName,
          entry.parentStoreKey,
          JSON.stringify(entry.report),
          0
        )
      return ok({ status: 'applied', entry })
    })
  }

  peekOutbox(
    request: PeekOutboxRequest
  ): FlowStoreV2Operation<import('better-effect-mq').FlowOutboxPage> {
    const checked = readDto(request, outboxPeekFields)
    if (Result.isError(checked)) return checked
    const limit =
      checked.value.limit === undefined ? ok(100) : safeInteger(checked.value.limit, 'limit', true)
    if (Result.isError(limit)) return limit
    if (limit.value > hardFlowMaxChildren)
      return invalid('limit', 'must not exceed the hard child limit')
    const cursor =
      checked.value.cursor === undefined
        ? ok<string | undefined>(undefined)
        : boundedText(checked.value.cursor, 'cursor', maxFlowChildIdLength)
    const parentStoreKey =
      checked.value.parentStoreKey === undefined
        ? ok<string | undefined>(undefined)
        : boundedText(checked.value.parentStoreKey, 'parentStoreKey', maxFlowStoreKeyLength)
    if (Result.isError(cursor)) return cursor
    if (Result.isError(parentStoreKey)) return parentStoreKey
    try {
      const values: unknown[] = [this.namespace]
      const conditions = ['namespace = ?']
      if (parentStoreKey.value !== undefined) {
        values.push(parentStoreKey.value)
        conditions.push('parent_store_key = ?')
      }
      if (cursor.value !== undefined) {
        conditions.push(
          `row_sequence > COALESCE((SELECT row_sequence FROM ${SQLITE_TABLES.flowOutbox} WHERE namespace = ? AND id = ?), 0)`
        )
        values.push(this.namespace, cursor.value)
      }
      values.push(limit.value + 1)
      const rows = this.database
        .prepare(
          `SELECT id, flow_name, parent_store_key, report_json FROM ${SQLITE_TABLES.flowOutbox}
             WHERE ${conditions.join(' AND ')} ORDER BY row_sequence ASC, id COLLATE BINARY ASC LIMIT ?`
        )
        .all(...values)
      const all = rowsOf(rows).map(asOutbox)
      const hasMore = all.length > limit.value
      const entries = Object.freeze(all.slice(0, limit.value))
      return ok({
        entries,
        cursor: hasMore && entries.length > 0 ? entries.at(-1)!.id : undefined,
        hasMore
      })
    } catch (cause) {
      return fail(storageFailure('peekOutbox', cause))
    }
  }

  ackOutbox(request: AckOutboxRequest): FlowStoreV2Operation<AckOutboxResult> {
    const checked = readDto(request, outboxAckFields, ['entries'])
    if (Result.isError(checked)) return checked
    if (!Array.isArray(checked.value.entries) || checked.value.entries.length > hardFlowMaxChildren)
      return invalid('entries', 'must be an array within the hard child limit')
    const entries: FlowOutboxEntry[] = []
    const seen = new Map<string, string>()
    for (const [index, value] of checked.value.entries.entries()) {
      const entry = validateFlowOutboxEntry(value)
      if (Result.isError(entry)) return invalid(`entries[${index}]`, entry.error.message)
      const digest = canonicalJson(entry.value)
      const previous = seen.get(entry.value.id)
      if (previous !== undefined && previous !== digest)
        return invalid('entries', 'contains conflicting duplicate outbox entries')
      if (previous === undefined) {
        seen.set(entry.value.id, digest)
        entries.push(entry.value)
      }
    }
    return this.write('ackOutbox', () => {
      let acknowledged = 0
      let skipped = 0
      for (const entry of entries) {
        const row = this.database
          .prepare(
            `SELECT id, flow_name, parent_store_key, report_json FROM ${SQLITE_TABLES.flowOutbox} WHERE namespace = ? AND id = ?`
          )
          .get(this.namespace, entry.id)
        if (row === undefined || row === null) {
          skipped += 1
          continue
        }
        const stored = asOutbox(row)
        if (canonicalJson(stored) !== canonicalJson(entry)) {
          skipped += 1
          continue
        }
        this.database
          .prepare(`DELETE FROM ${SQLITE_TABLES.flowOutbox} WHERE namespace = ? AND id = ?`)
          .run(this.namespace, entry.id)
        acknowledged += 1
      }
      return ok({ acknowledged, skipped })
    })
  }

  getFlow(request: GetFlowRequest): FlowStoreV2Operation<FlowSnapshot | undefined> {
    const checked = validateFlowIdRequest(request, getFlowFields)
    if (Result.isError(checked)) return checked
    if (this.closed)
      return fail(
        new JobStoreFailure({
          operation: 'flow.getFlow',
          retryable: false,
          message: 'SQLite flow store is closed'
        })
      )
    try {
      const row = this.database
        .prepare(`SELECT flow FROM ${SQLITE_TABLES.jobs} WHERE namespace = ? AND id = ?`)
        .get(this.namespace, checked.value.flowId)
      if (row === undefined || row === null || row.flow === null || row.flow === undefined)
        return ok(undefined)
      return ok(loadSnapshot(this.database, this.namespace, checked.value.flowId))
    } catch (cause) {
      return fail(storageFailure('getFlow', cause))
    }
  }

  private updateRecordJson(
    flowId: string,
    state: string,
    now: number,
    failure: SerializedJobFailure | undefined
  ): void {
    const row = this.database
      .prepare(`SELECT record_json FROM ${SQLITE_TABLES.jobs} WHERE namespace = ? AND id = ?`)
      .get(this.namespace, flowId)
    if (row === undefined || row === null || typeof row.record_json !== 'string') return
    const current = JSON.parse(row.record_json)
    if (!isPlainObject(current)) return
    const next = {
      ...current,
      state,
      updatedAt: now,
      processedAt: now,
      finishedAt: state === 'failed' || state === 'cancelled' ? now : undefined,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      cancellationRequestedAt: undefined,
      result: undefined,
      failure
    }
    this.database
      .prepare(`UPDATE ${SQLITE_TABLES.jobs} SET record_json = ? WHERE namespace = ? AND id = ?`)
      .run(JSON.stringify(next), this.namespace, flowId)
  }

  private appendParentReport(
    row: Row,
    jobId: string,
    outcome: 'failed' | 'cancelled',
    failure: SerializedJobFailure | undefined,
    now: number
  ): void {
    const parentValue = optionalJson(row.parent, 'parent')
    if (parentValue === undefined) return
    const parent = validateParentEnvelope(parentValue)
    if (Result.isError(parent)) throw parent.error
    const report = validateFlowChildReport({
      flowId: parent.value.flowId,
      childKey: parent.value.childKey,
      outcome,
      result: undefined,
      failure: outcome === 'failed' ? failure : undefined
    })
    if (Result.isError(report)) throw report.error
    this.database
      .prepare(
        `INSERT INTO ${SQLITE_TABLES.flowOutbox}(namespace, id, flow_name, parent_store_key, report_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, id) DO NOTHING`
      )
      .run(
        this.namespace,
        `flow-report/${jobId}/flow`,
        parent.value.flowName,
        parent.value.parentStoreKey,
        JSON.stringify(report.value),
        now
      )
  }

  async dispose(): Promise<void> {
    this.closed = true
    await this.chain
  }
}

const open = (
  config: SqliteFlowStoreConfig,
  token?: AnyFlowStoreToken
): SqliteFlowStoreInstance => {
  const normalized = normalizeSqliteJobStoreConfig(config)
  const marker = normalized.database
    .prepare(`SELECT version FROM ${SQLITE_TABLES.schemaVersions} WHERE component = ?`)
    .get(MIGRATION_COMPONENT)
  const version = marker === undefined || marker === null ? undefined : Number(marker.version)
  if (version !== 4) throw new SqliteFlowProtocolMismatchError(version)
  SqliteMigrator.validate(normalized.database)
  const namespace =
    token === undefined ? normalized.namespace : namespaceFor(token.jobStore, normalized.namespace)
  return new SqliteFlowStoreImplementation(normalized.database, namespace)
}

const makeLayer = <Token extends AnyFlowStoreToken>(token: Token, config: SqliteFlowStoreConfig) =>
  Layer.scoped(
    token,
    () =>
      FlowStore.of(open(config, token) as never) as unknown as ServiceContract<InstanceType<Token>>,
    (store) => (store as unknown as SqliteFlowStoreInstance).dispose()
  )

export const SqliteFlowStore = Object.freeze({
  make(config: SqliteFlowStoreConfig): SqliteFlowStoreInstance {
    return open(config)
  },
  layer(config: SqliteFlowStoreConfig): Layer<FlowStoreNamespace.Instance, never> {
    return makeLayer(FlowStore, config)
  },
  layerFor<Token extends AnyFlowStoreToken>(
    token: Token,
    config: SqliteFlowStoreConfig
  ): Layer<InstanceType<Token>, never> {
    return makeLayer(token, config)
  }
})
