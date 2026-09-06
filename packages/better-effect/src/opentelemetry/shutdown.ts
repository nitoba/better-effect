import {
  SpanStatusCode,
  trace,
  type AttributeValue,
  type Context,
  type Span
} from '@opentelemetry/api'

import type { RuntimeShutdownEvent } from '../runtime/observer'
import type { RuntimeShutdownReason } from '../runtime/outcome'

/** Controls how Runtime shutdown phases are represented in telemetry. */
export type ShutdownTelemetryMode = 'off' | 'events' | 'spans'

export type ShutdownPhase = 'requested' | 'quiesce' | 'drain' | 'abort' | 'release' | 'complete'

type AttributeMap = Record<string, AttributeValue>

type FailureDetails = {
  readonly message?: string
  readonly attributes: AttributeMap
}

export type ShutdownTelemetryOptions = {
  readonly mode: ShutdownTelemetryMode
  readonly recordFailures: boolean
  readonly rootContext: Context
  readonly startSpan: (
    name: string,
    attributes: AttributeMap,
    parentContext: Context | undefined
  ) => Span | undefined
  readonly makeAttributes: (
    event: RuntimeShutdownEvent,
    phase: ShutdownPhase,
    durationMs: number | undefined
  ) => AttributeMap
  readonly getFailureDetails: (cause: unknown) => FailureDetails | undefined
}

