import { Result } from 'better-result'

import { Effect, Layer, Runtime, Service } from 'better-effect'
import { WebEffect } from 'better-effect/web'

class Root extends Service<Root>()('PackageWebRoot') {
  value(): string {
    return 'root'
  }
}

class CompatibleRoot extends Service<CompatibleRoot>()('PackageWebRoot') {
  value(): string {
    return 'compatible'
  }
}

class RequestValue extends Service<RequestValue>()('PackageWebRequest') {
  constructor(readonly value: string) {
    super()
  }
}

// SAFETY: This declaration-only fixture never executes a Runtime.
const runtime = {} as Runtime<Root>
const requestLayer = Layer.gen(RequestValue, async function* () {
  const root = yield* Root
  return new RequestValue(root.value())
})
const program = Effect.fn(async function* () {
  const requestValue = yield* RequestValue
  return Result.ok(requestValue.value)
})

const response = WebEffect.handle(runtime, new Request('https://example.test'), program, {
  requestLayer: () => requestLayer
})

const compatibleResponse = WebEffect.handle(
  runtime,
  new Request('https://example.test'),
  Effect.fn(async function* () {
    const root = yield* Root
    return Result.ok(root.value())
  }),
  {
    requestLayer: () => Layer.succeed(CompatibleRoot, new CompatibleRoot())
  }
)

const unchecked = WebEffect.handle(runtime, new Request('https://example.test'), program, {
  // SAFETY: This fixture intentionally opts into the public unchecked Layer.Any escape hatch.
  requestLayer: () => Layer.succeed(RequestValue, new RequestValue('unchecked')) as Layer.Any
})

type NamedProgram = WebEffect.Program<string, never, Root>
type NamedOptions = WebEffect.Options<unknown, typeof requestLayer, string>

const options: NamedOptions = {
  requestLayer: () => requestLayer,
  onSuccess: ({ value }) => new Response(value)
}

void response
void compatibleResponse
void unchecked
void options
declare const namedProgram: NamedProgram
void namedProgram
