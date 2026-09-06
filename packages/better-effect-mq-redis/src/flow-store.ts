// oxlint-disable anti-slop/no-runtime-typeof -- flow requests and Redis replies are untyped boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- public flow operations validate external values.
// oxlint-disable anti-slop/no-unknown-returns -- command and JSON helpers are narrowed by explicit decoders.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- JSON snapshots are reconstructed after validation.
// oxlint-disable anti-slop/no-chained-type-assertions -- casts stay at validated Result boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions follow validation.

import { Result, type Result as ResultType } from 'better-result'
import {
  defaultFlowMaxChildren,
  flowLayoutVersion,
  hardFlowMaxChildren,
  makeFlowChildId,
  makeFlowMigration,
  makeJobId,
  makeLeaseToken,
  maxFlowChildKeyLength,
  protocolVersionV2,
  validateFlowChildReport,
  validateFlowChildRecord,
  validateFlowChildSpec,
  validateFlowManifest,
  validateParentEnvelope,
  validateSerializedJobFailure,
  validateTimestamp,
  type CancelFlowRequest,
  type CancelFlowResult,
  type FlowChildObservation,
  type FlowChildRecord,
  type FlowChildReport,
  type FlowChildSpec,
  type FlowFanOutRequest,
  type FlowFanOutResult,
  type FlowOutboxEntry,
  type FlowParentRecord,
  type FlowSnapshot,
  type FlowStoreV2,
  type FlowStoreV2Error,
  type JsonValue,
  type GetFlowRequest,
  JobDefinitionError,
  JobNotFoundError,
  JobStoreFailure,
  type MarkCascadedRequest,
  type MarkCascadedResult,
  type ReconcileFlowRequest,
  type ReconcileFlowResult,
  type RecordChildResultsRequest,
  type RecordChildResultsResult,
  type SerializedJobFailure,
  SettlementConflictError
} from 'better-effect-mq'

import { RedisClient } from './client'
import { sendRedisCommand } from './config'
import { RedisConnectionError, RedisLayoutError, RedisScriptError } from './errors'
import {
  canonicalFlowJson,
  decodeFlowChildEntry,
  decodeFlowParent,
  encodeFlowChildEntry,
  encodeFlowParent
} from './flow-codec'
import { decodeFlowChildIndexMember, encodeFlowChildIndexMember, encodeFlowReference } from './keys'
import { ensureRedisFlowLayout } from './layout'
import { hashReply, scriptReply } from './internal/replies'
import { runScript } from './internal/run-script'
import {
  RedisScriptRegistry,
  loadRedisFlowScriptManifest,
  type RedisScriptName
} from './script-registry'

type FlowResult<T> = ResultType<T, FlowStoreV2Error>

type NormalizedFlowObservation = {
  childKey: string
  state: FlowChildObservation['state']
  result?: JsonValue
  failure?: SerializedJobFailure
}

const ok = <T>(value: T): FlowResult<T> => Result.ok(value) as FlowResult<T>
const fail = <T>(error: FlowStoreV2Error): FlowResult<T> => Result.err(error) as FlowResult<T>

const invalid = (field: string, message: string): JobDefinitionError =>
  new JobDefinitionError({ field, message })

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const readFields = (
  value: unknown,
  allowed: readonly string[],
  field: string
): Record<string, unknown> => {
  if (!isPlainObject(value)) throw invalid(field, 'must be a plain object')
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const allowedSet = new Set(allowed)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedSet.has(key))
      throw invalid(field, 'contains unsupported fields')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor))
      throw invalid(`${field}.${key}`, 'must be a data field')
    output[key] = descriptor.value
  }
  return output
}

const required = (fields: Record<string, unknown>, name: string, field: string): unknown => {
  if (!Object.prototype.hasOwnProperty.call(fields, name))
    throw invalid(`${field}.${name}`, 'is required')
  return fields[name]
}

const parseJson = (value: unknown, field: string): unknown => {
  if (typeof value !== 'string') throw invalid(field, 'must be a JSON string')
  try {
    return JSON.parse(value)
  } catch {
    throw invalid(field, 'contains invalid JSON')
  }
}

