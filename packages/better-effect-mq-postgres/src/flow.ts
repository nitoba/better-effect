// oxlint-disable anti-slop/no-unknown-parameters -- PostgreSQL rows are validated at the protocol boundary.
// oxlint-disable anti-slop/no-unknown-returns -- decoded JSON is validated before it leaves this module.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- fixed JSON protocol objects are assembled after validation.
// oxlint-disable anti-slop/no-runtime-typeof -- database and public DTO boundaries are narrowed here.
// oxlint-disable anti-slop/no-chained-type-assertions -- FlowStore token identity is restored at this adapter boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are confined to validated SQL rows.

import { Layer } from 'better-effect'
import type { AnyService, ServiceContract, ServiceRequirement } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import {
  FlowStore,
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
  type CancelFlowRequest,
  type CancelFlowResult,
  type AckOutboxRequest,
  type AckOutboxResult,
  type AppendChildReportRequest,
  type AppendChildReportResult,
  type FlowChildObservation,
  type FlowChildRecord,
  type FlowChildReport,
  type FlowChildSpec,
  type FlowOutboxEntry,
  type FlowOutboxPage,
  type FlowParentRecord,
  type FlowSnapshot,
  type FlowStoreV2,
  type FlowStoreV2Descriptor,
  type FlowStoreV2Error,
  type AnyFlowStoreToken,
  type GetFlowRequest,
  type SerializedJobFailure,
  type MarkCascadedRequest,
  type MarkCascadedResult,
  type PeekOutboxRequest,
  type ReconcileFlowRequest,
  type ReconcileFlowResult,
  type RecordChildResultsRequest,
  type RecordChildResultsResult,
  type FlowFanOutRequest,
  type FlowFanOutResult
} from 'better-effect-mq'
import type {
  DurableJobEventInput,
  DurableJobEventType,
  JobEventStoreWriter
} from 'better-effect-mq'

import {
  normalizePostgresJobStoreConfig,
  normalizePostgresJobStoreConnectionConfig,
  type PoolClient,
  type PostgresJobStoreConfig,
  type PostgresJobStoreConnectionConfig
} from './config'
import { PostgresClient } from './client'
import {
  appendPostgresJobEvent,
  assertPostgresJobEventWriterReady,
  defaultPostgresJobEventWriter,
  postgresJobEventTableAvailable
} from './event-store'
import { PostgresFlowProtocolMismatchError } from './errors'
import { POSTGRES_TABLES, POSTGRES_FLOW_TABLES, quoteIdentifier } from './schema'
import {
  normalizePostgresLayerFactory,
  type PostgresLayerFactory,
  type PostgresLayerFactoryRequirements,
  type PostgresLayerGenerator,
  type PostgresLayerRequirements,
  type PostgresLayerValueFactory
} from './layer-factory'

const flowDescriptor: FlowStoreV2Descriptor = Object.freeze({
  parentLeaseMode: 'handoff',
  protocolVersion: protocolVersionV2,
  layoutVersion: flowLayoutVersion,
  migration: makeFlowMigration({ status: 'complete', from: undefined, to: flowLayoutVersion })
})

const flowMigrationVersion = 4

type QueryRow = Readonly<Record<string, unknown>>
type Tx = PoolClient & {
  query<Row = unknown>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: readonly Row[]; rowCount: number | null }>
}
type TransactionResult<Value> = ResultType<Value, FlowStoreV2Error>

const ok = <Value>(value: Value): TransactionResult<Value> => Result.ok(value)
const fail = <Value>(error: FlowStoreV2Error): TransactionResult<Value> => Result.err(error)
const invalid = <Value>(field: string, message: string): TransactionResult<Value> =>
  fail(new JobDefinitionError({ field, message }))
const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const storageFailure = (operation: string, cause: unknown): FlowStoreV2Error =>
  new JobStoreFailure({
    operation: `flow.${operation}`,
    retryable: true,
    message: `PostgreSQL flow operation failed: ${cause instanceof Error ? cause.message : 'storage error'}`
  })

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

const asRowObject = (value: unknown): QueryRow => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PostgreSQL row is not an object')
  }
  return value as QueryRow
}

const rowString = (row: QueryRow, field: string): string => {
  const value = row[field]
  if (typeof value !== 'string') throw new TypeError(`invalid ${field}`)
  return value
}

const rowNumber = (row: QueryRow, field: string): number => {
  const value = Number(row[field])
  if (!Number.isSafeInteger(value)) throw new TypeError(`invalid ${field}`)
  return value
}

const rowJson = (row: QueryRow, field: string): unknown => row[field]

const reportWithOptionalFields = (value: unknown) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const report = value as Record<string, unknown>
  return { ...report, result: report.result, failure: report.failure }
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
  ) {
    throw new TypeError(`invalid flow parent state ${state}`)
  }
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
    result: rowJson(row, 'result') ?? undefined,
    failure: rowJson(row, 'failure') ?? undefined,
    cascaded: row.cascaded,
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

