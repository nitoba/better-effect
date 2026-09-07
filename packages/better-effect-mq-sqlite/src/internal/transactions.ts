import type { SqliteDatabase } from '../config'

const databaseChains = new WeakMap<object, Promise<void>>()

/** Serialize transactions that share one SQLite connection across adapter instances. */
export const withSqliteTransaction = async <Value>(
  database: SqliteDatabase,
  operation: () => Value | PromiseLike<Value>
): Promise<Value> => {
  const previous = databaseChains.get(database) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  databaseChains.set(
    database,
    result.then(
      () => undefined,
      () => undefined
    )
  )
  return result
}
