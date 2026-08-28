import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../src/effect'
import { Layer } from '../src/layer'
import { Runtime } from '../src/runtime'
import { RuntimeContextNotConfiguredError, RuntimeContextOverlapError } from '../src/runtime'
import { ExplicitRuntimeContextStorage } from '../src/runtime/explicit'
import { NodeRuntimeContextStorage } from '../src/runtime/node'
import { Scope } from '../src/scope'
import { Service, ServiceRuntime, type AnyServiceToken, type ServiceResolver } from '../src/service'

class ContextService extends Service<ContextService>()('ContextService') {
  value(): number {
    return 42
  }
}

describe('Runtime context storage', () => {
  test('uses one context for Service, Scope and resolution paths', async () => {
    const storage = new ExplicitRuntimeContextStorage()
    const controller = new AbortController()
    const runtime = await Runtime.make(Layer.make(ContextService), {
      contextStorage: storage,
      signal: controller.signal
    })

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const context = storage.current()
          const service = yield* ContextService
          const scope = yield* Scope

          expect(context.resolver).toBeDefined()
          expect(context.scope).toBe(scope)
          expect(context.signal).toBeDefined()
          expect(context.signal).not.toBe(controller.signal)
          expect(context.resolutionPath).toEqual([])

          return Result.ok(service.value())
        })
      )

      expect(Result.isOk(result)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('explicit storage restores context after async settlement', async () => {
    const storage = new ExplicitRuntimeContextStorage()
    const scope = Scope.make()
    const resolver: ServiceResolver = {
      resolve: async <T extends AnyServiceToken>(_token: T): Promise<InstanceType<T>> => {
        throw new Error('unused test resolver')
      }
    }
    const context = {
      resolver,
      scope,
      resolutionPath: []
    }

    await storage.run(context, async () => {
      expect(storage.current()).toBe(context)
      expect(ServiceRuntime.current()).toBe(resolver)
      expect(Scope.current()).toBe(scope)
      await Promise.resolve()
      expect(storage.current()).toBe(context)
    })

    expect(() => storage.current()).toThrow(RuntimeContextNotConfiguredError)
    await scope.close()
  })

  test('explicit storage rejects overlapping root contexts and remains reusable', async () => {
    const storage = new ExplicitRuntimeContextStorage()
    const firstScope = Scope.make()
    const secondScope = Scope.make()
    const resolver: ServiceResolver = {
      resolve: async <T extends AnyServiceToken>(_token: T): Promise<InstanceType<T>> => {
        throw new Error('unused test resolver')
      }
    }
    const first = { resolver, scope: firstScope, resolutionPath: [] }
    const second = { resolver, scope: secondScope, resolutionPath: [] }
    let releaseFirst!: () => void
    let firstStarted!: () => void

    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve
    })

    const firstRun = storage.run(first, async () => {
      firstStarted()
      await firstMayFinish
      return storage.current()
    })

    await started

    expect(() => storage.run(second, async () => storage.current())).toThrow(
      RuntimeContextOverlapError
    )

    releaseFirst()
    expect(await firstRun).toBe(first)

    const secondRun = await storage.run(second, async () => storage.current())
    expect(secondRun).toBe(second)

    await Promise.all([firstScope.close(), secondScope.close()])
  })

  test('explicit storage allows nested derived Scope contexts', async () => {
    const storage = new ExplicitRuntimeContextStorage()
    const parent = Scope.make()
    const child = Scope.make()
    const context = { scope: parent, resolutionPath: [] }

    await storage.run(context, async () => {
      expect(Scope.current()).toBe(parent)

      await Scope.provide(child, async () => {
        expect(Scope.current()).toBe(child)
        await Promise.resolve()
        expect(Scope.current()).toBe(child)
      })

      expect(Scope.current()).toBe(parent)
    })

    await Promise.all([parent.close(), child.close()])
  })

  test('Node storage isolates concurrent async branches', async () => {
    const storage = new NodeRuntimeContextStorage()
    const scope = Scope.make()
    const resolver: ServiceResolver = {
      resolve: async <T extends AnyServiceToken>(_token: T): Promise<InstanceType<T>> => {
        throw new Error('unused test resolver')
      }
    }
    const first = { resolver, scope, resolutionPath: [] }
    const second = { resolver, scope, resolutionPath: [] }

    const [firstContext, secondContext] = await Promise.all([
      storage.run(first, async () => {
        await Promise.resolve()
        return storage.current()
      }),
      storage.run(second, async () => {
        await Promise.resolve()
        return storage.current()
      })
    ])

    expect(firstContext).toBe(first)
    expect(secondContext).toBe(second)
    await scope.close()
  })
})