type ShutdownState = {
  readonly reason: RuntimeShutdownReason
  starting: boolean
  span: Span | undefined
  readonly phaseSpans: Map<ShutdownPhase, Span>
  readonly phaseStartedAt: Map<ShutdownPhase, number>
  readonly pendingPhaseEnds: Map<ShutdownPhase, RuntimeShutdownEvent>
  readonly pendingEvents: RuntimeShutdownEvent[]
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Optional tracer methods are an opaque host boundary.
const callSpan = (operation: () => unknown): void => {
  try {
    void Promise.resolve(operation()).catch(() => {})
  } catch {
    // Optional tracer boundaries must not affect Runtime control flow.
  }
}

const readMonotonicTime = (): number => {
  try {
    return performance.now()
  } catch {
    return Date.now()
  }
}

const boundedDuration = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(value, 2 ** 31 - 1)
    : undefined

const phaseOf = (phase: RuntimeShutdownEvent['phase']): ShutdownPhase => {
  switch (phase) {
    case 'shutdown-requested':
      return 'requested'
    case 'quiesce-start':
    case 'quiesce-end':
      return 'quiesce'
    case 'drain-start':
    case 'drain-end':
      return 'drain'
    case 'abort-active':
      return 'abort'
    case 'release-start':
    case 'release-end':
      return 'release'
    case 'shutdown-complete':
    case 'shutdown-failure':
      return 'complete'
  }
}

const eventName = (phase: ShutdownPhase): string => `better-effect.shutdown.${phase}`

const isStart = (phase: RuntimeShutdownEvent['phase']): boolean =>
  phase === 'quiesce-start' || phase === 'drain-start' || phase === 'release-start'

const isEnd = (phase: RuntimeShutdownEvent['phase']): boolean =>
  phase === 'quiesce-end' || phase === 'drain-end' || phase === 'release-end'

const isTerminal = (phase: RuntimeShutdownEvent['phase']): boolean =>
  phase === 'shutdown-complete' || phase === 'shutdown-failure'

const finishSpan = (
  span: Span,
  status: 'success' | 'failure',
  details: FailureDetails | undefined
): void => {
  callSpan(() =>
    span.setStatus({
      code: status === 'failure' ? SpanStatusCode.ERROR : SpanStatusCode.OK
    })
  )

  if (details !== undefined) {
    const message = details.message

    if (message !== undefined) {
      callSpan(() => span.recordException(message))
    }

    if (Object.keys(details.attributes).length > 0) {
      callSpan(() => span.addEvent('better-effect.failure', details.attributes))
    }
  }

  callSpan(() => span.end())
}

/** Internal shutdown state machine for the OpenTelemetry Runtime observer. */
export class ShutdownTelemetry {
  private readonly states = new Map<RuntimeShutdownReason, ShutdownState>()

  private disposed = false

  constructor(private readonly options: ShutdownTelemetryOptions) {}

  onEvent(event: RuntimeShutdownEvent): void {
    if (this.disposed || this.options.mode === 'off') {
      return
    }

    if (event.phase === 'shutdown-requested') {
      this.start(event)
      return
    }

    const state = this.states.get(event.reason)

    if (state === undefined) {
      return
    }

    if (state.span === undefined && state.starting) {
      state.pendingEvents.push(event)
      return
    }

    if (state.span === undefined && isTerminal(event.phase)) {
      this.states.delete(event.reason)
      state.pendingEvents.length = 0
      return
    }

    if (state.span !== undefined) {
      this.process(state, event)
    }
  }

  private start(event: RuntimeShutdownEvent): void {
    if (this.states.has(event.reason)) {
      return
    }

    const state: ShutdownState = {
      reason: event.reason,
      starting: true,
      span: undefined,
      phaseSpans: new Map(),
      phaseStartedAt: new Map(),
      pendingPhaseEnds: new Map(),
      pendingEvents: []
    }
    this.states.set(event.reason, state)

    const span = this.options.startSpan(
      'better-effect.shutdown',
      this.options.makeAttributes(event, 'requested', undefined),
      this.options.rootContext
    )

    if (!this.states.has(event.reason)) {
      if (span !== undefined) {
        callSpan(() => span.end())
      }

      return
    }

    state.starting = false
    state.span = span

    if (span !== undefined) {
      this.addEvent(state, event)
    }

    const pendingEvents = state.pendingEvents.splice(0)

    for (const pendingEvent of pendingEvents) {
      this.process(state, pendingEvent)
    }
  }

  private process(state: ShutdownState, event: RuntimeShutdownEvent): void {
    const phase = phaseOf(event.phase)

    if (isStart(event.phase)) {
      this.startPhase(state, event, phase)
      return
    }

    if (isEnd(event.phase)) {
      if (!state.phaseStartedAt.has(phase)) {
        return
      }

      if (this.options.mode === 'spans' && !state.phaseSpans.has(phase)) {
        state.pendingPhaseEnds.set(phase, event)
        return
      }

      this.finishPhase(state, event, phase)
      return
    }

    if (event.phase === 'abort-active') {
      if (state.phaseStartedAt.has('abort')) {
        return
      }

      state.phaseStartedAt.set('abort', readMonotonicTime())

      if (this.options.mode === 'events') {
        this.addEvent(state, event)
        state.phaseStartedAt.delete('abort')
      } else {
        const span = this.startPhaseSpan(state, event, 'abort')

        if (span !== undefined) {
          state.phaseStartedAt.delete('abort')
          finishSpan(span, 'success', undefined)
        }
      }

      return
    }

    if (isTerminal(event.phase)) {
      this.finish(state, event)
    }
  }

  private startPhase(
    state: ShutdownState,
    event: RuntimeShutdownEvent,
    phase: ShutdownPhase
  ): void {
    if (state.phaseStartedAt.has(phase)) {
      return
    }

    state.phaseStartedAt.set(phase, readMonotonicTime())

    if (this.options.mode === 'events') {
      this.addEvent(state, event)
      return
    }

    const span = this.startPhaseSpan(state, event, phase)

    if (!this.states.has(state.reason)) {
      if (span !== undefined) {
        callSpan(() => span.end())
      }

      return
    }

    if (span !== undefined) {
      state.phaseSpans.set(phase, span)
      const pendingEnd = state.pendingPhaseEnds.get(phase)

      if (pendingEnd !== undefined) {
        state.pendingPhaseEnds.delete(phase)
        this.finishPhase(state, pendingEnd, phase)
      }
    }
  }

  private startPhaseSpan(
    state: ShutdownState,
    event: RuntimeShutdownEvent,
    phase: ShutdownPhase
  ): Span | undefined {
    let parent = this.options.rootContext

    if (state.span !== undefined) {
      try {
        parent = trace.setSpan(this.options.rootContext, state.span)
      } catch {
        parent = this.options.rootContext
      }
    }

    return this.options.startSpan(
      eventName(phase),
      this.options.makeAttributes(event, phase, undefined),
      parent
    )
  }

  private addEvent(
    state: ShutdownState,
    event: RuntimeShutdownEvent,
    durationMsOverride?: number
  ): void {
    const span = state.span

    if (span === undefined) {
      return
    }

    const phase = phaseOf(event.phase)
    const startedAt = state.phaseStartedAt.get(phase)
    const durationMs =
      durationMsOverride ??
      (startedAt === undefined ? undefined : Math.max(0, readMonotonicTime() - startedAt))
    callSpan(() =>
      span.addEvent(eventName(phase), this.options.makeAttributes(event, phase, durationMs))
    )
  }

  private finishPhase(
    state: ShutdownState,
    event: RuntimeShutdownEvent,
    phase: ShutdownPhase
  ): void {
    const span = state.phaseSpans.get(phase)
    const startedAt = state.phaseStartedAt.get(phase)
    const durationMs =
      startedAt === undefined ? event.durationMs : Math.max(0, readMonotonicTime() - startedAt)
    state.phaseSpans.delete(phase)
    state.phaseStartedAt.delete(phase)
    state.pendingPhaseEnds.delete(phase)

    if (this.options.mode === 'events') {
      this.addEvent(state, event, durationMs)
      return
    }

    if (span !== undefined) {
      callSpan(() =>
        span.setAttribute('better_effect.duration_ms', boundedDuration(durationMs) ?? 0)
      )
      finishSpan(span, 'success', undefined)
    }
  }

  private finish(state: ShutdownState, event: RuntimeShutdownEvent): void {
    if (this.states.get(state.reason) !== state) {
      return
    }

    // Claim the Runtime shutdown before invoking tracer code.
    this.states.delete(state.reason)
    const status = event.phase === 'shutdown-failure' ? 'failure' : 'success'
    const details =
      status === 'failure' && this.options.recordFailures
        ? this.options.getFailureDetails(event.error)
        : undefined

    for (const span of state.phaseSpans.values()) {
      callSpan(() => span.end())
    }
    state.phaseSpans.clear()
    state.phaseStartedAt.clear()
    state.pendingPhaseEnds.clear()
    state.pendingEvents.length = 0

    if (state.span === undefined) {
      return
    }

    this.addEvent(state, event)
    finishSpan(state.span, status, details)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    const pending = [...this.states.values()]
    this.states.clear()

    for (const state of pending) {
      for (const span of state.phaseSpans.values()) {
        callSpan(() => span.end())
      }

      if (state.span !== undefined) {
        callSpan(() => state.span!.end())
      }
    }
  }
}
