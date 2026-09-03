// oxlint-disable anti-slop/no-unknown-parameters -- key validators parse public JavaScript inputs at this boundary.
// oxlint-disable anti-slop/no-runtime-typeof -- runtime key validation establishes the string domain before encoding.

import type { JobState } from 'better-effect-mq'

import { RedisLayoutError } from './errors'
import { hasUnpairedSurrogate, utf8ByteLength } from './internal/text'

export const MAX_NAMESPACE_BYTES = 128 as const
export const MAX_PREFIX_BYTES = 128 as const
export const MAX_KEY_SEGMENT_BYTES = 512 as const
export const SAFE_INTEGER_WIDTH = 16 as const

const safeStates: readonly JobState[] = [
  'waiting',
  'delayed',
  'active',
  'completed',
  'failed',
  'cancelled'
]
const rawSegmentPattern = /^[A-Za-z0-9._-]+$/u
const safeIntegerTextPattern = /^\d{16}$/u

const invalid = (field: string, message: string): never => {
  throw new RedisLayoutError(message, field, 'INVALID_KEY')
}

const validateText = (value: unknown, field: string, maximumBytes: number): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    hasUnpairedSurrogate(value) ||
    utf8ByteLength(value) > maximumBytes
  ) {
    return invalid(field, `must be a non-empty well-formed string of at most ${maximumBytes} bytes`)
  }
  return value
}

export const validateNamespace = (value: unknown): string => {
  const namespace = validateText(value, 'namespace', MAX_NAMESPACE_BYTES)
  if (namespace.includes('{') || namespace.includes('}')) {
    return invalid('namespace', 'must not contain Redis hash-tag braces')
  }
  return namespace
}

export const validatePrefix = (value: unknown): string => {
  const prefix = validateText(value, 'prefix', MAX_PREFIX_BYTES)
  if (prefix.includes('{') || prefix.includes('}')) {
    return invalid('prefix', 'must not contain Redis hash-tag braces')
  }
  return prefix
}

export const validateKeySegment = (value: unknown, field = 'key segment'): string =>
  validateText(value, field, MAX_KEY_SEGMENT_BYTES)

const encodeBase64Url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')

const decodeBase64Url = (value: string, field: string): string => {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(value, 'base64url')
    )
    if (encodeBase64Url(decoded) !== value) return invalid(field, 'contains an invalid encoding')
    return decoded
  } catch (cause) {
    if (cause instanceof RedisLayoutError) throw cause
    return invalid(field, 'contains an invalid encoding')
  }
}

/** Encode a dynamic Redis key segment without delimiter collisions. */
export const encodeKeySegment = (value: string): string => {
  const segment = validateKeySegment(value)
  return rawSegmentPattern.test(segment) ? segment : `~${encodeBase64Url(segment)}`
}

export const decodeKeySegment = (value: string, field = 'key segment'): string => {
  if (typeof value !== 'string' || value.length === 0) return invalid(field, 'must be non-empty')
  if (value.startsWith('~')) {
    if (value.length === 1) return invalid(field, 'contains an invalid encoding')
    return decodeBase64Url(value.slice(1), field)
  }
  if (!rawSegmentPattern.test(value)) return invalid(field, 'contains an invalid encoding')
  return value
}

const encodeInteger = (value: number, field: string, positive = false): string => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (positive && value === 0)
  ) {
    return invalid(field, positive ? 'must be a positive safe integer' : 'must be a safe integer')
  }
  return String(value).padStart(SAFE_INTEGER_WIDTH, '0')
}

const decodeInteger = (value: string, field: string, positive = false): number => {
  if (!safeIntegerTextPattern.test(value))
    return invalid(field, 'contains an invalid integer encoding')
  const decoded = Number(value)
  if (!Number.isSafeInteger(decoded) || (positive && decoded === 0)) {
    return invalid(field, 'contains an unsafe integer')
  }
  return decoded
}

