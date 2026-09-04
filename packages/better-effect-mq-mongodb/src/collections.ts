// oxlint-disable anti-slop/no-runtime-typeof -- persisted metadata entries are validated at the MongoDB boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- BSON entry values are narrowed into the public metadata contract.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the entry object is structurally checked before accessing data fields.

import type { MongoDb } from './config'

/** Layout 2 installs strict complete-document validators. */
export const MONGODB_LAYOUT_VERSION = 2 as const
export const MONGODB_PROTOCOL_VERSION = 1 as const

export type MongoCollections = ReturnType<typeof mongoCollections>

export const mongoCollections = (db: MongoDb, prefix: string) =>
  Object.freeze({
    jobs: db.collection(`${prefix}_jobs`),
    attempts: db.collection(`${prefix}_attempts`),
    queues: db.collection(`${prefix}_queues`),
    counters: db.collection(`${prefix}_counters`),
    migrations: db.collection(`${prefix}_migrations`)
  })

export const collectionNames = (prefix: string) =>
  Object.freeze([
    `${prefix}_jobs`,
    `${prefix}_attempts`,
    `${prefix}_queues`,
    `${prefix}_counters`,
    `${prefix}_migrations`
  ])

export const metadataEntries = (metadata: Readonly<Record<string, string>>) =>
  Object.freeze(
    Object.entries(metadata)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => Object.freeze({ key, value }))
  )

export const metadataFromEntries = (entries: unknown): Readonly<Record<string, string>> => {
  if (!Array.isArray(entries)) throw new TypeError('metadataEntries must be an array')
  const result = Object.create(null) as Record<string, string>
  let previous: string | undefined
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object')
      throw new TypeError('metadata entry is invalid')
    const key = (entry as { key?: unknown }).key
    const value = (entry as { value?: unknown }).value
    if (typeof key !== 'string' || typeof value !== 'string')
      throw new TypeError('metadata entry is invalid')
    if (previous !== undefined && previous >= key)
      throw new TypeError('metadata entries are not canonical')
    previous = key
    result[key] = value
  }
  return Object.freeze(result)
}

export const namespaceId = (...parts: readonly string[]): string => parts.join('\u0000')
