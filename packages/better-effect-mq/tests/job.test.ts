// oxlint-disable anti-slop/no-chained-type-assertions -- hostile-value tests intentionally cross untyped boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test casts describe invalid boundary values.
// oxlint-disable anti-slop/no-known-value-widening -- test casts deliberately model malformed JavaScript.
// oxlint-disable anti-slop/no-unknown-parameters -- codec implementations cross an untyped boundary.

import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { expect, test } from 'bun:test'
import { Result } from 'better-result'

import {
  Codec,
  Job,
  JobDefinitionError,
  JobRegistry,
  Queue,
  makePersistedBackoff,
  runIdempotencyKey,
  runMetadata,
  runRetryable
} from '../src'
import type { Codec as CodecType } from '../src'

const unwrap = <Value, Failure>(result: Result<Value, Failure>): Value => {
  if (Result.isError(result)) {
    throw result.error
  }

  return result.value
}

const expectDefinitionError = (operation: () => void): void => {
  try {
    operation()
    throw new Error('expected operation to throw')
  } catch (cause) {
    expect(JobDefinitionError.is(cause)).toBe(true)
  }
}

test('Queue.job creates an inert immutable versioned descriptor with normalized defaults', () => {
  let idempotencyCalls = 0
  let metadataCalls = 0
  const backoff = unwrap(
    makePersistedBackoff({ type: 'exponential', delayMs: 100, maxDelayMs: 1_000 })
  )
  const defaults = {
    attempts: 5,
    backoff,
    timeoutMs: 30_000,
    priority: 4
  }
  const payload = Codec.json<{
    readonly messageId: string
    readonly tenantId: string
  }>()
  const queue = Queue.define('emails')
  const definition = queue.job('send-email', {
    version: 1,
    payload,
    defaults,
    idempotencyKey: ({ messageId }) => {
      idempotencyCalls += 1
      return messageId
    },
    metadata: ({ tenantId }) => {
      metadataCalls += 1
      return { tenantId }
    }
  })

  expect(definition.queue).toBe('emails')
  expect(definition.name).toBe('send-email')
  expect(definition.version).toBe(1)
  expect(definition.identity).toEqual({ queue: 'emails', name: 'send-email', version: 1 })
  expect(definition.defaults).toEqual({
    attempts: 5,
    backoff: { type: 'exponential', delayMs: 100, maxDelayMs: 1_000 },
    timeoutMs: 30_000,
    priority: 4
  })
  expect(Object.isFrozen(queue)).toBe(true)
  expect(Object.isFrozen(definition)).toBe(true)
  expect(Object.isFrozen(definition.identity)).toBe(true)
  expect(Object.isFrozen(definition.defaults)).toBe(true)
  expect(Object.isFrozen(definition.defaults.backoff)).toBe(true)
  expect(idempotencyCalls).toBe(0)
  expect(metadataCalls).toBe(0)

  defaults.attempts = 99
  expect(definition.defaults.attempts).toBe(5)
})

