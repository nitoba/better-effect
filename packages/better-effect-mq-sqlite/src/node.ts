// oxlint-disable anti-slop/no-chained-type-assertions -- Node's official binding structurally satisfies the generic driver boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the host-binding cast is deliberately isolated to this subpath.
import { DatabaseSync } from 'node:sqlite'
import { Layer } from 'better-effect'
import {
  JobStore,
  type AnyJobStoreToken,
  type JobStore as JobStoreNamespace
} from 'better-effect-mq'
import type { SqliteDatabase } from './config'
import type { SqliteJobStoreConfig } from './config'
import { SqliteJobStore } from './SqliteJobStore'

/** Node 24 host binding. It is isolated from the generic adapter entrypoint. */
export const openSqlite = (path: string): SqliteDatabase =>
  new DatabaseSync(path) as unknown as SqliteDatabase

export interface SqliteFileJobStoreConfig extends Omit<SqliteJobStoreConfig, 'database'> {
  readonly path: string
}

const databases = new WeakMap<object, SqliteDatabase>()
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
        database.close?.()
        throw cause
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
