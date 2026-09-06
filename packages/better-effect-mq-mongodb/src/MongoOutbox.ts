// oxlint-disable anti-slop/no-runtime-typeof -- MongoDB documents and public DTOs are validated at this boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- BSON queries and driver replies are intentionally opaque here.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- BSON documents are field-based persistence DTOs.
// oxlint-disable anti-slop/no-chained-type-assertions -- assertions restore validated records at the driver boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts follow explicit document validation.
// oxlint-disable anti-slop/no-known-value-widening -- BSON documents intentionally combine a fixed envelope with optional fields.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional BSON fields are omitted rather than persisted as undefined.

import { createHash } from 'node:crypto'
import { Result } from 'better-result'
import {
  OutboxConflictError,
  OutboxDefinitionError,
  OutboxStoreFailure,
  OutboxStore,
  isOutboxStoreToken,
  validateOutboxRecord,
  type AnyOutboxStoreToken,
  type OutboxAppendError,
  type OutboxAppendResult,
  type OutboxEffect,
  type OutboxRecord,
  type OutboxStoreError
} from 'better-effect-mq-outbox'

import {
  DEFAULT_COLLECTION_PREFIX,
  DEFAULT_NAMESPACE,
  validateCollectionPrefix,
  validateNamespace,
  type MongoCollection,
  type MongoDb,
  type MongoSession
} from './config'
import { mongoCollections, namespaceId } from './collections'

export type MongoOutboxTransaction = MongoSession
export type MongoOutboxRow = Record<string, unknown>

export interface MongoOutboxAppendOptions {
  readonly db: MongoDb
  readonly namespace?: string
  readonly collectionPrefix?: string
  readonly token?: AnyOutboxStoreToken
}

const failed = <Value, Failure extends OutboxStoreError>(
  error: Failure
): OutboxEffect<Value, Failure> => Result.err(error) as unknown as OutboxEffect<Value, Failure>

const succeeded = <Value>(value: Value): OutboxEffect<Value, never> =>
  Result.ok(value) as unknown as OutboxEffect<Value, never>

const isAppendError = (value: unknown): value is OutboxAppendError =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { readonly _tag?: unknown })._tag === 'string' &&
  ['OutboxDefinitionError', 'OutboxConflictError', 'OutboxStoreFailure'].includes(
    (value as { readonly _tag: string })._tag
  )

const retryable = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false
  const error = cause as { readonly code?: unknown; readonly errorLabels?: unknown }
  return (
    error.code === 91 ||
    error.code === 10107 ||
    (Array.isArray(error.errorLabels) &&
      error.errorLabels.some(
        (label) =>
          label === 'TransientTransactionError' || label === 'UnknownTransactionCommitResult'
      ))
  )
}

const failure = (operation: string, cause: unknown): OutboxStoreFailure =>
  new OutboxStoreFailure({
    operation,
    retryable: retryable(cause),
    message: `MongoDB ${operation} failed`
  })

const stored = (value: unknown): MongoOutboxRow | undefined => {
  if (value === null) return undefined
  if (typeof value !== 'object') return undefined
  if ('value' in value) {
    const document = (value as { readonly value?: unknown }).value
    return document === null || typeof document !== 'object'
      ? undefined
      : (document as MongoOutboxRow)
  }
  return value as MongoOutboxRow
}

const updatedExisting = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || !('lastErrorObject' in value)) return false
  const details = (value as { readonly lastErrorObject?: unknown }).lastErrorObject
  return typeof details === 'object' && details !== null && 'updatedExisting' in details
    ? (details as { readonly updatedExisting?: unknown }).updatedExisting === true
    : false
}

const encode = (namespace: string, record: OutboxRecord): MongoOutboxRow => ({
  _id: namespaceId(namespace, record.id),
  namespace,
  id: record.id,
  protocolVersion: record.protocolVersion,
  target: record.target,
  state: record.state,
  request: record.request,
  requestDigest: record.requestDigest,
  attemptsMax: record.attemptsMax,
  attemptsMade: record.attemptsMade,
  runAtMs: record.runAtMs,
  createdAtMs: record.createdAtMs,
  updatedAtMs: record.updatedAtMs,
  ...(record.publishedAtMs === undefined ? {} : { publishedAtMs: record.publishedAtMs }),
  ...(record.leaseOwner === undefined ? {} : { leaseOwner: record.leaseOwner }),
  ...(record.leaseToken === undefined ? {} : { leaseToken: record.leaseToken }),
  ...(record.leaseExpiresAtMs === undefined ? {} : { leaseExpiresAtMs: record.leaseExpiresAtMs }),
  ...(record.failure === undefined ? {} : { failure: record.failure })
})