test('job definitions snapshot decorated and class codec receivers at definition time', async () => {
  const queue = Queue.define('codecs')
  const decorated = {
    state: { prefix: 'decorated' },
    encode(value: string) {
      return Codec.string.encode(`${this.state.prefix}:${value}`)
    },
    decode(value: unknown) {
      return Codec.string.decode(`${this.state.prefix}:${String(value)}`)
    }
  }

  class StatefulCodecBase {
    prefix = 'stateful'

    format(value: string) {
      return `${this.prefix}:${value}`
    }
  }

  class StatefulCodec extends StatefulCodecBase implements CodecType<string> {
    encode(value: string) {
      return Codec.string.encode(this.format(value))
    }

    decode(value: unknown) {
      return Codec.string.decode(this.format(String(value)))
    }
  }

  const statefulCodec = new StatefulCodec()
  const decoratedJob = queue.job('decorated', { version: 1, payload: decorated })
  const classJob = queue.job('class', { version: 1, payload: statefulCodec })

  decorated.state.prefix = 'mutated'
  decorated.encode = () => Codec.string.encode('mutated')
  statefulCodec.prefix = 'mutated'
  StatefulCodecBase.prototype.format = () => 'mutated'
  StatefulCodec.prototype.encode = () => Codec.string.encode('mutated')

  expect(decoratedJob.payload).not.toBe(decorated)
  expect(Object.isFrozen(decoratedJob.payload)).toBe(true)
  expect(Object.keys(decoratedJob.payload)).toEqual(['encode', 'decode'])
  expect(classJob.payload).not.toBe(statefulCodec)
  expect(Object.isFrozen(classJob.payload)).toBe(true)
  expect(Object.keys(classJob.payload)).toEqual(['encode', 'decode'])

  expect(unwrap(await Promise.resolve(decoratedJob.payload.encode('value')))).toBe(
    'decorated:value'
  )
  expect(unwrap(await Promise.resolve(decoratedJob.payload.decode('value')))).toBe(
    'decorated:value'
  )
  expect(unwrap(await Promise.resolve(classJob.payload.encode('value')))).toBe('stateful:value')
  expect(unwrap(await Promise.resolve(classJob.payload.decode('value')))).toBe('stateful:value')
})

test('job definitions reject super methods before any codec invocation', () => {
  const queue = Queue.define('super-codecs')
  let invocations = 0

  class BaseCodec {
    format(value: string) {
      return `base:${value}`
    }
  }

  class SuperCodec extends BaseCodec {
    encode(value: string) {
      invocations += 1
      return Codec.string.encode(super.format(value))
    }

    decode(value: unknown) {
      invocations += 1
      return Codec.string.decode(super.format(String(value)))
    }
  }

  const codec = new SuperCodec()
  BaseCodec.prototype.format = () => 'mutated'

  expectDefinitionError(() => queue.job('super', { version: 1, payload: codec }))
  expect(invocations).toBe(0)
})

test('job definitions reject private-field codecs at definition time', () => {
  const queue = Queue.define('private-codecs')

  class PrivateCodec {
    #brand = true

    encode(value: string) {
      void this.#brand
      return Codec.string.encode(value)
    }

    decode(value: unknown) {
      return Codec.string.decode(String(value))
    }
  }

  let error: unknown

  try {
    queue.job('private', { version: 1, payload: new PrivateCodec() })
  } catch (cause) {
    error = cause
  }

  expect(JobDefinitionError.is(error)).toBe(true)
  expect(JSON.stringify(error)).not.toContain('private')
})

test('job definitions reject closure-dependent codec methods', () => {
  const queue = Queue.define('closure-codecs')
  let prefix = 'outside'

  class ClosureCodec {
    encode(value: string) {
      return Codec.string.encode(`${prefix}:${value}`)
    }

    decode(value: unknown) {
      return Codec.string.decode(`${prefix}:${String(value)}`)
    }
  }

  expectDefinitionError(() => queue.job('closure', { version: 1, payload: new ClosureCodec() }))
  prefix = 'mutated'
})

