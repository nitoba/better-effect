import { describe, expect, expectTypeOf, test } from 'bun:test'

import { Result } from 'better-result'

import { Service, ServiceRuntime, ServiceRuntimeNotConfiguredError } from '../src/service'

import { TestServiceResolver } from './helpers/test-service-resolver'

class CounterService extends Service<CounterService>() {
  constructor(readonly value: number) {
    super()
  }

  increment(): number {
    return this.value + 1
  }
}

describe('Service', () => {
  test('resolves a service using yield*', async () => {
    const instance = new CounterService(41)

    const resolver = new TestServiceResolver().provide(CounterService, instance)

    const result = await ServiceRuntime.run(resolver, () =>
      Result.gen(async function* () {
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
