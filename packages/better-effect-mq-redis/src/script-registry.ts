// oxlint-disable anti-slop/no-unknown-parameters -- driver replies and thrown errors are normalized here.
// oxlint-disable anti-slop/no-unknown-returns -- registry boundaries normalize optional-driver replies.
// oxlint-disable anti-slop/no-runtime-typeof -- thrown driver values are narrowed before error mapping.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts are immediately validated at the optional-driver boundary.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { RedisScriptError } from './errors'
import { assertSameRedisHashSlot } from './keys'
import { sendRedisCommand, type RedisCommandClient } from './config'

export const redisScriptNames = [
  'enqueue',
  'enqueue-many',
  'claim',
  'settle',
  'release',
  'heartbeat',
  'recover-stalled',
  'cancel',
  'promote',
  'retry',
  'remove',
  'pause',
  'resume'
] as const

export type RedisScriptName = (typeof redisScriptNames)[number]

export interface RedisScriptDefinition {
  readonly name: RedisScriptName
  readonly version: 1
  readonly source: string
}

export type RedisScriptManifest = readonly RedisScriptDefinition[]

const shaPattern = /^[0-9a-f]{40}$/u

const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (cause === null || typeof cause !== 'object') return ''
  try {
    const value = cause as { readonly message?: unknown; readonly code?: unknown }
    if (typeof value.message === 'string') return value.message
    if (typeof value.code === 'string') return value.code
  } catch {
    return ''
  }
  return ''
}

const errorCode = (cause: unknown): string | undefined => {
  const message = errorMessage(cause)
  const match = /\b(MQ_[A-Z0-9_]+|NOSCRIPT)\b/u.exec(message)
  return match?.[1]
}

const isNoScript = (cause: unknown): boolean => {
  if (errorMessage(cause).includes('NOSCRIPT')) return true
  if (cause === null || typeof cause !== 'object') return false
  try {
    return (cause as { readonly code?: unknown }).code === 'NOSCRIPT'
  } catch {
    return false
  }
}

const validScriptNames = new Set<string>(redisScriptNames)

const validateStringArray = (
  value: unknown,
  script: RedisScriptName,
  operation: string,
  allowEmpty: boolean
): readonly string[] => {
  if (!Array.isArray(value)) throw new RedisScriptError(script, operation, 'INVALID_ARGUMENTS')
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error('prototype')
    const keys = Reflect.ownKeys(value)
    if (
      keys.length !== value.length + 1 ||
      keys.some(
        (key) =>
          key !== 'length' &&
          (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length)
      )
    )
      throw new Error('shape')
    const output: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'string'
      )
        throw new Error('item')
      output.push(descriptor.value)
    }
    if (!allowEmpty && output.length === 0) throw new Error('empty')
    return Object.freeze(output)
  } catch (cause) {
    throw new RedisScriptError(script, operation, 'INVALID_ARGUMENTS', { cause })
  }
}