test('job definitions reject unsupported and malicious codec receiver state without reading it', () => {
  const queue = Queue.define('unsafe-codecs')
  let getterReads = 0
  const accessorCodec = {
    encode: Codec.string.encode,
    decode: Codec.string.decode
  }
  Object.defineProperty(accessorCodec, 'secret', {
    enumerable: true,
    get: () => {
      getterReads += 1
      throw new Error('payload-secret')
    }
  })

  let accessorError: unknown

  try {
    queue.job('accessor', { version: 1, payload: accessorCodec })
  } catch (cause) {
    accessorError = cause
  }

  expect(JobDefinitionError.is(accessorError)).toBe(true)
  expect(getterReads).toBe(0)
  expect(JSON.stringify(accessorError)).not.toContain('payload-secret')

  const unsupportedCodec = {
    state: new Map([['secret', 'value']]),
    encode: Codec.string.encode,
    decode: Codec.string.decode
  }

  expectDefinitionError(() => queue.job('unsupported', { version: 1, payload: unsupportedCodec }))

  const cyclicState: { self?: unknown } = {}
  cyclicState.self = cyclicState
  const cyclicCodec = {
    state: cyclicState,
    encode: Codec.string.encode,
    decode: Codec.string.decode
  }

  expectDefinitionError(() => queue.job('cyclic', { version: 1, payload: cyclicCodec }))

  const symbolCodec = {
    [Symbol('receiver-state')]: 'secret',
    encode: Codec.string.encode,
    decode: Codec.string.decode
  }

  expectDefinitionError(() => queue.job('symbol', { version: 1, payload: symbolCodec }))

  const transparentProxy = new Proxy(
    {
      encode: Codec.string.encode,
      decode: Codec.string.decode
    },
    {}
  )

  expectDefinitionError(() =>
    queue.job('transparent-proxy', { version: 1, payload: transparentProxy })
  )

  const throwingProxy = new Proxy(
    {
      encode: Codec.string.encode,
      decode: Codec.string.decode
    },
    {
      ownKeys: () => {
        throw new Error('receiver-secret')
      }
    }
  )

  let proxyError: unknown

  try {
    queue.job('proxy', { version: 1, payload: throwingProxy })
  } catch (cause) {
    proxyError = cause
  }

  expect(JobDefinitionError.is(proxyError)).toBe(true)
  expect(JSON.stringify(proxyError)).not.toContain('receiver-secret')
})

test('definitions validate names, versions, and persisted default policies', () => {
  const queue = Queue.define('emails')
  const payload = Codec.json<{ readonly value: string }>()

  expectDefinitionError(() => Queue.define('' as string))
  expectDefinitionError(() => queue.job('' as string, { version: 1, payload }))
  expectDefinitionError(() => queue.job('invalid', { version: 0 as number, payload }))
  expectDefinitionError(() => queue.job('invalid', { version: -1 as number, payload }))
  expectDefinitionError(() => queue.job('invalid', { version: 1.5 as number, payload }))
  expectDefinitionError(() =>
    queue.job('invalid', { version: 1, payload, defaults: { attempts: 0 } })
  )
  expectDefinitionError(() =>
    queue.job('invalid', { version: 1, payload, defaults: { timeoutMs: 0 } })
  )
  expectDefinitionError(() =>
    queue.job('invalid', { version: 1, payload, defaults: { timeoutMs: Number.POSITIVE_INFINITY } })
  )
  expectDefinitionError(() =>
    queue.job('invalid', { version: 1, payload, defaults: { priority: 1.2 } })
  )
  expectDefinitionError(() =>
    queue.job('invalid', {
      version: 1,
      payload,
      defaults: { retain: 7 } as unknown as { readonly attempts: number }
    })
  )
})

test('identity is the literal queue/name/version tuple, never a function name', () => {
  const queue = Queue.define('billing')
  const namedHandler = function ThisFunctionNameMustNotBecomeIdentity(): string {
    return 'unused'
  }
  const definition = queue.job('invoice', {
    version: 3,
    payload: Codec.string,
    metadata: () => ({ handler: namedHandler.name })
  })

  expect(definition.identity).toEqual({ queue: 'billing', name: 'invoice', version: 3 })
  expect(definition.identity).not.toHaveProperty('handler')
})

