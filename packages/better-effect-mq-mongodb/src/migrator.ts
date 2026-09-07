// oxlint-disable anti-slop/no-runtime-typeof -- driver errors are reduced to a bounded namespace-exists diagnostic.
// oxlint-disable anti-slop/no-object-parameters -- JSON-schema documents are owned by the adapter and passed through to the driver.
// oxlint-disable anti-slop/no-known-value-widening -- validator returns a driver schema document deliberately erased from public API.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- MongoDB JSON-schema properties are an adapter-owned open BSON document.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- only a checked driver error code is inspected.

import { randomUUID } from 'node:crypto'
import {
  collectionNames,
  flowCollectionNames,
  MONGODB_FLOW_LAYOUT_VERSION,
  MONGODB_FLOW_PROTOCOL_VERSION,
  MONGODB_LAYOUT_VERSION,
  MONGODB_PROTOCOL_VERSION,
  mongoCollections
} from './collections'
import { normalizeMongoJobStoreConfig, validateCollectionPrefix, type MongoDb } from './config'
import {
  MongoFlowProtocolMismatchError,
  MongoJobStoreLayoutError,
  MongoJobStoreMigrationError
} from './errors'

export interface MongoMigrationOptions {
  readonly db: MongoDb
  readonly collectionPrefix?: string
}

type MongoSchema = {
  readonly $jsonSchema: {
    readonly bsonType: 'object'
    readonly required: readonly string[]
    readonly properties: Record<string, unknown>
    readonly additionalProperties: false
  }
}

const validator = (
  required: readonly string[],
  properties: Record<string, unknown>
): MongoSchema => ({
  $jsonSchema: { bsonType: 'object', required, properties, additionalProperties: false }
})

