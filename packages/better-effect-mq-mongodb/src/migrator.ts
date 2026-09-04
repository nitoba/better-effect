// oxlint-disable anti-slop/no-runtime-typeof -- driver errors are reduced to a bounded namespace-exists diagnostic.
// oxlint-disable anti-slop/no-object-parameters -- JSON-schema documents are owned by the adapter and passed through to the driver.
// oxlint-disable anti-slop/no-known-value-widening -- validator returns a driver schema document deliberately erased from public API.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- only a checked driver error code is inspected.

import { randomUUID } from 'node:crypto'
import {
  collectionNames,
  MONGODB_LAYOUT_VERSION,
  MONGODB_PROTOCOL_VERSION,
  mongoCollections
} from './collections'
import { normalizeMongoJobStoreConfig, validateCollectionPrefix, type MongoDb } from './config'
import { MongoJobStoreLayoutError, MongoJobStoreMigrationError } from './errors'

export interface MongoMigrationOptions {
  readonly db: MongoDb
  readonly collectionPrefix?: string
}

const validator = (required: readonly string[], properties: object): object => ({
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
  })
} as const

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
    }
  ],
  [`${prefix}_attempts`]: [
    { key: { namespace: 1, jobId: 1, ledgerSequence: 1 }, name: 'attempt_ledger', unique: true }
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
  ): Promise<{ readonly version: 1; readonly applied: boolean }> {
    const prefix = validateCollectionPrefix(options.collectionPrefix ?? 'better_effect_mq')
    const db = normalizeMongoJobStoreConfig({ db: options.db, collectionPrefix: prefix }).db
    const collections = mongoCollections(db, prefix)
    const existingLayout = await collections.migrations.findOne({ _id: 'layout' })
    if (
      existingLayout !== null &&
      (existingLayout.protocolVersion !== MONGODB_PROTOCOL_VERSION ||
        existingLayout.layoutVersion !== MONGODB_LAYOUT_VERSION)
    )
      throw new MongoJobStoreLayoutError(
        'MongoDB namespace layout is incompatible; migration cannot overwrite another protocol or layout version',
        ['incompatible protocol or layout version']
      )
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
      await ensureCollection(db, names[0]!, schemas.jobs)
      await ensureCollection(db, names[1]!, schemas.attempts)
      await ensureCollection(db, names[2]!, schemas.queues)
      await ensureCollection(db, names[3]!, undefined)
      await ensureCollection(db, names[4]!, undefined)
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
      return Object.freeze({ version: 1 as const, applied: true })
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
