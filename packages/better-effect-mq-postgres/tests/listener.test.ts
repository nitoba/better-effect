// oxlint-disable anti-slop/no-chained-type-assertions -- the fake generic driver result is controlled by this test.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- tests inject a wire-format wake token and branded queue values.

import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'bun:test'
import { JobStore, type JobStoreContract, type JobStoreDescriptor } from 'better-effect-mq'
import { Runtime, ServiceRuntime } from 'better-effect'
import { PostgresJobStore, type Pool, type PoolClient, type QueryResult } from '../src/index'

type WakeRow = { readonly queue: string; readonly wake_version: number }

class TestListenerClient extends EventEmitter implements PoolClient {
  readonly released: Error[] = []
  readonly wakeRows: WakeRow[] = []
  listenFails = false
  unlistenFails = false

  async query<Row = unknown>(text: string): Promise<QueryResult<Row>> {
    if (this.listenFails && text.startsWith('LISTEN')) throw new Error('listen failed')
    if (this.unlistenFails && text.startsWith('UNLISTEN')) throw new Error('unlisten failed')
    if (text.includes('SELECT queue,wake_version')) {
      return {
        rows: this.wakeRows as unknown as readonly Row[],
        rowCount: this.wakeRows.length
      }
    }
    return { rows: [], rowCount: 0 }
  }

  release(error?: Error): void {
    if (error !== undefined) this.released.push(error)
  }
}

const wakeToken = (queues: Record<string, number>): string =>
  `postgres-wake-v1-${encodeURIComponent(JSON.stringify({ version: 1, queues }))}`

const descriptorOf = (store: JobStoreContract): JobStoreDescriptor => store.descriptor

describe('PostgreSQL LISTEN fallback', () => {
  test('uses polling when pool capacity is not exposed', async () => {
    const listener = new TestListenerClient()
    let connections = 0
    const pool: Pool = {
      connect: async () => {
        connections += 1
        return listener
      }
    }
    const runtime = await Runtime.make(PostgresJobStore.layer({ pool, validateSchema: false }))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const descriptor = descriptorOf(store)
      expect(descriptor).toEqual({
        protocolVersion: 1,
        adapter: 'postgres',
        adapterVersion: '0.1.0',
        layoutVersion: 1,
        capabilities: {
          queueFilteredNotifications: false,
          nativeBatchEnqueue: true,
          nativeBatchClaim: true,
          metadataIndex: 'indexed',
          transactionalEnqueue: true,
          durableChangeFeed: false,
          globalConcurrency: false,
          rateLimiting: false
        }
      })
      expect(Object.isFrozen(descriptor)).toBe(true)
      expect(Object.isFrozen(descriptor.capabilities)).toBe(true)
      expect(connections).toBe(0)
      expect(descriptor.capabilities.queueFilteredNotifications).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  test('destroys a failed listener connection and falls back to polling', async () => {
    const listener = new TestListenerClient()
    const pool: Pool & { readonly options: { readonly max: number } } = {
      options: { max: 2 },
      connect: async () => listener
    }
    const runtime = await Runtime.make(PostgresJobStore.layer({ pool, validateSchema: false }))
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const before = descriptorOf(store)
      const failure = new Error('connection failed')
      listener.emit('error', failure)
      expect(listener.released).toEqual([failure])
      expect(descriptorOf(store)).toBe(before)
      expect(descriptorOf(store).capabilities.queueFilteredNotifications).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('releases a connection that cannot enter LISTEN mode with its setup error', async () => {
    const listener = new TestListenerClient()
    listener.listenFails = true
    const pool: Pool & { readonly options: { readonly max: number } } = {
      options: { max: 2 },
      connect: async () => listener
    }
    const runtime = await Runtime.make(PostgresJobStore.layer({ pool, validateSchema: false }))
    try {
      await runtime.run(() => ServiceRuntime.resolve(JobStore))
      expect(listener.released[0]?.message).toBe('listen failed')
    } finally {
      await runtime.dispose()
    }
  })

  test('propagates UNLISTEN failures through Runtime cleanup', async () => {
    const listener = new TestListenerClient()
    listener.unlistenFails = true
    const pool: Pool & { readonly options: { readonly max: number } } = {
      options: { max: 2 },
      connect: async () => listener
    }
    const runtime = await Runtime.make(PostgresJobStore.layer({ pool, validateSchema: false }))
    await runtime.run(() => ServiceRuntime.resolve(JobStore))
    const cleanup = runtime.dispose().then(
      () => undefined,
      (cause: unknown) => cause
    )
    const failure = await cleanup
    expect(failure).toMatchObject({ name: 'LayerDisposeError' })
    expect(listener.released[0]?.message).toBe('unlisten failed')
  })

  test('honors queue filters and wakes an unfiltered waiter from notifications', async () => {
    const listener = new TestListenerClient()
    const pool: Pool & { readonly options: { readonly max: number } } = {
      options: { max: 2 },
      connect: async () => listener
    }
    const runtime = await Runtime.make(PostgresJobStore.layer({ pool, validateSchema: false }))
    const target = 'target'
    const other = 'other'
    try {
      const store = await runtime.run(() => ServiceRuntime.resolve(JobStore))
      const controller = new AbortController()
      let filteredSettled = false
      const filtered = store.awaitWake({
        queues: [target as never],
        wakeToken: wakeToken({ [target]: 0, [other]: 0 }) as never,
        signal: controller.signal
      })
      void Promise.resolve(filtered).then(() => {
        filteredSettled = true
      })
      await Promise.resolve()
      listener.wakeRows.push({ queue: other, wake_version: 1 })
      listener.emit('notification', { payload: other })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(filteredSettled).toBe(false)

      listener.wakeRows.push({ queue: target, wake_version: 1 })
      listener.emit('notification', { payload: target })
      expect((await filtered).isOk()).toBe(true)

      const unfiltered = store.awaitWake({
        queues: [],
        wakeToken: wakeToken({ [target]: 1, [other]: 1 }) as never,
        signal: new AbortController().signal
      })
      listener.wakeRows[0] = { queue: other, wake_version: 2 }
      listener.emit('notification', { payload: other })
      expect((await unfiltered).isOk()).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
