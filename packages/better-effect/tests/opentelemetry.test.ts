import { describe, expect, test } from 'bun:test'

import { SpanStatusCode, type Tracer } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan
} from '@opentelemetry/sdk-trace-base'
import { Result } from 'better-result'

import {
  Effect,
  Layer,
  Program,
  Runtime,
  RuntimeObserver,
  Scope,
  Service,
  ServiceRuntime
} from '../src'
import { OpenTelemetryRuntimeObserver } from '../src/opentelemetry'
import { RecordedRuntimeObserver } from '../src/testing'

class TelemetryService extends Service<TelemetryService>()('TelemetryService') {}

class CleanupService extends Service<CleanupService>()('CleanupService') {}

const makeTelemetry = () => {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)]
  })

  return {
    exporter,
    provider,
    tracer: provider.getTracer('better-effect-tests')
  }
}

const executionSpans = (spans: readonly ReadableSpan[]) =>
  spans.filter((span) => span.name !== 'better-effect.service')

const serializedValues = (spans: readonly ReadableSpan[]) =>
  spans.flatMap((span) => [
    ...Object.keys(span.attributes),
    ...Object.values(span.attributes).flatMap((value) => (Array.isArray(value) ? value : [value])),
    ...span.events.flatMap((event) => Object.values(event.attributes ?? {}))
  ])

const captureRejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (cause) => cause
  )