const normalizeManifest = (manifest: RedisScriptManifest): RedisScriptManifest => {
  if (!Array.isArray(manifest))
    throw new RedisScriptError('manifest', 'validate', 'INVALID_MANIFEST')
  try {
    if (Object.getPrototypeOf(manifest) !== Array.prototype) throw new Error('prototype')
    const keys = Reflect.ownKeys(manifest)
    if (
      keys.length !== manifest.length + 1 ||
      keys.some(
        (key) =>
          key !== 'length' &&
          (typeof key !== 'string' ||
            !/^(?:0|[1-9]\d*)$/u.test(key) ||
            Number(key) >= manifest.length)
      )
    )
      throw new Error('shape')
    for (let index = 0; index < manifest.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(manifest, String(index))
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
        throw new Error('item')
    }
  } catch (cause) {
    throw new RedisScriptError('manifest', 'validate', 'INVALID_MANIFEST', { cause })
  }
  const definitions: RedisScriptDefinition[] = []
  const seen = new Set<string>()
  try {
    for (const value of manifest) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new RedisScriptError('manifest', 'validate', 'INVALID_MANIFEST')
      }
      const prototype = Object.getPrototypeOf(value)
      const keys = Reflect.ownKeys(value)
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        keys.length !== 3 ||
        keys.some((key) => typeof key !== 'string')
      ) {
        throw new RedisScriptError('manifest', 'validate', 'INVALID_MANIFEST')
      }
      const nameDescriptor = Object.getOwnPropertyDescriptor(value, 'name')
      const versionDescriptor = Object.getOwnPropertyDescriptor(value, 'version')
      const sourceDescriptor = Object.getOwnPropertyDescriptor(value, 'source')
      if (
        nameDescriptor === undefined ||
        !('value' in nameDescriptor) ||
        !nameDescriptor.enumerable ||
        versionDescriptor === undefined ||
        !('value' in versionDescriptor) ||
        !versionDescriptor.enumerable ||
        sourceDescriptor === undefined ||
        !('value' in sourceDescriptor) ||
        !sourceDescriptor.enumerable
      ) {
        throw new RedisScriptError('manifest', 'validate', 'INVALID_MANIFEST')
      }
      const name = nameDescriptor.value
      const version = versionDescriptor.value
      const source = sourceDescriptor.value
      if (
        typeof name !== 'string' ||
        !validScriptNames.has(name) ||
        seen.has(name) ||
        version !== 1 ||
        typeof source !== 'string'
      ) {
        throw new RedisScriptError('manifest', 'validate', 'INVALID_MANIFEST')
      }
      seen.add(name)
      definitions.push(Object.freeze({ name: name as RedisScriptName, version: 1, source }))
    }
  } catch (cause) {
    if (cause instanceof RedisScriptError) throw cause
    throw new RedisScriptError('manifest', 'validate', 'INVALID_MANIFEST', { cause })
  }
  return Object.freeze(definitions)
}

const sourceChecksum = (manifest: RedisScriptManifest): string => {
  const hash = createHash('sha256')
  for (const definition of manifest) {
    hash.update(definition.name)
    hash.update('\u0000')
    hash.update(String(definition.version))
    hash.update('\u0000')
    hash.update(definition.source, 'utf8')
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

export const scriptSetChecksum = (manifest: RedisScriptManifest): string =>
  sourceChecksum(normalizeManifest(manifest))

const readDefinition = async (
  name: RedisScriptName,
  directory: URL
): Promise<RedisScriptDefinition> => {
  try {
    const source = await readFile(new URL(`${name}.lua`, directory), 'utf8')
    return Object.freeze({ name, version: 1, source })
  } catch (cause) {
    throw new RedisScriptError(name, 'read', 'SCRIPT_NOT_FOUND', { cause })
  }
}

export const loadRedisScriptManifest = async (
  directory = new URL('./scripts/', import.meta.url)
): Promise<RedisScriptManifest> => {
  const definitions: RedisScriptDefinition[] = []
  for (const name of redisScriptNames) definitions.push(await readDefinition(name, directory))
  return Object.freeze(definitions)
}

const normalizeSha = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !shaPattern.test(value)) {
    throw new RedisScriptError(name, 'load', 'INVALID_SHA')
  }
  return value
}

const isCallable = (value: unknown): value is (...args: never[]) => unknown =>
  typeof value === 'function'

/** Loaded Lua scripts with bounded NOSCRIPT recovery and no permanent EVAL fallback. */
export class RedisScriptRegistry {
  readonly manifest: RedisScriptManifest
  readonly scriptSetChecksum: string

  private readonly client: RedisCommandClient
  private readonly definitions: ReadonlyMap<RedisScriptName, RedisScriptDefinition>
  private readonly routingKey: string | undefined
  private readonly shas = new Map<RedisScriptName, string>()
  private readonly reloads = new Map<RedisScriptName, Promise<string>>()

