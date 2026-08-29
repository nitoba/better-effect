import { describe, expect, expectTypeOf, test } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../src/effect'
import { Service, ServiceRuntime, ServiceRuntimeNotConfiguredError } from '../src/service'

import { TestServiceResolver } from './helpers/test-service-resolver'

class CounterService extends Service<CounterService>()('CounterService') {
  constructor(readonly value: number) {
    super()
  }

  increment(): number {
    return this.value + 1
  }
}

class StructuralService extends Service<StructuralService>()('StructuralService') {
  query(sql: string): string {
    return sql
  }
}

const runtimeServiceFactory = Service<unknown>()

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This test deliberately probes invalid JavaScript inputs.
const invokeRuntimeServiceFactory = (tag: unknown): void => {
  // oxlint-disable-next-line anti-slop/no-reflect-apply -- This test deliberately invokes the typed factory with forged JavaScript inputs.
  Reflect.apply(runtimeServiceFactory, undefined, [tag])
}

describe('Service', () => {
  test('accepts only non-empty primitive string tags', () => {
    for (const tag of ['', new String('boxed'), { length: 7 }, null, undefined, 42]) {
      expect(() => invokeRuntimeServiceFactory(tag)).toThrow(TypeError)
    }
  })

  test('locks the declared tag against runtime mutation', () => {
    class ImmutableService extends Service<ImmutableService>()('ImmutableService') {}

    expect(Reflect.set(ImmutableService, 'serviceTag', 'mutated')).toBe(false)
    expect(ImmutableService.serviceTag).toBe('ImmutableService')
  })
  test('resolves a service using yield*', async () => {
    const instance = new CounterService(41)

    const resolver = new TestServiceResolver().provide(CounterService, instance)

    const result = await ServiceRuntime.run(resolver, () =>
      Effect.gen(async function* () {
        const counter = yield* CounterService

        expectTypeOf(counter).toEqualTypeOf<CounterService>()

        return Result.ok(counter.increment())
      })
    )

    expect(resolver.calls).toEqual([CounterService])

    expect(Result.isOk(result)).toBe(true)

    if (Result.isOk(result)) {
      expect(result.value).toBe(42)
    }
  })

  test('infers instance type from token', async () => {
    const instance = new CounterService(42)

    const resolver = new TestServiceResolver().provide(CounterService, instance)

    const counter = await ServiceRuntime.run(resolver, () => ServiceRuntime.resolve(CounterService))

    expectTypeOf(counter).toEqualTypeOf<CounterService>()

    expect(counter).toBe(instance)
  })

  test('creates a type-checked structural implementation without changing it', () => {
    const implementation = {
      query: (sql: string) => `Result: ${sql}`
    }

    const service = StructuralService.of(implementation)

    // SAFETY: `of` returns the branded Service view of this exact object.
    expect(service as object).toBe(implementation)
    expect(service.query('SELECT 1')).toBe('Result: SELECT 1')
    expect(service).not.toBeInstanceOf(StructuralService)
    expectTypeOf(service).toEqualTypeOf<StructuralService>()
  })

  test('does not leak the resolver outside the runtime context', async () => {
    const instance = new CounterService(42)

    const resolver = new TestServiceResolver().provide(CounterService, instance)

    const counter = await ServiceRuntime.run(resolver, () => ServiceRuntime.resolve(CounterService))

    expect(counter).toBe(instance)

    expect(ServiceRuntime.resolve(CounterService)).rejects.toBeInstanceOf(
      ServiceRuntimeNotConfiguredError
    )
  })
})