export interface RedisIdentity {
  readonly name: string
  readonly version: number
}

export const encodeIdentity = (name: string, version: number): string =>
  `${encodeKeySegment(validateKeySegment(name, 'identity.name'))}:${encodeInteger(version, 'identity.version', true)}`

export const decodeIdentity = (value: string): RedisIdentity => {
  if (typeof value !== 'string') return invalid('identity', 'must be a string')
  const separator = value.lastIndexOf(':')
  if (separator <= 0 || separator === value.length - 1) {
    return invalid('identity', 'contains an invalid encoding')
  }
  return Object.freeze({
    name: decodeKeySegment(value.slice(0, separator), 'identity.name'),
    version: decodeInteger(value.slice(separator + 1), 'identity.version', true)
  })
}

export const waitingScore = (priority: number): number => {
  if (typeof priority !== 'number' || !Number.isSafeInteger(priority)) {
    return invalid('priority', 'must be a safe integer')
  }
  return -priority
}

export interface RedisWaitingMember {
  readonly runAt: number
  readonly orderingSequence: number
  readonly jobId: string
}

export const encodeWaitingMember = (
  runAt: number,
  orderingSequence: number,
  jobId: string
): string =>
  `${encodeInteger(runAt, 'runAt')}:${encodeInteger(orderingSequence, 'orderingSequence')}:${encodeKeySegment(jobId)}`

export const decodeWaitingMember = (value: string): RedisWaitingMember => {
  if (typeof value !== 'string') return invalid('waiting member', 'must be a string')
  const parts = value.split(':')
  if (parts.length !== 3) return invalid('waiting member', 'contains an invalid encoding')
  return Object.freeze({
    runAt: decodeInteger(parts[0]!, 'waiting member.runAt'),
    orderingSequence: decodeInteger(parts[1]!, 'waiting member.orderingSequence'),
    jobId: decodeKeySegment(parts[2]!, 'waiting member.jobId')
  })
}

export interface RedisDelayedMember {
  readonly orderingSequence: number
  readonly jobId: string
}

export const encodeDelayedMember = (orderingSequence: number, jobId: string): string =>
  `${encodeInteger(orderingSequence, 'orderingSequence')}:${encodeKeySegment(jobId)}`

export const decodeDelayedMember = (value: string): RedisDelayedMember => {
  if (typeof value !== 'string') return invalid('delayed member', 'must be a string')
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) {
    return invalid('delayed member', 'contains an invalid encoding')
  }
  return Object.freeze({
    orderingSequence: decodeInteger(value.slice(0, separator), 'delayed member.orderingSequence'),
    jobId: decodeKeySegment(value.slice(separator + 1), 'delayed member.jobId')
  })
}

export const encodeListingMember = (orderingSequence: number, jobId: string): string =>
  encodeDelayedMember(orderingSequence, jobId)

export const decodeListingMember = (value: string): RedisDelayedMember => decodeDelayedMember(value)

export interface RedisKeyLayout {
  readonly prefix: string
  readonly namespace: string
  readonly base: string
  readonly wakeChannel: string
  readonly job: (jobId: string) => string
  readonly attempts: (jobId: string) => string
  readonly sequenceJobs: string
  readonly sequenceOutcome: string
  readonly identities: (queue: string) => string
  readonly waiting: (queue: string, name: string, version: number) => string
  readonly delayed: (queue: string, name: string, version: number) => string
  readonly active: string
  readonly queues: string
  readonly queue: (queue: string) => string
  readonly wake: string
  readonly layoutLock: string
  readonly counts: string
  readonly idempotency: (scopeHash?: string) => string
  readonly all: string
  readonly byQueue: (queue: string) => string
  readonly byIdentity: (name: string, version: number) => string
  readonly byState: (state: JobState) => string
  readonly finished: (state: JobState) => string
  readonly layout: string
}

