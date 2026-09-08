// oxlint-disable anti-slop/no-unknown-parameters -- MySQL rows and public flow DTOs cross an untyped persistence boundary.
// oxlint-disable anti-slop/no-unknown-returns -- decoded JSON is validated before it leaves this module.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- fixed protocol objects are assembled after validation.
// oxlint-disable anti-slop/no-runtime-typeof -- database and public DTO boundaries are narrowed here.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to validated SQL rows.
// oxlint-disable anti-slop/no-chained-type-assertions -- the legacy FlowStoreV2Error union predates the event readiness error.

import { createHash } from 'node:crypto'
import { Result, type Result as ResultType } from 'better-result'
import {
  defaultFlowLimits,
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
  JobEventWriterRejectedError,
  JobNotFoundError,
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
  type DurableJobEventInput,
  type DurableJobEventType,
  type JobEventStoreWriter,
  type AckOutboxRequest,
  type AckOutboxResult,
  type AppendChildReportRequest,
  type AppendChildReportResult,
  type CancelFlowRequest,
  type CancelFlowResult,
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
  type JobId,
  type MarkCascadedRequest,
  type MarkCascadedResult,
  type PeekOutboxRequest,
  type ReconcileFlowRequest,
  type ReconcileFlowResult,
  type RecordChildResultsRequest,
  type RecordChildResultsResult,
  type SerializedJobFailure
} from 'better-effect-mq'

import {
  normalizeMySqlJobStoreConfig,
  normalizeMySqlJobStoreConnectionConfig,
  type MySqlJobStoreConfig,
  type MySqlJobStoreConnectionConfig,
  type PoolConnection
} from './config'
import { MySqlClient } from './client'
import {
  appendMySqlJobEvent,
  assertMySqlJobEventWriterReady,
  ensureMySqlJobEventActivationTable,
  flushMySqlJobEventWakes
} from './event-store'
import { MySqlFlowProtocolMismatchError } from './errors'
import { MYSQL_FLOW_TABLES, MYSQL_TABLES, quoteIdentifier } from './schema'

const flowDescriptor: FlowStoreV2Descriptor = Object.freeze({
  protocolVersion: protocolVersionV2,
  layoutVersion: flowLayoutVersion,
  migration: makeFlowMigration({ status: 'complete', from: undefined, to: flowLayoutVersion })
})

const flowMigrationVersion = 5
const maxRetries = 3
const eventMutationOperations = new Set([
  'fanOut',
  'recordChildResults',
  'cancel',
  'reconcile',
  'markCascaded',
  'appendChildReport',
  'ackOutbox'
])
const defaultEventWriter: JobEventStoreWriter = Object.freeze({
  id: 'better-effect-mq-mysql',
  version: 'current',
  canAppend: true
})

type QueryRow = Readonly<Record<string, unknown>>
type FlowResult<Value> = ResultType<Value, FlowStoreV2Error>
type Transaction = PoolConnection
type EventTransactionOptions = {
  readonly eventsAvailable: boolean
  readonly eventWriter: JobEventStoreWriter
}

const ok = <Value>(value: Value): FlowResult<Value> => Result.ok(value)
const fail = <Value>(error: FlowStoreV2Error): FlowResult<Value> => Result.err(error)
const invalid = <Value>(field: string, message: string): FlowResult<Value> =>
  fail(new JobDefinitionError({ field, message }))