const asOutbox = (row: QueryRow): FlowOutboxEntry => {
  const entry = validateFlowOutboxEntry({
    id: rowString(row, 'id'),
    flowName: rowString(row, 'flow_name'),
    parentStoreKey: rowString(row, 'parent_store_key'),
    report: reportWithOptionalFields(rowJson(row, 'report'))
  })
  if (Result.isError(entry)) throw entry.error
  return entry.value
}

const loadSnapshot = async (
  client: PoolClient,
  schema: string,
  namespace: string,
  flowId: string,
  lockParent = false
): Promise<FlowSnapshot> => {
  const parentRow = await client.query<QueryRow>(
    `SELECT id AS flow_id, state, flow, failure,
            COALESCE(flow_lease_token, lease_token) AS lease_token,
            flow_name, flow_parent_store_key AS parent_store_key, flow_depth AS depth
       FROM ${quoteIdentifier(schema)}.${quoteIdentifier(POSTGRES_TABLES.jobs)}
      WHERE namespace = $1 AND id = $2${lockParent ? ' FOR UPDATE' : ''}`,
    [namespace, flowId]
  )
  if (parentRow.rows[0] === undefined) throw new Error('flow parent was not found')
  const children = await client.query<QueryRow>(
    `SELECT flow_id, child_key, name, version, store_key, child_job_id, request,
            status, result, failure, cascaded, pending_since_ms
       FROM ${quoteIdentifier(schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.children)}
      WHERE namespace = $1 AND flow_id = $2
      ORDER BY child_key COLLATE "C" ASC`,
    [namespace, flowId]
  )
  const outbox = await client.query<QueryRow>(
    `SELECT id, flow_name, parent_store_key, report
       FROM ${quoteIdentifier(schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.outbox)}
      WHERE namespace = $1 AND report->>'flowId' = $2
      ORDER BY sequence ASC, id COLLATE "C" ASC`,
    [namespace, flowId]
  )
  return Object.freeze({
    parent: asParent(asRowObject(parentRow.rows[0])),
    children: Object.freeze(children.rows.map((row) => asChild(asRowObject(row)))),
    outbox: Object.freeze(outbox.rows.map((row) => asOutbox(asRowObject(row))))
  })
}

const withTransaction = async <Value>(
  client: PostgresClient,
  operation: string,
  callback: (transaction: Tx) => Promise<TransactionResult<Value>>,
  eventWriter: JobEventStoreWriter,
  ensureEvents: (transaction: Tx) => Promise<boolean>
): Promise<TransactionResult<Value>> => {
  let transaction: Tx | undefined
  try {
    transaction = (await client.pool.connect()) as Tx
    await transaction.query('BEGIN')
    const eventsAvailable = await ensureEvents(transaction)
    if (flowEventMutationOperations.has(operation)) {
      await assertPostgresJobEventWriterReady(
        transaction,
        client,
        operation,
        eventWriter,
        eventsAvailable
      )
    }
    const result = await callback(transaction)
    if (Result.isError(result)) {
      await transaction.query('ROLLBACK')
      return result
    }
    await transaction.query('COMMIT')
    return result
  } catch (cause) {
    if (transaction !== undefined) {
      try {
        await transaction.query('ROLLBACK')
      } catch {
        // Preserve the original storage failure.
      }
    }
    return fail(storageFailure(operation, cause))
  } finally {
    transaction?.release()
  }
}

const flowEventMutationOperations = new Set([
  'fanOut',
  'recordChildResults',
  'cancel',
  'markCascaded',
  'appendChildReport',
  'ackOutbox'
])

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
    if (Result.isError(expected) || expected.value !== child.childJobId) {
      return fail(
        new JobStoreFailure({
          operation: 'flow.fanOut',
          retryable: false,
          message: 'child ID is not deterministic'
        })
      )
    }
  }
  return Result.ok({
    ...request,
    flowId: flowId.value,
    leaseToken: leaseToken.value,
    children: outcome.value.children
  })
}

class PostgresFlowStoreImplementation implements FlowStoreV2 {
  readonly descriptor = flowDescriptor
  private disposal: Promise<void> | undefined
  private eventsLayoutChecked = false
  private eventsAvailable = false
  private readonly eventWriter: JobEventStoreWriter

  constructor(
    private readonly client: PostgresClient,
    private readonly ownsClient: boolean,
    eventWriter?: JobEventStoreWriter
  ) {
    this.namespace = client.namespace
    this.schema = client.schema
    this.eventWriter = eventWriter ?? defaultPostgresJobEventWriter
  }

  private readonly namespace: string
  private readonly schema: string

  private async ensureEvents(tx: Tx): Promise<boolean> {
    if (this.eventsLayoutChecked) return this.eventsAvailable
    this.eventsAvailable = await postgresJobEventTableAvailable(tx, this.client)
    this.eventsLayoutChecked = true
    return this.eventsAvailable
  }

  private withTransaction<Value>(
    operation: string,
    callback: (transaction: Tx) => Promise<TransactionResult<Value>>
  ): Promise<TransactionResult<Value>> {
    return withTransaction(this.client, operation, callback, this.eventWriter, (transaction) =>
      this.ensureEvents(transaction)
    )
  }

