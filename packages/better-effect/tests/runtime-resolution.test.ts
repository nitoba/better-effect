import { describe, expect, test } from 'bun:test'

import {
  CircularDependencyError,
  Layer,
  MapLayerBackend,
  Runtime,
  Service,
  ServiceAcquisitionError,
  ServiceRuntime
} from '../src'
import { MemoryLayerBackend } from '../src/testing'

class UserRepository extends Service<UserRepository>()('UserRepository') {}

class Database extends Service<Database>()('Database') {}

class Config extends Service<Config>()('Config') {}

class AcquisitionConsumer extends Service<AcquisitionConsumer>()('AcquisitionConsumer') {}

describe('Runtime Service resolution', () => {
  test('detects circular dependencies with the complete Service path', async () => {
    const runtime = await Runtime.make(
      Layer.merge(
        Layer.make(UserRepository, async () => {
          await ServiceRuntime.resolve(Database)

          return new UserRepository()
        }),
        Layer.make(Database, async () => {
          await ServiceRuntime.resolve(Config)

          return new Database()
        }),
        Layer.make(Config, async () => {
          await ServiceRuntime.resolve(UserRepository)

          return new Config()
        })
      )
    )

    try {
      const cause = await runtime
        .run(() => ServiceRuntime.resolve(UserRepository))
        .then(
          () => undefined,
          (error) => error
        )

      expect(cause).toBeInstanceOf(CircularDependencyError)

      if (cause instanceof CircularDependencyError) {
        expect(cause.path.map((service) => service.serviceTag)).toEqual([
          'UserRepository',
          'Database',
          'Config',
          'UserRepository'
        ])
        expect(cause.message).toBe(
          'Circular Service dependency detected:\n' +
            'UserRepository → Database → Config → UserRepository'
        )
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('wraps provider acquisition failures with the Service path', async () => {
    const acquisitionCause = new Error('database unavailable')
    const runtime = await Runtime.make(
      Layer.merge(
        Layer.make(AcquisitionConsumer, async () => {
          await ServiceRuntime.resolve(Database)

          return new AcquisitionConsumer()
        }),
        Layer.make(Database, () => {
          throw acquisitionCause
        })
      )
    )

    try {
      const cause = await runtime
        .run(() => ServiceRuntime.resolve(AcquisitionConsumer))
        .then(
          () => undefined,
          (error) => error
        )

      expect(cause).toBeInstanceOf(ServiceAcquisitionError)

      if (cause instanceof ServiceAcquisitionError) {
        expect(cause.service).toBe(Database)
        expect(cause.resolutionPath).toEqual([AcquisitionConsumer, Database])
        expect(cause.cause).toBe(acquisitionCause)
        expect(cause.message).toContain('AcquisitionConsumer → Database')
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('uses MapLayerBackend by default and keeps the testing alias', async () => {
    expect(MemoryLayerBackend).toBe(MapLayerBackend)

    const resolved = await Runtime.run(Layer.make(Database), () => ServiceRuntime.resolve(Database))

    expect(resolved).toBeInstanceOf(Database)
  })

  test('Layer.complete keeps the original Layer at runtime', () => {
    const layer = Layer.make(Database)

    expect(Layer.complete(layer)).toBe(layer)
  })

  test('accepts a backend through Runtime options', async () => {
    const backend = new MapLayerBackend()

    const resolved = await Runtime.run(Layer.make(Database), { backend }, () =>
      ServiceRuntime.resolve(Database)
    )

    expect(resolved).toBeInstanceOf(Database)
  })

  test('Runtime.use disposes the Runtime after the callback settles', async () => {
    let released = 0

    const result = await Runtime.use(
      Layer.scoped(
        Database,
        () => new Database(),
        () => {
          released++
        }
      ),
      async (runtime) => runtime.run(() => ServiceRuntime.resolve(Database))
    )

    expect(result).toBeInstanceOf(Database)
    expect(released).toBe(1)
  })

  test('Runtime is async disposable', async () => {
    let released = 0

    {
      await using runtime = await Runtime.make(
        Layer.scoped(
          Database,
          () => new Database(),
          () => {
            released++
          }
        )
      )

      await runtime.run(() => ServiceRuntime.resolve(Database))
      expect(released).toBe(0)
    }

    expect(released).toBe(1)
  })
})
