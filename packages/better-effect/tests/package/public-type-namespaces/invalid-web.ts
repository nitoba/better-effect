import { Result } from 'better-result'

import { Effect, Layer, Runtime, Service } from 'better-effect'
import { WebEffect } from 'better-effect/web'

class Root extends Service<Root>()('PackageInvalidWebRoot') {
  value(): string {
    return 'root'
  }
}

class IncompatibleRoot extends Service<IncompatibleRoot>()('PackageInvalidWebRoot') {
  other(): number {
    return 1
  }
}

declare const runtime: Runtime<Root>

// The request provider collides with the concrete root provider under the same tag.
const invalidRootOverride = WebEffect.handle(
  runtime,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('invalid')
  }),
  {
    requestLayer: () => Layer.succeed(IncompatibleRoot, new IncompatibleRoot())
  }
)

void invalidRootOverride