const schemas = {
  jobs: validator(
    [
      '_id',
      'namespace',
      'id',
      'identity',
      'queue',
      'name',
      'version',
      'state',
      'payload',
      'metadataEntries',
      'priority',
      'runAtMs',
      'orderSequence',
      'attemptsMax',
      'attemptsMade',
      'deliveryCount',
      'stalledCount',
      'cancelRequested',
      'createdAtMs',
      'updatedAtMs',
      'ledgerCount'
    ],
    {
      _id: { bsonType: 'string' },
      namespace: { bsonType: 'string', minLength: 1 },
      id: { bsonType: 'string', minLength: 1 },
      identity: { bsonType: 'string', minLength: 1 },
      queue: { bsonType: 'string', minLength: 1 },
      name: { bsonType: 'string', minLength: 1 },
      version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      state: { enum: ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'] },
      payload: {},
      metadataEntries: {
        bsonType: 'array',
        items: {
          bsonType: 'object',
          required: ['key', 'value'],
          properties: {
            key: { bsonType: 'string' },
            value: { bsonType: 'string' }
          },
          additionalProperties: false
        }
      },
      priority: { bsonType: ['int', 'long', 'double'] },
      runAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      orderSequence: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      attemptsMax: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      attemptsMade: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      attemptSequence: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      deliveryCount: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      stalledCount: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      cancelRequested: { bsonType: 'bool' },
      cancellationRequestedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      createdAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      updatedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      processedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      finishedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      leaseOwner: { bsonType: 'string', minLength: 1 },
      leaseToken: { bsonType: 'string', minLength: 1 },
      leaseExpiresAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      result: {},
      failure: {},
      backoff: {},
      timeoutMs: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      idempotencyKey: { bsonType: 'string', minLength: 1 },
      dispatchKey: { bsonType: 'string', minLength: 1, maxLength: 512 },
      ledgerCount: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      lastSettlementToken: { bsonType: 'string', minLength: 1 },
      lastSettlementDigest: { bsonType: 'string', minLength: 1 },
      lastSettlementOutcome: { bsonType: 'string', minLength: 1 }
    }
  ),
  attempts: validator(
    [
      '_id',
      'namespace',
      'jobId',
      'ledgerSequence',
      'attempt',
      'delivery',
      'finishedAtMs',
      'outcome'
    ],
    {
      _id: { bsonType: 'string' },
      namespace: { bsonType: 'string' },
      jobId: { bsonType: 'string' },
      ledgerSequence: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      attempt: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      delivery: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      finishedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      outcome: { enum: ['completed', 'retried', 'failed', 'cancelled', 'stalled', 'released'] },
      attemptSequence: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      startedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      result: {},
      failure: {},
      workerId: { bsonType: 'string', minLength: 1 },
      retryAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      retryDelayMs: { bsonType: ['int', 'long', 'double'], minimum: 0 }
    }
  ),
  queues: validator(['_id', 'namespace', 'queue', 'paused', 'wakeVersion', 'updatedAtMs'], {
    _id: { bsonType: 'string' },
    namespace: { bsonType: 'string' },
    queue: { bsonType: 'string' },
    paused: { bsonType: 'bool' },
    wakeVersion: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    updatedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 }
  }),
  outbox: validator(
    [
      '_id',
      'namespace',
      'id',
      'protocolVersion',
      'target',
      'state',
      'request',
      'requestDigest',
      'attemptsMax',
      'attemptsMade',
      'runAtMs',
      'createdAtMs',
      'updatedAtMs'
    ],
    {
      _id: { bsonType: 'string' },
      namespace: { bsonType: 'string', minLength: 1 },
      id: { bsonType: 'string', minLength: 1 },
      protocolVersion: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      target: { bsonType: 'string', minLength: 1 },
      state: { enum: ['pending', 'active', 'published', 'failed'] },
      request: { bsonType: 'object' },
      requestDigest: { bsonType: 'string', minLength: 1 },
      attemptsMax: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      attemptsMade: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      runAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      createdAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      updatedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      publishedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      leaseOwner: { bsonType: 'string', minLength: 1 },
      leaseToken: { bsonType: 'string', minLength: 1 },
      leaseExpiresAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      failure: { bsonType: 'object' }
    }
  ),
  events: validator(['_id', 'namespace', 'cursor', 'recordedAtMs', 'eventType', 'attributes'], {
    _id: { bsonType: 'string', minLength: 1 },
    namespace: { bsonType: 'string', minLength: 1 },
    cursor: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    recordedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    eventType: {
      enum: [
        'job-enqueued',
        'job-claimed',
        'job-completed',
        'job-retry-scheduled',
        'job-failed',
        'job-cancelled',
        'job-cancel-requested',
        'job-released',
        'job-stalled-recovered',
        'job-promoted',
        'job-admin-retried',
        'job-removed',
        'queue-paused',
        'queue-resumed'
      ]
    },
    jobId: { bsonType: 'string', minLength: 1 },
    queue: { bsonType: 'string', minLength: 1 },
    name: { bsonType: 'string', minLength: 1 },
    version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    state: { bsonType: 'string', minLength: 1 },
    attempt: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    delivery: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    workerId: { bsonType: 'string', minLength: 1 },
    outcome: { bsonType: 'string', minLength: 1 },
    failureKind: { bsonType: 'string', minLength: 1 },
    duplicate: { bsonType: 'bool' },
    attributes: { bsonType: 'object' }
  }),
  schedules: validator(
    [
      '_id',
      'namespace',
      'scheduleKey',
      'group',
      'job',
      'queue',
      'payload',
      'metadataEntries',
      'priority',
      'attemptsMax',
      'misfire',
      'overlap',
      'paused',
      'revision',
      'nextRunAtMs',
      'createdAtMs',
      'updatedAtMs'
    ],
    {
      _id: { bsonType: 'string' },
      namespace: { bsonType: 'string', minLength: 1 },
      scheduleKey: { bsonType: 'string', minLength: 1 },
      group: { bsonType: 'string', minLength: 1 },
      job: {
        bsonType: 'object',
        required: ['queue', 'name', 'version'],
        properties: {
          queue: { bsonType: 'string', minLength: 1 },
          name: { bsonType: 'string', minLength: 1 },
          version: { bsonType: ['int', 'long', 'double'], minimum: 1 }
        },
        additionalProperties: false
      },
      queue: { bsonType: 'string', minLength: 1 },
      cron: { bsonType: 'string', minLength: 1 },
      everyMs: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      timeZone: { bsonType: 'string', minLength: 1 },
      payload: {},
      metadataEntries: {
        bsonType: 'array',
        items: {
          bsonType: 'object',
          required: ['key', 'value'],
          properties: {
            key: { bsonType: 'string' },
            value: { bsonType: 'string' }
          },
          additionalProperties: false
        }
      },
      priority: { bsonType: ['int', 'long', 'double'] },
      attemptsMax: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      backoff: {},
      timeoutMs: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      misfire: { bsonType: 'object' },
      overlap: { enum: ['allow', 'skip'] },
      paused: { bsonType: 'bool' },
      revision: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      nextRunAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      lastScheduledAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      lastJobId: { bsonType: 'string', minLength: 1 },
      createdAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      updatedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 }
    }
  )
} as const

