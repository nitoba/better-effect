import { afterEach, describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Layer, buildLayer } from '../src/layer'

import { Service, ServiceRuntime } from '../src/service'
import { ItiLayerBackend } from '../src/adapters/iti'

class Database extends Service<Database>() {
  readonly id = crypto.randomUUID()
}

class UserRepository extends Service<UserRepository>() {
  readonly id = crypto.randomUUID()
}

afterEach(() => {
  ServiceRuntime.reset()
})

describe('ItiLayerBackend', () => {
  test.serial('resolves a service using the class token', async () => {
    const runtime = await buildLayer(
      Layer.make(Database, () => new Database()),
      new ItiLayerBackend()
    )

    try {
      const database = await ServiceRuntime.resolve(Database)

      expect(database).toBeInstanceOf(Database)
    } finally {
      await runtime.dispose()
    }
  })

  test.serial('resolves providers lazily', async () => {
    let acquired = 0

    const runtime = await buildLayer(
      Layer.make(Database, () => {
        acquired++

        return new Database()
      }),

      new ItiLayerBackend()
    )

    try {
      expect(acquired).toBe(0)

      await ServiceRuntime.resolve(Database)

      expect(acquired).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test.serial('caches resolved instances', async () => {
    let acquired = 0

    const runtime = await buildLayer(
      Layer.make(Database, () => {
        acquired++

        return new Database()
      }),

      new ItiLayerBackend()
    )

    try {
      const result = await Result.gen(async function* () {
        const first = yield* Database

        const second = yield* Database

        return Result.ok({
          first,
          second
        })
      })

      expect(Result.isOk(result)).toBe(true)

      if (Result.isOk(result)) {
        expect(result.value.first).toBe(result.value.second)
      }

      expect(acquired).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test.serial('keeps different class tokens independent', async () => {
    const runtime = await buildLayer(
      Layer.merge(
        Layer.make(Database, () => new Database()),

        Layer.make(UserRepository, () => new UserRepository())
      ),

      new ItiLayerBackend()
    )

    try {
      const database = await ServiceRuntime.resolve(Database)

      const repository = await ServiceRuntime.resolve(UserRepository)

      expect(database).toBeInstanceOf(Database)

      expect(repository).toBeInstanceOf(UserRepository)

      expect(database).not.toBe(repository)
    } finally {
      await runtime.dispose()
    }
  })

  test.serial('releases scoped services on dispose', async () => {
    let releases = 0

    const runtime = await buildLayer(
      Layer.scoped(
        Database,

        () => new Database(),

        () => {
          releases++
        }
      ),

      new ItiLayerBackend()
    )

    await ServiceRuntime.resolve(Database)

    expect(releases).toBe(0)

    await runtime.dispose()

    expect(releases).toBe(1)
  })

  test.serial('does not release a scoped service that was never resolved', async () => {
    let releases = 0

    const runtime = await buildLayer(
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
})
