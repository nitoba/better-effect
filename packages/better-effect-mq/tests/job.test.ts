// oxlint-disable anti-slop/no-chained-type-assertions -- hostile-value tests intentionally cross untyped boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test casts describe invalid boundary values.
// oxlint-disable anti-slop/no-known-value-widening -- test casts deliberately model malformed JavaScript.

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

  const invalidKey = runIdempotencyKey(badKey, 'payload')
  const invalidMetadata = runMetadata(badMetadata, 'payload')
  const thrown = runIdempotencyKey(throwing, 'payload')

  expect(Result.isError(invalidKey)).toBe(true)
  expect(Result.isError(invalidMetadata)).toBe(true)
  expect(Result.isError(thrown)).toBe(true)
  if (Result.isError(thrown)) {
    expect(thrown.error.message).not.toContain('secret payload')
    expect(JobDefinitionError.is(thrown.error)).toBe(true)
  }
})

test('registry preserves versions, rejects duplicate identities, and has explicit misses', () => {
  const queue = Queue.define('orders')
  const payload = Codec.json<{ readonly orderId: string }>()
  const version1 = queue.job('submit', { version: 1, payload })
  const version2 = queue.job('submit', { version: 2, payload })
  const other = queue.job('cancel', { version: 1, payload })
  const registry = JobRegistry.make([version1, version2, other] as const)

  expect(registry.definitions).toEqual([version1, version2, other])
  expect(registry.accepted).toEqual([
    { queue: 'orders', name: 'submit', version: 1 },
    { queue: 'orders', name: 'submit', version: 2 },
    { queue: 'orders', name: 'cancel', version: 1 }
  ])
  expect(registry.acceptedClaimIdentities).toBe(registry.accepted)
  expect(Object.isFrozen(registry)).toBe(true)
  expect(Object.isFrozen(registry.definitions)).toBe(true)
  expect(Object.isFrozen(registry.accepted)).toBe(true)

  const foundV1 = registry.lookup(version1.identity)
  const foundV2 = registry.get('orders', 'submit', 2)
  const missing = registry.lookup({ queue: 'orders', name: 'submit', version: 9 })

  expect(unwrap(foundV1)).toBe(version1)
  expect(unwrap(foundV2)).toBe(version2)
  expect(Result.isError(missing)).toBe(true)
  expect(registry.has(version1.identity)).toBe(true)
  expect(registry.has('orders', 'submit', 9)).toBe(false)

  expectDefinitionError(() => JobRegistry.make([version1, version1]))
  expectDefinitionError(() =>
    JobRegistry.make([version1, version2, other, queue.job('submit', { version: 1, payload })])
  )
})

test('Queue and Job guards accept duplicate package copies and reject hostile values safely', async () => {
  const queue = Queue.define('guarded')
  const definition = queue.job('safe', { version: 1, payload: Codec.string })
  const duplicateSpecifier = new URL('../src/index.ts?duplicate-job-module', import.meta.url).href
  const duplicate = await import(duplicateSpecifier)
  const duplicateQueue = duplicate.Queue.define('duplicate')
  const duplicateDefinition = duplicateQueue.job('safe', {
    version: 1,
    payload: duplicate.Codec.string
  })

  expect(Queue.is(duplicateQueue)).toBe(true)
  expect(Job.is(duplicateDefinition)).toBe(true)
  expect(duplicate.Queue.is(queue)).toBe(true)
  expect(duplicate.Job.is(definition)).toBe(true)
  expect(Job.TypeId).toBe(duplicate.Job.TypeId)
  expect(Queue.TypeId).toBe(duplicate.Queue.TypeId)

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
})