const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const retryable = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false
  const error = cause as {
    readonly code?: unknown
    readonly errno?: unknown
    readonly sqlState?: unknown
  }
  return (
    error.code === 'ER_LOCK_DEADLOCK' ||
    error.code === 'ER_LOCK_WAIT_TIMEOUT' ||
    error.errno === 1213 ||
    error.errno === 1205 ||
    error.sqlState === '40001'
  )
}
const storageFailure = (operation: string, cause: unknown): FlowStoreV2Error => {
  if (JobEventWriterRejectedError.is(cause)) {
    // SAFETY: the adapter preserves this tagged readiness failure at runtime; the legacy FlowStoreV2Error union predates the event extension.
    return cause as unknown as FlowStoreV2Error
  }
  return new JobStoreFailure({
    operation: `flow.${operation}`,
    retryable: retryable(cause),
    message: `MySQL flow operation failed: ${cause instanceof Error ? cause.message : 'storage error'}`
  })
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

const json = (value: unknown): string => JSON.stringify(value)
const identityHash = (...values: readonly string[]): Buffer => {
  const hash = createHash('sha256')
  for (const value of values) hash.update(String(value.length)).update(':').update(value)
  return hash.digest()
}
const parsedJson = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined
  return typeof value === 'string' ? JSON.parse(value) : value
}
const asRowObject = (value: unknown): QueryRow => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('MySQL row is not an object')
  return value as QueryRow
}
const rowString = (row: QueryRow, field: string): string => {
  const value = row[field]
  if (typeof value !== 'string') throw new TypeError(`invalid ${field}`)
  return value
}
const rowNumber = (row: QueryRow, field: string): number => {
  const value = row[field]
  const number = typeof value === 'bigint' || typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number))
    throw new TypeError(`invalid ${field}`)
  return number
}
const rowJson = (row: QueryRow, field: string): unknown => parsedJson(row[field])
const rowBoolean = (row: QueryRow, field: string): boolean => {
  const value = row[field]
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  throw new TypeError(`invalid ${field}`)
}
const asFailure = (value: unknown): SerializedJobFailure | undefined => {
  if (value === null || value === undefined) return undefined
  const checked = validateSerializedJobFailure(value)
  if (Result.isError(checked)) throw new TypeError(`invalid failure: ${checked.error.message}`)
  return checked.value
}
const asParent = (row: QueryRow): FlowParentRecord => {
  const flowId = makeJobId(rowString(row, 'flow_id'))
  const leaseToken = makeLeaseToken(rowString(row, 'lease_token'))
  const envelope = validateParentEnvelope({
    flowName: rowString(row, 'flow_name'),
    flowId: rowString(row, 'flow_id'),
    childKey: 'flow-root',
    parentStoreKey: rowString(row, 'parent_store_key'),
    depth: rowNumber(row, 'depth')
  })
  const flow = validateFlowState(rowJson(row, 'flow'))
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
    failure: asFailure(rowJson(row, 'failure'))
  })
}
const asChild = (row: QueryRow): FlowChildRecord => {
  const checked = validateFlowChildRecord({
    flowId: rowString(row, 'flow_id'),
    childKey: rowString(row, 'child_key'),
    name: rowString(row, 'name'),
    version: rowNumber(row, 'version'),
    storeKey: rowString(row, 'store_key'),
    childJobId: rowString(row, 'child_job_id'),
    status: rowString(row, 'status'),
    result: rowJson(row, 'result'),
    failure: rowJson(row, 'failure'),
    cascaded: rowBoolean(row, 'cascaded'),
    pendingSinceMs: rowNumber(row, 'pending_since_ms')
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}
const asSpec = (row: QueryRow): FlowChildSpec => {
  const checked = validateFlowChildSpec({
    childKey: rowString(row, 'child_key'),
    name: rowString(row, 'name'),
    version: rowNumber(row, 'version'),
    storeKey: rowString(row, 'store_key'),
    childJobId: rowString(row, 'child_job_id'),
    request: rowJson(row, 'request')
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const reportWithOptionalFields = (value: unknown) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const report = value as Record<string, unknown>
  return { ...report, result: report.result, failure: report.failure }
}

const asOutbox = (row: QueryRow): FlowOutboxEntry => {
  const checked = validateFlowOutboxEntry({
    id: rowString(row, 'id'),
    flowName: rowString(row, 'flow_name'),
    parentStoreKey: rowString(row, 'parent_store_key'),
    report: reportWithOptionalFields(parsedJson(row.report))
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const childSelect = `flow_id,child_key,name,version,store_key,child_job_id,request,status,result,failure,cascaded,pending_since_ms`
const parentSelect = `id AS flow_id,state,flow,failure,COALESCE(flow_lease_token,lease_token) AS lease_token,flow_name,flow_parent_store_key AS parent_store_key,flow_depth AS depth`
const loadSnapshot = async (
  connection: Transaction,
  namespace: string,
  flowId: string,
  lockParent = false
): Promise<FlowSnapshot> => {
  const parent = await connection.query<QueryRow>(
    `SELECT ${parentSelect} FROM ${quoteIdentifier(MYSQL_TABLES.jobs)} WHERE namespace=? AND id=?${lockParent ? ' FOR UPDATE' : ''}`,
    [namespace, flowId]
  )
  if (parent.rows[0] === undefined) throw new Error('flow parent was not found')
  const children = await connection.query<QueryRow>(
    `SELECT ${childSelect} FROM ${quoteIdentifier(MYSQL_FLOW_TABLES.children)} WHERE namespace=? AND flow_id=? ORDER BY child_key COLLATE utf8mb4_bin ASC`,
    [namespace, flowId]
  )
  const outbox = await connection.query<QueryRow>(
    `SELECT id,flow_name,parent_store_key,report FROM ${quoteIdentifier(MYSQL_FLOW_TABLES.outbox)} WHERE namespace=? AND JSON_UNQUOTE(JSON_EXTRACT(report,'$.flowId'))=? ORDER BY sequence ASC`,
    [namespace, flowId]
  )
  return Object.freeze({
    parent: asParent(asRowObject(parent.rows[0])),
    children: Object.freeze(children.rows.map((row) => asChild(asRowObject(row)))),
    outbox: Object.freeze(outbox.rows.map((row) => asOutbox(asRowObject(row))))
  })
}

const withTransaction = async <Value>(
  client: MySqlClient,
  operation: string,
  callback: (transaction: Transaction) => Promise<FlowResult<Value>>,
  options: EventTransactionOptions
): Promise<FlowResult<Value>> => {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    let connection: Transaction | undefined
    let committed = false
    try {
      connection = await client.pool.getConnection()
      await connection.beginTransaction()
      if (eventMutationOperations.has(operation))
        await assertMySqlJobEventWriterReady(
          connection,
          client.namespace,
          operation,
          options.eventWriter,
          options.eventsAvailable
        )
      const result = await callback(connection)
      if (Result.isError(result)) {
        await connection.rollback()
        return result
      }
      await connection.commit()
      committed = true
      flushMySqlJobEventWakes(connection)
      return result
    } catch (cause) {
      if (connection !== undefined && !committed) {
        try {
          await connection.rollback()
        } catch {
          // Preserve the original storage failure.
        }
      }
      if (retryable(cause) && attempt + 1 < maxRetries) continue
      return fail(storageFailure(operation, cause))
    } finally {
      connection?.release()
    }
  }
  return fail(storageFailure(operation, new Error('retry budget exhausted')))
}

const normalizeFanOut = (request: FlowFanOutRequest): FlowResult<FlowFanOutRequest> => {
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
  if (Result.isError(flowId)) return fail(flowId.error)
  if (Result.isError(leaseToken)) return fail(leaseToken.error)
  if (Result.isError(parent)) return fail(parent.error)
  if (Result.isError(limits)) return fail(limits.error)
  if (Result.isError(outcome)) return fail(outcome.error)
  for (const child of outcome.value.children) {
    const expected = makeFlowChildId({
      parentStoreKey: parent.value.parentStoreKey,
      flowId: parent.value.flowId,
      childKey: child.childKey
    })
    if (Result.isError(expected) || expected.value !== child.childJobId)
      return fail(
        new JobStoreFailure({
          operation: 'flow.fanOut',
          retryable: false,
          message: 'child ID is not deterministic'
        })
      )
  }
  return ok({
    ...request,
    flowId: flowId.value,
    leaseToken: leaseToken.value,
    children: outcome.value.children
  })
}

const normalizeReports = (
  request: RecordChildResultsRequest
): FlowResult<{
  readonly flowId: JobId
  readonly reports: readonly FlowChildReport[]
  readonly now: number
}> => {
  const flowId = makeJobId(request.flowId)
  if (Result.isError(flowId)) return fail(flowId.error)
  if (!Array.isArray(request.reports) || request.reports.length > hardFlowMaxChildren)
    return invalid('reports', 'must be an array within the hard child limit')
  if (!validTimestamp(request.now)) return invalid('now', 'must be a non-negative safe integer')
  const reports: FlowChildReport[] = []
  const seen = new Map<string, string>()
  for (const report of request.reports) {
    const checked = validateFlowChildReport(report)
    if (Result.isError(checked)) return fail(checked.error)
    if (checked.value.flowId !== flowId.value)
      return fail(
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
  return ok({ flowId: flowId.value, reports, now: request.now })
}

class MySqlFlowStoreImplementation implements FlowStoreV2 {
  readonly descriptor = flowDescriptor
  private disposal: Promise<void> | undefined

  constructor(
    private readonly client: MySqlClient,
    private readonly ownsClient: boolean,
    private readonly eventsAvailable: boolean,
    private readonly eventWriter: JobEventStoreWriter
  ) {}

  private transactionOptions(): EventTransactionOptions {
    return { eventsAvailable: this.eventsAvailable, eventWriter: this.eventWriter }
  }

  private async appendEvent(
    transaction: Transaction,
    type: DurableJobEventType,
    flowId: string | undefined,
    flowName: string | undefined,
    recordedAtMs: number,
    attributes: Readonly<Record<string, string>>
  ): Promise<void> {
    if (!this.eventsAvailable || !this.eventWriter.canAppend) return
    const input: DurableJobEventInput = {
      type,
      recordedAtMs,
      jobId: flowId as never,
      queue: undefined,
      name: flowName,
      version: undefined,
      state: undefined,
      attempt: undefined,
      delivery: undefined,
      workerId: undefined,
      outcome: undefined,
      failureKind: undefined,
      duplicate: undefined,
      attributes: Object.freeze({ ...attributes })
    }
    await appendMySqlJobEvent(transaction, this.client, input)
  }

  async fanOut(request: FlowFanOutRequest): Promise<FlowResult<FlowFanOutResult>> {
    const checked = normalizeFanOut(request)
    if (Result.isError(checked)) return checked
    const normalized = checked.value
    const digest = flowDigest(normalized)
    return withTransaction(
      this.client,
      'fanOut',
      async (transaction) => {
        const result = await transaction.query<QueryRow>(
          `SELECT ${parentSelect},flow_manifest_digest FROM ${quoteIdentifier(MYSQL_TABLES.jobs)} WHERE namespace=? AND id=? FOR UPDATE`,
          [this.client.namespace, normalized.flowId]
        )
        const row = result.rows[0]
        if (row === undefined) return fail(new JobNotFoundError({ jobId: normalized.flowId }))
        const current = asRowObject(row)
        const currentFlow = rowJson(current, 'flow')
        if (currentFlow !== undefined) {
          if (rowString(current, 'flow_manifest_digest') === digest) {
            const snapshot = await loadSnapshot(
              transaction,
              this.client.namespace,
              normalized.flowId
            )
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
        if (
          rowString(current, 'state') !== 'active' ||
          rowString(current, 'lease_token') !== normalized.leaseToken
        )
          return fail(
            new LeaseLostError({
              jobId: normalized.flowId,
              leaseToken: normalized.leaseToken,
              reason: 'mismatched-token'
            })
          )
        const flow = Object.freeze({
          flowName: normalized.flowName,
          failFast: normalized.failFast,
          pending: normalized.children.length,
          completed: 0,
          failed: 0,
          cancelled: 0
        })
        for (const child of normalized.children)
          await transaction.query(
            `INSERT INTO ${quoteIdentifier(MYSQL_FLOW_TABLES.children)} (namespace,flow_id,child_key,name,version,store_key,child_job_id,request,status,result,failure,cascaded,pending_since_ms,flow_child_identity,child_job_identity) VALUES (?,?,?,?,?,?,?,?,'pending',NULL,NULL,FALSE,?,?,?)`,
            [
              this.client.namespace,
              normalized.flowId,
              child.childKey,
              child.name,
              child.version,
              child.storeKey,
              child.childJobId,
              json(child.request),
              normalized.now,
              identityHash(this.client.namespace, normalized.flowId, child.childKey),
              identityHash(this.client.namespace, child.childJobId)
            ]
          )
        await transaction.query(
          `UPDATE ${quoteIdentifier(MYSQL_TABLES.jobs)} SET state=?,flow=?,flow_manifest_digest=?,flow_lease_token=?,flow_name=?,flow_parent_store_key=?,flow_depth=?,lease_owner=NULL,lease_token=NULL,lease_expires_at_ms=NULL,cancel_requested=FALSE,cancellation_requested_at_ms=NULL,updated_at_ms=?,processed_at_ms=? WHERE namespace=? AND id=?`,
          [
            normalized.children.length === 0 ? 'waiting' : 'waiting-children',
            json(flow),
            digest,
            normalized.leaseToken,
            normalized.flowName,
            normalized.parentStoreKey,
            normalized.depth,
            normalized.now,
            normalized.now,
            this.client.namespace,
            normalized.flowId
          ]
        )
        const snapshot = await loadSnapshot(transaction, this.client.namespace, normalized.flowId)
        await this.appendEvent(
          transaction,
          'flow-fan-out',
          normalized.flowId,
          normalized.flowName,
          normalized.now,
          { children: String(normalized.children.length) }
        )
        return ok({ status: 'applied', parent: snapshot.parent, children: snapshot.children })
      },
      this.transactionOptions()
    )
  }

  async recordChildResults(
    request: RecordChildResultsRequest
  ): Promise<FlowResult<RecordChildResultsResult>> {
    const normalized = normalizeReports(request)
    if (Result.isError(normalized)) return normalized
    return withTransaction(
      this.client,
      'recordChildResults',
      async (transaction) => {
        const childRows = await transaction.query<QueryRow>(
          `SELECT ${childSelect} FROM ${quoteIdentifier(MYSQL_FLOW_TABLES.children)} WHERE namespace=? AND flow_id=? ORDER BY child_key COLLATE utf8mb4_bin ASC FOR UPDATE`,
          [this.client.namespace, normalized.value.flowId]
        )
        const children = new Map(
          childRows.rows.map((row) => {
            const value = asChild(asRowObject(row))
            return [value.childKey, value] as const
          })
        )
        if (children.size === 0)
          return fail(new JobNotFoundError({ jobId: normalized.value.flowId }))
        const parentResult = await transaction.query<QueryRow>(
          `SELECT ${parentSelect} FROM ${quoteIdentifier(MYSQL_TABLES.jobs)} WHERE namespace=? AND id=? FOR UPDATE`,
          [this.client.namespace, normalized.value.flowId]
        )
        if (parentResult.rows[0] === undefined)
          return fail(new JobNotFoundError({ jobId: normalized.value.flowId }))
        const parentRow = asRowObject(parentResult.rows[0])
        const flowChecked = validateFlowState(rowJson(parentRow, 'flow'))
        if (Result.isError(flowChecked)) return fail(flowChecked.error)
        let flow = flowChecked.value
        let applied = 0
        let firstFailure: FlowChildReport | undefined
        for (const report of normalized.value.reports) {
          const child = children.get(report.childKey)
          if (child === undefined)
            return fail(
              new JobStoreFailure({
                operation: 'flow.recordChildResults',
                retryable: false,
                message: 'unknown child key'
              })
            )
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
          await transaction.query(
            `UPDATE ${quoteIdentifier(MYSQL_FLOW_TABLES.children)} SET status=?,result=?,failure=? WHERE namespace=? AND flow_id=? AND child_key=? AND status='pending'`,
            [
              report.outcome,
              report.result === undefined ? null : json(report.result),
              report.failure === undefined ? null : json(report.failure),
              this.client.namespace,
              normalized.value.flowId,
              report.childKey
            ]
          )
        }
        let state = rowString(parentRow, 'state')
        let failure = asFailure(rowJson(parentRow, 'failure'))
        let parentSettled = false
        if (state === 'waiting-children' && flow.failFast && firstFailure !== undefined) {
          const reported = new Set(normalized.value.reports.map((report) => report.childKey))
          const remaining = [...children.values()].filter(
            (child) => child.status === 'pending' && !reported.has(child.childKey)
          )
          for (const child of remaining)
            await transaction.query(
              `UPDATE ${quoteIdentifier(MYSQL_FLOW_TABLES.children)} SET status='cancelled',result=NULL,failure=NULL,cascaded=FALSE WHERE namespace=? AND flow_id=? AND child_key=? AND status='pending'`,
              [this.client.namespace, normalized.value.flowId, child.childKey]
            )
          flow = Object.freeze({
            ...flow,
            pending: 0,
            cancelled: flow.cancelled + remaining.length
          })
          state = 'failed'
          failure = firstFailure.failure
          parentSettled = true
        } else if (state === 'waiting-children' && flow.pending === 0) {
          state = 'waiting'
          parentSettled = true
        }
        await transaction.query(
          `UPDATE ${quoteIdentifier(MYSQL_TABLES.jobs)} SET state=?,flow=?,failure=?,finished_at_ms=CASE WHEN ? IN ('failed','cancelled') THEN ? ELSE finished_at_ms END,updated_at_ms=? WHERE namespace=? AND id=?`,
          [
            state,
            json(flow),
            failure === undefined ? null : json(failure),
            state,
            normalized.value.now,
            normalized.value.now,
            this.client.namespace,
            normalized.value.flowId
          ]
        )
        const snapshot = await loadSnapshot(
          transaction,
          this.client.namespace,
          normalized.value.flowId
        )
        if (applied > 0)
          await this.appendEvent(
            transaction,
            'flow-child-results-recorded',
            normalized.value.flowId,
            snapshot.parent.flowName,
            normalized.value.now,
            { applied: String(applied), parentSettled: String(parentSettled) }
          )
        return ok({ applied, parentSettled, parent: snapshot.parent, children: snapshot.children })
      },
      this.transactionOptions()
    )
  }

  async cancel(request: CancelFlowRequest): Promise<FlowResult<CancelFlowResult>> {
    const flowId = makeJobId(request.flowId)
    if (Result.isError(flowId)) return fail(flowId.error)
    if (!validTimestamp(request.now)) return invalid('now', 'must be a non-negative safe integer')
    return withTransaction(
      this.client,
      'cancel',
      async (transaction) => {
        const childRows = await transaction.query<QueryRow>(
          `SELECT ${childSelect} FROM ${quoteIdentifier(MYSQL_FLOW_TABLES.children)} WHERE namespace=? AND flow_id=? ORDER BY child_key COLLATE utf8mb4_bin ASC FOR UPDATE`,
          [this.client.namespace, flowId.value]
        )
        const parentResult = await transaction.query<QueryRow>(
          `SELECT ${parentSelect} FROM ${quoteIdentifier(MYSQL_TABLES.jobs)} WHERE namespace=? AND id=? FOR UPDATE`,
          [this.client.namespace, flowId.value]
        )
        if (parentResult.rows[0] === undefined)
          return fail(new JobNotFoundError({ jobId: flowId.value }))
        const parentRow = asRowObject(parentResult.rows[0])
        const flowChecked = validateFlowState(rowJson(parentRow, 'flow'))
        if (Result.isError(flowChecked)) return fail(flowChecked.error)
        const children = childRows.rows.map((row) => asChild(asRowObject(row)))
        if (rowString(parentRow, 'state') !== 'waiting-children') {
          const snapshot = await loadSnapshot(transaction, this.client.namespace, flowId.value)
          return ok({
            cancelled: 0,
            parentSettled: false,
            parent: snapshot.parent,
            children: snapshot.children
          })
        }
        const pending = children.filter((child) => child.status === 'pending')
        if (pending.length === 0) {
          const snapshot = await loadSnapshot(transaction, this.client.namespace, flowId.value)
          return ok({
            cancelled: 0,
            parentSettled: false,
            parent: snapshot.parent,
            children: snapshot.children
          })
        }
        for (const child of pending)
          await transaction.query(
            `UPDATE ${quoteIdentifier(MYSQL_FLOW_TABLES.children)} SET status='cancelled',result=NULL,failure=NULL,cascaded=FALSE WHERE namespace=? AND flow_id=? AND child_key=? AND status='pending'`,
            [this.client.namespace, flowId.value, child.childKey]
          )
        const flow = Object.freeze({
          ...flowChecked.value,
          pending: 0,
          cancelled: flowChecked.value.cancelled + pending.length
        })
        await transaction.query(
          `UPDATE ${quoteIdentifier(MYSQL_TABLES.jobs)} SET state='cancelled',flow=?,finished_at_ms=?,updated_at_ms=? WHERE namespace=? AND id=?`,
          [json(flow), request.now, request.now, this.client.namespace, flowId.value]
        )
        const snapshot = await loadSnapshot(transaction, this.client.namespace, flowId.value)
        await this.appendEvent(
          transaction,
          'flow-cancelled',
          flowId.value,
          snapshot.parent.flowName,
          request.now,
          { cancelled: String(pending.length) }
        )
        return ok({
          cancelled: pending.length,
          parentSettled: true,
          parent: snapshot.parent,
          children: snapshot.children
        })
      },
      this.transactionOptions()
    )
  }

  async reconcile(request: ReconcileFlowRequest): Promise<FlowResult<ReconcileFlowResult>> {
    const flowId = makeJobId(request.flowId)
    if (Result.isError(flowId)) return fail(flowId.error)
    if (!Array.isArray(request.observations) || request.observations.length > hardFlowMaxChildren)
      return invalid('observations', 'must be an array within the hard child limit')
    if (!validTimestamp(request.now)) return invalid('now', 'must be a non-negative safe integer')
    if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1))
      return invalid('limit', 'must be a positive safe integer')
    if (request.limit !== undefined && request.limit > hardFlowMaxChildren)
      return invalid('limit', 'must not exceed the hard child limit')
    const observations = request.observations.slice(0, request.limit ?? request.observations.length)
    return withTransaction(
      this.client,
      'reconcile',
      async (transaction) => {
        const rows = await transaction.query<QueryRow>(
          `SELECT ${childSelect} FROM ${quoteIdentifier(MYSQL_FLOW_TABLES.children)} WHERE namespace=? AND flow_id=? ORDER BY child_key COLLATE utf8mb4_bin ASC FOR UPDATE`,
          [this.client.namespace, flowId.value]
        )
        const children = new Map(
          rows.rows.map((row) => {
            const value = asChild(asRowObject(row))
            return [value.childKey, { record: value, spec: asSpec(asRowObject(row)) }] as const
          })
        )
        if (children.size === 0) return fail(new JobNotFoundError({ jobId: flowId.value }))
        const enqueue: FlowChildSpec[] = []
        const reports: FlowChildReport[] = []
        const cascade: FlowChildSpec[] = []
        const cascadeLimit = request.limit ?? hardFlowMaxChildren
        const seen = new Set<string>()
        for (const [index, candidate] of observations.entries()) {
          if (
            typeof candidate.childKey !== 'string' ||
            candidate.childKey.length === 0 ||
            candidate.childKey.length > 512
          )
            return invalid(`observations[${index}].childKey`, 'must be bounded text')
          if (seen.has(candidate.childKey)) return invalid('observations', 'duplicate childKey')
          seen.add(candidate.childKey)
          if (
            candidate.state !== 'missing' &&
            candidate.state !== 'waiting' &&
            candidate.state !== 'delayed' &&
            candidate.state !== 'active' &&
            candidate.state !== 'waiting-children' &&
            candidate.state !== 'completed' &&
            candidate.state !== 'failed' &&
            candidate.state !== 'cancelled'
          )
            return invalid(`observations[${index}].state`, 'invalid child state')
          const entry = children.get(candidate.childKey)
          if (entry === undefined)
            return fail(
              new JobStoreFailure({
                operation: 'flow.reconcile',
                retryable: false,
                message: 'unknown child key'
              })
            )
          if (entry.record.status === 'pending') {
            await transaction.query(
              `UPDATE ${quoteIdentifier(MYSQL_FLOW_TABLES.children)} SET pending_since_ms=? WHERE namespace=? AND flow_id=? AND child_key=? AND status='pending'`,
              [request.now, this.client.namespace, flowId.value, candidate.childKey]
            )
            if (candidate.state === 'missing') enqueue.push(entry.spec)
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
              if (Result.isError(checked)) return fail(checked.error)
              reports.push(checked.value)
            }
          }
          if (
            entry.record.status === 'cancelled' &&
            !entry.record.cascaded &&
            cascade.length < cascadeLimit
          )
            cascade.push(entry.spec)
        }
        for (const entry of children.values())
          if (
            entry.record.status === 'cancelled' &&
            !entry.record.cascaded &&
            !cascade.some((spec) => spec.childKey === entry.spec.childKey) &&
            cascade.length < cascadeLimit
          )
            cascade.push(entry.spec)
        return ok({
          enqueue: Object.freeze(enqueue),
          reports: Object.freeze(reports),
          cascade: Object.freeze(cascade)
        })
      },
      this.transactionOptions()
    )
  }

  async markCascaded(request: MarkCascadedRequest): Promise<FlowResult<MarkCascadedResult>> {
    const flowId = makeJobId(request.flowId)
    if (Result.isError(flowId)) return fail(flowId.error)
    if (!Array.isArray(request.childKeys) || request.childKeys.length > hardFlowMaxChildren)
      return invalid('childKeys', 'must be an array within the hard child limit')
    const keys = new Set<string>()
    for (const [index, key] of request.childKeys.entries()) {
      if (typeof key !== 'string' || key.length === 0 || key.length > 512)
        return invalid(`childKeys[${index}]`, 'must be bounded text')
      if (keys.has(key)) return invalid('childKeys', 'duplicate childKey')
      keys.add(key)
    }
    return withTransaction(
      this.client,
      'markCascaded',
      async (transaction) => {
        const rows = await transaction.query<QueryRow>(
          `SELECT ${childSelect} FROM ${quoteIdentifier(MYSQL_FLOW_TABLES.children)} WHERE namespace=? AND flow_id=? ORDER BY child_key COLLATE utf8mb4_bin ASC FOR UPDATE`,
          [this.client.namespace, flowId.value]
        )
        if (rows.rows.length === 0) return fail(new JobNotFoundError({ jobId: flowId.value }))
        let marked = 0
        for (const row of rows.rows) {
          const child = asChild(asRowObject(row))
          if (!keys.has(child.childKey) || child.status !== 'cancelled' || child.cascaded) continue
          await transaction.query(
            `UPDATE ${quoteIdentifier(MYSQL_FLOW_TABLES.children)} SET cascaded=TRUE WHERE namespace=? AND flow_id=? AND child_key=? AND status='cancelled' AND cascaded=FALSE`,
            [this.client.namespace, flowId.value, child.childKey]
          )
          marked += 1
        }
        const snapshot = await loadSnapshot(transaction, this.client.namespace, flowId.value)
        if (marked > 0)
          await this.appendEvent(
            transaction,
            'flow-cascaded',
            flowId.value,
            snapshot.parent.flowName,
            Date.now(),
            { marked: String(marked) }
          )
        return ok({ marked, children: snapshot.children })
      },
      this.transactionOptions()
    )
  }

  async appendChildReport(
    request: AppendChildReportRequest
  ): Promise<FlowResult<AppendChildReportResult>> {
    const checked = validateFlowOutboxEntry(request)
    if (Result.isError(checked)) return fail(checked.error)
    const entry = checked.value
    return withTransaction(
      this.client,
      'appendChildReport',
      async (transaction) => {
        const existing = await transaction.query<QueryRow>(
          `SELECT id,flow_name,parent_store_key,report FROM ${quoteIdentifier(MYSQL_FLOW_TABLES.outbox)} WHERE namespace=? AND id=? FOR UPDATE`,
          [this.client.namespace, entry.id]
        )
        if (existing.rows[0] !== undefined) {
          const stored = asOutbox(asRowObject(existing.rows[0]))
          if (canonicalJson(stored) !== canonicalJson(entry))
            return fail(
              new SettlementConflictError({
                jobId: entry.report.flowId,
                leaseToken: makeLeaseToken('outbox-conflict').unwrap()
              })
            )
          return ok({ status: 'already-applied', entry: stored })
        }
        await transaction.query(
          `INSERT INTO ${quoteIdentifier(MYSQL_FLOW_TABLES.outbox)} (namespace,id,id_identity,flow_name,parent_store_key,report,created_at_ms) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`,
          [
            this.client.namespace,
            entry.id,
            identityHash(this.client.namespace, entry.id),
            entry.flowName,
            entry.parentStoreKey,
            json(entry.report),
            0
          ]
        )
        await this.appendEvent(
          transaction,
          'flow-outbox-appended',
          entry.report.flowId,
          entry.flowName,
          Date.now(),
          { action: 'append' }
        )
        return ok({ status: 'applied', entry })
      },
      this.transactionOptions()
    )
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
    let connection: Transaction | undefined
    try {
      connection = await this.client.pool.getConnection()
      const conditions = ['namespace=?']
      const values: unknown[] = [this.client.namespace]
      if (request.parentStoreKey !== undefined) {
        conditions.push('parent_store_key=?')
        values.push(request.parentStoreKey)
      }
      if (request.cursor !== undefined) {
        conditions.push(
          `(sequence > COALESCE((SELECT sequence FROM ${quoteIdentifier(MYSQL_FLOW_TABLES.outbox)} WHERE namespace=? AND id=?),0))`
        )
        values.push(this.client.namespace, request.cursor)
      }
      values.push(limit + 1)
      const result = await connection.query<QueryRow>(
        `SELECT id,flow_name,parent_store_key,report FROM ${quoteIdentifier(MYSQL_FLOW_TABLES.outbox)} WHERE ${conditions.join(' AND ')} ORDER BY sequence ASC LIMIT ?`,
        values
      )
      const all = result.rows.map((row) => asOutbox(asRowObject(row)))
      const hasMore = all.length > limit
      const entries = Object.freeze(all.slice(0, limit))
      return ok({
        entries,
        cursor: hasMore && entries.length > 0 ? entries.at(-1)!.id : undefined,
        hasMore
      })
    } catch (cause) {
      return fail(storageFailure('peekOutbox', cause))
    } finally {
      connection?.release()
    }
  }

  async ackOutbox(request: AckOutboxRequest): Promise<FlowResult<AckOutboxResult>> {
    if (!Array.isArray(request.entries) || request.entries.length > hardFlowMaxChildren)
      return invalid('entries', 'must be an array within the hard limit')
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
    return withTransaction(
      this.client,
      'ackOutbox',
      async (transaction) => {
        let acknowledged = 0
        let skipped = 0
        const acknowledgedEntries: FlowOutboxEntry[] = []
        for (const entry of entries) {
          const result = await transaction.query<QueryRow>(
            `SELECT id,flow_name,parent_store_key,report FROM ${quoteIdentifier(MYSQL_FLOW_TABLES.outbox)} WHERE namespace=? AND id=? FOR UPDATE`,
            [this.client.namespace, entry.id]
          )
          const row = result.rows[0]
          if (row === undefined) {
            skipped += 1
            continue
          }
          const stored = asOutbox(asRowObject(row))
          if (canonicalJson(stored) !== canonicalJson(entry)) {
            skipped += 1
            continue
          }
          await transaction.query(
            `DELETE FROM ${quoteIdentifier(MYSQL_FLOW_TABLES.outbox)} WHERE namespace=? AND id=?`,
            [this.client.namespace, entry.id]
          )
          acknowledged += 1
          acknowledgedEntries.push(entry)
        }
        if (acknowledged > 0) {
          const flowIds = new Set(acknowledgedEntries.map((entry) => entry.report.flowId))
          await this.appendEvent(
            transaction,
            'flow-outbox-appended',
            flowIds.size === 1 ? [...flowIds][0] : undefined,
            undefined,
            Date.now(),
            { action: 'ack', acknowledged: String(acknowledged) }
          )
        }
        return ok({ acknowledged, skipped })
      },
      this.transactionOptions()
    )
  }

  async getFlow(request: GetFlowRequest): Promise<FlowResult<FlowSnapshot | undefined>> {
    const flowId = makeJobId(request.flowId)
    if (Result.isError(flowId)) return fail(flowId.error)
    let connection: Transaction | undefined
    try {
      connection = await this.client.pool.getConnection()
      const row = await connection.query<QueryRow>(
        `SELECT id,flow FROM ${quoteIdentifier(MYSQL_TABLES.jobs)} WHERE namespace=? AND id=?`,
        [this.client.namespace, flowId.value]
      )
      if (row.rows[0] === undefined || rowJson(asRowObject(row.rows[0]), 'flow') === undefined)
        return ok(undefined)
      return ok(await loadSnapshot(connection, this.client.namespace, flowId.value))
    } catch (cause) {
      return fail(storageFailure('getFlow', cause))
    } finally {
      connection?.release()
    }
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposal = this.ownsClient ? this.client.dispose() : Promise.resolve()
    return this.disposal
  }
}

export type MySqlFlowStoreInstance = FlowStoreV2 & {
  readonly descriptor: FlowStoreV2Descriptor
  dispose(): Promise<void>
}

const open = async (
  client: MySqlClient,
  ownsClient: boolean,
  eventWriter: JobEventStoreWriter | undefined
): Promise<MySqlFlowStoreInstance> => {
  if (client.validateSchema) await client.validate()
  const connection = await client.pool.getConnection()
  let eventsAvailable = false
  try {
    const version = await connection.query<{ version: number | string }>(
      `SELECT version FROM ${quoteIdentifier(MYSQL_TABLES.schemaVersions)} WHERE component=?`,
      ['better-effect-mq']
    )
    const actualLayoutVersion = Number(version.rows[0]?.version)
    if (!Number.isSafeInteger(actualLayoutVersion) || actualLayoutVersion < flowMigrationVersion)
      throw new MySqlFlowProtocolMismatchError({
        expectedProtocolVersion: protocolVersionV2,
        actualLayoutVersion: Number.isSafeInteger(actualLayoutVersion)
          ? actualLayoutVersion
          : undefined
      })
    const tables = await connection.query<{ table_name: string; engine: string | null }>(
      `SELECT table_name AS table_name,engine AS engine FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN (?,?)`,
      [MYSQL_FLOW_TABLES.children, MYSQL_FLOW_TABLES.outbox]
    )
    const found = new Map(tables.rows.map((row) => [row.table_name, row.engine?.toLowerCase()]))
    if (
      found.get(MYSQL_FLOW_TABLES.children) !== 'innodb' ||
      found.get(MYSQL_FLOW_TABLES.outbox) !== 'innodb'
    )
      throw new MySqlFlowProtocolMismatchError({
        expectedProtocolVersion: protocolVersionV2,
        actualLayoutVersion
      })
    const events = await connection.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?`,
      [MYSQL_TABLES.events]
    )
    eventsAvailable = events.rows.length > 0
  } finally {
    connection.release()
  }
  if (eventsAvailable) await ensureMySqlJobEventActivationTable(client)
  return new MySqlFlowStoreImplementation(
    client,
    ownsClient,
    eventsAvailable,
    eventWriter ?? defaultEventWriter
  )
}

export const MySqlFlowStore = Object.freeze({
  async make(config: MySqlJobStoreConfig): Promise<MySqlFlowStoreInstance> {
    const normalized = normalizeMySqlJobStoreConfig(config)
    return open(MySqlClient.fromPool(normalized), false, normalized.eventWriter)
  },
  async makeFromConfig(config: MySqlJobStoreConnectionConfig): Promise<MySqlFlowStoreInstance> {
    const normalized = normalizeMySqlJobStoreConnectionConfig(config)
    const client = await MySqlClient.fromConfig(normalized)
    try {
      return await open(client, true, normalized.eventWriter)
    } catch (cause) {
      await client.dispose().catch(() => undefined)
      throw cause
    }
  }
})
