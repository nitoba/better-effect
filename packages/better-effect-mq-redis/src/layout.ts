// oxlint-disable anti-slop/no-unknown-parameters -- Redis replies are narrowed by the layout reader.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- HGETALL replies are string dictionaries.
// oxlint-disable anti-slop/no-unknown-returns -- scan and hash replies are validated before use.
// oxlint-disable anti-slop/no-runtime-typeof -- Redis replies are narrowed by explicit layout parsers.
// oxlint-disable anti-slop/no-known-value-widening -- null-prototype Redis hash snapshots avoid pollution.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts follow reply shape validation.

import { createHash, randomUUID } from 'node:crypto'

import { RedisLayoutError, RedisLayoutMismatchError } from './errors'
import type { RedisCommandClient } from './config'
import type { RedisKeyLayout } from './keys'

export const REDIS_ADAPTER_VERSION = '0.1.0' as const
export const REDIS_PROTOCOL_VERSION = '1' as const
export const REDIS_LAYOUT_VERSION = '1' as const
export const MAX_LAYOUT_SCAN_PAGES = 10_000 as const
export const MAX_LAYOUT_SCAN_KEYS = 10_000 as const

export const REDIS_INDEX_CONFIGURATION = Object.freeze([
  'active',
  'all',
  'attempts',
  'byidentity',
  'byqueue',
  'bystate',
  'counts',
  'delayed',
  'finished',
  'identities',
  'idempotency',
  'job',
  'layout',
  'layout-lock',
  'queue',
  'queues',
  'seq:jobs',
  'seq:outcome',
  'waiting',
  'wake'
] as const)

const indexConfigurationChecksum = createHash('sha256')
  .update(JSON.stringify(REDIS_INDEX_CONFIGURATION))
  .digest('hex')

export const REDIS_INDEX_CONFIGURATION_CHECKSUM = indexConfigurationChecksum

export interface RedisLayoutMarker {
  readonly adapterVersion: string
  readonly protocolVersion: string
  readonly layoutVersion: string
  readonly scriptSetChecksum: string
  readonly indexConfigurationChecksum: string
}

type RedisHash = Record<string, string>

type ScanReply = {
  readonly cursor: string
  readonly keys: readonly string[]
}

const invalid = (field: string, message: string, cause?: unknown): RedisLayoutError =>
  new RedisLayoutError(message, field, 'INVALID_LAYOUT', cause === undefined ? {} : { cause })

const isObject = (value: unknown): value is object => value !== null && typeof value === 'object'

const readArrayItem = (value: readonly unknown[], index: number): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
  if (descriptor === undefined || !('value' in descriptor)) {
    throw invalid('layout', 'Redis reply contains a sparse or accessor array')
  }
  return descriptor.value
}

const toHash = (value: unknown): RedisHash => {
  if (value === null || value === undefined) return Object.create(null) as RedisHash
  if (Array.isArray(value)) return arrayToHash(value)
  if (value instanceof Map) {
    const output: RedisHash = Object.create(null) as RedisHash
    for (const [key, item] of value) {
      if (typeof key !== 'string' || typeof item !== 'string')
        throw invalid('layout', 'marker is malformed')
      output[key] = item
    }
    return output
  }
  if (!isObject(value)) throw invalid('layout', 'marker is malformed')
  const output: RedisHash = Object.create(null) as RedisHash
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid('layout', 'marker is malformed')
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw invalid('layout', 'marker is malformed')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        !descriptor.enumerable ||
        typeof descriptor.value !== 'string'
      ) {
        throw invalid('layout', 'marker is malformed')
      }
      output[key] = descriptor.value
    }
  } catch (cause) {
    if (cause instanceof RedisLayoutError) throw cause
    throw invalid('layout', 'marker is unreadable', cause)
  }
  return output
}

const arrayToHash = (value: readonly unknown[]): RedisHash => {
  if (value.length % 2 !== 0) throw invalid('layout', 'marker array is malformed')
  const output: RedisHash = Object.create(null) as RedisHash
  for (let index = 0; index < value.length; index += 2) {
    const key = readArrayItem(value, index)
    const item = readArrayItem(value, index + 1)
    if (typeof key !== 'string' || typeof item !== 'string') {
      throw invalid('layout', 'marker array is malformed')
    }
    output[key] = item
  }
  return output
}