const decode = (document: MongoOutboxRow): OutboxRecord => {
  const checked = validateOutboxRecord({
    id: document.id,
    protocolVersion: document.protocolVersion,
    target: document.target,
    state: document.state,
    request: document.request,
    requestDigest: document.requestDigest,
    attemptsMax: document.attemptsMax,
    attemptsMade: document.attemptsMade,
    runAtMs: document.runAtMs,
    createdAtMs: document.createdAtMs,
    updatedAtMs: document.updatedAtMs,
    publishedAtMs: document.publishedAtMs,
    leaseOwner: document.leaseOwner,
    leaseToken: document.leaseToken,
    leaseExpiresAtMs: document.leaseExpiresAtMs,
    failure: document.failure
  })
  if (Result.isError(checked)) throw checked.error
  return checked.value
}

const initial = (value: OutboxRecord): OutboxRecord => {
  const checked = validateOutboxRecord(value)
  if (Result.isError(checked)) throw checked.error
  if (
    checked.value.state !== 'pending' ||
    checked.value.attemptsMade !== 0 ||
    checked.value.publishedAtMs !== undefined ||
    checked.value.leaseOwner !== undefined ||
    checked.value.leaseToken !== undefined ||
    checked.value.leaseExpiresAtMs !== undefined ||
    checked.value.failure !== undefined
  )
    throw new OutboxDefinitionError({
      field: 'record',
      message: 'append requires an initial pending record'
    })
  return checked.value
}

export const namespaceForOutboxToken = (token: AnyOutboxStoreToken, namespace: string): string =>
  token.serviceTag === OutboxStore.serviceTag
    ? namespace
    : `${namespace}:outbox-${createHash('sha256').update(token.serviceTag).digest('hex').slice(0, 48)}`

const normalize = (options: MongoOutboxAppendOptions): NormalizedAppendOptions => {
  const namespace = validateNamespace(options.namespace ?? DEFAULT_NAMESPACE)
  const collectionPrefix = validateCollectionPrefix(
    options.collectionPrefix ?? DEFAULT_COLLECTION_PREFIX
  )
  if (options.token !== undefined && !isOutboxStoreToken(options.token))
    throw new OutboxDefinitionError({ field: 'token', message: 'must be an OutboxStore token' })
  return {
    db: options.db,
    namespace:
      options.token === undefined ? namespace : namespaceForOutboxToken(options.token, namespace),
    collectionPrefix
  }
}

interface NormalizedAppendOptions {
  readonly db: MongoDb
  readonly namespace: string
  readonly collectionPrefix: string
}

const appendRecord = async (
  collection: MongoCollection,
  session: MongoSession,
  namespace: string,
  record: OutboxRecord
): Promise<OutboxAppendResult> => {
  const reply = await collection.findOneAndUpdate(
    { _id: namespaceId(namespace, record.id) },
    { $setOnInsert: encode(namespace, record) },
    {
      upsert: true,
      returnDocument: 'after',
      includeResultMetadata: true,
      session
    }
  )
  const document = stored(reply)
  if (document === undefined)
    throw new OutboxStoreFailure({
      operation: 'append',
      retryable: true,
      message: 'MongoDB returned no outbox document'
    })
  const persisted = decode(document)
  if (persisted.requestDigest !== record.requestDigest)
    throw new OutboxConflictError({
      id: record.id,
      existingDigest: persisted.requestDigest,
      incomingDigest: record.requestDigest
    })
  return { record: persisted, duplicate: updatedExisting(reply) }
}

export const MongoOutbox = Object.freeze({
  async appendIn(
    session: MongoOutboxTransaction,
    record: OutboxRecord,
    options: MongoOutboxAppendOptions
  ): Promise<OutboxEffect<OutboxAppendResult, OutboxAppendError>> {
    try {
      const normalized = normalize(options)
      const checked = initial(record)
      return succeeded(
        await appendRecord(
          mongoCollections(normalized.db, normalized.collectionPrefix).outbox,
          session,
          normalized.namespace,
          checked
        )
      )
    } catch (cause) {
      return failed<OutboxAppendResult, OutboxAppendError>(
        isAppendError(cause) ? cause : failure('append', cause)
      )
    }
  }
})

export const encodeMongoOutboxRecord = encode
export const decodeMongoOutboxRecord = decode
