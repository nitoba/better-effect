import { afterEach, describe, expect, expectTypeOf, test } from 'bun:test'

import { Result } from 'better-result'

import { Service, ServiceRuntime } from '../src/service'

import { TestServiceResolver } from './helpers/test-service-resolver'

class CounterService extends Service<CounterService>() {
  constructor(readonly value: number) {
    super()
  }

  increment(): number {
    return this.value + 1
  }
}

afterEach(() => {
  ServiceRuntime.reset()
})

describe('Service', () => {
  test.serial('resolves a service using yield*', async () => {
    const instance = new CounterService(41)

    const resolver = new TestServiceResolver().provide(CounterService, instance)

    ServiceRuntime.configure(resolver)

    const result = await Result.gen(async function* () {
      const counter = yield* CounterService

      expectTypeOf(counter).toEqualTypeOf<CounterService>()

      return Result.ok(counter.increment())
    })

    expect(resolver.calls).toEqual([CounterService])

    expect(Result.isOk(result)).toBe(true)

    if (Result.isOk(result)) {
      expect(result.value).toBe(42)
    }
  })

  test.serial('infers instance type from token', async () => {
    const instance = new CounterService(42)

    const resolver = new TestServiceResolver().provide(CounterService, instance)

    ServiceRuntime.configure(resolver)

    const counter = await ServiceRuntime.resolve(CounterService)

    expectTypeOf(counter).toEqualTypeOf<CounterService>()

    expect(counter).toBe(instance)
  })
})
