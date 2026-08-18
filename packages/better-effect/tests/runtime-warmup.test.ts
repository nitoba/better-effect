import { describe, expect, test } from 'bun:test'

import {
  Layer,
  MapLayerBackend,
  Runtime,
  Service,
  ServiceAcquisitionError,
  ServiceRuntime,
  type RuntimeObserver
} from '../src'

class Config extends Service<Config>()('Config') {}

class Database extends Service<Database>()('Database') {
  constructor(readonly config: Config) {
    super()
  }
}

class OwnedResource extends Service<OwnedResource>()('OwnedResource') {}

class WarmupConsumer extends Service<WarmupConsumer>()('WarmupConsumer') {}

class BrokenService extends Service<BrokenService>()('BrokenService') {}

class TrackingBackend extends MapLayerBackend {
  disposed = 0

  override async disposeAll(): Promise<void> {
    this.disposed++
    await super.disposeAll()
  }
}

describe('Runtime warmup and observers', () => {
  test('resolves every Layer provider before Runtime.make returns', async () => {
    let configAcquisitions = 0
    let databaseAcquisitions = 0

    const runtime = await Runtime.make(
      Layer.merge(
        Layer.make(Config, () => {
          configAcquisitions++
          return new Config()
        }),
        Layer.make(Database, async () => {
          databaseAcquisitions++
          return new Database(await ServiceRuntime.resolve(Config))
        })
      ),
      { warmup: true }
    )

    try {
      expect(configAcquisitions).toBe(1)
      expect(databaseAcquisitions).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('cleans acquired resources and disposes the backend when warmup fails', async () => {
    let released = 0
    const backend = new TrackingBackend()
    const acquisitionCause = new Error('configuration unavailable')

    const failure = await Runtime.make(
      Layer.merge(
        Layer.scoped(
          OwnedResource,
          () => new OwnedResource(),
          () => {
            released++
          }
        ),
        Layer.make(WarmupConsumer, async () => {
          await ServiceRuntime.resolve(BrokenService)
          return new WarmupConsumer()
        }),
        Layer.make(BrokenService, () => {
          throw acquisitionCause
        })
      ),
      { backend, warmup: true }
    ).then(
      () => undefined,
      (cause) => cause
    )

    expect(failure).toBeInstanceOf(ServiceAcquisitionError)

    if (failure instanceof ServiceAcquisitionError) {
      expect(failure.service).toBe(BrokenService)
      expect(failure.resolutionPath).toEqual([WarmupConsumer, BrokenService])
      expect(failure.cause).toBe(acquisitionCause)
    }
    expect(released).toBe(1)
    expect(backend.disposed).toBe(1)
  })

  test('manual warmup keeps successfully acquired resources until disposal', async () => {
    let released = 0
    const runtime = await Runtime.make(
      Layer.scoped(
        OwnedResource,
        () => new OwnedResource(),
        () => {
          released++
        }
      )
    )

    await runtime.warmup()
    expect(released).toBe(0)
    await runtime.dispose()
    expect(released).toBe(1)
  })

  test('emits resolution, acquisition, execution and release events', async () => {
    const resolved: string[] = []
    const acquired: string[] = []
    const executions: string[] = []
    const releases: string[] = []
    const observer: RuntimeObserver = {
      onServiceResolve: (event) => {
        resolved.push(`${event.service.serviceTag}:${event.outcome.status}`)
      },
      onServiceAcquire: (event) => {
        acquired.push(`${event.service.serviceTag}:${event.outcome.status}`)
      },
      onExecutionStart: () => {
        executions.push('start')
      },
      onExecutionEnd: (event) => {
        executions.push(`end:${event.outcome.status}`)
      },
      onResourceRelease: (event) => {
        releases.push(`${event.service.serviceTag}:${event.outcome.status}`)
      }
    }

    const runtime = await Runtime.make(
      Layer.scoped(
        Config,
        () => new Config(),
        () => {}
      ),
      { observers: [observer] }
    )

    try {
      const config = await runtime.run(() => ServiceRuntime.resolve(Config))

      expect(config).toBeInstanceOf(Config)
      expect(resolved).toEqual(['Config:success'])
      expect(acquired).toEqual(['Config:success'])
      expect(executions).toEqual(['start', 'end:success'])
    } finally {
      await runtime.dispose()
    }

    expect(releases).toEqual(['Config:success'])
  })
})
