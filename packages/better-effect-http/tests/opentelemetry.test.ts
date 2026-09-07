/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-known-value-widening -- The fake tracer deliberately models the external OpenTelemetry surface without bringing an SDK/exporter into the test. */
import { expect, test } from 'bun:test'
import { type Span, type Tracer } from '@opentelemetry/api'
import { HttpStatusError } from '../src/errors'
import { HttpTelemetry } from '../src/opentelemetry'

type RecordedSpan = {
  readonly name: string
  readonly attributes: Record<string, unknown>
  readonly exceptions: unknown[]
  readonly statuses: unknown[]
  endCount: number
}

const makeTracer = () => {
  const spans: RecordedSpan[] = []
  const tracer = {
    startSpan(name: string): Span {
      const recorded: RecordedSpan = {
        name,
        attributes: {},
        exceptions: [],
        statuses: [],
        endCount: 0
      }
      const span = {
        spanContext: () => ({ traceId: 'trace', spanId: `span-${spans.length}`, traceFlags: 1 }),
        setAttribute: (key: string, value: unknown) => {
          recorded.attributes[key] = value
          return span
        },
        setAttributes: (attributes: Record<string, unknown>) => {
          Object.assign(recorded.attributes, attributes)
          return span
        },
        addEvent: () => span,
        addLink: () => span,
        addLinks: () => span,
        setStatus: (status: unknown) => {
          recorded.statuses.push(status)
          return span
        },
        updateName: () => span,
        end: () => {
          recorded.endCount++
        },
        isRecording: () => recorded.endCount === 0,
        recordException: (exception: unknown) => {
          recorded.exceptions.push(exception)
        }
      }
      spans.push(recorded)
      return span as unknown as Span
    }
  } as unknown as Tracer
  return { spans, tracer }
}

test('lifecycle keeps one logical span, child attempts, safe attributes, and idempotent completion', () => {
  const { spans, tracer } = makeTracer()
  const events: string[] = []
  const observer = HttpTelemetry.observe({
    tracer,
    onEvent: (event) => {
      events.push(`${event.operationId}:${event.phase}`)
      throw new Error('observer diagnostics must be isolated')
    }
  })
  const first = observer.lifecycle.start({
    method: 'GET',
    url: 'https://user:password@api.example.test/users/123?token=secret#fragment',
    template: '/users/:id'
  })
  const second = observer.lifecycle.start({ method: 'POST', url: 'https://api.example.test/write' })

  observer.lifecycle.attemptStart(first, 1)
  observer.lifecycle.retry(first, { attempt: 1, nextAttempt: 2, delayMs: 25 })
  observer.lifecycle.attemptEnd(first, 1, true)
  observer.lifecycle.attemptStart(first, 2)
  observer.lifecycle.attemptEnd(first, 2)
  observer.lifecycle.success(first, {
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    url: 'https://api.example.test/users/123',
    data: { id: '123' }
  })
  observer.lifecycle.success(first, {
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    url: 'https://api.example.test/users/123',
    data: { id: '123' }
  })
  observer.lifecycle.error(
    second,
    new HttpStatusError({
      phase: 'status',
      status: 500,
      statusText: 'provider secret',
      headers: new Headers({ authorization: 'token' }),
      url: 'https://api.example.test/write?secret=1',
      body: { password: 'secret' }
    })
  )

  expect(spans).toHaveLength(4)
  expect(spans[0]?.endCount).toBe(1)
  expect(spans[0]?.name).toBe('GET /users/:id')
  expect(spans[0]?.attributes['http.url']).toBe('https://api.example.test/users/123')
  expect(spans[0]?.attributes['http.route']).toBe('/users/:id')
  expect(spans[1]?.endCount).toBe(1)
  expect(spans[2]?.endCount).toBe(1)
  expect(spans[3]?.endCount).toBe(1)
  expect(spans[1]?.exceptions).toEqual([{ name: 'HttpStatusError' }])
  expect(JSON.stringify(events)).not.toContain('secret')
})

test('safe metadata uses an allowlist and propagation only uses approved origins', () => {
  const { tracer } = makeTracer()
  const observer = HttpTelemetry.observe({
    tracer,
    propagation: { allowedOrigins: ['https://partner.example.com'] }
  })
  const headers = new Headers({
    authorization: 'Bearer secret',
    cookie: 'session=secret',
    'content-type': 'application/json',
    'x-request-id': 'private'
  })
  expect(HttpTelemetry.safeHeaders(headers)).toEqual({ 'content-type': 'application/json' })
  expect(HttpTelemetry.safeUrl('https://user:pass@partner.example.com/path?token=secret#x')).toBe(
    'https://partner.example.com/path'
  )

  const operationId = observer.lifecycle.start({
    method: 'GET',
    url: 'https://partner.example.com/path'
  })
  const blocked = observer.lifecycle.propagate(
    operationId,
    'https://other.example.com/path',
    new Headers()
  )
  expect([...blocked]).toEqual([])
  const approved = observer.lifecycle.propagate(
    operationId,
    'https://partner.example.com/path',
    new Headers()
  )
  expect([...approved]).toEqual([])
  observer.lifecycle.cancel(operationId)
})

test('a failing tracer does not escape the observer callback', () => {
  const tracer = {
    startSpan: () => {
      throw new Error('telemetry provider failed')
    }
  } as unknown as Tracer
  const observer = HttpTelemetry.observe({ tracer })
  expect(() =>
    observer.lifecycle.start({ method: 'GET', url: 'https://example.test' })
  ).not.toThrow()
  expect(() =>
    observer.onError?.({
      error: new HttpStatusError({
        phase: 'status',
        status: 503,
        statusText: 'Unavailable',
        headers: new Headers(),
        url: 'https://example.test'
      })
    })
  ).not.toThrow()
})
