import { Effect, Runtime } from 'better-effect'
import { ClockTest } from 'better-effect/testing'
import { Result } from 'better-result'
import { HttpAuth, HttpClient, HttpInterceptor, HttpRetry } from 'better-effect-http'

import { withLocalServer } from './support'

let token = 'expired'
let refreshes = 0
let sends = 0
let unauthorizedResponses = 0
let releaseUnauthorized: (() => void) | undefined
const unauthorizedBarrier = new Promise<void>((resolve) => {
  releaseUnauthorized = resolve
})
const observed: string[] = []
const clock = new ClockTest(new Date('2026-01-01T00:00:00Z'))

const authentication = HttpAuth.authentication({
  credential: Effect.fn(async function* () {
    const credential = yield* Result.await(Promise.resolve(Result.ok(token)))
    return Result.ok(credential)
  })
})
const recovery = HttpAuth.refresh({
  maxReplays: 1,
  key: () => Result.ok('demo-session'),
  refresh: Effect.fn(async function* () {
    refreshes++
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    token = 'fresh'
    const refreshed = yield* Result.await(Promise.resolve(Result.ok(token)))
    return Result.ok(refreshed)
  })
})
const observer = HttpInterceptor.observe({
  name: 'demo-observer',
  onSuccess: () => {
    observed.push('success')
    return Result.ok(undefined)
  }
})
const DemoHttp = HttpClient.service('@example/DemoHttp', {
  interceptors: [authentication],
  middleware: [recovery],
  observers: [observer]
})

const responseFor = async (request: Request): Promise<Response> => {
  sends++
  if (request.headers.get('authorization') === 'Bearer fresh') return Response.json({ ok: true })
  if (sends <= 2) return new Response('temporarily unavailable', { status: 503 })
  unauthorizedResponses++
  if (unauthorizedResponses === 2) releaseUnauthorized?.()
  await unauthorizedBarrier
  return new Response('expired credential', { status: 401 })
}

await withLocalServer(responseFor, async (baseURL) => {
  const runtime = await Runtime.make(
    DemoHttp.layer({
      baseURL,
      limits: { concurrency: 2 }
    })
  )
  const request = () =>
    runtime.run(
      Effect.fn(async function* () {
        const http = yield* DemoHttp
        const response = yield* http.get('/profile', {
          retry: HttpRetry.transient({ times: 1, delay: HttpRetry.fixed(0) })
        })
        return Result.ok(response.data)
      })
    )

  try {
    const results = await Promise.all([request(), request()])
    if (results.some(Result.isError)) throw new Error('authentication example failed')
    if (refreshes !== 1) throw new Error('same-session refresh was not single-flight')
    if (!observed.includes('success')) throw new Error('observer did not receive success')
    console.log(JSON.stringify({ requests: sends, refreshes, clock: clock.now(), observed }))
  } finally {
    await runtime.dispose()
  }
})