const jobsV2Schema = validator(schemas.jobs.$jsonSchema.required, {
  ...schemas.jobs.$jsonSchema.properties,
  state: {
    enum: ['waiting', 'delayed', 'active', 'waiting-children', 'completed', 'failed', 'cancelled']
  },
  parent: {
    bsonType: 'object',
    required: ['flowName', 'flowId', 'childKey', 'parentStoreKey', 'depth'],
    properties: {
      flowName: { bsonType: 'string', minLength: 1 },
      flowId: { bsonType: 'string', minLength: 1 },
      childKey: { bsonType: 'string', minLength: 1 },
      parentStoreKey: { bsonType: 'string', minLength: 1 },
      depth: { bsonType: ['int', 'long', 'double'], minimum: 1, maximum: 32 }
    },
    additionalProperties: false
  },
  flow: {
    bsonType: 'object',
    required: ['flowName', 'failFast', 'pending', 'completed', 'failed', 'cancelled'],
    properties: {
      flowName: { bsonType: 'string', minLength: 1 },
      failFast: { bsonType: 'bool' },
      pending: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      completed: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      failed: { bsonType: ['int', 'long', 'double'], minimum: 0 },
      cancelled: { bsonType: ['int', 'long', 'double'], minimum: 0 }
    },
    additionalProperties: false
  },
  flowManifestDigest: { bsonType: 'string', minLength: 1 },
  flowLeaseToken: { bsonType: 'string', minLength: 1 },
  flowName: { bsonType: 'string', minLength: 1 },
  flowParentStoreKey: { bsonType: 'string', minLength: 1 },
  flowDepth: { bsonType: ['int', 'long', 'double'], minimum: 1, maximum: 32 }
})

const flowChildrenSchema = validator(
  [
    '_id',
    'namespace',
    'flowId',
    'childKey',
    'name',
    'version',
    'storeKey',
    'childJobId',
    'request',
    'status',
    'cascaded',
    'pendingSinceMs'
  ],
  {
    _id: { bsonType: 'string' },
    namespace: { bsonType: 'string', minLength: 1 },
    flowId: { bsonType: 'string', minLength: 1 },
    childKey: { bsonType: 'string', minLength: 1 },
    name: { bsonType: 'string', minLength: 1 },
    version: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    storeKey: { bsonType: 'string', minLength: 1 },
    childJobId: { bsonType: 'string', minLength: 1 },
    request: { bsonType: 'object' },
    status: { enum: ['pending', 'completed', 'failed', 'cancelled'] },
    result: {},
    failure: { bsonType: 'object' },
    cascaded: { bsonType: 'bool' },
    pendingSinceMs: { bsonType: ['int', 'long', 'double'], minimum: 0 }
  }
)

const flowOutboxSchema = validator(
  ['_id', 'namespace', 'id', 'flowName', 'parentStoreKey', 'report', 'sequence', 'createdAtMs'],
  {
    _id: { bsonType: 'string' },
    namespace: { bsonType: 'string', minLength: 1 },
    id: { bsonType: 'string', minLength: 1 },
    flowName: { bsonType: 'string', minLength: 1 },
    parentStoreKey: { bsonType: 'string', minLength: 1 },
    report: { bsonType: 'object' },
    sequence: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    createdAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 }
  }
)