const readScanKeys = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) throw invalid('scan', 'Redis scan reply is malformed')
  const keys: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const key = readArrayItem(value, index)
    if (typeof key !== 'string') throw invalid('scan', 'Redis scan reply is malformed')
    keys.push(key)
  }
  return Object.freeze(keys)
}

const toScanReply = (value: unknown): ScanReply => {
  if (Array.isArray(value)) {
    const cursor = readArrayItem(value, 0)
    const keys = readArrayItem(value, 1)
    if (typeof cursor !== 'string') throw invalid('scan', 'Redis scan reply is malformed')
    return { cursor, keys: readScanKeys(keys) }
  }
  if (isObject(value)) {
    try {
      const cursorDescriptor = Object.getOwnPropertyDescriptor(value, 'cursor')
      const keysDescriptor = Object.getOwnPropertyDescriptor(value, 'keys')
      if (
        cursorDescriptor === undefined ||
        !('value' in cursorDescriptor) ||
        keysDescriptor === undefined ||
        !('value' in keysDescriptor)
      ) {
        throw invalid('scan', 'Redis scan reply is malformed')
      }
      const cursor = cursorDescriptor.value
      if (typeof cursor !== 'string') throw invalid('scan', 'Redis scan reply is malformed')
      return { cursor, keys: readScanKeys(keysDescriptor.value) }
    } catch (cause) {
      if (cause instanceof RedisLayoutError) throw cause
      throw invalid('scan', 'Redis scan reply is unreadable', cause)
    }
  }
  throw invalid('scan', 'Redis scan reply is malformed')
}

const escapeScanPattern = (value: string): string =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll('*', '\\*')
    .replaceAll('?', '\\?')
    .replaceAll('[', '\\[')

const scanNamespace = async (
  client: RedisCommandClient,
  layout: RedisKeyLayout
): Promise<readonly string[]> => {
  const pattern = `${escapeScanPattern(layout.base)}:*`
  const discovered: string[] = []
  let cursor = '0'
  let pages = 0
  do {
    if (pages >= MAX_LAYOUT_SCAN_PAGES)
      throw invalid('layout', 'namespace scan exceeded its page limit')
    const reply = toScanReply(
      await client.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '256'])
    )
    for (const key of reply.keys) {
      if (!key.startsWith(`${layout.base}:`) || key === layout.layoutLock) continue
      discovered.push(key)
      if (discovered.length > MAX_LAYOUT_SCAN_KEYS) {
        throw invalid('layout', 'namespace scan exceeded its key limit')
      }
    }
    cursor = reply.cursor
    pages += 1
  } while (cursor !== '0')
  return Object.freeze(discovered)
}

const LAYOUT_LOCK_TTL_MS = 30_000

const acquireLayoutLock = async (
  client: RedisCommandClient,
  layout: RedisKeyLayout
): Promise<string> => {
  const token = randomUUID()
  try {
    const reply = await client.sendCommand([
      'SET',
      layout.layoutLock,
      token,
      'NX',
      'PX',
      String(LAYOUT_LOCK_TTL_MS)
    ])
    if (reply !== 'OK') {
      throw new RedisLayoutMismatchError(['layout initialization is already in progress'])
    }
    return token
  } catch (cause) {
    if (cause instanceof RedisLayoutError) throw cause
    throw invalid('layout', 'could not acquire layout initialization lock', cause)
  }
}

const releaseLayoutLock = async (
  client: RedisCommandClient,
  layout: RedisKeyLayout,
  token: string
): Promise<void> => {
  try {
    const current = await client.sendCommand(['GET', layout.layoutLock])
    if (current === token) await client.sendCommand(['DEL', layout.layoutLock])
  } catch (cause) {
    throw invalid('layout', 'could not release layout initialization lock', cause)
  }
}

const expectedMarker = (scriptSetChecksum: string): RedisLayoutMarker =>
  Object.freeze({
    adapterVersion: REDIS_ADAPTER_VERSION,
    protocolVersion: REDIS_PROTOCOL_VERSION,
    layoutVersion: REDIS_LAYOUT_VERSION,
    scriptSetChecksum,
    indexConfigurationChecksum: REDIS_INDEX_CONFIGURATION_CHECKSUM
  })

