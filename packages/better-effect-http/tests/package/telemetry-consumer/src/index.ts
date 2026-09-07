// oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- the consumer supplies a deliberately minimal fake tracer for the public OpenTelemetry contract.
import { HttpTelemetry } from 'better-effect-http/opentelemetry'
import type { Tracer } from '@opentelemetry/api'

const names: string[] = []
const makeSpan = () => {
  const span = {
    spanContext: () => ({ traceId: 'trace', spanId: `span-${names.length}`, traceFlags: 1 }),
    setAttribute: () => span,
    setAttributes: () => span,
    addEvent: () => span,
    addLink: () => span,
    addLinks: () => span,
    setStatus: () => span,
    updateName: () => span,
    end: () => undefined,
    isRecording: () => true,
    recordException: () => undefined
  }
  return span
}

const tracer = {
  startSpan(name: string) {
    names.push(name)
    return makeSpan()
  }
} as unknown as Tracer

const events: string[] = []
const observer = HttpTelemetry.observe({
  tracer,
  onEvent: (event) => events.push(event.phase)
})
const operationId = observer.lifecycle.start({
  method: 'GET',
  url: 'https://example.test/users/1?token=secret'
})
observer.lifecycle.attemptStart(operationId, 1)
observer.lifecycle.attemptEnd(operationId, 1)
observer.lifecycle.success(operationId, {
  status: 200,
  statusText: 'OK',
  headers: new Headers(),
  url: 'https://example.test/users/1',
  data: { id: '1' }
})

if (names.length !== 2 || events.join(',') !== 'admission,send,headers,complete') {
  throw new Error('The packed OpenTelemetry subpath did not preserve its lifecycle')
}
if (
  HttpTelemetry.safeUrl('https://user:password@example.test/users?token=secret') !==
  'https://example.test/users'
) {
  throw new Error('The packed OpenTelemetry subpath did not redact URL credentials')
}

console.log('better-effect-http OpenTelemetry consumer passed')