  private async appendEvent(
    tx: Tx,
    type: DurableJobEventType,
    jobId: string | undefined,
    name: string | undefined,
    recordedAtMs: number,
    attributes: Readonly<Record<string, string>>
  ): Promise<void> {
    if (!this.eventsAvailable || !this.eventWriter.canAppend) return
    const input: DurableJobEventInput = {
      type,
      recordedAtMs,
      jobId: jobId as never,
      queue: undefined,
      name,
      version: undefined,
      state: undefined,
      attempt: undefined,
      delivery: undefined,
      workerId: undefined,
      outcome: undefined,
      failureKind: undefined,
      duplicate: undefined,
      attributes
    }
    await appendPostgresJobEvent(tx, this.client, input)
  }

  async fanOut(
    request: FlowFanOutRequest
  ): Promise<ResultType<FlowFanOutResult, FlowStoreV2Error>> {
    const checked = normalizeFanOut(request)
    if (Result.isError(checked)) return checked
    const normalized = checked.value
    const digest = flowDigest(normalized)
    return this.withTransaction('fanOut', async (transaction) => {
      const parentResult = await transaction.query<QueryRow>(
        `SELECT id AS flow_id, state, flow, failure, lease_token,
                flow_name, flow_parent_store_key AS parent_store_key, flow_depth AS depth,
                flow_manifest_digest
          FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_TABLES.jobs)}
          WHERE namespace = $1 AND id = $2
          FOR UPDATE`,
        [this.namespace, normalized.flowId]
      )
      const row = parentResult.rows[0]
      if (row === undefined) return fail(new JobNotFoundError({ jobId: normalized.flowId }))
      const current = asRowObject(row)
      if (current.flow !== null && current.flow !== undefined) {
        if (current.flow_manifest_digest === digest) {
          const snapshot = await loadSnapshot(
            transaction,
            this.schema,
            this.namespace,
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
      ) {
        return fail(
          new LeaseLostError({
            jobId: normalized.flowId,
            leaseToken: normalized.leaseToken,
            reason: 'mismatched-token'
          })
        )
      }
      const flow = {
        flowName: normalized.flowName,
        failFast: normalized.failFast,
        pending: normalized.children.length,
        completed: 0,
        failed: 0,
        cancelled: 0
      }
      for (const child of normalized.children) {
        await transaction.query(
          `INSERT INTO ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.children)}
            (namespace, flow_id, child_key, name, version, store_key, child_job_id, request,
             status, result, failure, cascaded, pending_since_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NULL, NULL, false, $9)`,
          [
            this.namespace,
            normalized.flowId,
            child.childKey,
            child.name,
            child.version,
            child.storeKey,
            child.childJobId,
            json(child.request),
            normalized.now
          ]
        )
      }
      await transaction.query(
        `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_TABLES.jobs)}
            SET state = $3, flow = $4, flow_manifest_digest = $5, flow_lease_token = $6,
                flow_name = $7, flow_parent_store_key = $8, flow_depth = $9,
                lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL,
                cancel_requested = false, cancellation_requested_at_ms = NULL,
                updated_at_ms = $10, processed_at_ms = $10
          WHERE namespace = $1 AND id = $2`,
        [
          this.namespace,
          normalized.flowId,
          normalized.children.length === 0 ? 'waiting' : 'waiting-children',
          json(flow),
          digest,
          normalized.leaseToken,
          normalized.flowName,
          normalized.parentStoreKey,
          normalized.depth,
          normalized.now
        ]
      )
      await this.appendEvent(
        transaction,
        'flow-fan-out',
        normalized.flowId,
        normalized.flowName,
        normalized.now,
        { children: String(normalized.children.length) }
      )
      const snapshot = await loadSnapshot(
        transaction,
        this.schema,
        this.namespace,
        normalized.flowId
      )
      return ok({ status: 'applied', parent: snapshot.parent, children: snapshot.children })
    })
  }

  async recordChildResults(
    request: RecordChildResultsRequest
  ): Promise<ResultType<RecordChildResultsResult, FlowStoreV2Error>> {
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
    return this.withTransaction('recordChildResults', async (transaction) => {
      const childRows = await transaction.query<QueryRow>(
        `SELECT flow_id, child_key, name, version, store_key, child_job_id, request,
                status, result, failure, cascaded, pending_since_ms
           FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.children)}
          WHERE namespace = $1 AND flow_id = $2
          ORDER BY child_key COLLATE "C" ASC
          FOR UPDATE`,
        [this.namespace, flowId.value]
      )
      const children = new Map(
        childRows.rows.map((row) => [
          rowString(asRowObject(row), 'child_key'),
          asChild(asRowObject(row))
        ])
      )
      if (children.size === 0) return fail(new JobNotFoundError({ jobId: flowId.value }))
      const parentResult = await transaction.query<QueryRow>(
        `SELECT id AS flow_id, state, flow, failure,
                COALESCE(flow_lease_token, lease_token) AS lease_token,
                flow_name, flow_parent_store_key AS parent_store_key, flow_depth AS depth
           FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_TABLES.jobs)}
          WHERE namespace = $1 AND id = $2
          FOR UPDATE`,
        [this.namespace, flowId.value]
      )
      if (parentResult.rows[0] === undefined)
        return fail(new JobNotFoundError({ jobId: flowId.value }))
      const parentRow = asRowObject(parentResult.rows[0])
      const flowChecked = validateFlowState(rowJson(parentRow, 'flow'))
      if (Result.isError(flowChecked)) return fail(flowChecked.error)
      let flow = flowChecked.value
      let applied = 0
      let firstFailure: FlowChildReport | undefined
      for (const report of reports) {
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
          `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.children)}
              SET status = $4, result = $5, failure = $6
            WHERE namespace = $1 AND flow_id = $2 AND child_key = $3 AND status = 'pending'`,
          [
            this.namespace,
            flowId.value,
            report.childKey,
            report.outcome,
            report.result === undefined ? null : json(report.result),
            report.failure === undefined ? null : json(report.failure)
          ]
        )
      }
      let state = rowString(parentRow, 'state')
      let failure = asFailure(rowJson(parentRow, 'failure'))
      let parentSettled = false
      if (state === 'waiting-children' && flow.failFast && firstFailure !== undefined) {
        const remaining = [...children.values()].filter(
          (child) =>
            child.status === 'pending' &&
            !reports.some((report) => report.childKey === child.childKey)
        )
        for (const child of remaining) {
          await transaction.query(
            `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.children)}
                SET status = 'cancelled', result = NULL, failure = NULL, cascaded = false
              WHERE namespace = $1 AND flow_id = $2 AND child_key = $3 AND status = 'pending'`,
            [this.namespace, flowId.value, child.childKey]
          )
        }
        flow = Object.freeze({ ...flow, pending: 0, cancelled: flow.cancelled + remaining.length })
        state = 'failed'
        failure = firstFailure.failure
        parentSettled = true
      } else if (state === 'waiting-children' && flow.pending === 0) {
        state = 'waiting'
        parentSettled = true
      }
      await transaction.query(
        `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_TABLES.jobs)}
            SET state = $3, flow = $4, failure = $5,
                finished_at_ms = CASE WHEN $3 IN ('failed', 'cancelled') THEN $6 ELSE finished_at_ms END,
                updated_at_ms = $6
          WHERE namespace = $1 AND id = $2`,
        [
          this.namespace,
          flowId.value,
          state,
          json(flow),
          failure === undefined ? null : json(failure),
          request.now
        ]
      )
      if (applied > 0) {
        await this.appendEvent(
          transaction,
          'flow-child-results-recorded',
          flowId.value,
          rowString(parentRow, 'flow_name'),
          request.now,
          { applied: String(applied), parentSettled: String(parentSettled) }
        )
      }
      const snapshot = await loadSnapshot(transaction, this.schema, this.namespace, flowId.value)
      return ok({ applied, parentSettled, parent: snapshot.parent, children: snapshot.children })
    })
  }

  async cancel(
    request: CancelFlowRequest
  ): Promise<ResultType<CancelFlowResult, FlowStoreV2Error>> {
    const flowId = makeJobId(request.flowId)
    if (Result.isError(flowId)) return fail(flowId.error)
    if (!validTimestamp(request.now)) return invalid('now', 'must be a non-negative safe integer')
    return this.withTransaction('cancel', async (transaction) => {
      const childRows = await transaction.query<QueryRow>(
        `SELECT flow_id, child_key, name, version, store_key, child_job_id, request,
                status, result, failure, cascaded, pending_since_ms
           FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.children)}
          WHERE namespace = $1 AND flow_id = $2
          ORDER BY child_key COLLATE "C" ASC
          FOR UPDATE`,
        [this.namespace, flowId.value]
      )
      const parentResult = await transaction.query<QueryRow>(
        `SELECT id AS flow_id, state, flow, failure,
                COALESCE(flow_lease_token, lease_token) AS lease_token,
                flow_name, flow_parent_store_key AS parent_store_key, flow_depth AS depth
           FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_TABLES.jobs)}
          WHERE namespace = $1 AND id = $2
          FOR UPDATE`,
        [this.namespace, flowId.value]
      )
      if (parentResult.rows[0] === undefined)
        return fail(new JobNotFoundError({ jobId: flowId.value }))
      const parentRow = asRowObject(parentResult.rows[0])
      const flowChecked = validateFlowState(rowJson(parentRow, 'flow'))
      if (Result.isError(flowChecked)) return fail(flowChecked.error)
      const children = childRows.rows.map((row) => asChild(asRowObject(row)))
      if (rowString(parentRow, 'state') !== 'waiting-children') {
        const snapshot = await loadSnapshot(transaction, this.schema, this.namespace, flowId.value)
        return ok({
          cancelled: 0,
          parentSettled: false,
          parent: snapshot.parent,
          children: snapshot.children
        })
      }
      const pending = children.filter((child) => child.status === 'pending')
      if (pending.length === 0) {
        const snapshot = await loadSnapshot(transaction, this.schema, this.namespace, flowId.value)
        return ok({
          cancelled: 0,
          parentSettled: false,
          parent: snapshot.parent,
          children: snapshot.children
        })
      }
      for (const child of pending) {
        await transaction.query(
          `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.children)}
              SET status = 'cancelled', result = NULL, failure = NULL, cascaded = false
            WHERE namespace = $1 AND flow_id = $2 AND child_key = $3 AND status = 'pending'`,
          [this.namespace, flowId.value, child.childKey]
        )
      }
      const flow = Object.freeze({
        ...flowChecked.value,
        pending: 0,
        cancelled: flowChecked.value.cancelled + pending.length
      })
      await transaction.query(
        `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_TABLES.jobs)}
            SET state = 'cancelled', flow = $3, finished_at_ms = $4, updated_at_ms = $4
          WHERE namespace = $1 AND id = $2`,
        [this.namespace, flowId.value, json(flow), request.now]
      )
      await this.appendEvent(
        transaction,
        'flow-cancelled',
        flowId.value,
        rowString(parentRow, 'flow_name'),
        request.now,
        { cancelled: String(pending.length) }
      )
      const snapshot = await loadSnapshot(transaction, this.schema, this.namespace, flowId.value)
      return ok({
        cancelled: pending.length,
        parentSettled: true,
        parent: snapshot.parent,
        children: snapshot.children
      })
    })
  }

  async reconcile(
    request: ReconcileFlowRequest
  ): Promise<ResultType<ReconcileFlowResult, FlowStoreV2Error>> {
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
    return this.withTransaction('reconcile', async (transaction) => {
      const childRows = await transaction.query<QueryRow>(
        `SELECT flow_id, child_key, name, version, store_key, child_job_id, request,
                status, result, failure, cascaded, pending_since_ms
           FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.children)}
          WHERE namespace = $1 AND flow_id = $2
          ORDER BY child_key COLLATE "C" ASC
          FOR UPDATE`,
        [this.namespace, flowId.value]
      )
      const children = new Map(
        childRows.rows.map((row) => [
          rowString(asRowObject(row), 'child_key'),
          { record: asChild(asRowObject(row)), spec: asSpec(asRowObject(row)) }
        ])
      )
      if (children.size === 0) return fail(new JobNotFoundError({ jobId: flowId.value }))
      const enqueue: FlowChildSpec[] = []
      const reports: FlowChildReport[] = []
      const cascade: FlowChildSpec[] = []
      const cascadeLimit = request.limit ?? hardFlowMaxChildren
      const seen = new Set<string>()
      for (const [index, observation] of observations.entries()) {
        const candidate = observation as FlowChildObservation
        if (
          typeof candidate.childKey !== 'string' ||
          candidate.childKey.length === 0 ||
          candidate.childKey.length > 256
        )
          return invalid(`observations[${index}].childKey`, 'must be bounded text')
        if (seen.has(candidate.childKey)) return invalid('observations', 'duplicate childKey')
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
            `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.children)}
                SET pending_since_ms = $4
              WHERE namespace = $1 AND flow_id = $2 AND child_key = $3 AND status = 'pending'`,
            [this.namespace, flowId.value, candidate.childKey, request.now]
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
      for (const entry of children.values()) {
        if (
          entry.record.status === 'cancelled' &&
          !entry.record.cascaded &&
          !cascade.some((spec) => spec.childKey === entry.spec.childKey) &&
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

  async markCascaded(
    request: MarkCascadedRequest
  ): Promise<ResultType<MarkCascadedResult, FlowStoreV2Error>> {
    const flowId = makeJobId(request.flowId)
    if (Result.isError(flowId)) return fail(flowId.error)
    if (!Array.isArray(request.childKeys) || request.childKeys.length > hardFlowMaxChildren)
      return invalid('childKeys', 'must be an array within the hard child limit')
    const requestedKeys = new Set<string>()
    for (const [index, key] of request.childKeys.entries()) {
      if (typeof key !== 'string' || key.length === 0 || key.length > 256)
        return invalid(`childKeys[${index}]`, 'must be bounded text')
      if (requestedKeys.has(key)) return invalid('childKeys', 'duplicate childKey')
      requestedKeys.add(key)
    }
    return this.withTransaction('markCascaded', async (transaction) => {
      const rows = await transaction.query<QueryRow>(
        `SELECT flow_id, child_key, name, version, store_key, child_job_id, request,
                status, result, failure, cascaded, pending_since_ms
           FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.children)}
          WHERE namespace = $1 AND flow_id = $2
          ORDER BY child_key COLLATE "C" ASC
          FOR UPDATE`,
        [this.namespace, flowId.value]
      )
      if (rows.rows.length === 0) return fail(new JobNotFoundError({ jobId: flowId.value }))
      let marked = 0
      for (const row of rows.rows) {
        const child = asChild(asRowObject(row))
        if (!requestedKeys.has(child.childKey) || child.status !== 'cancelled' || child.cascaded)
          continue
        await transaction.query(
          `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.children)}
              SET cascaded = true
            WHERE namespace = $1 AND flow_id = $2 AND child_key = $3 AND status = 'cancelled' AND cascaded = false`,
          [this.namespace, flowId.value, child.childKey]
        )
        marked += 1
      }
      const snapshot = await loadSnapshot(transaction, this.schema, this.namespace, flowId.value)
      if (marked > 0) {
        await this.appendEvent(
          transaction,
          'flow-cascaded',
          flowId.value,
          snapshot.parent.flowName,
          Date.now(),
          { marked: String(marked) }
        )
      }
      return ok({ marked, children: snapshot.children })
    })
  }

  async appendChildReport(
    request: AppendChildReportRequest
  ): Promise<ResultType<AppendChildReportResult, FlowStoreV2Error>> {
    const checked = validateFlowOutboxEntry(request)
    if (Result.isError(checked)) return fail(checked.error)
    const entry = checked.value
    return this.withTransaction('appendChildReport', async (transaction) => {
      const inserted = await transaction.query(
        `INSERT INTO ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.outbox)}
          (namespace, id, flow_name, parent_store_key, report, created_at_ms)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (namespace, id) DO NOTHING`,
        [this.namespace, entry.id, entry.flowName, entry.parentStoreKey, json(entry.report), 0]
      )
      const result = await transaction.query<QueryRow>(
        `SELECT id, flow_name, parent_store_key, report
           FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.outbox)}
          WHERE namespace = $1 AND id = $2
          FOR UPDATE`,
        [this.namespace, entry.id]
      )
      const row = result.rows[0]
      if (row === undefined) return fail(storageFailure('appendChildReport', 'missing row'))
      const stored = asOutbox(asRowObject(row))
      if (canonicalJson(stored) !== canonicalJson(entry)) {
        return fail(
          new SettlementConflictError({
            jobId: entry.report.flowId,
            leaseToken: makeLeaseToken('outbox-conflict').unwrap()
          })
        )
      }
      if (inserted.rowCount === 1) {
        await this.appendEvent(
          transaction,
          'flow-outbox-appended',
          entry.report.flowId,
          entry.flowName,
          Date.now(),
          { action: 'append' }
        )
      }
      return ok({
        status: inserted.rowCount === 1 ? 'applied' : 'already-applied',
        entry: stored
      })
    })
  }

  async peekOutbox(
    request: PeekOutboxRequest
  ): Promise<ResultType<FlowOutboxPage, FlowStoreV2Error>> {
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

    let connection: PoolClient | undefined
    try {
      connection = await this.client.pool.connect()
      const values: unknown[] = [this.namespace]
      const conditions = ['namespace = $1']
      if (request.parentStoreKey !== undefined) {
        values.push(request.parentStoreKey)
        conditions.push(`parent_store_key = $${values.length}`)
      }
      if (request.cursor !== undefined) {
        values.push(request.cursor)
        conditions.push(
          `(sequence > COALESCE((SELECT sequence FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.outbox)} WHERE namespace = $1 AND id = $${values.length}), 0))`
        )
      }
      values.push(limit + 1)
      const rows = await connection.query<QueryRow>(
        `SELECT id, flow_name, parent_store_key, report
           FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.outbox)}
          WHERE ${conditions.join(' AND ')}
          ORDER BY sequence ASC, id COLLATE "C" ASC
          LIMIT $${values.length}`,
        values
      )
      const all = rows.rows.map((row) => asOutbox(asRowObject(row)))
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

  async ackOutbox(
    request: AckOutboxRequest
  ): Promise<ResultType<AckOutboxResult, FlowStoreV2Error>> {
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
    return this.withTransaction('ackOutbox', async (transaction) => {
      let acknowledged = 0
      let skipped = 0
      const acknowledgedEntries: FlowOutboxEntry[] = []
      for (const entry of entries) {
        const result = await transaction.query<QueryRow>(
          `SELECT id, flow_name, parent_store_key, report
             FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.outbox)}
            WHERE namespace = $1 AND id = $2
            FOR UPDATE`,
          [this.namespace, entry.id]
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
          `DELETE FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_FLOW_TABLES.outbox)}
            WHERE namespace = $1 AND id = $2`,
          [this.namespace, entry.id]
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
    })
  }

  async getFlow(
    request: GetFlowRequest
  ): Promise<ResultType<FlowSnapshot | undefined, FlowStoreV2Error>> {
    const flowId = makeJobId(request.flowId)
    if (Result.isError(flowId)) return fail(flowId.error)
    let connection: PoolClient | undefined
    try {
      connection = await this.client.pool.connect()
      const result = await connection.query<QueryRow>(
        `SELECT id, flow FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier(POSTGRES_TABLES.jobs)} WHERE namespace = $1 AND id = $2`,
        [this.namespace, flowId.value]
      )
      if (result.rows[0] === undefined) return ok(undefined)
      if (rowJson(asRowObject(result.rows[0]), 'flow') == null) return ok(undefined)
      return ok(await loadSnapshot(connection, this.schema, this.namespace, flowId.value))
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

export type PostgresFlowStoreInstance = FlowStoreV2 & {
  readonly descriptor: FlowStoreV2Descriptor
  dispose(): Promise<void>
}

type FlowResource = {
  readonly client: PostgresClient
  readonly eventWriter: JobEventStoreWriter | undefined
}

type FlowLayer<Token extends AnyFlowStoreToken, Yield extends ServiceRequirement<unknown>> = Layer<
  InstanceType<Token>,
  InstanceType<Token['jobStore']> | PostgresLayerRequirements<Yield>
>

type FlowLayerWithRequired<Token extends AnyFlowStoreToken, Required> = Layer<
  InstanceType<Token>,
  InstanceType<Token['jobStore']> | Extract<Required, AnyService>
>

const open = async (
  client: PostgresClient,
  ownsClient: boolean,
  eventWriter?: JobEventStoreWriter
): Promise<PostgresFlowStoreInstance> => {
  if (client.validateSchema) await client.validate()
  const connection = await client.pool.connect()
  try {
    const version = await connection.query<{ version: number | string }>(
      `SELECT version FROM ${quoteIdentifier(client.schema)}.${quoteIdentifier(POSTGRES_TABLES.schemaVersions)} WHERE component = $1`,
      ['better-effect-mq']
    )
    const value = Number(version.rows[0]?.version)
    if (!Number.isSafeInteger(value) || value < flowMigrationVersion) {
      throw new PostgresFlowProtocolMismatchError({
        expectedProtocolVersion: protocolVersionV2,
        actualLayoutVersion: value
      })
    }
    const tables = await connection.query<{ table_name: string }>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])',
      [client.schema, Object.values(POSTGRES_FLOW_TABLES)]
    )
    const present = new Set(tables.rows.map((row) => row.table_name))
    if (Object.values(POSTGRES_FLOW_TABLES).some((table) => !present.has(table))) {
      throw new PostgresFlowProtocolMismatchError({
        expectedProtocolVersion: protocolVersionV2,
        actualLayoutVersion: value
      })
    }
  } finally {
    connection.release()
  }
  return new PostgresFlowStoreImplementation(client, ownsClient, eventWriter)
}

const makeLayer = <
  Token extends AnyFlowStoreToken,
  Yield extends ServiceRequirement<unknown> = never
>(
  token: Token,
  acquire: PostgresLayerFactory<FlowResource, Yield>,
  ownsClient: boolean
): FlowLayer<Token, Yield> =>
  Layer.scopedGen(
    token,
    async function* () {
      yield* token.jobStore
      const resource = yield* normalizePostgresLayerFactory(acquire)()
      try {
        const store = await open(resource.client, ownsClient, resource.eventWriter)
        return FlowStore.of(store) as unknown as ServiceContract<InstanceType<Token>>
      } catch (cause) {
        if (ownsClient) await resource.client.dispose().catch(() => undefined)
        throw cause
      }
    },
    async (store) => {
      await (store as unknown as PostgresFlowStoreInstance).dispose()
    }
  ) as FlowLayer<Token, Yield>

const borrowedClient = (config: PostgresJobStoreConfig): (() => Promise<FlowResource>) => {
  const normalized = normalizePostgresJobStoreConfig(config)
  return async () => ({
    client: PostgresClient.fromPool(normalized),
    eventWriter: normalized.eventWriter
  })
}

const borrowedClientFromFactory = <Yield extends ServiceRequirement<unknown>>(
  factory: PostgresLayerFactory<PostgresJobStoreConfig, Yield>
): PostgresLayerFactory<FlowResource, Yield> =>
  async function* () {
    const config = yield* normalizePostgresLayerFactory(factory)()
    const normalized = normalizePostgresJobStoreConfig(config)
    return {
      client: PostgresClient.fromPool(normalized),
      eventWriter: normalized.eventWriter
    }
  }

const ownedClient = (config: PostgresJobStoreConnectionConfig): (() => Promise<FlowResource>) => {
  const normalized = normalizePostgresJobStoreConnectionConfig(config)
  return () =>
    PostgresClient.fromConfig(normalized).then((client) => ({
      client,
      eventWriter: normalized.eventWriter
    }))
}

const ownedClientFromFactory = <Yield extends ServiceRequirement<unknown>>(
  factory: PostgresLayerFactory<PostgresJobStoreConnectionConfig, Yield>
): PostgresLayerFactory<FlowResource, Yield> =>
  async function* () {
    const config = yield* normalizePostgresLayerFactory(factory)()
    const normalized = normalizePostgresJobStoreConnectionConfig(config)
    const client = await PostgresClient.fromConfig(normalized)
    return { client, eventWriter: normalized.eventWriter }
  }

type PostgresFlowStoreApi = {
  readonly make: (config: PostgresJobStoreConfig) => Promise<PostgresFlowStoreInstance>
  readonly makeFromConfig: (
    config: PostgresJobStoreConnectionConfig
  ) => Promise<PostgresFlowStoreInstance>
  readonly layer: (config: PostgresJobStoreConfig) => FlowLayer<typeof FlowStore, never>
  readonly layerFor: <Token extends AnyFlowStoreToken>(
    token: Token,
    config: PostgresJobStoreConfig
  ) => FlowLayer<Token, never>
  readonly layerWith: {
    <Factory extends PostgresLayerGenerator<PostgresJobStoreConfig, ServiceRequirement<unknown>>>(
      factory: Factory
    ): FlowLayerWithRequired<typeof FlowStore, PostgresLayerFactoryRequirements<Factory>>
    (factory: PostgresLayerValueFactory<PostgresJobStoreConfig>): FlowLayer<typeof FlowStore, never>
  }
  readonly layerWithFor: {
    <
      Token extends AnyFlowStoreToken,
      Factory extends PostgresLayerGenerator<PostgresJobStoreConfig, ServiceRequirement<unknown>>
    >(
      token: Token,
      factory: Factory
    ): FlowLayerWithRequired<Token, PostgresLayerFactoryRequirements<Factory>>
    <Token extends AnyFlowStoreToken>(
      token: Token,
      factory: PostgresLayerValueFactory<PostgresJobStoreConfig>
    ): FlowLayer<Token, never>
  }
  readonly layerFromConfig: (
    config: PostgresJobStoreConnectionConfig
  ) => FlowLayer<typeof FlowStore, never>
  readonly layerFromConfigFor: <Token extends AnyFlowStoreToken>(
    token: Token,
    config: PostgresJobStoreConnectionConfig
  ) => FlowLayer<Token, never>
  readonly layerFromConfigWith: {
    <
      Factory extends PostgresLayerGenerator<
        PostgresJobStoreConnectionConfig,
        ServiceRequirement<unknown>
      >
    >(
      factory: Factory
    ): FlowLayerWithRequired<typeof FlowStore, PostgresLayerFactoryRequirements<Factory>>
    (
      factory: PostgresLayerValueFactory<PostgresJobStoreConnectionConfig>
    ): FlowLayer<typeof FlowStore, never>
  }
  readonly layerFromConfigWithFor: {
    <
      Token extends AnyFlowStoreToken,
      Factory extends PostgresLayerGenerator<
        PostgresJobStoreConnectionConfig,
        ServiceRequirement<unknown>
      >
    >(
      token: Token,
      factory: Factory
    ): FlowLayerWithRequired<Token, PostgresLayerFactoryRequirements<Factory>>
    <Token extends AnyFlowStoreToken>(
      token: Token,
      factory: PostgresLayerValueFactory<PostgresJobStoreConnectionConfig>
    ): FlowLayer<Token, never>
  }
}

export const PostgresFlowStore: PostgresFlowStoreApi = Object.freeze({
  async make(config: PostgresJobStoreConfig): Promise<PostgresFlowStoreInstance> {
    const normalized = normalizePostgresJobStoreConfig(config)
    return open(PostgresClient.fromPool(normalized), false, normalized.eventWriter)
  },
  async makeFromConfig(
    config: PostgresJobStoreConnectionConfig
  ): Promise<PostgresFlowStoreInstance> {
    const normalized = normalizePostgresJobStoreConnectionConfig(config)
    const client = await PostgresClient.fromConfig(normalized)
    try {
      return await open(client, true, normalized.eventWriter)
    } catch (cause) {
      await client.dispose().catch(() => undefined)
      throw cause
    }
  },
  layer(config: PostgresJobStoreConfig) {
    return makeLayer<typeof FlowStore, never>(FlowStore, borrowedClient(config), false)
  },
  layerFor<Token extends AnyFlowStoreToken>(token: Token, config: PostgresJobStoreConfig) {
    return makeLayer<Token, never>(token, borrowedClient(config), false)
  },
  layerWith<Yield extends ServiceRequirement<unknown>>(
    factory: PostgresLayerFactory<PostgresJobStoreConfig, Yield>
  ) {
    return makeLayer<typeof FlowStore, Yield>(FlowStore, borrowedClientFromFactory(factory), false)
  },
  layerWithFor<Token extends AnyFlowStoreToken, Yield extends ServiceRequirement<unknown>>(
    token: Token,
    factory: PostgresLayerFactory<PostgresJobStoreConfig, Yield>
  ) {
    return makeLayer<Token, Yield>(token, borrowedClientFromFactory(factory), false)
  },
  layerFromConfig(config: PostgresJobStoreConnectionConfig) {
    return makeLayer<typeof FlowStore, never>(FlowStore, ownedClient(config), true)
  },
  layerFromConfigFor<Token extends AnyFlowStoreToken>(
    token: Token,
    config: PostgresJobStoreConnectionConfig
  ) {
    return makeLayer<Token, never>(token, ownedClient(config), true)
  },
  layerFromConfigWith<Yield extends ServiceRequirement<unknown>>(
    factory: PostgresLayerFactory<PostgresJobStoreConnectionConfig, Yield>
  ) {
    return makeLayer<typeof FlowStore, Yield>(FlowStore, ownedClientFromFactory(factory), true)
  },
  layerFromConfigWithFor<
    Token extends AnyFlowStoreToken,
    Yield extends ServiceRequirement<unknown>
  >(token: Token, factory: PostgresLayerFactory<PostgresJobStoreConnectionConfig, Yield>) {
    return makeLayer<Token, Yield>(token, ownedClientFromFactory(factory), true)
  }
})
