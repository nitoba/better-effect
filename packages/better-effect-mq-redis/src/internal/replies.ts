// oxlint-disable anti-slop/no-unknown-parameters -- replies are parsed by this boundary.
// oxlint-disable anti-slop/no-runtime-typeof -- Redis driver representations are narrowed here.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- hashes are normalized to string fields.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts follow reply validation.
import { RedisLayoutError } from '../errors'

export type RedisHash = Record<string, string>

const replyArray = (value: unknown, message: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new RedisLayoutError(message, 'reply', 'INVALID_DATA')
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new RedisLayoutError(message, 'reply', 'INVALID_DATA')
    }
    const keys = Reflect.ownKeys(value)
    if (
      keys.length !== value.length + 1 ||
      keys.some(
        (key) =>
          key !== 'length' &&
          (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length)
      )
    ) {
      throw new RedisLayoutError(message, 'reply', 'INVALID_DATA')
    }
    const output: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !('value' in descriptor))
        throw new RedisLayoutError(message, 'reply', 'INVALID_DATA')
      output.push(descriptor.value)
    }
    return output
  } catch (cause) {
    if (cause instanceof RedisLayoutError) throw cause
    throw new RedisLayoutError(message, 'reply', 'INVALID_DATA', { cause })
  }
}

export const hashReply = (value: unknown): RedisHash => {
  if (value === null || value === undefined) return Object.create(null) as RedisHash
  const out = Object.create(null) as RedisHash
  if (Array.isArray(value)) {
    const items = replyArray(value, 'malformed hash reply')
    if (items.length % 2 !== 0)
      throw new RedisLayoutError('malformed hash reply', 'reply', 'INVALID_DATA')
    for (let i = 0; i < items.length; i += 2) {
      if (typeof items[i] !== 'string' || typeof items[i + 1] !== 'string')
        throw new RedisLayoutError('malformed hash reply', 'reply', 'INVALID_DATA')
      out[items[i] as string] = items[i + 1] as string
    }
    return out
  }
  if (typeof value !== 'object')
    throw new RedisLayoutError('malformed hash reply', 'reply', 'INVALID_DATA')
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new RedisLayoutError('malformed hash reply', 'reply', 'INVALID_DATA')
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string')
        throw new RedisLayoutError('malformed hash reply', 'reply', 'INVALID_DATA')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'string'
      )
        throw new RedisLayoutError('malformed hash reply', 'reply', 'INVALID_DATA')
      out[key] = descriptor.value
    }
  } catch (cause) {
    if (cause instanceof RedisLayoutError) throw cause
    throw new RedisLayoutError('malformed hash reply', 'reply', 'INVALID_DATA', { cause })
  }
  return out
}

export const stringsReply = (value: unknown): readonly string[] =>
  Object.freeze(
    replyArray(value, 'malformed array reply').map((item) => {
      if (typeof item !== 'string')
        throw new RedisLayoutError('malformed string reply', 'reply', 'INVALID_DATA')
      return item
    })
  )

export const numberReply = (value: unknown, field = 'reply'): number => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(n))
    throw new RedisLayoutError('unsafe numeric reply', field, 'INVALID_DATA')
  return n
}

export interface RedisScriptReply {
  readonly status: 'ok' | 'error'
  readonly operation: string
  readonly values: readonly unknown[]
}

/** Validate Redis's deliberately untyped Lua array reply before it enters the store. */
export const scriptReply = (value: unknown, operation: string): RedisScriptReply => {
  const items = replyArray(value, 'malformed script reply')
  if (typeof items[0] !== 'string' || typeof items[1] !== 'string')
    throw new RedisLayoutError('malformed script reply', 'reply', 'INVALID_DATA')
  if (items[0] !== 'ok' && items[0] !== 'error')
    throw new RedisLayoutError('malformed script reply', 'reply', 'INVALID_DATA')
  if (items[0] === 'ok' && items[1] !== operation)
    throw new RedisLayoutError('script reply operation mismatch', 'reply', 'INVALID_DATA')
  return Object.freeze({
    status: items[0],
    operation: items[1],
    values: Object.freeze(items.slice(2))
  }) as RedisScriptReply
}
