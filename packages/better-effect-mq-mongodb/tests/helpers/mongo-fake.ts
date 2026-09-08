// oxlint-disable anti-slop/no-runtime-typeof -- this fake narrows values at the MongoDB boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- BSON test documents are intentionally erased.
// oxlint-disable anti-slop/no-unknown-returns -- the fake models the driver's opaque replies.
// oxlint-disable anti-slop/no-object-parameters -- MongoDB options are deliberately open here.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions stay in the fake driver.

import type { MongoCollection, MongoDb, MongoSession } from '../../src/config'

export type MongoFakeDocument = Record<string, unknown>

const at = (document: MongoFakeDocument, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (value, part) =>
        value !== null && typeof value === 'object'
          ? (value as MongoFakeDocument)[part]
          : undefined,
      document
    )

const matches = (document: MongoFakeDocument, filter: MongoFakeDocument): boolean => {
  for (const [field, expected] of Object.entries(filter)) {
    if (field === '$or') {
      if (
        !Array.isArray(expected) ||
        !expected.some((item) => matches(document, item as MongoFakeDocument))
      )
        return false
      continue
    }
    const actual = at(document, field)
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      for (const [operator, operand] of Object.entries(expected as MongoFakeDocument)) {
        if (operator === '$exists' && (operand === true) !== (actual !== undefined)) return false
        if (operator === '$in' && (!Array.isArray(operand) || !operand.includes(actual)))
          return false
        if (operator === '$gt' && !(typeof actual === 'number' && actual > (operand as number)))
          return false
        if (operator === '$lt' && !(typeof actual === 'number' && actual < (operand as number)))
          return false
        if (operator === '$lte' && !(typeof actual === 'number' && actual <= (operand as number)))
          return false
      }
      continue
    }
    if (actual !== expected) return false
  }
  return true
}

const update = (source: MongoFakeDocument, changes: MongoFakeDocument, inserting: boolean) => {
  const next = { ...source }
  if (inserting && changes.$setOnInsert !== undefined)
    Object.assign(next, changes.$setOnInsert as MongoFakeDocument)
  if (changes.$set !== undefined) Object.assign(next, changes.$set as MongoFakeDocument)
  if (changes.$inc !== undefined)
    for (const [field, amount] of Object.entries(changes.$inc as Record<string, number>))
      next[field] = (typeof next[field] === 'number' ? next[field] : 0) + amount
  if (changes.$unset !== undefined)
    for (const field of Object.keys(changes.$unset as MongoFakeDocument)) delete next[field]
  return next
}

export const makeDatabase = (): MongoDb => {
  const documents = new Map<string, MongoFakeDocument>()
  const handles = new Map<string, MongoCollection>()
  const collection = (name: string): MongoCollection => {
    const existing = handles.get(name)
    if (existing !== undefined) return existing
    const rows = () =>
      [...documents.entries()].filter(([, document]) => document.__collection === name)
    const handle: MongoCollection = {
      find: (filter = {}, options) => ({
        toArray: async () => {
          const sorted = rows()
            .map(([, document]) => document)
            .filter((document) => matches(document, filter as MongoFakeDocument))
          const limit = (options as { readonly limit?: number } | undefined)?.limit
          return limit === undefined ? sorted : sorted.slice(0, limit)
        }
      }),
      findOne: async (filter) =>
        rows().find(([, document]) => matches(document, filter as MongoFakeDocument))?.[1] ?? null,
      findOneAndUpdate: async (filter, changes, options = {}) => {
        const selected = rows().find(([, document]) =>
          matches(document, filter as MongoFakeDocument)
        )
        if (selected === undefined && (options as { readonly upsert?: boolean }).upsert !== true)
          return null
        const equality = Object.fromEntries(
          Object.entries(filter as MongoFakeDocument).filter(
            ([, value]) => value === null || typeof value !== 'object'
          )
        )
        const next = update(
          selected?.[1] ?? equality,
          changes as MongoFakeDocument,
          selected === undefined
        )
        next.__collection = name
        if (next._id === undefined) next._id = String((filter as MongoFakeDocument)._id)
        if (selected !== undefined) documents.delete(selected[0])
        documents.set(`${name}:${String(next._id)}`, next)
        return { value: { ...next } }
      },
      updateOne: async (filter, changes, options = {}) => {
        const selected = rows().find(([, document]) =>
          matches(document, filter as MongoFakeDocument)
        )
        if (selected === undefined) {
          if ((options as { readonly upsert?: boolean }).upsert !== true) return { matchedCount: 0 }
          const equality = Object.fromEntries(
            Object.entries(filter as MongoFakeDocument).filter(
              ([, value]) => value === null || typeof value !== 'object'
            )
          )
          const next = update(equality, changes as MongoFakeDocument, true)
          next.__collection = name
          if (next._id === undefined) next._id = String((filter as MongoFakeDocument)._id)
          documents.set(`${name}:${String(next._id)}`, next)
          return { matchedCount: 0 }
        }
        const next = update(selected[1], changes as MongoFakeDocument, false)
        next.__collection = name
        documents.set(selected[0], next)
        return { matchedCount: 1 }
      },
      insertOne: async (document) => {
        const key = `${name}:${String((document as MongoFakeDocument)._id)}`
        if (documents.has(key)) throw Object.assign(new Error('duplicate'), { code: 11000 })
        documents.set(key, { ...(document as MongoFakeDocument), __collection: name })
      },
      deleteOne: async (filter) => {
        const selected = rows().find(([, document]) =>
          matches(document, filter as MongoFakeDocument)
        )
        if (selected === undefined) return { deletedCount: 0 }
        documents.delete(selected[0])
        return { deletedCount: 1 }
      },
      deleteMany: async (filter) => {
        for (const [key, document] of rows())
          if (matches(document, filter as MongoFakeDocument)) documents.delete(key)
      },
      createIndexes: async () => undefined,
      aggregate: () => ({ toArray: async () => [] })
    }
    handles.set(name, handle)
    return handle
  }
  const session: MongoSession = {
    withTransaction: async (callback) => callback(),
    endSession: () => undefined
  }
  return {
    collection,
    admin: () => ({ command: async () => ({ logicalSessionTimeoutMinutes: 30, setName: 'rs0' }) }),
    createCollection: async () => undefined,
    command: async () => undefined,
    client: { startSession: () => session, close: async () => undefined }
  }
}