const controlsSchema = validator(
  [
    '_id',
    'namespace',
    'queue',
    'controlGroup',
    'enabled',
    'revision',
    'createdAtMs',
    'updatedAtMs'
  ],
  {
    _id: { bsonType: 'string', minLength: 1 },
    namespace: { bsonType: 'string', minLength: 1 },
    queue: { bsonType: 'string', minLength: 1 },
    controlGroup: { bsonType: 'string', minLength: 1 },
    enabled: { bsonType: 'bool' },
    revision: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    globalConcurrency: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    perKeyConcurrency: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    rateLimitMax: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    rateLimitDurationMs: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    createdAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    updatedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 }
  }
)

const permitsSchema = validator(
  ['_id', 'namespace', 'jobId', 'queue', 'dispatchKey', 'leaseToken', 'acquiredAtMs'],
  {
    _id: { bsonType: 'string', minLength: 1 },
    namespace: { bsonType: 'string', minLength: 1 },
    jobId: { bsonType: 'string', minLength: 1 },
    queue: { bsonType: 'string', minLength: 1 },
    dispatchKey: { bsonType: 'string', minLength: 1, maxLength: 512 },
    leaseToken: { bsonType: 'string', minLength: 1 },
    acquiredAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 }
  }
)

const rateWindowsSchema = validator(
  ['_id', 'namespace', 'queue', 'startedAtMs', 'claimCount', 'updatedAtMs'],
  {
    _id: { bsonType: 'string', minLength: 1 },
    namespace: { bsonType: 'string', minLength: 1 },
    queue: { bsonType: 'string', minLength: 1 },
    startedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    claimCount: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    updatedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 }
  }
)

const controlCursorsSchema = validator(
  ['_id', 'namespace', 'queue', 'cursorSequence', 'updatedAtMs'],
  {
    _id: { bsonType: 'string', minLength: 1 },
    namespace: { bsonType: 'string', minLength: 1 },
    queue: { bsonType: 'string', minLength: 1 },
    cursorSequence: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    updatedAtMs: { bsonType: ['int', 'long', 'double'], minimum: 0 }
  }
)

