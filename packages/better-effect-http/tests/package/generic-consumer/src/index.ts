// oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- this fixture proves the provider-neutral published entrypoint with a minimal Standard Schema consumer.
import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import * as Http from 'better-effect-http'
import packageJson from 'better-effect-http/package.json' with { type: 'json' }
import type { StandardSchemaV1 } from 'better-effect-schema'

if (packageJson.name !== 'better-effect-http') {
  throw new Error('The generic consumer did not load the published HTTP package')
}

const schema: StandardSchemaV1<unknown, { readonly ok: boolean }> = {
  '~standard': {
    version: 1,
    vendor: 'generic-consumer',
    types: undefined as unknown as StandardSchemaV1.Types<unknown, { readonly ok: boolean }>,
    validate(value: unknown) {
      return typeof value === 'object' && value !== null && 'ok' in value
        ? { value: { ok: Boolean(value.ok) } }
        : { issues: [{ message: 'Expected an ok response' }] }
    }
  }
}

const fetch: typeof globalThis.fetch = Object.assign(
  async () => new Response('{"ok":true}', { status: 200 }),
  { preconnect: () => {} }
)

const result = (await Runtime.run(
  Http.HttpClient.layer({ fetch }),
  Effect.fn(async function* () {
    const http = yield* Http.HttpClient
    const response = yield* http.get('/health', { schema })
    return Result.ok(response.data)
  }) as never
)) as Result<{ readonly ok: boolean }, unknown>

if (Result.isError(result) || !result.value.ok) {
  throw new Error('Generic consumer request failed')
}

console.log('better-effect-http generic consumer passed')
