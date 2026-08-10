import { afterEach, describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Layer, buildLayer, type LayerBackend } from '../src/layer'

import type { LayerProvider } from '../src/layer/types'

import { Service, ServiceRuntime, type AnyServiceToken } from '../src/service'

class ExampleService extends Service<ExampleService>() {
  value(): number {
    return 42
  }
}

class MemoryLayerBackend implements LayerBackend {
  readonly providers = new Map<AnyServiceToken, LayerProvider>()

  readonly instances = new Map<AnyServiceToken, unknown>()

  disposed = false

  register(provider: LayerProvider): void {
    this.providers.set(provider.service, provider)
  }

  async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    if (this.instances.has(token)) {
      return this.instances.get(token) as InstanceType<T>
    }

    const provider = this.providers.get(token)

    if (!provider) {
      throw new Error(`Missing service: ${token.name}`)
    }

    const instance = await provider.acquire()

    this.instances.set(token, instance)

    return instance as InstanceType<T>
  }

  async disposeAll(): Promise<void> {
    for (const [token, instance] of this.instances) {
      const provider = this.providers.get(token)

      await provider?.release?.(instance)
    }

    this.instances.clear()

    this.disposed = true
  }
}

afterEach(() => {
  ServiceRuntime.reset()
})

describe('buildLayer', () => {
  test.serial('registers every provider in the backend', async () => {
    const layer = Layer.make(ExampleService, () => new ExampleService())

    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(layer, backend)

    expect(backend.providers.has(ExampleService)).toBe(true)

    expect(backend.instances.size).toBe(0)

    await runtime.dispose()
  })

  test.serial('does not acquire services while building the layer', async () => {
    let acquired = 0

    const layer = Layer.make(ExampleService, () => {
      acquired++

      return new ExampleService()
    })

    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(layer, backend)

    expect(acquired).toBe(0)

    await runtime.dispose()
  })

  test.serial('configures ServiceRuntime with the backend', async () => {
    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      backend
    )

    const result = await Result.gen(async function* () {
      const service = yield* ExampleService

      return Result.ok(service.value())
    })

    expect(Result.isOk(result)).toBe(true)

    if (Result.isOk(result)) {
      expect(result.value).toBe(42)
    }

    await runtime.dispose()
  })

  test.serial('caches instances according to backend behavior', async () => {
    let acquired = 0

    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(
      Layer.make(ExampleService, () => {
        acquired++

        return new ExampleService()
      }),
      backend
    )

    const first = await ServiceRuntime.resolve(ExampleService)

    const second = await ServiceRuntime.resolve(ExampleService)

    expect(first).toBe(second)

    expect(acquired).toBe(1)

    await runtime.dispose()
  })

  test.serial('releases acquired scoped services', async () => {
    let released = 0

    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(
      Layer.scoped(
        ExampleService,

        () => new ExampleService(),

        () => {
          released++
        }
      ),
      backend
    )

    await ServiceRuntime.resolve(ExampleService)

    expect(released).toBe(0)

    await runtime.dispose()

    expect(released).toBe(1)
  })

  test.serial('does not release services that were never acquired', async () => {
    let released = 0

    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(
      Layer.scoped(
        ExampleService,

        () => new ExampleService(),

        () => {
          released++
        }
      ),
      backend
    )

    await runtime.dispose()

    expect(released).toBe(0)
  })

  test.serial('resets ServiceRuntime after dispose', async () => {
    const runtime = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),

      new MemoryLayerBackend()
    )

    await runtime.dispose()

    expect(ServiceRuntime.resolve(ExampleService)).rejects.toThrow(
      'ServiceRuntime has not been configured'
    )
  })
})