test('callbacks are evaluated later through safe canonical result helpers', () => {
  const queue = Queue.define('callbacks')
  const definition = queue.job('payload', {
    version: 1,
    payload: Codec.json<{ readonly id: string }>(),
    idempotencyKey: ({ id }) => id,
    metadata: ({ id }) => ({ id })
  })
  const retryable = queue.job('retryable', {
    version: 1,
    payload: Codec.string,
    failure: Codec.json<{ readonly code: string }>(),
    retryable: ({ code }) => code !== 'permanent'
  })

  const key = runIdempotencyKey(definition, { id: 'message-1' })
  const metadata = runMetadata(definition, { id: 'message-1' })
  const retryDecision = runRetryable(retryable, { code: 'temporary' })

  expect(unwrap(key)).toBe('message-1')
  expect(unwrap(metadata)).toEqual({ id: 'message-1' })
  expect(Object.isFrozen(unwrap(metadata))).toBe(true)
  expect(unwrap(retryDecision)).toBe(true)

  const badKey = queue.job('bad-key', {
    version: 1,
    payload: Codec.string,
    idempotencyKey: (() => '') as unknown as (value: string) => string
  })
  const badMetadata = queue.job('bad-metadata', {
    version: 1,
    payload: Codec.string,
    metadata: (() => ({ tenantId: undefined })) as unknown as (
      value: string
    ) => Readonly<Record<string, string>>
  })
  const throwing = queue.job('throwing', {
    version: 1,
    payload: Codec.string,
    idempotencyKey: (() => {
      throw new Error('secret payload')
    }) as unknown as (value: string) => string
  })
  const throwingRetryable = queue.job('throwing-retryable', {
    version: 1,
    payload: Codec.string,
    failure: Codec.json<{ readonly code: string }>(),
    retryable: () => {
      throw new Error('secret failure')
    }
  })
  const rejectedRetryable = queue.job('rejected-retryable', {
    version: 1,
    payload: Codec.string,
    failure: Codec.json<{ readonly code: string }>(),
    retryable: (() => Promise.reject(new Error('secret rejection'))) as unknown as (failure: {
      readonly code: string
    }) => boolean
  })

  const invalidKey = runIdempotencyKey(badKey, 'payload')
  const invalidMetadata = runMetadata(badMetadata, 'payload')
  const thrown = runIdempotencyKey(throwing, 'payload')
  const thrownRetry = runRetryable(throwingRetryable, { code: 'temporary' })
  const rejectedRetry = runRetryable(rejectedRetryable, { code: 'temporary' })

  expect(Result.isError(invalidKey)).toBe(true)
  expect(Result.isError(invalidMetadata)).toBe(true)
  expect(Result.isError(thrown)).toBe(true)
  if (Result.isError(thrown)) {
    expect(thrown.error.message).not.toContain('secret payload')
    expect(JobDefinitionError.is(thrown.error)).toBe(true)
  }
  expect(unwrap(thrownRetry)).toBe(true)
  expect(unwrap(rejectedRetry)).toBe(true)
  expect(JSON.stringify(thrownRetry)).not.toContain('secret failure')
  expect(JSON.stringify(rejectedRetry)).not.toContain('secret rejection')
})