  private constructor(
    client: RedisCommandClient,
    manifest: RedisScriptManifest,
    routingKey?: string
  ) {
    this.client = client
    this.manifest = manifest
    this.routingKey = routingKey
    this.scriptSetChecksum = sourceChecksum(manifest)
    this.definitions = new Map(manifest.map((definition) => [definition.name, definition]))
  }

  static async load(
    client: RedisCommandClient,
    manifest?: RedisScriptManifest,
    routingKey?: string
  ): Promise<RedisScriptRegistry> {
    const loadedManifest = normalizeManifest(manifest ?? (await loadRedisScriptManifest()))
    const registry = new RedisScriptRegistry(client, loadedManifest, routingKey)
    for (const definition of loadedManifest) await registry.loadOne(definition)
    return registry
  }

  getSha(name: RedisScriptName): string {
    const sha = this.shas.get(name)
    if (sha === undefined) throw new RedisScriptError(name, 'lookup', 'SCRIPT_NOT_LOADED')
    return sha
  }

  getSource(name: RedisScriptName): string {
    const definition = this.definitions.get(name)
    if (definition === undefined) throw new RedisScriptError(name, 'lookup', 'SCRIPT_UNKNOWN')
    return definition.source
  }

  async execute(
    name: RedisScriptName,
    keys: readonly string[],
    arguments_: readonly string[] = []
  ): Promise<unknown> {
    assertSameRedisHashSlot(keys)
    validateStringArray(arguments_, name, 'execute', true)
    try {
      return await this.evalSha(name, keys, arguments_)
    } catch (cause) {
      if (!isNoScript(cause)) throw this.executionError(name, cause)
      await this.reload(name, keys[0])
      try {
        return await this.evalSha(name, keys, arguments_)
      } catch (retryCause) {
        throw this.executionError(name, retryCause)
      }
    }
  }

  private async evalSha(
    name: RedisScriptName,
    keys: readonly string[],
    arguments_: readonly string[]
  ): Promise<unknown> {
    const command = ['EVALSHA', this.getSha(name), String(keys.length), ...keys, ...arguments_]
    return sendRedisCommand(this.client, command, keys[0] ?? this.routingKey)
  }

  private async loadOne(
    definition: RedisScriptDefinition,
    routingKey = this.routingKey
  ): Promise<string> {
    try {
      const reply = await sendRedisCommand(
        this.client,
        ['SCRIPT', 'LOAD', definition.source],
        routingKey
      )
      const sha = normalizeSha(reply, definition.name)
      this.shas.set(definition.name, sha)
      return sha
    } catch (cause) {
      if (cause instanceof RedisScriptError) throw cause
      throw new RedisScriptError(definition.name, 'load', errorCode(cause), { cause })
    }
  }

  private async reload(name: RedisScriptName, routingKey?: string): Promise<string> {
    const existing = this.reloads.get(name)
    if (existing !== undefined) return existing
    const definition = this.definitions.get(name)
    if (definition === undefined) throw new RedisScriptError(name, 'reload', 'SCRIPT_UNKNOWN')
    const pending = this.loadOne(definition, routingKey)
    this.reloads.set(name, pending)
    try {
      return await pending
    } finally {
      if (this.reloads.get(name) === pending) this.reloads.delete(name)
    }
  }

  private executionError(name: RedisScriptName, cause: unknown): RedisScriptError {
    return cause instanceof RedisScriptError
      ? cause
      : new RedisScriptError(name, 'execute', isNoScript(cause) ? 'NOSCRIPT' : errorCode(cause), {
          cause
        })
  }
}

export const isRedisScriptClient = (value: unknown): value is RedisCommandClient => {
  if (value === null || typeof value !== 'object') return false
  try {
    const candidate = value as { readonly sendCommand?: unknown }
    return isCallable(candidate.sendCommand)
  } catch {
    return false
  }
}