const stateKey = (state: JobState, field: string): string => {
  if (!safeStates.includes(state)) return invalid(field, 'contains an unknown job state')
  return encodeKeySegment(state)
}

export const makeRedisKeyLayout = (prefixValue: string, namespaceValue: string): RedisKeyLayout => {
  const prefix = validatePrefix(prefixValue)
  const namespace = validateNamespace(namespaceValue)
  const base = `${prefix}:{${namespace}}`
  const suffix = (value: string): string => `${base}:${value}`
  const queueSegment = (queue: string): string =>
    encodeKeySegment(validateKeySegment(queue, 'queue'))
  const identitySegment = (name: string, version: number): string =>
    encodeIdentity(validateKeySegment(name, 'name'), version)
  const identityWithQueue = (queue: string, name: string, version: number): string =>
    `${queueSegment(queue)}:${identitySegment(name, version)}`

  const layout: RedisKeyLayout = {
    prefix,
    namespace,
    base,
    wakeChannel: suffix('wake'),
    job: (jobId: string) => suffix(`job:${encodeKeySegment(jobId)}`),
    attempts: (jobId: string) => suffix(`attempts:${encodeKeySegment(jobId)}`),
    sequenceJobs: suffix('seq:jobs'),
    sequenceOutcome: suffix('seq:outcome'),
    identities: (queue: string) => suffix(`identities:${queueSegment(queue)}`),
    waiting: (queue: string, name: string, version: number) =>
      suffix(`waiting:${identityWithQueue(queue, name, version)}`),
    delayed: (queue: string, name: string, version: number) =>
      suffix(`delayed:${identityWithQueue(queue, name, version)}`),
    active: suffix('active'),
    queues: suffix('queues'),
    queue: (queue: string) => suffix(`queue:${queueSegment(queue)}`),
    wake: suffix('wake'),
    layoutLock: suffix('layout-lock'),
    counts: suffix('counts'),
    idempotency: (scopeHash?: string) =>
      scopeHash === undefined
        ? suffix('idempotency')
        : suffix(`idempotency:${encodeKeySegment(scopeHash)}`),
    all: suffix('all'),
    byQueue: (queue: string) => suffix(`byqueue:${queueSegment(queue)}`),
    byIdentity: (name: string, version: number) =>
      suffix(`byidentity:${identitySegment(name, version)}`),
    byState: (state: JobState) => suffix(`bystate:${stateKey(state, 'state')}`),
    finished: (state: JobState) => suffix(`finished:${stateKey(state, 'state')}`),
    layout: suffix('layout')
  }
  return Object.freeze(layout)
}

export const createRedisKeyLayout = makeRedisKeyLayout

const hashTag = (key: string): Uint8Array => {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.includes('\u0000') ||
    hasUnpairedSurrogate(key)
  ) {
    return invalid('key', 'must be a non-empty well-formed string without NUL')
  }
  const open = key.indexOf('{')
  const close = open < 0 ? -1 : key.indexOf('}', open + 1)
  const value = open >= 0 && close > open + 1 ? key.slice(open + 1, close) : key
  return new TextEncoder().encode(value)
}

/** Redis Cluster's CRC16/XMODEM hash slot calculation. */
export const redisHashSlot = (key: string): number => {
  let crc = 0
  for (const byte of hashTag(key)) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1
      crc &= 0xffff
    }
  }
  return crc % 16384
}

export const keyHashSlot = redisHashSlot

export const assertSameRedisHashSlot = (keys: readonly string[]): number => {
  if (!Array.isArray(keys)) return invalid('keys', 'must be an array')
  const first = keys[0]
  if (first === undefined) return invalid('keys', 'must contain at least one key')
  const slot = redisHashSlot(first)
  for (const key of keys.slice(1)) {
    if (redisHashSlot(key) !== slot)
      return invalid('keys', 'must share one Redis Cluster hash slot')
  }
  return slot
}