describe('OpenTelemetryRuntimeObserver', () => {
  test('records one named execution span and correlated Service events', async () => {
    const telemetry = makeTelemetry()
    const observer = OpenTelemetryRuntimeObserver.make({
      tracer: telemetry.tracer,
      serviceResolution: 'events'
    })
    const runtime = await Runtime.make(Layer.make(TelemetryService), {
      observers: [observer]
    })

    try {
      const result = await runtime.run(
        Program.named(
          'telemetry.load',
          Effect.fn(async function* () {
            const service = yield* TelemetryService
            return Result.ok(service)
          })
        )
      )

      expect(Result.isOk(result)).toBe(true)
    } finally {
      await runtime.dispose()
    }

    const spans = telemetry.exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    const span = spans[0]

    if (!span) {
      throw new Error('Expected an execution span')
    }

    expect(span.name).toBe('telemetry.load')
    expect(span.status.code).toBe(SpanStatusCode.OK)
    expect(span.attributes['better_effect.execution_id']).toEqual(expect.any(String))
    expect(span.attributes['better_effect.program_name']).toBe('telemetry.load')
    expect(span.events.map((event) => event.name)).toEqual([
      'better-effect.service.acquire',
      'better-effect.service.resolve'
    ])
    expect(span.events[0]?.attributes?.['better_effect.service_tag']).toBe('TelemetryService')
    expect(span.events[0]?.attributes?.['better_effect.execution_id']).toBe(
      span.attributes['better_effect.execution_id']
    )
  })

  test('accepts an existing provider without registering it globally', async () => {
    const telemetry = makeTelemetry()
    const observer = OpenTelemetryRuntimeObserver.make({
      provider: telemetry.provider
    })
    const runtime = await Runtime.make(Layer.empty, { observers: [observer] })

    try {
      await runtime.run(() => Result.ok('provider'))
    } finally {
      await runtime.dispose()
    }

    expect(telemetry.exporter.getFinishedSpans()).toHaveLength(1)
  })

  test('maps typed failures and defects to ERROR without recording causes by default', async () => {
    const telemetry = makeTelemetry()
    const observer = OpenTelemetryRuntimeObserver.make({ tracer: telemetry.tracer })
    const runtime = await Runtime.make(Layer.empty, { observers: [observer] })
    const typedFailure = { code: 'typed-secret', request: { password: 'hidden' } }
    const defect = new Error('defect-secret')

    try {
      const typedResult = await runtime.run(() => Result.err(typedFailure))
      expect(Result.isError(typedResult)).toBe(true)

      expect(await captureRejection(runtime.run(() => Promise.reject(defect)))).toBe(defect)
    } finally {
      await runtime.dispose()
    }

    const spans = executionSpans(telemetry.exporter.getFinishedSpans())
    expect(spans).toHaveLength(2)
    expect(spans.every((span) => span.status.code === SpanStatusCode.ERROR)).toBe(true)
    expect(spans.every((span) => !span.events.some((event) => event.name === 'exception'))).toBe(
      true
    )
    const serializedTelemetry = serializedValues(spans)
    expect(serializedTelemetry).not.toContain('typed-secret')
    expect(serializedTelemetry).not.toContain('defect-secret')
  })

  test('copies only explicit execution attributes and bounded sanitized failure details', async () => {
    const telemetry = makeTelemetry()
    const observer = OpenTelemetryRuntimeObserver.make({
      tracer: telemetry.tracer,
      recordFailures: true,
      executionAttributeAllowlist: ['requestId', 'request'],
      sanitizeFailure: () => ({
        message: 'safe-failure-message-that-is-too-long',
        attributes: { safeCode: 'safe-value' }
      }),
      maxAttributeLength: 12
    })
    const runtime = await Runtime.make(Layer.empty, { observers: [observer] })

    try {
      await runtime.run(() => Result.err({ secret: 'do-not-record' }), {
        attributes: {
          requestId: 'request-identifier-that-is-too-long',
          request: { body: 'private' }
        }
      })
    } finally {
      await runtime.dispose()
    }

    const span = executionSpans(telemetry.exporter.getFinishedSpans())[0]

    if (!span) {
      throw new Error('Expected a sanitized execution span')
    }

    expect(span.attributes['requestId']).toBe('request-iden')
    expect(span.attributes['request']).toBeUndefined()
    expect(span.events.some((event) => event.name === 'exception')).toBe(true)
    expect(
      span.events.some((event) => event.attributes?.['exception.message'] === 'safe-failure')
    ).toBe(true)
    expect(serializedValues([span])).not.toContain('do-not-record')
    expect(serializedValues([span])).not.toContain('private')
  })

  test('implements off, events, and child-span Service policies', async () => {
    for (const mode of ['off', 'events', 'spans'] as const) {
      const telemetry = makeTelemetry()
      const observer = OpenTelemetryRuntimeObserver.make({
        tracer: telemetry.tracer,
        serviceResolution: mode
      })
      const runtime = await Runtime.make(Layer.make(TelemetryService), {
        observers: [observer]
      })

      try {
        await runtime.run(() => ServiceRuntime.resolve(TelemetryService))
      } finally {
        await runtime.dispose()
      }

      const spans = telemetry.exporter.getFinishedSpans()
      const execution = spans.find((span) => span.name === 'better-effect.execution')

      if (!execution) {
        throw new Error(`Expected an execution span for ${mode}`)
      }

      if (mode === 'off') {
        expect(spans).toHaveLength(1)
        expect(execution.events).toHaveLength(0)
      } else if (mode === 'events') {
        expect(spans).toHaveLength(1)
        expect(execution.events.map((event) => event.name)).toEqual([
          'better-effect.service.acquire',
          'better-effect.service.resolve'
        ])
      } else {
        const children = spans.filter((span) => span !== execution)
        expect(children).toHaveLength(2)
        expect(children.map((span) => span.parentSpanContext?.spanId)).toEqual(
          expect.arrayContaining([execution.spanContext().spanId, execution.spanContext().spanId])
        )
      }
    }
  })

  test('correlates concurrent executions only by their execution IDs', async () => {
    const telemetry = makeTelemetry()
    const observer = OpenTelemetryRuntimeObserver.make({ tracer: telemetry.tracer })
    const runtime = await Runtime.make(Layer.empty, { observers: [observer] })
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let firstStarted!: () => void
    let secondStarted!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })

    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const secondStartedPromise = new Promise<void>((resolve) => {
      secondStarted = resolve
    })

    try {
      const first = runtime.run(
        Program.named(
          'concurrent.first',
          Effect.fn(async function* () {
            yield* []
            firstStarted()
            await firstGate
            return Result.ok('first')
          })
        )
      )
      await firstStartedPromise

      const second = runtime.run(
        Program.named(
          'concurrent.second',
          Effect.fn(async function* () {
            yield* []
            secondStarted()
            await secondGate
            return Result.ok('second')
          })
        )
      )
      await secondStartedPromise

      releaseFirst()
      releaseSecond()
      await Promise.all([first, second])
    } finally {
      releaseFirst()
      releaseSecond()
      await runtime.dispose()
    }

    const spans = executionSpans(telemetry.exporter.getFinishedSpans())
    expect(spans).toHaveLength(2)
    expect(new Set(spans.map((span) => span.attributes['better_effect.execution_id'])).size).toBe(2)
    expect(spans.map((span) => span.name)).toEqual(
      expect.arrayContaining(['concurrent.first', 'concurrent.second'])
    )
  })

  test('uses standalone spans for warmup and cleanup outside executions', async () => {
    const telemetry = makeTelemetry()
    const releaseFailure = new Error('release-secret')
    const observer = OpenTelemetryRuntimeObserver.make({
      tracer: telemetry.tracer,
      serviceResolution: 'spans'
    })
    const runtime = await Runtime.make(
      Layer.scoped(
        CleanupService,
        () => new CleanupService(),
        () => {
          throw releaseFailure
        }
      ),
      { warmup: true, observers: [observer] }
    )

    await runtime.run(() => Result.ok('cleanup'))
    const disposeFailure = await captureRejection(runtime.dispose())
    expect(disposeFailure).toBeInstanceOf(Error)

    const serviceSpans = telemetry.exporter
      .getFinishedSpans()
      .filter((span) => span.name.startsWith('better-effect.service.'))
    expect(serviceSpans.some((span) => span.name === 'better-effect.service.acquire')).toBe(true)
    expect(serviceSpans.some((span) => span.status.code === SpanStatusCode.ERROR)).toBe(true)
    expect(serializedValues(serviceSpans)).not.toContain('release-secret')
  })

  test('composes with other observers and cleans pending or repeated events safely', async () => {
    const telemetry = makeTelemetry()
    const recorded = RecordedRuntimeObserver.make()
    const observer = OpenTelemetryRuntimeObserver.make({ tracer: telemetry.tracer })
    const composed = RuntimeObserver.compose(observer, recorded)
    const runtime = await Runtime.make(Layer.empty, { observers: [composed] })

    try {
      await runtime.run(() => Result.ok('composed'))
    } finally {
      await runtime.dispose()
    }

    expect(recorded.executionStarts).toHaveLength(1)
    expect(recorded.executionEnds).toHaveLength(1)

    const pendingTelemetry = makeTelemetry()
    const pending = OpenTelemetryRuntimeObserver.make({ tracer: pendingTelemetry.tracer })
    const scope = Scope.make()
    const start = {
      executionId: 'pending-execution',
      scope,
      startedAt: 0
    }

    pending.onExecutionStart(start)
    pending.onExecutionStart(start)
    pending.dispose()
    pending.dispose()
    pending.onExecutionEnd({
      ...start,
      durationMs: 1,
      outcome: { status: 'success' }
    })

    expect(pendingTelemetry.exporter.getFinishedSpans()).toHaveLength(1)
    expect(telemetry.exporter.getFinishedSpans()).toHaveLength(1)
  })

  test('isolates tracer failures from Runtime results and other observers', async () => {
    const recorded = RecordedRuntimeObserver.make()
    const throwingTracer = {
      startSpan: () => {
        throw new Error('tracer failed')
      },
      // SAFETY: the test double deliberately implements every overloaded callback with a throwing function.
      startActiveSpan: (() => {
        throw new Error('tracer failed')
      }) as Tracer['startActiveSpan']
    } satisfies Tracer
    const observer = OpenTelemetryRuntimeObserver.make({ tracer: throwingTracer })
    const runtime = await Runtime.make(Layer.empty, {
      observers: [RuntimeObserver.compose(observer, recorded)]
    })

    try {
      const result = await runtime.run(() => Result.ok('still-runs'))
      expect(Result.isOk(result) && result.value).toBe('still-runs')
    } finally {
      await runtime.dispose()
    }

    expect(recorded.executionStarts).toHaveLength(1)
    expect(recorded.executionEnds).toHaveLength(1)
  })
})
