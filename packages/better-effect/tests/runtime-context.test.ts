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

class BranchService extends Service<BranchService>()('BranchService') {
  constructor(readonly label: string) {
    super()
  }
}

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve } satisfies Deferred
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

  test('rejects overlapping sibling derived contexts on one explicit storage', async () => {
    const storage = new ExplicitRuntimeContextStorage()
    const root = Scope.make()
    const first = Scope.make()
    const second = Scope.make()
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const context = { scope: root, resolutionPath: [] }
    let secondCallbackRan = false

    await storage.run(context, async () => {
      const firstRun = Scope.provide(first, async () => {
        firstStarted.resolve()
        await releaseFirst.promise
        expect(Scope.current()).toBe(first)
      })

      await firstStarted.promise

      expect(() =>
        Scope.provide(second, () => {
          secondCallbackRan = true
        })
      ).toThrow(RuntimeContextOverlapError)
      expect(secondCallbackRan).toBe(false)

      releaseFirst.resolve()
      await firstRun
      expect(Scope.current()).toBe(root)
    })

    await root.close()
    await first.close()
    await second.close()
  })

  test('Node frames preserve nested derived contexts after suspension', async () => {
    const storage = new NodeRuntimeContextStorage()
    const root = Scope.make()
    const child = Scope.make()
    const grandchild = Scope.make()
    const context = { scope: root, resolutionPath: [] }

    await storage.run(context, async () => {
      expect(Scope.current()).toBe(root)
      await Promise.resolve()

      await Scope.provide(child, async () => {
        expect(Scope.current()).toBe(child)
        await Promise.resolve()

        await Scope.provide(grandchild, async () => {
          expect(Scope.current()).toBe(grandchild)
          await Promise.resolve()
          expect(Scope.current()).toBe(grandchild)
        })

        expect(Scope.current()).toBe(child)
      })

      expect(Scope.current()).toBe(root)
    })

    await Promise.all([root.close(), child.close(), grandchild.close()])
  })

  test('separate explicit Runtime instances isolate resolver and Scope context', async () => {
    const firstStorage = new ExplicitRuntimeContextStorage()
    const secondStorage = new ExplicitRuntimeContextStorage()
    const firstRuntime = await Runtime.make(
      Layer.succeed(BranchService, new BranchService('first')),
      { contextStorage: firstStorage }
    )
    const secondRuntime = await Runtime.make(
      Layer.succeed(BranchService, new BranchService('second')),
      { contextStorage: secondStorage }
    )
    const firstStarted = deferred()
    const secondStarted = deferred()
    const releaseFirst = deferred()
    const releaseSecond = deferred()

    try {
      const firstRun = firstRuntime.run(async () => {
        const resolver = ServiceRuntime.current()
        const scope = Scope.current()
        firstStarted.resolve()
        await releaseFirst.promise
        const service = await ServiceRuntime.resolve(BranchService)

        expect(ServiceRuntime.current()).toBe(resolver)
        expect(Scope.current()).toBe(scope)
        return Result.ok({ label: service.label, resolver, scope })
      })
      const secondRun = secondRuntime.run(async () => {
        const resolver = ServiceRuntime.current()
        const scope = Scope.current()
        secondStarted.resolve()
        await releaseSecond.promise
        const service = await ServiceRuntime.resolve(BranchService)

        expect(ServiceRuntime.current()).toBe(resolver)
        expect(Scope.current()).toBe(scope)
        return Result.ok({ label: service.label, resolver, scope })
      })

      await Promise.all([firstStarted.promise, secondStarted.promise])
      releaseFirst.resolve()
      const firstResult = await firstRun
      releaseSecond.resolve()
      const secondResult = await secondRun

      expect(Result.isOk(firstResult)).toBe(true)
      expect(Result.isOk(secondResult)).toBe(true)

      if (Result.isOk(firstResult) && Result.isOk(secondResult)) {
        expect(firstResult.value.label).toBe('first')
        expect(secondResult.value.label).toBe('second')
        expect(firstResult.value.scope).not.toBe(secondResult.value.scope)
        expect(firstResult.value.resolver).not.toBe(secondResult.value.resolver)
      }
    } finally {
      await Promise.all([firstRuntime.dispose(), secondRuntime.dispose()])
    }
  })

  test('Node and explicit Runtime instances remain isolated while overlapping', async () => {
    const explicitStorage = new ExplicitRuntimeContextStorage()
    const nodeStorage = new NodeRuntimeContextStorage()
    const explicitRuntime = await Runtime.make(
      Layer.succeed(BranchService, new BranchService('explicit')),
      { contextStorage: explicitStorage }
    )
    const nodeRuntime = await Runtime.make(
      Layer.succeed(BranchService, new BranchService('node')),
      { contextStorage: nodeStorage }
    )
    const explicitStarted = deferred()
    const nodeStarted = deferred()
    const releaseExplicit = deferred()
    const releaseNode = deferred()

    try {
      const explicitRun = explicitRuntime.run(async () => {
        const resolver = ServiceRuntime.current()
        const scope = Scope.current()
        explicitStarted.resolve()
        await releaseExplicit.promise
        const service = await ServiceRuntime.resolve(BranchService)
        expect(ServiceRuntime.current()).toBe(resolver)
        expect(Scope.current()).toBe(scope)
        return service.label
      })
      const nodeRun = nodeRuntime.run(async () => {
        const resolver = ServiceRuntime.current()
        const scope = Scope.current()
        nodeStarted.resolve()
        await releaseNode.promise
        const service = await ServiceRuntime.resolve(BranchService)
        expect(ServiceRuntime.current()).toBe(resolver)
        expect(Scope.current()).toBe(scope)
        return service.label
      })

      await Promise.all([explicitStarted.promise, nodeStarted.promise])
      releaseNode.resolve()
      expect(await nodeRun).toBe('node')
      releaseExplicit.resolve()
      expect(await explicitRun).toBe('explicit')
    } finally {
      await Promise.all([explicitRuntime.dispose(), nodeRuntime.dispose()])
    }
  })

  test('sequential explicit Runtime resolutions retain nested context after await', async () => {
    const storage = new ExplicitRuntimeContextStorage()
    const runtime = await Runtime.make(
      Layer.merge(
        Layer.make(ContextService),
        Layer.make(BranchService, () => new BranchService('next'))
      ),
      { contextStorage: storage }
    )

    try {
      const result = await runtime.run(async () => {
        const resolver = ServiceRuntime.current()
        const scope = Scope.current()
        const first = await ServiceRuntime.resolve(ContextService)
        await Promise.resolve()
        const second = await ServiceRuntime.resolve(BranchService)

        expect(ServiceRuntime.current()).toBe(resolver)
        expect(Scope.current()).toBe(scope)
        return Result.ok([first.value(), second.label] as const)
      })

      expect(Result.isOk(result)).toBe(true)

      if (Result.isOk(result)) {
        expect(result.value).toEqual([42, 'next'])
      }
    } finally {
      await runtime.dispose()
    }
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
