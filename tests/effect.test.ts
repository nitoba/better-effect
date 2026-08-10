import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../src/effect'
import { Service, ServiceRuntime } from '../src/service'

import { TestServiceResolver } from './helpers/test-service-resolver'

class GreetingService extends Service<GreetingService>() {
  greet(name: string): string {
    return `Hello, ${name}!`
  }
}

describe('Effect.gen', () => {
  test('supports synchronous Result generators', () => {
    const result = Effect.gen(function* () {
      const value = yield* Result.ok(41)

      return Result.ok(value + 1)
    })

    expect(result).toEqual(Result.ok(42))
  })

  test('delegates service resolution and Result control flow', async () => {
    const greeting = new GreetingService()
    const resolver = new TestServiceResolver().provide(GreetingService, greeting)

    const result = await ServiceRuntime.run(resolver, () =>
      Effect.gen(async function* () {
        const service = yield* GreetingService

        const suffix = yield* Result.await(Promise.resolve(Result.ok('welcome')))

        return Result.ok(service.greet(suffix))
      })
    )

    expect(resolver.calls).toEqual([GreetingService])
    expect(result).toEqual(Result.ok('Hello, welcome!'))
  })

  test('preserves Result errors', async () => {
    const result = await Effect.gen(async function* () {
      yield* Result.err('failed')

      return Result.ok('unreachable')
    })

    expect(result).toEqual(Result.err('failed'))
  })
})