const indexes = (prefix: string) => ({
  [`${prefix}_jobs`]: [
    { key: { namespace: 1, id: 1 }, name: 'job_identity', unique: true },
    {
      key: { namespace: 1, queue: 1, name: 1, version: 1, idempotencyKey: 1 },
      name: 'idempotency',
      unique: true,
      partialFilterExpression: { idempotencyKey: { $exists: true } }
    },
    {
      key: {
        namespace: 1,
        queue: 1,
        state: 1,
        identity: 1,
        priority: -1,
        runAtMs: 1,
        orderSequence: 1,
        id: 1
      },
      name: 'claim'
    },
    { key: { namespace: 1, state: 1, leaseExpiresAtMs: 1 }, name: 'lease_sweep' },
    { key: { namespace: 1, createdAtMs: -1, orderSequence: -1, id: -1 }, name: 'created_listing' },
    {
      key: { namespace: 1, queue: 1, identity: 1, createdAtMs: -1, orderSequence: -1, id: -1 },
      name: 'queue_identity_listing'
    },
    {
      key: { namespace: 1, state: 1, finishedAtMs: -1, orderSequence: -1, id: -1 },
      name: 'terminal_listing'
    },
    {
      key: { namespace: 1, 'metadataEntries.key': 1, 'metadataEntries.value': 1 },
      name: 'metadata'
    },
    {
      key: {
        namespace: 1,
        queue: 1,
        state: 1,
        runAtMs: 1,
        priority: -1,
        orderSequence: 1,
        id: 1
      },
      name: 'controlled_claim'
    }
  ],
  [`${prefix}_attempts`]: [
    { key: { namespace: 1, jobId: 1, ledgerSequence: 1 }, name: 'attempt_ledger', unique: true }
  ],
  [`${prefix}_schedules`]: [
    {
      key: { namespace: 1, group: 1, scheduleKey: 1 },
      name: 'schedule_identity',
      unique: true
    },
    {
      key: { namespace: 1, paused: 1, nextRunAtMs: 1, group: 1, scheduleKey: 1 },
      name: 'schedule_due'
    },
    { key: { namespace: 1, group: 1, scheduleKey: 1 }, name: 'schedule_group' },
    { key: { namespace: 1, scheduleKey: 1, group: 1 }, name: 'schedule_key' }
  ],
  [`${prefix}_outbox`]: [
    { key: { namespace: 1, id: 1 }, name: 'outbox_identity', unique: true },
    {
      key: { namespace: 1, state: 1, runAtMs: 1, createdAtMs: 1, id: 1 },
      name: 'outbox_claim'
    },
    { key: { namespace: 1, state: 1, leaseExpiresAtMs: 1 }, name: 'outbox_lease_sweep' },
    { key: { namespace: 1, target: 1, state: 1, createdAtMs: -1, id: -1 }, name: 'outbox_target' }
  ],
  [`${prefix}_events`]: [
    { key: { namespace: 1, cursor: 1 }, name: 'event_cursor', unique: true },
    { key: { namespace: 1, queue: 1, cursor: 1 }, name: 'event_queue_cursor' },
    { key: { namespace: 1, eventType: 1, cursor: 1 }, name: 'event_type_cursor' },
    { key: { namespace: 1, recordedAtMs: 1, cursor: 1 }, name: 'event_retention' }
  ],
  [`${prefix}_controls`]: [
    { key: { namespace: 1, queue: 1 }, name: 'controls_identity', unique: true },
    { key: { namespace: 1, controlGroup: 1, queue: 1 }, name: 'controls_group' }
  ],
  [`${prefix}_controlled_permits`]: [
    { key: { namespace: 1, jobId: 1 }, name: 'controlled_permit_job', unique: true },
    { key: { namespace: 1, queue: 1, dispatchKey: 1 }, name: 'controlled_permit_key' },
    { key: { namespace: 1, jobId: 1, leaseToken: 1 }, name: 'controlled_permit_owner' }
  ],
  [`${prefix}_controlled_rate_windows`]: [
    { key: { namespace: 1, queue: 1 }, name: 'controlled_rate_window', unique: true }
  ],
  [`${prefix}_controlled_cursors`]: [
    { key: { namespace: 1, queue: 1 }, name: 'controlled_cursor', unique: true }
  ]
})

const flowIndexes = (prefix: string) => ({
  [`${prefix}_jobs`]: [
    {
      key: { namespace: 1, state: 1, updatedAtMs: 1, orderSequence: 1, id: 1 },
      name: 'waiting_children',
      partialFilterExpression: { state: 'waiting-children' }
    },
    { key: { namespace: 1, 'parent.flowId': 1, 'parent.childKey': 1 }, name: 'flow_parent' }
  ],
  [`${prefix}_flow_children`]: [
    {
      key: { namespace: 1, flowId: 1, childKey: 1 },
      name: 'flow_child_identity',
      unique: true
    },
    { key: { namespace: 1, childJobId: 1 }, name: 'flow_child_job', unique: true },
    {
      key: { namespace: 1, flowId: 1, status: 1, pendingSinceMs: 1, childKey: 1 },
      name: 'flow_child_pending'
    },
    {
      key: { namespace: 1, flowId: 1, status: 1, cascaded: 1, childKey: 1 },
      name: 'flow_child_cascade'
    }
  ],
  [`${prefix}_flow_outbox`]: [
    { key: { namespace: 1, id: 1 }, name: 'flow_outbox_identity', unique: true },
    { key: { namespace: 1, sequence: 1, id: 1 }, name: 'flow_outbox_claim' },
    {
      key: { namespace: 1, parentStoreKey: 1, sequence: 1, id: 1 },
      name: 'flow_outbox_route'
    },
    { key: { namespace: 1, 'report.flowId': 1, sequence: 1, id: 1 }, name: 'flow_outbox_parent' }
  ]
})

