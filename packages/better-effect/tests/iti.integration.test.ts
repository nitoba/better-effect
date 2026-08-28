import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../src/effect'
import { ItiLayerBackend } from '../src/adapters/iti'
import { DuplicateServiceError, Layer, ServiceTagCollisionError } from '../src/layer'
import { createRuntimeHandle } from '../src/layer/runtime'
import { Service, ServiceAcquisitionError, ServiceRuntime } from '../src/service'

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

  test('rejects exact duplicate registrations', () => {
    const backend = new ItiLayerBackend()
    const registration = {
      service: Database,
      acquire: () => new Database()
    }

    backend.register(registration)

    expect(() => backend.register(registration)).toThrow(DuplicateServiceError)
  })

  test('resets registrations and singleton caches for reuse', async () => {
    const backend = new ItiLayerBackend()
    const first = new Database()

    backend.register({
      service: Database,
      acquire: () => first
    })

    expect(await backend.resolve(Database)).toBe(first)

    await backend.disposeAll()

    const second = new Database()

    backend.register({
      service: Database,
      acquire: () => second
    })

    expect(await backend.resolve(Database)).toBe(second)

    await backend.disposeAll()
  })

  test('waits for pending acquisitions before resetting the container', async () => {
    const backend = new ItiLayerBackend()
    let resolveAcquisition!: (database: Database) => void
    let acquisitionStarted = false
    const acquisition = new Promise<Database>((resolve) => {
      resolveAcquisition = resolve
    })

    backend.register({
      service: Database,
      acquire: () => {
        acquisitionStarted = true
        return acquisition
      }
    })

    const resolving = backend.resolve(Database)

    expect(acquisitionStarted).toBe(true)

    let disposalFinished = false
    const disposing = backend.disposeAll().then(() => {
      disposalFinished = true
    })

    await Promise.resolve()
    expect(disposalFinished).toBe(false)

    const first = new Database()
    resolveAcquisition(first)

    expect(await resolving).toBe(first)
    await disposing

    const second = new Database()

    backend.register({
      service: Database,
      acquire: () => second
    })

    expect(await backend.resolve(Database)).toBe(second)
    await backend.disposeAll()
  })

  test('resets sticky failed acquisitions after disposal', async () => {
    const backend = new ItiLayerBackend()
    const failure = new Error('acquisition failed')
    let attempts = 0

    backend.register({
      service: Database,
      acquire: async () => {
        attempts++
        throw failure
      }
    })

    const resolveFailure = () => Promise.resolve().then(() => backend.resolve(Database))

    const firstCause = await resolveFailure().then(
      () => undefined,
      (error) => error
    )
    const secondCause = await resolveFailure().then(
      () => undefined,
      (error) => error
    )

    expect(firstCause).toBe(failure)
    expect(secondCause).toBe(failure)
    expect(attempts).toBe(1)

    await backend.disposeAll()

    const recovered = new Database()

    backend.register({
      service: Database,
      acquire: () => {
        attempts++
        return recovered
      }
    })

    expect(await backend.resolve(Database)).toBe(recovered)
    expect(attempts).toBe(2)
    await backend.disposeAll()
  })

  test('does not release a scoped service when acquisition fails', async () => {
    const acquisitionFailure = new Error('acquisition failed')
    let releases = 0
    const runtime = await createRuntimeHandle(
      Layer.scoped(
        Database,
        async () => {
          throw acquisitionFailure
        },
        () => {
          releases++
        }
      ),
      new ItiLayerBackend()
    )

    try {
      const cause = await runtime
        .run(() => ServiceRuntime.resolve(Database))
        .then(
          () => undefined,
          (error) => error
        )

      expect(cause).toBeInstanceOf(ServiceAcquisitionError)

      if (cause instanceof ServiceAcquisitionError) {
        expect(cause.cause).toBe(acquisitionFailure)
      }

      expect(releases).toBe(0)
    } finally {
      await runtime.dispose()
    }
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
