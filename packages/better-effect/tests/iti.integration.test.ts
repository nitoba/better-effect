import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../src/effect'
import { ItiLayerBackend } from '../src/adapters/iti'
import { Layer, ServiceTagCollisionError } from '../src/layer'
import { createRuntimeHandle } from '../src/layer/runtime'
import { Service, ServiceRuntime } from '../src/service'

class Database extends Service<Database>()('Database') {
  readonly id = crypto.randomUUID()
}

class UserRepository extends Service<UserRepository>()('UserRepository') {
  readonly id = crypto.randomUUID()
}

class TaggedDatabaseA extends Service<TaggedDatabaseA>()('ItiTaggedDatabase') {
  value(): string {
    return 'a'
  }
}

class TaggedDatabaseB extends Service<TaggedDatabaseB>()('ItiTaggedDatabase') {
  value(): string {
    return 'b'
  }
}

class IncompatibleTaggedA extends Service<IncompatibleTaggedA>()('ItiCollision') {
  query(): string {
    return 'a'
  }
}

class IncompatibleTaggedB extends Service<IncompatibleTaggedB>()('ItiCollision') {
  migrate(): void {}
}

describe('ItiLayerBackend', () => {
  test('resolves a service using the class token', async () => {
    const runtime = await createRuntimeHandle(
      Layer.make(Database, () => new Database()),
      new ItiLayerBackend()
    )

    try {
      const database = await runtime.run(() => ServiceRuntime.resolve(Database))

      expect(database).toBeInstanceOf(Database)
    } finally {
      await runtime.dispose()
    }
  })

  test('resolves providers lazily', async () => {
    let acquired = 0

    const runtime = await createRuntimeHandle(
      Layer.make(Database, () => {
        acquired++

        return new Database()
      }),
      new ItiLayerBackend()
    )

    try {
      expect(acquired).toBe(0)

      await runtime.run(() => ServiceRuntime.resolve(Database))

      expect(acquired).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('caches resolved instances', async () => {
    let acquired = 0

    const runtime = await createRuntimeHandle(
      Layer.make(Database, () => {
        acquired++

        return new Database()
      }),
      new ItiLayerBackend()
    )

    try {
      const result = await runtime.run(() =>
        Effect.gen(async function* () {
          const first = yield* Database

          const second = yield* Database

          return Result.ok({
            first,
            second
          })
        })
      )

      expect(Result.isOk(result)).toBe(true)

      if (Result.isOk(result)) {
        expect(result.value.first).toBe(result.value.second)
      }

      expect(acquired).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps different class tokens independent', async () => {
    const runtime = await createRuntimeHandle(
      Layer.merge(
        Layer.make(Database, () => new Database()),

        Layer.make(UserRepository, () => new UserRepository())
      ),
      new ItiLayerBackend()
    )

    try {
      const { database, repository } = await runtime.run(async () => ({
        database: await ServiceRuntime.resolve(Database),

        repository: await ServiceRuntime.resolve(UserRepository)
      }))

      expect(database).toBeInstanceOf(Database)

      expect(repository).toBeInstanceOf(UserRepository)

      expect(database).not.toBe(repository)
    } finally {
      await runtime.dispose()
    }
  })

  test('releases scoped services on dispose', async () => {
    let releases = 0

    const runtime = await createRuntimeHandle(
      Layer.scoped(
        Database,

        () => new Database(),

        () => {
          releases++
        }
      ),
      new ItiLayerBackend()
    )

    await runtime.run(() => ServiceRuntime.resolve(Database))

    expect(releases).toBe(0)

    await runtime.dispose()

    expect(releases).toBe(1)
  })

  test('does not release a scoped service that was never resolved', async () => {
    let releases = 0

    const runtime = await createRuntimeHandle(
      Layer.scoped(
        Database,

        () => new Database(),

        () => {
          releases++
        }
      ),
      new ItiLayerBackend()
    )

    await runtime.dispose()

    expect(releases).toBe(0)
  })

  test('accepts registrations without lifecycle callbacks', async () => {
    const backend = new ItiLayerBackend()

    backend.register({
      service: Database,
      acquire: () => new Database()
    })

    await backend.resolve(Database)
    await backend.disposeAll()
  })

  test('does not expose services outside the runtime context', async () => {
    const runtime = await createRuntimeHandle(
      Layer.make(Database, () => new Database()),
      new ItiLayerBackend()
    )

    try {
      expect(ServiceRuntime.resolve(Database)).rejects.toThrow(
        'No ServiceResolver is available in the current runtime context'
      )
    } finally {
      await runtime.dispose()
    }
  })

  test('isolates services between concurrent runtimes', async () => {
    const databaseA = new Database()

    const databaseB = new Database()

    const runtimeA = await createRuntimeHandle(
      Layer.succeed(Database, databaseA),
      new ItiLayerBackend()
    )

    const runtimeB = await createRuntimeHandle(
      Layer.succeed(Database, databaseB),
      new ItiLayerBackend()
    )

    try {
      const [resolvedA, resolvedB] = await Promise.all([
        runtimeA.run(async () => {
          await Promise.resolve()

          return ServiceRuntime.resolve(Database)
        }),

        runtimeB.run(async () => {
          await Promise.resolve()

          return ServiceRuntime.resolve(Database)
        })
      ])

      expect(resolvedA).toBe(databaseA)

      expect(resolvedB).toBe(databaseB)
    } finally {
      await Promise.all([runtimeA.dispose(), runtimeB.dispose()])
    }
  })

  test('uses the tag key for compatible overrides', async () => {
    const runtime = await createRuntimeHandle(
      Layer.override(
        Layer.make(TaggedDatabaseA, () => new TaggedDatabaseA()),
        Layer.make(TaggedDatabaseB, () => new TaggedDatabaseB())
      ),
      new ItiLayerBackend()
    )

    try {
      const resolved = await runtime.run(() => ServiceRuntime.resolve(TaggedDatabaseA))

      expect(resolved).toBeInstanceOf(TaggedDatabaseB)
      expect(resolved.value()).toBe('b')
    } finally {
      await runtime.dispose()
    }
  })

  test('rejects duplicate tag registrations', () => {
    const backend = new ItiLayerBackend()

    backend.register({
      service: TaggedDatabaseA,
      acquire: () => new TaggedDatabaseA()
    })

    expect(() =>
      backend.register({
        service: TaggedDatabaseB,
        acquire: () => new TaggedDatabaseB()
      })
    ).toThrow(ServiceTagCollisionError)
  })

  test('rejects an incompatible same-tag lookup', async () => {
    const backend = new ItiLayerBackend()

    backend.register({
      service: IncompatibleTaggedB,
      acquire: () => new IncompatibleTaggedB()
    })

    const cause = await Promise.resolve()
      .then(() => backend.resolve(IncompatibleTaggedA))
      .then(
        () => undefined,
        (error) => error
      )

    expect(cause).toBeInstanceOf(ServiceTagCollisionError)
  })
})