const ensureCollection = async (
  db: MongoDb,
  name: string,
  validation: object | undefined
): Promise<void> => {
  try {
    await db.createCollection?.(
      name,
      validation === undefined
        ? undefined
        : { validator: validation, validationLevel: 'moderate', validationAction: 'error' }
    )
  } catch (cause) {
    const code =
      cause !== null && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined
    if (code !== 48 && code !== 'NamespaceExists')
      throw new MongoJobStoreMigrationError('MongoDB collection creation failed', { cause })
    if (validation !== undefined)
      await db.command?.({
        collMod: name,
        validator: validation,
        validationLevel: 'moderate',
        validationAction: 'error'
      })
  }
}

export const MongoJobStoreMigrator = Object.freeze({
  async migrate(
    options: MongoMigrationOptions
  ): Promise<{ readonly version: typeof MONGODB_LAYOUT_VERSION; readonly applied: boolean }> {
    const prefix = validateCollectionPrefix(options.collectionPrefix ?? 'better_effect_mq')
    const db = normalizeMongoJobStoreConfig({ db: options.db, collectionPrefix: prefix }).db
    const collections = mongoCollections(db, prefix)
    const existingLayout = await collections.migrations.findOne({ _id: 'layout' })
    if (
      existingLayout !== null &&
      (existingLayout.protocolVersion !== MONGODB_PROTOCOL_VERSION ||
        typeof existingLayout.layoutVersion !== 'number' ||
        existingLayout.layoutVersion > MONGODB_LAYOUT_VERSION ||
        existingLayout.layoutVersion < 1)
    )
      throw new MongoJobStoreLayoutError(
        'MongoDB namespace layout is incompatible; migration cannot overwrite another protocol or layout version',
        ['incompatible protocol or layout version']
      )
    const existingFlowLayout = await collections.migrations.findOne({ _id: 'flow-layout' })
    if (
      existingFlowLayout !== null &&
      (existingFlowLayout.protocolVersion !== MONGODB_FLOW_PROTOCOL_VERSION ||
        existingFlowLayout.layoutVersion !== MONGODB_FLOW_LAYOUT_VERSION)
    )
      throw new MongoFlowProtocolMismatchError({
        expectedProtocolVersion: MONGODB_FLOW_PROTOCOL_VERSION,
        actualProtocolVersion:
          typeof existingFlowLayout.protocolVersion === 'number'
            ? existingFlowLayout.protocolVersion
            : undefined,
        actualLayoutVersion:
          typeof existingFlowLayout.layoutVersion === 'number'
            ? existingFlowLayout.layoutVersion
            : undefined
      })
    const jobSchema = existingFlowLayout === null ? schemas.jobs : jobsV2Schema
    const owner = randomUUID()
    // A conditional upsert races when two fresh processes observe no lock
    // document. Duplicate-key is contention, not a layout failure.
    let acquired = false
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      const now = Date.now()
      try {
        const lock = await collections.migrations.findOneAndUpdate(
          { _id: 'migration-lock', $or: [{ leaseExpiresAtMs: { $lt: now } }, { owner }] },
          { $set: { owner, leaseExpiresAtMs: now + 60_000 }, $inc: { fencing: 1 } },
          { upsert: true, returnDocument: 'after' }
        )
        const document =
          lock !== null && typeof lock === 'object' && 'value' in lock
            ? (lock as { readonly value?: unknown }).value
            : lock
        acquired = document !== null
      } catch (cause) {
        const duplicate =
          typeof cause === 'object' &&
          cause !== null &&
          ((cause as { readonly code?: unknown }).code === 11000 ||
            (cause as { readonly codeName?: unknown }).codeName === 'DuplicateKey')
        if (!duplicate) throw cause
      }
    }
    if (!acquired)
      throw new MongoJobStoreMigrationError('MongoDB migration lock is held by another process')
    try {
      const names = collectionNames(prefix)
      await ensureCollection(db, names[0]!, jobSchema)
      await ensureCollection(db, names[1]!, schemas.attempts)
      await ensureCollection(db, names[2]!, schemas.queues)
      await ensureCollection(db, names[3]!, undefined)
      await ensureCollection(db, names[4]!, undefined)
      await ensureCollection(db, names[5]!, schemas.schedules)
      await ensureCollection(db, names[6]!, schemas.outbox)
      await ensureCollection(db, names[7]!, schemas.events)
      await ensureCollection(db, names[8]!, controlsSchema)
      await ensureCollection(db, names[9]!, permitsSchema)
      await ensureCollection(db, names[10]!, rateWindowsSchema)
      await ensureCollection(db, names[11]!, controlCursorsSchema)
      const declared = indexes(prefix)
      for (const [name, definition] of Object.entries(declared))
        await db.collection(name).createIndexes(definition)
      await collections.migrations.updateOne(
        { _id: 'layout' },
        {
          $set: {
            protocolVersion: MONGODB_PROTOCOL_VERSION,
            layoutVersion: MONGODB_LAYOUT_VERSION,
            updatedAtMs: Date.now()
          }
        },
        { upsert: true }
      )
      return Object.freeze({ version: MONGODB_LAYOUT_VERSION, applied: true })
    } finally {
      await collections.migrations.updateOne(
        { _id: 'migration-lock', owner },
        { $set: { leaseExpiresAtMs: 0 } }
      )
    }
  },
  async validate(db: MongoDb, collectionPrefix = 'better_effect_mq'): Promise<void> {
    const prefix = validateCollectionPrefix(collectionPrefix)
    const marker = await mongoCollections(db, prefix).migrations.findOne({ _id: 'layout' })
    const problems: string[] = []
    if (marker?.protocolVersion !== MONGODB_PROTOCOL_VERSION)
      problems.push('incompatible protocol version')
    if (marker?.layoutVersion !== MONGODB_LAYOUT_VERSION)
      problems.push('incompatible layout version')
    if (problems.length > 0)
      throw new MongoJobStoreLayoutError(
        'MongoDB namespace layout is incompatible; run MongoJobStore.migrate() explicitly',
        problems
      )
  }
})