const normalizedRecord = (value: unknown): FlowChildRecord => {
  if (!isPlainObject(value)) throw invalid('child', 'must be a plain object')
  const checked = validateChildRecord({
    ...value,
    result: value.result,
    failure: value.failure
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const validateChildRecord = (value: unknown) => {
  return validateFlowChildRecord(value)
}

const parseChildRecords = (value: unknown): readonly FlowChildRecord[] => {
  const parsed = parseJson(value, 'children')
  if (!Array.isArray(parsed)) throw invalid('children', 'must be an array')
  return Object.freeze(
    parsed.map(normalizedRecord).sort((left, right) => sortBytes(left.childKey, right.childKey))
  )
}

const isRetryable = (cause: unknown): boolean => {
  if (cause instanceof RedisConnectionError) return true
  if (cause instanceof RedisScriptError) {
    return ['TRYAGAIN', 'CLUSTERDOWN', 'READONLY', 'MOVED', 'ASK', 'LOADING'].includes(
      cause.code ?? ''
    )
  }
  return false
}

const mapFailure = (
  operation: string,
  cause: unknown,
  flowId?: string,
  leaseToken?: string
): FlowStoreV2Error => {
  if (cause instanceof RedisScriptError) {
    if (cause.code === 'MQ_NOT_FOUND' && flowId !== undefined) {
      const id = makeJobId(flowId)
      if (!Result.isError(id)) return new JobNotFoundError({ jobId: id.value })
    }
    if (
      cause.code === 'MQ_SETTLEMENT_CONFLICT' &&
      flowId !== undefined &&
      leaseToken !== undefined
    ) {
      const id = makeJobId(flowId)
      const token = makeLeaseToken(leaseToken)
      if (!Result.isError(id) && !Result.isError(token)) {
        return new SettlementConflictError({ jobId: id.value, leaseToken: token.value })
      }
    }
    if (cause.code === 'MQ_INVALID_ARGUMENT' || cause.code === 'MQ_BATCH_LIMIT') {
      return invalid(operation, 'Redis flow request exceeds the protocol limits')
    }
  }
  if (cause instanceof Error && (cause as { readonly _tag?: unknown })._tag !== undefined) {
    return cause as FlowStoreV2Error
  }
  return new JobStoreFailure({
    operation,
    retryable: isRetryable(cause),
    message: `Redis ${operation} failed`
  }) as never
}

const sortBytes = (left: string, right: string): number =>
  Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))

const decodeReport = (value: unknown): FlowChildReport => {
  if (!isPlainObject(value)) throw invalid('report', 'must be a plain object')
  const checked = validateFlowChildReport({
    ...value,
    result: value.result,
    failure: value.failure
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const decodeSpecs = (value: unknown): readonly FlowChildSpec[] => {
  const parsed = parseJson(value, 'specs')
  if (!Array.isArray(parsed)) throw invalid('specs', 'must be an array')
  return Object.freeze(
    parsed.map((item) => {
      const checked = validateFlowChildSpec(item)
      if (Result.isError(checked)) throw checked.error
      return checked.value
    })
  )
}

const decodeReports = (value: unknown): readonly FlowChildReport[] => {
  const parsed = parseJson(value, 'reports')
  if (!Array.isArray(parsed)) throw invalid('reports', 'must be an array')
  return Object.freeze(parsed.map(decodeReport))
}

const decodeParent = (value: unknown): FlowParentRecord => {
  const checked = decodeFlowParent(value)
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const decodeScript = async (
  registry: RedisScriptRegistry,
  name: RedisScriptName,
  keys: readonly string[],
  args: readonly string[]
) => {
  const result = await runScript(registry, name, {
    keys,
    args,
    decode: (reply) => scriptReply(reply, name)
  })
  if (Result.isError(result)) throw result.error
  if (result.value.status === 'error') {
    const code = result.value.operation
    throw new RedisScriptError(name, 'execute', code)
  }
  return result.value.values
}

const flowParentFields = [
  'flowId',
  'flowName',
  'parentStoreKey',
  'depth',
  'state',
  'leaseToken',
  'flow',
  'failure'
] as const

const normalizeFanOut = (request: FlowFanOutRequest) => {
  const fields = readFields(
    request,
    [
      ...flowParentFields.filter(
        (field) => field !== 'state' && field !== 'flow' && field !== 'failure'
      ),
      'failFast',
      'children',
      'now',
      'maxChildren'
    ],
    'request'
  )
  const flowId = makeJobId(required(fields, 'flowId', 'request'))
  const leaseToken = makeLeaseToken(required(fields, 'leaseToken', 'request'))
  const now = validateTimestamp(required(fields, 'now', 'request'), 'now')
  const parent = validateParentEnvelope({
    flowName: required(fields, 'flowName', 'request'),
    flowId: required(fields, 'flowId', 'request'),
    childKey: 'flow-parent',
    parentStoreKey: required(fields, 'parentStoreKey', 'request'),
    depth: required(fields, 'depth', 'request')
  })
  const maxChildrenValue =
    fields.maxChildren === undefined ? defaultFlowMaxChildren : fields.maxChildren
  if (
    typeof maxChildrenValue !== 'number' ||
    !Number.isSafeInteger(maxChildrenValue) ||
    maxChildrenValue < 1 ||
    maxChildrenValue > hardFlowMaxChildren
  ) {
    throw invalid('request.maxChildren', 'must be a positive bounded integer')
  }
  const maxChildren = maxChildrenValue
  const children = validateFlowManifest(fields.children, { maxChildren, maxDepth: 8 })
  if (Result.isError(flowId)) throw flowId.error
  if (Result.isError(leaseToken)) throw leaseToken.error
  if (Result.isError(now)) throw now.error
  if (Result.isError(parent)) throw parent.error
  if (Result.isError(children)) throw children.error
  if (fields.failFast !== true && fields.failFast !== false)
    throw invalid('request.failFast', 'must be a boolean')
  for (const child of children.value) {
    const expectedId = makeFlowChildId({
      parentStoreKey: parent.value.parentStoreKey,
      flowId: parent.value.flowId,
      childKey: child.childKey
    })
    if (Result.isError(expectedId)) throw expectedId.error
    if (child.childJobId !== expectedId.value) {
      throw invalid('request.children', `childJobId for "${child.childKey}" is not deterministic`)
    }
  }
  const flow = Object.freeze({
    flowName: parent.value.flowName,
    failFast: fields.failFast,
    pending: children.value.length,
    completed: 0,
    failed: 0,
    cancelled: 0
  })
  const parentRecord: FlowParentRecord = Object.freeze({
    flowId: flowId.value,
    flowName: parent.value.flowName,
    parentStoreKey: parent.value.parentStoreKey,
    depth: parent.value.depth,
    state: children.value.length === 0 ? 'waiting' : 'waiting-children',
    leaseToken: leaseToken.value,
    flow,
    failure: undefined
  })
  const digest = canonicalFlowJson({
    children: [...children.value].sort((a, b) => sortBytes(a.childKey, b.childKey)),
    depth: parent.value.depth,
    failFast: fields.failFast,
    flowId: flowId.value,
    flowName: parent.value.flowName,
    leaseToken: leaseToken.value,
    parentStoreKey: parent.value.parentStoreKey
  })
  const items = children.value.map((spec) => {
    const record: FlowChildRecord = Object.freeze({
      flowId: flowId.value,
      childKey: spec.childKey,
      name: spec.name,
      version: spec.version,
      storeKey: spec.storeKey,
      childJobId: spec.childJobId,
      status: 'pending',
      result: undefined,
      failure: undefined,
      cascaded: false,
      pendingSinceMs: now.value
    })
    const reference = encodeFlowReference(flowId.value, spec.childKey)
    return {
      childKey: spec.childKey,
      member: encodeFlowChildIndexMember(spec.childKey),
      reference,
      entry: encodeFlowChildEntry(spec, record, reference)
    }
  })
  return {
    flowId: flowId.value,
    leaseToken: leaseToken.value,
    now: now.value,
    digest,
    parentRecord,
    items
  }
}

const normalizeReports = (request: RecordChildResultsRequest) => {
  const fields = readFields(request, ['flowId', 'reports', 'now'], 'request')
  const flowId = makeJobId(required(fields, 'flowId', 'request'))
  const now = validateTimestamp(required(fields, 'now', 'request'), 'now')
  if (Result.isError(flowId)) throw flowId.error
  if (Result.isError(now)) throw now.error
  if (!Array.isArray(fields.reports) || fields.reports.length > hardFlowMaxChildren) {
    throw invalid('request.reports', 'must be a bounded array')
  }
  const seen = new Set<string>()
  const reports = fields.reports.map((value, index) => {
    if (!isPlainObject(value)) throw invalid(`request.reports[${index}]`, 'must be a plain object')
    const report = decodeReport({ ...value, result: value.result, failure: value.failure })
    if (report.flowId !== flowId.value)
      throw invalid(`request.reports[${index}].flowId`, 'does not match flowId')
    if (seen.has(report.childKey)) throw invalid('request.reports', 'contains duplicate childKey')
    seen.add(report.childKey)
    return { ...report, reference: encodeFlowReference(flowId.value, report.childKey) }
  })
  return { flowId: flowId.value, now: now.value, reports }
}

const normalizeObservation = (value: unknown, index: number): FlowChildObservation => {
  if (!isPlainObject(value)) throw invalid(`observations[${index}]`, 'must be a plain object')
  const childKey = value.childKey
  if (
    typeof childKey !== 'string' ||
    childKey.length === 0 ||
    childKey.length > maxFlowChildKeyLength
  ) {
    throw invalid(`observations[${index}].childKey`, 'must be a bounded non-empty string')
  }
  const states = [
    'missing',
    'waiting',
    'delayed',
    'active',
    'waiting-children',
    'completed',
    'failed',
    'cancelled'
  ]
  if (!states.includes(value.state as string))
    throw invalid(`observations[${index}].state`, 'contains an invalid state')
  if (value.result !== undefined) {
    const parsed = canonicalFlowJson(value.result)
    void parsed
  }
  if (value.failure !== undefined) {
    const failure = validateSerializedJobFailure(value.failure)
    if (Result.isError(failure)) throw failure.error
  }
  const observation = {
    childKey,
    state: value.state as FlowChildObservation['state']
  } as NormalizedFlowObservation
  if (value.result !== undefined) observation.result = value.result as JsonValue
  if (value.failure !== undefined) observation.failure = value.failure as SerializedJobFailure
  return observation
}

const normalizeReconcile = (request: ReconcileFlowRequest) => {
  const fields = readFields(request, ['flowId', 'observations', 'now', 'limit'], 'request')
  const flowId = makeJobId(required(fields, 'flowId', 'request'))
  const now = validateTimestamp(required(fields, 'now', 'request'), 'now')
  if (Result.isError(flowId)) throw flowId.error
  if (Result.isError(now)) throw now.error
  if (!Array.isArray(fields.observations) || fields.observations.length > hardFlowMaxChildren) {
    throw invalid('request.observations', 'must be a bounded array')
  }
  const limit = fields.limit === undefined ? fields.observations.length : fields.limit
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > hardFlowMaxChildren
  ) {
    throw invalid('request.limit', 'must be a positive bounded integer')
  }
  const observations = fields.observations.slice(0, limit).map(normalizeObservation)
  const seen = new Set<string>()
  const items = observations.map((observation) => {
    if (seen.has(observation.childKey))
      throw invalid('request.observations', 'contains duplicate childKey')
    seen.add(observation.childKey)
    if (
      observation.state === 'completed' ||
      observation.state === 'failed' ||
      observation.state === 'cancelled'
    ) {
      const report = validateFlowChildReport({
        flowId: flowId.value,
        childKey: observation.childKey,
        outcome: observation.state,
        result: observation.result,
        failure: observation.failure
      })
      if (Result.isError(report)) throw report.error
    }
    return {
      ...observation,
      reference: encodeFlowReference(flowId.value, observation.childKey)
    }
  })
  return { flowId: flowId.value, now: now.value, observations: items }
}

const normalizeCancel = (request: CancelFlowRequest) => {
  const fields = readFields(request, ['flowId', 'now'], 'request')
  const flowId = makeJobId(required(fields, 'flowId', 'request'))
  const now = validateTimestamp(required(fields, 'now', 'request'), 'now')
  if (Result.isError(flowId)) throw flowId.error
  if (Result.isError(now)) throw now.error
  return { flowId: flowId.value, now: now.value }
}

const normalizeMarkCascaded = (request: MarkCascadedRequest) => {
  const fields = readFields(request, ['flowId', 'childKeys'], 'request')
  const flowId = makeJobId(required(fields, 'flowId', 'request'))
  if (Result.isError(flowId)) throw flowId.error
  if (!Array.isArray(fields.childKeys) || fields.childKeys.length > hardFlowMaxChildren) {
    throw invalid('request.childKeys', 'must be a bounded array')
  }
  const seen = new Set<string>()
  const childKeys = fields.childKeys.map((value, index) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxFlowChildKeyLength) {
      throw invalid(`request.childKeys[${index}]`, 'must be a bounded non-empty string')
    }
    if (seen.has(value)) throw invalid('request.childKeys', 'contains duplicate childKey')
    seen.add(value)
    return value
  })
  return { flowId: flowId.value, childKeys }
}

class RedisFlowStoreImplementation implements FlowStoreV2 {
  private readonly ready: Promise<void>
  private closed = false
  private registry: RedisScriptRegistry | undefined

  constructor(private readonly redis: RedisClient) {
    this.ready = this.initialize()
  }

  get descriptor() {
    return Object.freeze({
      protocolVersion: protocolVersionV2,
      layoutVersion: flowLayoutVersion,
      migration: makeFlowMigration({
        status: 'not-required',
        from: undefined,
        to: flowLayoutVersion
      })
    })
  }

  private async initialize(): Promise<void> {
    await this.redis.initialize()
    const registry = await RedisScriptRegistry.load(
      this.redis.client,
      await loadRedisFlowScriptManifest(),
      this.redis.layout.base
    )
    await ensureRedisFlowLayout(
      this.redis.client,
      this.redis.layout,
      registry.scriptSetChecksum,
      this.redis.validateLayout
    )
    this.registry = registry
  }

  private async script(
    operation: RedisScriptName,
    keys: readonly string[],
    payload: Record<string, unknown>
  ): Promise<readonly unknown[]> {
    if (this.closed) throw new RedisConnectionError(operation)
    await this.ready
    if (this.registry === undefined) throw new RedisConnectionError('flow script initialization')
    return decodeScript(this.registry, operation, keys, [canonicalFlowJson(payload)])
  }

  private async command(args: readonly string[]): Promise<unknown> {
    if (this.closed) throw new RedisConnectionError('flow command')
    await this.ready
    return sendRedisCommand(this.redis.client, args, this.redis.layout.base)
  }

  private async operation<T>(
    operation: string,
    action: () => Promise<T>,
    flowId?: string,
    leaseToken?: string
  ): Promise<FlowResult<T>> {
    try {
      return ok(await action())
    } catch (cause) {
      return fail(mapFailure(operation, cause, flowId, leaseToken))
    }
  }

  async fanOut(request: FlowFanOutRequest): Promise<FlowResult<FlowFanOutResult>> {
    let normalized: ReturnType<typeof normalizeFanOut>
    try {
      normalized = normalizeFanOut(request)
    } catch (cause) {
      return fail(cause as FlowStoreV2Error)
    }
    return this.operation(
      'flow-fanout',
      async () => {
        const values = await this.script(
          'flow-fanout',
          [
            this.redis.layout.flowParent(normalized.flowId),
            this.redis.layout.flowChildren(normalized.flowId),
            this.redis.layout.flowChildIndex(normalized.flowId),
            this.redis.layout.flowPending
          ],
          {
            mode: 'flow-fanout',
            parent: JSON.parse(encodeFlowParent(normalized.parentRecord)),
            digest: normalized.digest,
            now: normalized.now,
            children: normalized.items
          }
        )
        if (
          values.length !== 4 ||
          typeof values[0] !== 'string' ||
          typeof values[1] !== 'string' ||
          typeof values[2] !== 'string' ||
          typeof values[3] !== 'string'
        ) {
          throw new RedisLayoutError(
            'flow-fanout returned an invalid reply',
            'reply',
            'INVALID_DATA'
          )
        }
        return {
          status: values[0] === 'already-applied' ? 'already-applied' : 'applied',
          parent: decodeParent(values[1]),
          children: parseChildRecords(values[2])
        }
      },
      normalized.flowId,
      normalized.leaseToken
    )
  }

  async recordChildResults(
    request: RecordChildResultsRequest
  ): Promise<FlowResult<RecordChildResultsResult>> {
    let normalized: ReturnType<typeof normalizeReports>
    try {
      normalized = normalizeReports(request)
    } catch (cause) {
      return fail(cause as FlowStoreV2Error)
    }
    return this.operation(
      'flow-record-child-results',
      async () => {
        const values = await this.script(
          'flow-record-child-results',
          [
            this.redis.layout.flowParent(normalized.flowId),
            this.redis.layout.flowChildren(normalized.flowId),
            this.redis.layout.flowPending,
            this.redis.layout.flowCascade
          ],
          { mode: 'flow-record-child-results', reports: normalized.reports, now: normalized.now }
        )
        if (
          values.length !== 5 ||
          typeof values[0] !== 'string' ||
          typeof values[1] !== 'string' ||
          typeof values[2] !== 'string' ||
          typeof values[3] !== 'string' ||
          typeof values[4] !== 'string'
        ) {
          throw new RedisLayoutError(
            'flow report returned an invalid reply',
            'reply',
            'INVALID_DATA'
          )
        }
        const applied = Number(values[0])
        if (!Number.isSafeInteger(applied) || (values[1] !== '0' && values[1] !== '1'))
          throw new RedisLayoutError(
            'flow report returned invalid counters',
            'reply',
            'INVALID_DATA'
          )
        return {
          applied,
          parentSettled: values[1] === '1',
          parent: decodeParent(values[2]),
          children: parseChildRecords(values[3])
        }
      },
      normalized.flowId
    )
  }

  async cancel(request: CancelFlowRequest): Promise<FlowResult<CancelFlowResult>> {
    let normalized: ReturnType<typeof normalizeCancel>
    try {
      normalized = normalizeCancel(request)
    } catch (cause) {
      return fail(cause as FlowStoreV2Error)
    }
    return this.operation(
      'flow-cancel',
      async () => {
        const values = await this.script(
          'flow-cancel',
          [
            this.redis.layout.flowParent(normalized.flowId),
            this.redis.layout.flowChildren(normalized.flowId),
            this.redis.layout.flowPending,
            this.redis.layout.flowCascade
          ],
          { mode: 'flow-cancel', now: normalized.now }
        )
        if (values.length !== 4 || values.some((value) => typeof value !== 'string'))
          throw new RedisLayoutError(
            'flow cancel returned an invalid reply',
            'reply',
            'INVALID_DATA'
          )
        const cancelled = Number(values[0])
        if (!Number.isSafeInteger(cancelled) || (values[1] !== '0' && values[1] !== '1'))
          throw new RedisLayoutError(
            'flow cancel returned invalid counters',
            'reply',
            'INVALID_DATA'
          )
        return {
          cancelled,
          parentSettled: values[1] === '1',
          parent: decodeParent(values[2]),
          children: parseChildRecords(values[3])
        }
      },
      normalized.flowId
    )
  }

  async reconcile(request: ReconcileFlowRequest): Promise<FlowResult<ReconcileFlowResult>> {
    let normalized: ReturnType<typeof normalizeReconcile>
    try {
      normalized = normalizeReconcile(request)
    } catch (cause) {
      return fail(cause as FlowStoreV2Error)
    }
    return this.operation(
      'flow-reconcile',
      async () => {
        const values = await this.script(
          'flow-reconcile',
          [
            this.redis.layout.flowParent(normalized.flowId),
            this.redis.layout.flowChildren(normalized.flowId),
            this.redis.layout.flowPending
          ],
          { mode: 'flow-reconcile', observations: normalized.observations, now: normalized.now }
        )
        if (values.length !== 3 || values.some((value) => typeof value !== 'string'))
          throw new RedisLayoutError(
            'flow reconcile returned an invalid reply',
            'reply',
            'INVALID_DATA'
          )
        return {
          enqueue: decodeSpecs(values[0]),
          reports: decodeReports(values[1]),
          cascade: decodeSpecs(values[2])
        }
      },
      normalized.flowId
    )
  }

  async markCascaded(request: MarkCascadedRequest): Promise<FlowResult<MarkCascadedResult>> {
    let normalized: ReturnType<typeof normalizeMarkCascaded>
    try {
      normalized = normalizeMarkCascaded(request)
    } catch (cause) {
      return fail(cause as FlowStoreV2Error)
    }
    return this.operation(
      'flow-mark-cascaded',
      async () => {
        const values = await this.script(
          'flow-mark-cascaded',
          [this.redis.layout.flowChildren(normalized.flowId), this.redis.layout.flowCascade],
          { mode: 'flow-mark-cascaded', childKeys: normalized.childKeys }
        )
        if (values.length !== 2 || typeof values[0] !== 'string' || typeof values[1] !== 'string')
          throw new RedisLayoutError(
            'flow cascade returned an invalid reply',
            'reply',
            'INVALID_DATA'
          )
        const marked = Number(values[0])
        if (!Number.isSafeInteger(marked))
          throw new RedisLayoutError(
            'flow cascade returned invalid counters',
            'reply',
            'INVALID_DATA'
          )
        return { marked, children: parseChildRecords(values[1]) }
      },
      normalized.flowId
    )
  }

  async getFlow(request: GetFlowRequest): Promise<FlowResult<FlowSnapshot | undefined>> {
    let fields: Record<string, unknown>
    try {
      fields = readFields(request, ['flowId'], 'request')
    } catch (cause) {
      return fail(cause as FlowStoreV2Error)
    }
    const flowId = makeJobId(required(fields, 'flowId', 'request'))
    if (Result.isError(flowId)) return fail(flowId.error)
    return this.operation(
      'flow-get',
      async () => {
        const parentFields = hashReply(
          await this.command(['HGETALL', this.redis.layout.flowParent(flowId.value)])
        )
        if (Object.keys(parentFields).length === 0) return undefined
        const parent = decodeParent(parentFields)
        const childFields = hashReply(
          await this.command(['HGETALL', this.redis.layout.flowChildren(flowId.value)])
        )
        const children = Object.entries(childFields)
          .sort(([left], [right]) => sortBytes(left, right))
          .map(([childKey, encoded]) => {
            if (childKey !== decodeFlowChildIndexMember(encodeFlowChildIndexMember(childKey)))
              throw new RedisLayoutError('flow child key is malformed', 'childKey', 'INVALID_DATA')
            const decoded = decodeFlowChildEntry(encoded)
            if (Result.isError(decoded)) throw decoded.error
            return decoded.value.record
          })
        const outbox: readonly FlowOutboxEntry[] = Object.freeze([])
        return Object.freeze({ parent, children: Object.freeze(children), outbox })
      },
      flowId.value
    )
  }
}

export const RedisFlowStore = Object.freeze({
  make(redis: RedisClient): FlowStoreV2 {
    return new RedisFlowStoreImplementation(redis)
  }
})
