import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import {
  CircularDependencyError,
  Effect,
  Layer,
  MapLayerBackend,
  Runtime,
  Service,
  ServiceAcquisitionError,
  ServiceNotFoundError,
  ServiceRuntime
} from '../src'
import { MemoryLayerBackend } from '../src/testing'

class UserRepository extends Service<UserRepository>()('UserRepository') {}

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'database'
  }
}

class Config extends Service<Config>()('Config') {}

class AcquisitionConsumer extends Service<AcquisitionConsumer>()('AcquisitionConsumer') {}

class RequestContext extends Service<RequestContext>()('RequestContext') {
  constructor(
    readonly requestId: string,
    readonly database: Database
  ) {
    super()
  }
}

class RequestDatabase extends Service<RequestDatabase>()('Database') {
  query(): string {
    return 'request'
  }
}

describe('Runtime Service resolution', () => {
  test('reports missing providers with the logical Service tag', async () => {
    let acquisitions = 0
    const runtime = await Runtime.make(
      Layer.make(Database, () => {
        acquisitions++
        return new Database()
      })
    )

    try {
      const error = await runtime
        .run(() => ServiceRuntime.resolve(Config))
        .then(
          () => undefined,
          (cause) => cause
        )

      expect(error).toBeInstanceOf(ServiceNotFoundError)

      if (error instanceof ServiceNotFoundError) {
        expect(error.service).toBe(Config)
        expect(error.message).toBe('Service "Config" was not provided')
      }
      expect(acquisitions).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

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

  test('runs a request Layer in the execution Scope and falls back to root Services', async () => {
    let databaseAcquisitions = 0
    let requestAcquisitions = 0
    let requestReleases = 0
    const releaseOutcomes: string[] = []

    const runtime = await Runtime.make(
      Layer.make(Database, () => {
        databaseAcquisitions++
        return new Database()
      })
    )

    const requestLayer = Layer.scopedGen(
      RequestContext,
      async function* () {
        const database = yield* Database
        requestAcquisitions++
        return new RequestContext(`request-${requestAcquisitions}`, database)
      },
      (_request, outcome) => {
        requestReleases++
        releaseOutcomes.push(outcome.status)
      }
    )

    try {
      const program = Effect.fn(async function* () {
        const request = yield* RequestContext

        return Result.ok({
          requestId: request.requestId,
          query: request.database.query()
        })
      })

      const first = await runtime.runWith(requestLayer, program)
      const second = await runtime.runWith(requestLayer, program)

      expect(Result.isOk(first)).toBe(true)
      expect(Result.isOk(second)).toBe(true)

      if (Result.isOk(first) && Result.isOk(second)) {
        expect(first.value).toEqual({ requestId: 'request-1', query: 'database' })
        expect(second.value).toEqual({ requestId: 'request-2', query: 'database' })
      }
      expect(databaseAcquisitions).toBe(1)
      expect(requestAcquisitions).toBe(2)
      expect(requestReleases).toBe(2)
      expect(releaseOutcomes).toEqual(['success', 'success'])
    } finally {
      await runtime.dispose()
    }
  })

  test('isolates concurrent request Layers and supports local overrides', async () => {
    const runtime = await Runtime.make(Layer.succeed(Database, new Database()))

    try {
      const [first, second] = await Promise.all([
        runtime.runWith(
          Layer.succeed(RequestContext, new RequestContext('first', new Database())),
          async () => {
            await Promise.resolve()
            return (await ServiceRuntime.resolve(RequestContext)).requestId
          }
        ),
        runtime.runWith(
          Layer.succeed(RequestContext, new RequestContext('second', new Database())),
          async () => {
            await Promise.resolve()
            return (await ServiceRuntime.resolve(RequestContext)).requestId
          }
        )
      ])

      expect([first, second]).toEqual(['first', 'second'])

      const overridden = await runtime.runWith(
        Layer.succeed(RequestDatabase, new RequestDatabase()),
        () => ServiceRuntime.resolve(Database)
      )

      expect(overridden.query()).toBe('request')
      expect((await runtime.run(() => ServiceRuntime.resolve(Database))).query()).toBe('database')
    } finally {
      await runtime.dispose()
    }
  })

  test('closes request-scoped providers with the execution outcome', async () => {
    let outcome: string | undefined
    const failure = new Error('request failed')
    const runtime = await Runtime.make(Layer.merge())

    try {
      const result = await runtime.runWith(
        Layer.scoped(
          RequestContext,
          () => new RequestContext('failed', new Database()),
          (_request, requestOutcome) => {
            outcome = requestOutcome.status
          }
        ),
        async () => {
          await ServiceRuntime.resolve(RequestContext)
          return Result.err(failure)
        }
      )

      expect(Result.isError(result)).toBe(true)

      if (Result.isError(result)) {
        expect(result.error).toBe(failure)
      }
      expect(outcome).toBe('failure')
    } finally {
      await runtime.dispose()
    }
  })
})
