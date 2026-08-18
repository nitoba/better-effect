import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../src/effect'
import { Layer } from '../src/layer'
import { Runtime } from '../src/runtime'
import { RuntimeContextNotConfiguredError } from '../src/runtime'
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
    const signal = new AbortController().signal
    const runtime = await Runtime.make(Layer.make(ContextService), {
      contextStorage: storage,
      signal
    })

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const context = storage.current()
          const service = yield* ContextService
          const scope = yield* Scope

          expect(context.resolver).toBeDefined()
          expect(context.scope).toBe(scope)
          expect(context.signal).toBe(signal)
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