test('registry preserves versions, rejects duplicate identities, and has explicit misses', () => {
  const queue = Queue.define('orders')
  const payload = Codec.json<{ readonly orderId: string }>()
  const version1 = queue.job('submit', { version: 1, payload })
  const version2 = queue.job('submit', { version: 2, payload })
  const other = queue.job('cancel', { version: 1, payload })
  const source = [version1, version2, other] as const
  const registry = JobRegistry.make(source)

  expect(registry.definitions).toEqual([version1, version2, other])
  expect(registry.definitions).not.toBe(source)
  expect(registry.accepted).toEqual([
    { queue: 'orders', name: 'submit', version: 1 },
    { queue: 'orders', name: 'submit', version: 2 },
    { queue: 'orders', name: 'cancel', version: 1 }
  ])
  expect(registry.acceptedClaimIdentities).toBe(registry.accepted)
  expect(Object.isFrozen(registry)).toBe(true)
  expect(Object.isFrozen(registry.definitions)).toBe(true)
  expect(Object.isFrozen(registry.accepted)).toBe(true)
  expect(registry.accepted).not.toBe(source)
  expect(registry.acceptedClaimIdentities).toBe(registry.accepted)
  expect(registry.claimIdentities).toBe(registry.accepted)

  for (const identity of registry.accepted) {
    expect(Object.isFrozen(identity)).toBe(true)
  }

  const acceptedV1 = registry.accepted[0]
  expect(acceptedV1).toBeDefined()
  if (acceptedV1 !== undefined) {
    expect(acceptedV1).not.toBe(version1.identity)
    expect(() => Object.assign(acceptedV1, { queue: 'tampered' })).toThrow()
    expect(acceptedV1).toEqual({ queue: 'orders', name: 'submit', version: 1 })
  }

  const foundV1 = registry.lookup(version1.identity)
  const foundV2 = registry.get('orders', 'submit', 2)
  const missing = registry.lookup({ queue: 'orders', name: 'submit', version: 9 })

  expect(unwrap(foundV1)).toBe(version1)
  expect(unwrap(foundV2)).toBe(version2)
  expect(unwrap(registry.lookup({ queue: 'orders', name: 'submit', version: 1 }))).toBe(version1)
  expect(Result.isError(missing)).toBe(true)
  expect(registry.has(version1.identity)).toBe(true)
  expect(registry.has('orders', 'submit', 9)).toBe(false)

  expectDefinitionError(() => JobRegistry.make([version1, version1]))
  expectDefinitionError(() =>
    JobRegistry.make([version1, version2, other, queue.job('submit', { version: 1, payload })])
  )
})

test('Queue and Job guards accept real duplicate package copies and reject hostile values safely', async () => {
  const queue = Queue.define('guarded')
  const definition = queue.job('safe', { version: 1, payload: Codec.string })
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'better-effect-mq-module-copy-'))

  try {
    await cp(join(packageRoot, 'src'), join(temporaryRoot, 'src'), { recursive: true })
    await symlink(join(packageRoot, 'node_modules'), join(temporaryRoot, 'node_modules'))
    const duplicate = await import(pathToFileURL(join(temporaryRoot, 'src/index.ts')).href)
    const duplicateQueue = duplicate.Queue.define('guarded')
    const duplicateDefinition = duplicateQueue.job('safe', {
      version: 1,
      payload: duplicate.Codec.string
    })
    const registry = JobRegistry.make([definition])
    const duplicateRegistry = duplicate.JobRegistry.make([duplicateDefinition])

    expect(duplicate.Queue).not.toBe(Queue)
    expect(duplicate.Job).not.toBe(Job)
    expect(duplicate.JobRegistry).not.toBe(JobRegistry)
    expect(duplicateQueue).not.toBe(queue)
    expect(duplicateDefinition).not.toBe(definition)
    expect(duplicateRegistry).not.toBe(registry)
    expect(Queue.is(duplicateQueue)).toBe(true)
    expect(Job.is(duplicateDefinition)).toBe(true)
    expect(duplicate.Queue.is(queue)).toBe(true)
    expect(duplicate.Job.is(definition)).toBe(true)
    expect(Job.TypeId).toBe(duplicate.Job.TypeId)
    expect(Queue.TypeId).toBe(duplicate.Queue.TypeId)
    expect(unwrap(registry.lookup(duplicateDefinition.identity))).toBe(definition)
    expect(unwrap(duplicateRegistry.lookup(definition.identity))).toBe(duplicateDefinition)

    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const throwing = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('trap')
        }
      }
    )

    for (const value of [null, undefined, 1, 'job', revoked.proxy, throwing]) {
      expect(() => Job.is(value)).not.toThrow()
      expect(() => Queue.is(value)).not.toThrow()
      expect(Job.is(value)).toBe(false)
      expect(Queue.is(value)).toBe(false)
    }

    expectDefinitionError(() => JobRegistry.make([revoked.proxy] as unknown as readonly Job.Any[]))
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