export const MongoFlowMigrator = Object.freeze({
  async migrate(
    options: MongoMigrationOptions
  ): Promise<{ readonly version: typeof MONGODB_FLOW_LAYOUT_VERSION; readonly applied: boolean }> {
    const prefix = validateCollectionPrefix(options.collectionPrefix ?? 'better_effect_mq')
    const db = normalizeMongoJobStoreConfig({ db: options.db, collectionPrefix: prefix }).db
    const collections = mongoCollections(db, prefix)
    const base = await collections.migrations.findOne({ _id: 'layout' })
    if (
      base === null ||
      base.protocolVersion !== MONGODB_PROTOCOL_VERSION ||
      base.layoutVersion !== MONGODB_LAYOUT_VERSION
    )
      throw new MongoFlowProtocolMismatchError({
        expectedProtocolVersion: MONGODB_FLOW_PROTOCOL_VERSION,
        actualProtocolVersion:
          typeof base?.protocolVersion === 'number' ? base.protocolVersion : undefined,
        actualLayoutVersion:
          typeof base?.layoutVersion === 'number' ? base.layoutVersion : undefined
      })
    const marker = await collections.migrations.findOne({ _id: 'flow-layout' })
    if (marker !== null) {
      if (
        marker.protocolVersion !== MONGODB_FLOW_PROTOCOL_VERSION ||
        marker.layoutVersion !== MONGODB_FLOW_LAYOUT_VERSION
      )
        throw new MongoFlowProtocolMismatchError({
          expectedProtocolVersion: MONGODB_FLOW_PROTOCOL_VERSION,
          actualProtocolVersion:
            typeof marker.protocolVersion === 'number' ? marker.protocolVersion : undefined,
          actualLayoutVersion:
            typeof marker.layoutVersion === 'number' ? marker.layoutVersion : undefined
        })
      return Object.freeze({ version: MONGODB_FLOW_LAYOUT_VERSION, applied: false })
    }
    const owner = randomUUID()
    let acquired = false
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      const now = Date.now()
      try {
        const lock = await collections.migrations.findOneAndUpdate(
          { _id: 'flow-migration-lock', $or: [{ leaseExpiresAtMs: { $lt: now } }, { owner }] },
          { $set: { owner, leaseExpiresAtMs: now + 60_000 }, $inc: { fencing: 1 } },
          { upsert: true, returnDocument: 'after' }
        )
        const document =
          lock !== null && typeof lock === 'object' && 'value' in lock
            ? (lock as { readonly value?: unknown }).value
            : lock
        acquired = document !== null
      } catch (cause) {
        const duplicate =
          typeof cause === 'object' &&
          cause !== null &&
          ((cause as { readonly code?: unknown }).code === 11000 ||
            (cause as { readonly codeName?: unknown }).codeName === 'DuplicateKey')
        if (!duplicate) throw cause
      }
    }
    if (!acquired)
      throw new MongoJobStoreMigrationError(
        'MongoDB flow migration lock is held by another process'
      )
    try {
      const names = flowCollectionNames(prefix)
      await ensureCollection(db, `${prefix}_jobs`, jobsV2Schema)
      await ensureCollection(db, names[0]!, flowChildrenSchema)
      await ensureCollection(db, names[1]!, flowOutboxSchema)
      const declared = flowIndexes(prefix)
      for (const [name, definition] of Object.entries(declared))
        await db.collection(name).createIndexes(definition)
      await collections.migrations.updateOne(
        { _id: 'flow-layout' },
        {
          $set: {
            protocolVersion: MONGODB_FLOW_PROTOCOL_VERSION,
            layoutVersion: MONGODB_FLOW_LAYOUT_VERSION,
            migration: {
              status: 'complete',
              from: undefined,
              to: MONGODB_FLOW_LAYOUT_VERSION
            },
            updatedAtMs: Date.now()
          }
        },
        { upsert: true }
      )
      return Object.freeze({ version: MONGODB_FLOW_LAYOUT_VERSION, applied: true })
    } finally {
      await collections.migrations.updateOne(
        { _id: 'flow-migration-lock', owner },
        { $set: { leaseExpiresAtMs: 0 } }
      )
    }
  },
  async validate(db: MongoDb, collectionPrefix = 'better_effect_mq'): Promise<void> {
    const prefix = validateCollectionPrefix(collectionPrefix)
    const collections = mongoCollections(db, prefix)
    const base = await collections.migrations.findOne({ _id: 'layout' })
    if (
      base?.protocolVersion !== MONGODB_PROTOCOL_VERSION ||
      base.layoutVersion !== MONGODB_LAYOUT_VERSION
    )
      throw new MongoFlowProtocolMismatchError({
        expectedProtocolVersion: MONGODB_FLOW_PROTOCOL_VERSION,
        actualProtocolVersion:
          typeof base?.protocolVersion === 'number' ? base.protocolVersion : undefined,
        actualLayoutVersion:
          typeof base?.layoutVersion === 'number' ? base.layoutVersion : undefined
      })
    const marker = await collections.migrations.findOne({ _id: 'flow-layout' })
    if (
      marker?.protocolVersion !== MONGODB_FLOW_PROTOCOL_VERSION ||
      marker.layoutVersion !== MONGODB_FLOW_LAYOUT_VERSION
    )
      throw new MongoFlowProtocolMismatchError({
        expectedProtocolVersion: MONGODB_FLOW_PROTOCOL_VERSION,
        actualProtocolVersion:
          typeof marker?.protocolVersion === 'number' ? marker.protocolVersion : undefined,
        actualLayoutVersion:
          typeof marker?.layoutVersion === 'number' ? marker.layoutVersion : undefined
      })
  }
})
