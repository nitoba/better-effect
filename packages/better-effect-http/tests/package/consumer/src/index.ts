// oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-reflect-get, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- packed consumer fixtures intentionally model external Standard Schema values.
import { Effect, Runtime } from 'better-effect'
import { WebEffect as Web } from 'better-effect/web'
import { HonoEffect } from 'better-effect/hono'
import { Schema, type StandardSchemaV1 } from 'better-effect-schema'
import { ArkTypeAdapter } from 'better-effect-schema/arktype'
import { ValibotAdapter } from 'better-effect-schema/valibot'
import { ZodAdapter } from 'better-effect-schema/zod'
import { Result } from 'better-result'
import type { Result as ResultType } from 'better-result'
import { type as arkType } from 'arktype'
import * as v from 'valibot'
import * as z from 'zod'
import { Hono } from 'hono'
import * as Http from 'better-effect-http'
import { HttpTest } from 'better-effect-http/testing'
import packageJson from 'better-effect-http/package.json' with { type: 'json' }

for (const exportName of ['HttpRequest', 'HttpRequestError', 'HttpClient', 'validateHttpOptions']) {
  if (!(exportName in Http)) {
    throw new Error(`Missing public HTTP foundation export: ${exportName}`)
  }
}

if (packageJson.name !== 'better-effect-http' || packageJson.version !== '0.1.1') {
  throw new Error('The packed HTTP package manifest is not the expected artifact')
}

const scenario = HttpTest.sequence([HttpTest.response(200, { ok: true })])
const response = await scenario.fetch('https://example.test/health')
if (response.status !== 200 || scenario.calls !== 1) {
  throw new Error('The packed HTTP testing subpath is not functional')
}

const userClass = class ExternalUser extends Schema.Class<ExternalUser>('external/User')({
  schema: {
    '~standard': {
      version: 1,
      vendor: 'external-consumer',
      types: undefined as unknown as StandardSchemaV1.Types<unknown, { readonly id: string }>,
      validate(value: unknown) {
        return typeof value === 'object' &&
          value !== null &&
          typeof Reflect.get(value, 'id') === 'string'
          ? { value: { id: Reflect.get(value, 'id') as string } }
          : { issues: [{ message: 'Expected an external user' }] }
      }
    }
  },
  propsSchema: {
    '~standard': {
      version: 1,
      vendor: 'external-consumer',
      types: undefined as unknown as StandardSchemaV1.Types<
        { readonly id: string },
        { readonly id: string }
      >,
      validate(value: unknown) {
        return typeof value === 'object' &&
          value !== null &&
          typeof Reflect.get(value, 'id') === 'string'
          ? { value: { id: Reflect.get(value, 'id') as string } }
          : { issues: [{ message: 'Expected external user props' }] }
      }
    }
  }
}) {}

const fetch = async () => new Response('{"id":"external"}', { status: 200 })
const providerSchemas = [
  z.object({ id: z.string() }),
  v.object({ id: v.string() }),
  arkType({ id: 'string' })
] as const

const zodRead = Schema.with(ZodAdapter).read(z.object({ id: z.string() }))
const valibotRead = Schema.with(ValibotAdapter).read(v.object({ id: v.string() }))
const arktypeRead = Schema.with(ArkTypeAdapter).read(arkType({ id: 'string' }))
if (Result.isError(zodRead) || Result.isError(valibotRead) || Result.isError(arktypeRead)) {
  throw new Error('Optional schema adapter consumer failed')
}

for (const schema of providerSchemas) {
  const result = (await Runtime.run(
    Http.HttpClient.layer({ fetch }),
    Effect.fn(async function* () {
      const http = yield* Http.HttpClient
      const response = yield* http.get('/users/external', { schema })
      return Result.ok(response.data)
    }) as never
  )) as ResultType<{ readonly id: string }, unknown>
  if (Result.isError(result) || result.value.id !== 'external') {
    throw new Error('Provider-neutral Standard Schema consumer failed')
  }
}

const classResult = (await Runtime.run(
  Http.HttpClient.layer({ fetch }),
  Effect.fn(async function* () {
    const http = yield* Http.HttpClient
    const response = yield* http.get('/users/external', { schema: userClass })
    return Result.ok(response.data)
  }) as never
)) as ResultType<InstanceType<typeof userClass>, unknown>
if (Result.isError(classResult) || !(classResult.value instanceof userClass)) {
  throw new Error('Packed class schema did not preserve identity')
}

const eventSchema = <Output>(parse: (value: Record<string, unknown>) => Output) =>
  ({
    '~standard': {
      version: 1,
      vendor: 'external-consumer',
      types: undefined as unknown as StandardSchemaV1.Types<unknown, Output>,
      validate(value: unknown) {
        if (typeof value !== 'object' || value === null) {
          return { issues: [{ message: 'Expected an event object' }] }
        }
        return { value: parse(value as Record<string, unknown>) }
      }
    }
  }) satisfies StandardSchemaV1<unknown, unknown>

const progressEvent = eventSchema<{ readonly percent: number }>((value) => ({
  percent: Number(value['percent'])
}))
const completedEvent = eventSchema<{ readonly ok: boolean }>((value) => ({
  ok: Boolean(value['ok'])
}))
const deltaEvent = eventSchema<{ readonly text: string }>((value) => ({
  text: String(value['text'])
}))

const externalStreamingApp = HonoEffect.app(
  '@external/HonoHttpStreaming',
  {},
  async function* (routes) {
    const app = new Hono()
    app.use('*', yield* routes.middleware())

    app.get(
      '/proxy',
      yield* routes.stream(
        Effect.fn(async function* () {
          const http = yield* Http.HttpClient
          const upstream = http.stream('/download')
          return Result.ok<Web.Stream>({
            headers: { 'content-type': 'application/octet-stream' },
            producer: async function* () {
              for await (const item of upstream.results()) {
                if (Result.isError(item)) throw item.error
                yield item.value
              }
            }
          })
        })
      )
    )

    app.get(
      '/events',
      yield* routes.stream(
        Effect.fn(async function* () {
          const http = yield* Http.HttpClient
          const upstream = http.sse('/events', {
            events: { progress: progressEvent, completed: completedEvent }
          })
          return Result.ok<Web.Stream>({
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
            producer: async function* () {
              let completed = false
              for await (const item of upstream.results()) {
                if (Result.isError(item)) throw item.error
                const data = JSON.stringify(item.value.data)
                yield new TextEncoder().encode(`event: ${item.value.event}\ndata: ${data}\n\n`)
                if (item.value.event === 'completed') {
                  completed = true
                  break
                }
              }
              if (!completed) throw new Error('progress ended before completed')
            }
          })
        })
      )
    )

    app.post(
      '/generate',
      yield* routes.stream(
        Effect.fn(async function* () {
          const http = yield* Http.HttpClient
          const upstream = http.sse('/generate', {
            method: 'POST',
            body: { prompt: 'hello' },
            reconnect: false,
            events: { delta: deltaEvent, completed: completedEvent }
          })
          return Result.ok<Web.Stream>({
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
            producer: async function* () {
              let completed = false
              for await (const item of upstream.results()) {
                if (Result.isError(item)) throw item.error
                const data = JSON.stringify(item.value.data)
                yield new TextEncoder().encode(`event: ${item.value.event}\ndata: ${data}\n\n`)
                if (item.value.event === 'completed') {
                  completed = true
                  break
                }
              }
              if (!completed) throw new Error('generation ended before completed')
            }
          })
        })
      )
    )

    return app
  }
)

void externalStreamingApp
