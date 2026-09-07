// oxlint-disable anti-slop/no-runtime-typeof -- persisted metadata entries are validated at the MongoDB boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- BSON entry values are narrowed into the public metadata contract.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the entry object is structurally checked before accessing data fields.

import type { MongoDb } from './config'

export const MONGODB_LAYOUT_VERSION = 4 as const
export const MONGODB_PROTOCOL_VERSION = 1 as const
export const MONGODB_FLOW_LAYOUT_VERSION = 1 as const
export const MONGODB_FLOW_PROTOCOL_VERSION = 2 as const
export const MONGODB_EVENTS_LAYOUT_VERSION = 1 as const
export const MONGODB_EVENTS_PROTOCOL_VERSION = 1 as const

export type MongoCollections = ReturnType<typeof mongoCollections>

export const mongoCollections = (db: MongoDb, prefix: string) =>
  Object.freeze({
    jobs: db.collection(`${prefix}_jobs`),
    schedules: db.collection(`${prefix}_schedules`),
    attempts: db.collection(`${prefix}_attempts`),
    queues: db.collection(`${prefix}_queues`),
    counters: db.collection(`${prefix}_counters`),
    controls: db.collection(`${prefix}_controls`),
    permits: db.collection(`${prefix}_controlled_permits`),
    rateWindows: db.collection(`${prefix}_controlled_rate_windows`),
    controlCursors: db.collection(`${prefix}_controlled_cursors`),
    events: db.collection(`${prefix}_job_events`),
    migrations: db.collection(`${prefix}_migrations`),
    outbox: db.collection(`${prefix}_outbox`),
    flowChildren: db.collection(`${prefix}_flow_children`),
    flowOutbox: db.collection(`${prefix}_flow_outbox`)
  })

export const collectionNames = (prefix: string) =>
  Object.freeze([
    `${prefix}_jobs`,
    `${prefix}_attempts`,
    `${prefix}_queues`,
    `${prefix}_counters`,
    `${prefix}_migrations`,
    `${prefix}_schedules`,
    `${prefix}_outbox`,
    `${prefix}_controls`,
    `${prefix}_controlled_permits`,
    `${prefix}_controlled_rate_windows`,
    `${prefix}_controlled_cursors`
  ])

export const flowCollectionNames = (prefix: string) =>
  Object.freeze([`${prefix}_flow_children`, `${prefix}_flow_outbox`])

export const eventCollectionNames = (prefix: string) => Object.freeze([`${prefix}_job_events`])

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
