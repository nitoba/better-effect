import { describe, expect, test } from 'bun:test'

import { Layer, ServiceTagCollisionError } from '../src'
import { createRuntimeHandle } from '../src/layer/runtime'
import { MemoryLayerBackend } from '../src/testing'
import { Service, ServiceRuntime } from '../src/service'

class PrimaryDatabase extends Service<PrimaryDatabase>()('PrimaryDatabase') {
  query(): string {
    return 'primary'
  }
}

class ReplicaDatabase extends Service<ReplicaDatabase>()('ReplicaDatabase') {
  query(): string {
    return 'replica'
  }
}

class CompatibleDatabaseA extends Service<CompatibleDatabaseA>()('CompatibleDatabase') {
  query(): string {
    return 'a'
  }
}

class CompatibleDatabaseB extends Service<CompatibleDatabaseB>()('CompatibleDatabase') {
  query(): string {
    return 'b'
  }
}

class CollisionDatabaseA extends Service<CollisionDatabaseA>()('CollisionDatabase') {
  query(): string {
    return 'a'
  }
}

class CollisionDatabaseB extends Service<CollisionDatabaseB>()('CollisionDatabase') {
  migrate(): void {}
}

describe('tagged Service identity', () => {
  test('keeps structurally identical different-tag Services isolated', async () => {
    const runtime = await createRuntimeHandle(
      Layer.merge(
        Layer.succeed(PrimaryDatabase, new PrimaryDatabase()),
        Layer.succeed(ReplicaDatabase, new ReplicaDatabase())
      ),
      new MemoryLayerBackend()
    )

    try {
      const resolved = await runtime.run(async () => ({
        primary: await ServiceRuntime.resolve(PrimaryDatabase),
        replica: await ServiceRuntime.resolve(ReplicaDatabase)
      }))

      expect(resolved.primary.query()).toBe('primary')
      expect(resolved.replica.query()).toBe('replica')
      expect(resolved.primary).not.toBe(resolved.replica)
    } finally {
      await runtime.dispose()
    }
  })

  test('rejects duplicate tags during Layer.merge', () => {
    expect(() =>
      Layer.merge(
        Layer.make(CollisionDatabaseA, () => new CollisionDatabaseA()),
        Layer.make(CollisionDatabaseB, () => new CollisionDatabaseB())
      )
    ).toThrow(ServiceTagCollisionError)
  })

  test('allows compatible same-tag overrides and resolves by tag', async () => {
    const runtime = await createRuntimeHandle(
      Layer.override(
        Layer.make(CompatibleDatabaseA, () => new CompatibleDatabaseA()),
        Layer.make(CompatibleDatabaseB, () => new CompatibleDatabaseB())
      ),
      new MemoryLayerBackend()
    )

    try {
      const resolved = await runtime.run(() => ServiceRuntime.resolve(CompatibleDatabaseA))

      expect(resolved).toBeInstanceOf(CompatibleDatabaseB)
      expect(resolved.query()).toBe('b')
    } finally {
      await runtime.dispose()
    }
  })

  test('rejects a direct backend registration collision', () => {
    const backend = new MemoryLayerBackend()

    backend.register({
      service: CollisionDatabaseA,
      acquire: () => new CollisionDatabaseA()
    })

    expect(() =>
      backend.register({
        service: CollisionDatabaseB,
        acquire: () => new CollisionDatabaseB()
      })
    ).toThrow(ServiceTagCollisionError)
  })

  test('rejects an incompatible same-tag lookup instead of returning the wrong instance', async () => {
    const backend = new MemoryLayerBackend()

    backend.register({
      service: CollisionDatabaseB,
      acquire: () => new CollisionDatabaseB()
    })

    const cause = await backend.resolve(CollisionDatabaseA).then(
      () => undefined,
      (error) => error
    )

    expect(cause).toBeInstanceOf(ServiceTagCollisionError)
  })

  test('reports missing tags by logical identity', async () => {
    const backend = new MemoryLayerBackend()

    const cause = await backend.resolve(ReplicaDatabase).then(
      () => undefined,
      (error) => error
    )

    expect(cause).toBeInstanceOf(Error)

    if (cause instanceof Error) {
      expect(cause.message).toContain('ReplicaDatabase')
    }
  })
})
