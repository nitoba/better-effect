// oxlint-disable anti-slop/no-chained-type-assertions -- Bun's official binding structurally satisfies the generic driver boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- acquisition failures are preserved across host cleanup.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the host-binding cast is deliberately isolated to this subpath.
import { Database } from 'bun:sqlite'
import { Layer } from 'better-effect'
import {
  FlowStore,
  JobStore,
  type AnyJobStoreToken,
  type AnyFlowStoreToken,
  type FlowStore as FlowStoreNamespace,
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
import { SqliteFlowStore, type SqliteFlowStoreConfig } from './SqliteFlowStore'
import { SqliteOutboxStore, type SqliteOutboxStoreConfig } from './SqliteOutboxStore'

/** Bun host binding. It is isolated from the generic adapter entrypoint. */
export const openSqlite = (path: string): SqliteDatabase =>
  new Database(path) as unknown as SqliteDatabase

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

/** Adapter-owned Bun database lifecycle. Run `SqliteJobStore.migrate` first. */
export const layerFromFile = (
  config: SqliteFileJobStoreConfig
): Layer<JobStoreNamespace.Instance, never> => ownedLayer(JobStore, config)
export const layerFromFileFor = <Token extends AnyJobStoreToken>(
  token: Token,
  config: SqliteFileJobStoreConfig
): Layer<InstanceType<Token>, never> => ownedLayer(token, config)

export interface SqliteFileFlowStoreConfig extends Omit<SqliteFlowStoreConfig, 'database'> {
  readonly path: string
}

const ownedFlowLayer = <Token extends AnyFlowStoreToken>(
  token: Token,
  config: SqliteFileFlowStoreConfig
) =>
  Layer.scoped(
    token,
    () => {
      const { path, ...options } = config
      const database = openSqlite(path)
      try {
        database.exec('PRAGMA journal_mode = WAL;')
        const store = SqliteFlowStore.make({
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

/** Adapter-owned Bun database lifecycle for FlowStore v2. */
export const flowLayerFromFile = (
  config: SqliteFileFlowStoreConfig
): Layer<FlowStoreNamespace.Instance, never> => ownedFlowLayer(FlowStore, config)
export const flowLayerFromFileFor = <Token extends AnyFlowStoreToken>(
  token: Token,
  config: SqliteFileFlowStoreConfig
): Layer<InstanceType<Token>, never> => ownedFlowLayer(token, config)

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

/** Adapter-owned Bun database lifecycle for a durable outbox. */
export const outboxLayerFromFile = (
  config: SqliteFileOutboxStoreConfig
): Layer<OutboxStoreNamespace.Instance, never> => ownedOutboxLayer(OutboxStore, config)
export const outboxLayerFromFileFor = <Token extends AnyOutboxStoreToken>(
  token: Token,
  config: SqliteFileOutboxStoreConfig
): Layer<InstanceType<Token>, never> => ownedOutboxLayer(token, config)
