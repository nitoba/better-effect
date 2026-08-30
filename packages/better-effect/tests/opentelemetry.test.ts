import { describe, expect, test } from 'bun:test'

import { SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api'
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

class WarmupService extends Service<WarmupService>()('WarmupService') {}

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

  test('marks execution cleanup failures without changing the primary program outcome', async () => {
    const telemetry = makeTelemetry()
    const recorded = RecordedRuntimeObserver.make()
    const releaseFailure = new Error('execution-release-secret')
    const observer = OpenTelemetryRuntimeObserver.make({ tracer: telemetry.tracer })
    const runtime = await Runtime.make(Layer.empty, {
      observers: [RuntimeObserver.compose(observer, recorded)]
    })

    try {
      const failure = await captureRejection(
        runtime.run(
          Effect.fn(async function* () {
            yield* Effect.acquireRelease(
              () => 'resource',
              () => {
                throw releaseFailure
              }
            )
            return Result.ok('program-success')
          })
        )
      )

      expect(failure).toMatchObject({ causes: [releaseFailure] })
    } finally {
      await runtime.dispose()
    }

    const end = recorded.executionEnds[0]
    const span = executionSpans(telemetry.exporter.getFinishedSpans())[0]

    if (!end || !span) {
      throw new Error('Expected cleanup-aware execution telemetry')
    }

    expect(end.outcome).toEqual({ status: 'success' })
    expect(end.cleanupFailure?.causes).toEqual([releaseFailure])
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.attributes['better_effect.outcome']).toBe('failure')
    expect(serializedValues([span])).not.toContain('execution-release-secret')
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

  test('bounds sanitizer array inspection as well as telemetry output', async () => {
    const telemetry = makeTelemetry()
    const oversized = Array.from({ length: 1024 }, () => 'safe')
    Object.defineProperty(oversized, 16, {
      get: () => {
        throw new Error('sanitizer scanned beyond the array bound')
      }
    })
    const observer = OpenTelemetryRuntimeObserver.make({
      tracer: telemetry.tracer,
      recordFailures: true,
      sanitizeFailure: () => ({ attributes: { boundedValues: oversized } })
    })
    const runtime = await Runtime.make(Layer.empty, { observers: [observer] })

    try {
      await runtime.run(() => Result.err({ code: 'bounded' }))
    } finally {
      await runtime.dispose()
    }

    const span = executionSpans(telemetry.exporter.getFinishedSpans())[0]
    const failureEvent = span?.events.find((event) => event.name === 'better-effect.failure')
    const values = failureEvent?.attributes?.['boundedValues']

    expect(Array.isArray(values)).toBe(true)
    expect(values).toHaveLength(16)
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

  test('preserves mixed concurrent execution IDs and final statuses', async () => {
    const telemetry = makeTelemetry()
    const observer = OpenTelemetryRuntimeObserver.make({ tracer: telemetry.tracer })
    const runtime = await Runtime.make(Layer.empty, { observers: [observer] })
    let releaseSuccess!: () => void
    let releaseFailure!: () => void
    const successGate = new Promise<void>((resolve) => {
      releaseSuccess = resolve
    })
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve
    })
    const failure = { code: 'mixed-failure' }

    try {
      const success = runtime.run(
        Program.named(
          'mixed.success',
          Effect.fn(async function* () {
            yield* []
            await successGate
            return Result.ok('success')
          })
        )
      )
      const failed = runtime.run(
        Program.named(
          'mixed.failure',
          Effect.fn(async function* () {
            yield* []
            await failureGate
            return Result.err(failure)
          })
        )
      )

      releaseSuccess()
      releaseFailure()
      const [successResult, failureResult] = await Promise.all([success, failed])
      expect(Result.isOk(successResult)).toBe(true)
      expect(Result.isError(failureResult)).toBe(true)
    } finally {
      releaseSuccess()
      releaseFailure()
      await runtime.dispose()
    }

    const spans = executionSpans(telemetry.exporter.getFinishedSpans())
    const successSpan = spans.find((span) => span.name === 'mixed.success')
    const failureSpan = spans.find((span) => span.name === 'mixed.failure')

    if (!successSpan || !failureSpan) {
      throw new Error('Expected both mixed execution spans')
    }

    expect(successSpan.attributes['better_effect.execution_id']).toEqual(expect.any(String))
    expect(failureSpan.attributes['better_effect.execution_id']).toEqual(expect.any(String))
    expect(successSpan.attributes['better_effect.execution_id']).not.toBe(
      failureSpan.attributes['better_effect.execution_id']
    )
    expect(successSpan.status.code).toBe(SpanStatusCode.OK)
    expect(failureSpan.status.code).toBe(SpanStatusCode.ERROR)
    expect(successSpan.attributes['better_effect.outcome']).toBe('success')
    expect(failureSpan.attributes['better_effect.outcome']).toBe('failure')
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

  test('keeps overlapping warmup Service activity outside an active execution span', async () => {
    const telemetry = makeTelemetry()
    const observer = OpenTelemetryRuntimeObserver.make({
      tracer: telemetry.tracer,
      serviceResolution: 'events'
    })
    let releaseWarmup!: () => void
    let markWarmupStarted!: () => void
    let releaseExecution!: () => void
    let markExecutionStarted!: () => void
    const warmupGate = new Promise<void>((resolve) => {
      releaseWarmup = resolve
    })
    const warmupStarted = new Promise<void>((resolve) => {
      markWarmupStarted = resolve
    })
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve
    })
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve
    })
    const runtime = await Runtime.make(
      Layer.make(WarmupService, async () => {
        markWarmupStarted()
        await warmupGate
        return new WarmupService()
      }),
      { observers: [observer] }
    )

    try {
      const warmup = runtime.warmup()
      await warmupStarted

      const execution = runtime.run(async () => {
        markExecutionStarted()
        await executionGate
        return Result.ok('active')
      })
      await executionStarted

      releaseWarmup()
      await warmup
      releaseExecution()
      await execution
    } finally {
      releaseWarmup()
      releaseExecution()
      await runtime.dispose()
    }

    const spans = telemetry.exporter.getFinishedSpans()
    const executionSpan = spans.find((span) => span.name === 'better-effect.execution')
    const standaloneServiceSpans = spans.filter((span) => span.name === 'better-effect.service')

    if (!executionSpan) {
      throw new Error('Expected the active execution span')
    }

    expect(executionSpan.events).toHaveLength(0)
    expect(standaloneServiceSpans.length).toBeGreaterThanOrEqual(2)
    expect(
      standaloneServiceSpans.every(
        (span) => span.attributes['better_effect.execution_id'] === undefined
      )
    ).toBe(true)
    expect(
      standaloneServiceSpans.flatMap((span) => span.events.map((event) => event.name))
    ).toEqual(
      expect.arrayContaining(['better-effect.service.acquire', 'better-effect.service.resolve'])
    )
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

  test('reserves execution state across reentrant start and end callbacks', () => {
    const telemetry = makeTelemetry()
    const scope = Scope.make()
    const start = {
      executionId: 'reentrant-execution',
      scope,
      startedAt: 0
    }
    const end = {
      ...start,
      durationMs: 1,
      outcome: { status: 'success' as const }
    }
    let observer!: OpenTelemetryRuntimeObserver
    let reentered = false
    const startSpan: Tracer['startSpan'] = (name, options, parentContext) => {
      const span = telemetry.tracer.startSpan(name, options, parentContext)

      if (!reentered) {
        reentered = true
        observer.onExecutionStart(start)
        observer.onExecutionEnd(end)
      }

      return span
    }
    const tracer = {
      startSpan,
      startActiveSpan: telemetry.tracer.startActiveSpan.bind(telemetry.tracer)
    } satisfies Tracer

    observer = OpenTelemetryRuntimeObserver.make({ tracer })
    observer.onExecutionStart(start)
    observer.onExecutionEnd(end)

    const spans = telemetry.exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]?.status.code).toBe(SpanStatusCode.OK)

    observer.dispose()
    void scope.close()
  })

  for (const reentrantOperation of [
    'setAttribute',
    'setStatus',
    'failureSanitizer',
    'end'
  ] as const) {
    test(`finalizes once when ${reentrantOperation} re-enters dispose`, () => {
      const telemetry = makeTelemetry()
      const scope = Scope.make()
      const start = {
        executionId: `reentrant-${reentrantOperation}`,
        scope,
        startedAt: 0
      }
      const end = {
        ...start,
        durationMs: 1,
        outcome:
          reentrantOperation === 'failureSanitizer'
            ? { status: 'failure' as const, cause: { code: 'failure' } }
            : { status: 'success' as const }
      }
      let observer!: OpenTelemetryRuntimeObserver
      let reentered = false
      let endCalls = 0
      const reenterDispose = () => {
        if (!reentered) {
          reentered = true
          observer.dispose()
        }
      }
      const startSpan: Tracer['startSpan'] = (name, options, parentContext) => {
        const span = telemetry.tracer.startSpan(name, options, parentContext)
        const endSpan = span.end.bind(span)
        Object.defineProperty(span, 'end', {
          value: () => {
            endCalls += 1

            if (reentrantOperation === 'end') {
              reenterDispose()
            }

            endSpan()
          }
        })

        if (reentrantOperation === 'setAttribute') {
          const setAttribute = span.setAttribute.bind(span)
          Object.defineProperty(span, 'setAttribute', {
            value: (...args: Parameters<Span['setAttribute']>) => {
              reenterDispose()
              return setAttribute(...args)
            }
          })
        }

        if (reentrantOperation === 'setStatus') {
          const setStatus = span.setStatus.bind(span)
          Object.defineProperty(span, 'setStatus', {
            value: (...args: Parameters<Span['setStatus']>) => {
              reenterDispose()
              return setStatus(...args)
            }
          })
        }

        return span
      }
      const tracer = {
        startSpan,
        startActiveSpan: telemetry.tracer.startActiveSpan.bind(telemetry.tracer)
      } satisfies Tracer
      if (reentrantOperation === 'failureSanitizer') {
        observer = OpenTelemetryRuntimeObserver.make({
          tracer,
          recordFailures: true,
          sanitizeFailure: () => {
            reenterDispose()
            return { attributes: { safe: 'value' } }
          }
        })
      } else {
        observer = OpenTelemetryRuntimeObserver.make({ tracer })
      }

      observer.onExecutionStart(start)
      observer.onExecutionEnd(end)

      expect(endCalls).toBe(1)
      expect(telemetry.exporter.getFinishedSpans()).toHaveLength(1)

      observer.dispose()
      void scope.close()
    })
  }

  test('isolates rejecting tracer and span operations from Runtime results', async () => {
    const startFailure = new Error('start-span-rejected')
    const startSpan: Tracer['startSpan'] = () => {
      // SAFETY: This test double deliberately returns a rejected thenable through the Span return type.
      return Promise.reject(startFailure) as never
    }
    const startObserver = OpenTelemetryRuntimeObserver.make({
      tracer: {
        startSpan,
        // SAFETY: The adapter never calls startActiveSpan; this double is only a minimal test tracer.
        startActiveSpan: (() => Promise.reject(startFailure)) as Tracer['startActiveSpan']
      }
    })
    const startRuntime = await Runtime.make(Layer.empty, { observers: [startObserver] })

    try {
      const result = await startRuntime.run(() => Result.ok('start-rejected'))
      expect(Result.isOk(result) && result.value).toBe('start-rejected')
    } finally {
      await startRuntime.dispose()
      startObserver.dispose()
    }

    const spanFailure = new Error('span-operation-rejected')
    const telemetry = makeTelemetry()
    const span = telemetry.tracer.startSpan('rejecting')
    let rejectedOperations = 0
    const rejectOperation = (): Promise<void> => {
      rejectedOperations++
      return Promise.reject(spanFailure)
    }

    for (const method of ['setAttribute', 'setStatus', 'end'] as const) {
      Object.defineProperty(span, method, { value: rejectOperation })
    }

    const spanObserver = OpenTelemetryRuntimeObserver.make({
      tracer: {
        startSpan: () => span,
        startActiveSpan: telemetry.tracer.startActiveSpan.bind(telemetry.tracer)
      }
    })
    const spanRuntime = await Runtime.make(Layer.empty, { observers: [spanObserver] })

    try {
      const result = await spanRuntime.run(() => Result.ok('span-rejected'))
      expect(Result.isOk(result) && result.value).toBe('span-rejected')
    } finally {
      await spanRuntime.dispose()
      spanObserver.dispose()
    }

    expect(rejectedOperations).toBeGreaterThanOrEqual(3)
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
