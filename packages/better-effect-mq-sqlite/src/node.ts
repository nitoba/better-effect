// oxlint-disable anti-slop/no-chained-type-assertions -- Node's official binding structurally satisfies the generic driver boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- acquisition failures are preserved across host cleanup.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the host-binding cast is deliberately isolated to this subpath.
import { DatabaseSync } from 'node:sqlite'
import { Layer } from 'better-effect'
import {
  JobStore,
  type AnyJobStoreToken,
  type JobStore as JobStoreNamespace
} from 'better-effect-mq'
import {
  OutboxStore,
  type AnyOutboxStoreToken,
  type OutboxStore as OutboxStoreNamespace
} from 'better-effect-mq-outbox'
import type { SqliteDatabase } from './config'
import type { SqliteJobStoreConfig } from './config'
import { SqliteJobStore } from './SqliteJobStore'
import { SqliteOutboxStore, type SqliteOutboxStoreConfig } from './SqliteOutboxStore'

/** Node 24 host binding. It is isolated from the generic adapter entrypoint. */
export const openSqlite = (path: string): SqliteDatabase =>
  new DatabaseSync(path) as unknown as SqliteDatabase

export interface SqliteFileJobStoreConfig extends Omit<SqliteJobStoreConfig, 'database'> {
  readonly path: string
}

const databases = new WeakMap<object, SqliteDatabase>()

const closeOwnedDatabase = (database: SqliteDatabase, cause: unknown): never => {
  try {
    database.close?.()
  } catch (cleanupCause) {
    throw new AggregateError([cause, cleanupCause], 'SQLite layer acquisition cleanup failed')
  }
  throw cause
}

const ownedLayer = <Token extends AnyJobStoreToken>(
  token: Token,
  config: SqliteFileJobStoreConfig
) =>
  Layer.scoped(
    token,
    () => {
      const { path, ...options } = config
      const database = openSqlite(path)
      try {
        database.exec('PRAGMA journal_mode = WAL;')
        const store = SqliteJobStore.make({
          ...options,
          database,
          configurePragmas: options.configurePragmas ?? true
        })
        databases.set(store, database)
        return store as never
      } catch (cause) {
        return closeOwnedDatabase(database, cause)
      }
    },
    (store) => databases.get(store as object)?.close?.()
  )

/** Adapter-owned Node database lifecycle. Run `SqliteJobStore.migrate` first. */
export const layerFromFile = (
  config: SqliteFileJobStoreConfig
): Layer<JobStoreNamespace.Instance, never> => ownedLayer(JobStore, config)
export const layerFromFileFor = <Token extends AnyJobStoreToken>(
  token: Token,
  config: SqliteFileJobStoreConfig
): Layer<InstanceType<Token>, never> => ownedLayer(token, config)

export interface SqliteFileOutboxStoreConfig extends Omit<SqliteOutboxStoreConfig, 'database'> {
  readonly path: string
}

const ownedOutboxLayer = <Token extends AnyOutboxStoreToken>(
  token: Token,
  config: SqliteFileOutboxStoreConfig
) =>
  Layer.scoped(
    token,
    () => {
      const { path, ...options } = config
      const database = openSqlite(path)
      try {
        database.exec('PRAGMA journal_mode = WAL;')
        const store = SqliteOutboxStore.make({
          ...options,
          database,
          configurePragmas: options.configurePragmas ?? true
        })
        const provided = token.of(store as never)
        databases.set(provided as object, database)
        return provided as never
      } catch (cause) {
        return closeOwnedDatabase(database, cause)
      }
    },
    (store) => databases.get(store as object)?.close?.()
  )

/** Adapter-owned Node database lifecycle for a durable outbox. */
export const outboxLayerFromFile = (
  config: SqliteFileOutboxStoreConfig
): Layer<OutboxStoreNamespace.Instance, never> => ownedOutboxLayer(OutboxStore, config)
export const outboxLayerFromFileFor = <Token extends AnyOutboxStoreToken>(
  token: Token,
  config: SqliteFileOutboxStoreConfig
): Layer<InstanceType<Token>, never> => ownedOutboxLayer(token, config)