const markerFields = (marker: RedisLayoutMarker): RedisHash =>
  Object.freeze({
    adapterVersion: marker.adapterVersion,
    protocolVersion: marker.protocolVersion,
    layoutVersion: marker.layoutVersion,
    scriptSetChecksum: marker.scriptSetChecksum,
    indexConfigurationChecksum: marker.indexConfigurationChecksum
  }) as RedisHash

const readMarker = async (
  client: RedisCommandClient,
  layout: RedisKeyLayout
): Promise<RedisHash> => {
  try {
    return toHash(await client.sendCommand(['HGETALL', layout.layout]))
  } catch (cause) {
    if (cause instanceof RedisLayoutError) throw cause
    throw invalid('layout', 'could not read Redis layout marker', cause)
  }
}

const writeMarker = async (
  client: RedisCommandClient,
  layout: RedisKeyLayout,
  marker: RedisLayoutMarker
): Promise<void> => {
  const fields = markerFields(marker)
  try {
    const claimed = await client.sendCommand([
      'HSETNX',
      layout.layout,
      'adapterVersion',
      marker.adapterVersion
    ])
    if (claimed !== 1 && claimed !== '1') {
      throw new RedisLayoutMismatchError(['layout marker appeared during initialization'])
    }
    const command = ['HSET', layout.layout]
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'adapterVersion') continue
      command.push(key, value)
    }
    await client.sendCommand(command)
  } catch (cause) {
    if (cause instanceof RedisLayoutError) throw cause
    throw invalid('layout', 'could not create Redis layout marker', cause)
  }
}

const markerProblems = (actual: RedisHash, expected: RedisLayoutMarker): readonly string[] => {
  const problems: string[] = []
  for (const [field, value] of Object.entries(expected)) {
    if (actual[field] === undefined) problems.push(`missing ${field}`)
    else if (actual[field] !== value) problems.push(`incompatible ${field}`)
  }
  for (const field of Object.keys(actual)) {
    if (!(field in expected)) problems.push(`unsupported ${field}`)
  }
  return Object.freeze(problems)
}

const validateExistingMarker = (
  actual: RedisHash,
  expected: RedisLayoutMarker
): RedisLayoutMarker => {
  const problems = markerProblems(actual, expected)
  if (problems.length > 0) throw new RedisLayoutMismatchError(problems)
  return expected
}

const initializeEmptyLayout = async (
  client: RedisCommandClient,
  layout: RedisKeyLayout,
  expected: RedisLayoutMarker
): Promise<RedisLayoutMarker> => {
  const token = await acquireLayoutLock(client, layout)
  let result: RedisLayoutMarker | undefined
  let failure: unknown
  try {
    const actual = await readMarker(client, layout)
    if (Object.keys(actual).length > 0) {
      result = validateExistingMarker(actual, expected)
    } else {
      const existingKeys = await scanNamespace(client, layout)
      if (existingKeys.length > 0) {
        throw new RedisLayoutMismatchError(['layout marker is missing from a non-empty namespace'])
      }
      await writeMarker(client, layout, expected)
      result = expected
    }
  } catch (cause) {
    failure = cause
  }

  try {
    await releaseLayoutLock(client, layout, token)
  } catch (cause) {
    if (failure === undefined) failure = cause
    else failure = new AggregateError([failure, cause], 'Redis layout initialization failed')
  }
  if (failure !== undefined) throw failure
  return result!
}

/** Validate or initialize the cooperative namespace marker without deleting data. */
export const ensureRedisLayout = async (
  client: RedisCommandClient,
  layout: RedisKeyLayout,
  scriptSetChecksum: string,
  validateLayout: boolean
): Promise<RedisLayoutMarker | undefined> => {
  if (!validateLayout) return undefined
  const expected = expectedMarker(scriptSetChecksum)
  const actual = await readMarker(client, layout)
  if (Object.keys(actual).length > 0) return validateExistingMarker(actual, expected)
  return initializeEmptyLayout(client, layout, expected)
}
