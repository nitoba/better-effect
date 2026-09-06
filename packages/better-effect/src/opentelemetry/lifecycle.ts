import { SpanStatusCode, type AttributeValue, type Context, type Span } from '@opentelemetry/api'

import type {
  RuntimeLifecycleEndEvent,
  RuntimeLifecycleEventMetadata,
  RuntimeLifecycleReleaseEvent,
  RuntimeLifecycleStartEvent
} from '../runtime/observer'

/** Controls how lifecycle-only Layer entries are represented in telemetry. */
export type LifecycleTelemetryMode = 'off' | 'events' | 'spans'

export type LifecyclePhase = 'activate' | 'release'

type AttributeMap = Record<string, AttributeValue>

type FailureDetails = {
  readonly message?: string
  readonly attributes: AttributeMap
}

export type LifecycleTelemetryOptions = {
  readonly mode: LifecycleTelemetryMode
  readonly recordFailures: boolean
  readonly getParentContext: () => Context
  readonly startSpan: (
    name: string,
    attributes: AttributeMap,
    parentContext: Context | undefined
  ) => Span | undefined
  readonly makeAttributes: (
    event: RuntimeLifecycleEventMetadata,
    phase: LifecyclePhase,
    outcome: 'success' | 'failure' | undefined,
    durationMs: number | undefined
  ) => AttributeMap
  readonly getFailureDetails: (cause: unknown) => FailureDetails | undefined
}

type LifecycleState = {
  readonly lifecycleId: symbol
  readonly startedAt: number
  readonly parentContext: Context
  starting: boolean
  carrier: Span | undefined
  activationSpan: Span | undefined
  activationEnded: boolean
  activationReported: boolean
  pendingActivationEnd: RuntimeLifecycleEndEvent | undefined
}

const readMonotonicTime = (): number => {
  try {
    return performance.now()
  } catch {
    return Date.now()
  }
}

const eventName = (phase: LifecyclePhase): string => `better-effect.lifecycle.${phase}`

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Optional tracer methods are an opaque host boundary.
const callSpan = (operation: () => unknown): void => {
  try {
    void Promise.resolve(operation()).catch(() => {})
  } catch {
    // Optional tracer boundaries must not affect Runtime control flow.
  }
}

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

type FailureCause = Parameters<LifecycleTelemetryOptions['getFailureDetails']>[0]

const failureCause = (
  event: RuntimeLifecycleEndEvent | RuntimeLifecycleReleaseEvent
): FailureCause => {
  if (event.error !== undefined) {
    return event.error
  }

  return event.outcome.status === 'failure' ? event.outcome.cause : undefined
}

const eventStatus = (
  event: RuntimeLifecycleEndEvent | RuntimeLifecycleReleaseEvent
): 'success' | 'failure' =>
  'error' in event && event.error !== undefined ? 'failure' : event.outcome.status

/** Internal lifecycle state machine for the OpenTelemetry Runtime observer. */
export class LifecycleTelemetry {
  private readonly states = new Map<symbol, LifecycleState>()

  private disposed = false

  constructor(private readonly options: LifecycleTelemetryOptions) {}

  onStart(event: RuntimeLifecycleStartEvent): void {
    if (this.disposed || this.options.mode === 'off' || this.states.has(event.lifecycleId)) {
      return
    }

    const state: LifecycleState = {
      lifecycleId: event.lifecycleId,
      startedAt: readMonotonicTime(),
      parentContext: this.options.getParentContext(),
      starting: true,
      carrier: undefined,
      activationSpan: undefined,
      activationEnded: false,
      activationReported: false,
      pendingActivationEnd: undefined
    }
    this.states.set(event.lifecycleId, state)

    const span = this.options.startSpan(
      this.options.mode === 'events' ? 'better-effect.lifecycle' : eventName('activate'),
      this.options.makeAttributes(event, 'activate', undefined, undefined),
      state.parentContext
    )

    if (!this.states.has(event.lifecycleId)) {
      if (span !== undefined) {
        callSpan(() => span.end())
      }

      return
    }

    state.starting = false

    if (this.options.mode === 'events') {
      state.carrier = span

      if (span !== undefined) {
        callSpan(() =>
          span.addEvent(
            eventName('activate'),
            this.options.makeAttributes(event, 'activate', undefined, undefined)
          )
        )
      }
    } else {
      state.activationSpan = span
    }

    const pendingEnd = state.pendingActivationEnd

    if (pendingEnd !== undefined) {
      state.pendingActivationEnd = undefined
      this.onEnd(pendingEnd)
    }
  }

  onEnd(event: RuntimeLifecycleEndEvent): void {
    if (this.options.mode === 'off') {
      return
    }

    const state = this.states.get(event.lifecycleId)

    if (state === undefined || state.activationReported) {
      return
    }

    const durationMs = Math.max(0, readMonotonicTime() - state.startedAt)
    const status = eventStatus(event)

    if (this.options.mode === 'events') {
      const span = state.carrier

      if (span === undefined) {
        if (state.starting) {
          state.pendingActivationEnd = event
          return
        }

        state.activationReported = true

        if (status === 'failure') {
          this.states.delete(event.lifecycleId)
        }

        return
      }

      state.activationReported = true
      state.activationEnded = true

      if (status === 'failure') {
        this.states.delete(event.lifecycleId)
      }

      callSpan(() =>
        span.addEvent(
          eventName('activate'),
          this.options.makeAttributes(event, 'activate', status, durationMs)
        )
      )

      if (status === 'failure' && this.options.recordFailures) {
        const details = this.options.getFailureDetails(failureCause(event))

        if (details !== undefined) {
          finishDetails(span, details)
        }
      }

      if (status === 'failure') {
        callSpan(() => span.setStatus({ code: SpanStatusCode.ERROR }))
        callSpan(() => span.end())
      }

      return
    }

    const span = state.activationSpan

    if (span === undefined) {
      if (state.starting) {
        state.pendingActivationEnd = event
        return
      }

      state.activationReported = true

      if (status === 'failure') {
        this.states.delete(event.lifecycleId)
      }

      return
    }

    state.activationReported = true

    if (status === 'failure') {
      this.states.delete(event.lifecycleId)
    }

    state.activationEnded = true
    finishSpan(
      span,
      status,
      status === 'failure' && this.options.recordFailures
        ? this.options.getFailureDetails(failureCause(event))
        : undefined
    )
  }

  onRelease(event: RuntimeLifecycleReleaseEvent): void {
    if (this.options.mode === 'off') {
      return
    }

    const state = this.states.get(event.lifecycleId)

    if (state === undefined) {
      return
    }

    this.states.delete(event.lifecycleId)
    const status = eventStatus(event)
    const attributes = this.options.makeAttributes(event, 'release', status, undefined)
    const details =
      status === 'failure' && this.options.recordFailures
        ? this.options.getFailureDetails(failureCause(event))
        : undefined

    if (this.options.mode === 'events') {
      if (state.carrier === undefined) {
        return
      }

      callSpan(() => state.carrier!.addEvent(eventName('release'), attributes))

      if (details !== undefined) {
        finishDetails(state.carrier, details)
      }

      finishSpan(state.carrier, status, undefined)
      return
    }

    const span = this.options.startSpan(eventName('release'), attributes, state.parentContext)

    if (span !== undefined) {
      finishSpan(span, status, details)
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    const pending = [...this.states.values()]
    this.states.clear()

    for (const state of pending) {
      if (state.carrier !== undefined) {
        callSpan(() => state.carrier!.end())
      }

      if (state.activationSpan !== undefined && !state.activationEnded) {
        callSpan(() => state.activationSpan!.end())
      }
    }
  }
}

const finishDetails = (span: Span, details: FailureDetails): void => {
  const message = details.message

  if (message !== undefined) {
    callSpan(() => span.recordException(message))
  }

  if (Object.keys(details.attributes).length > 0) {
    callSpan(() => span.addEvent('better-effect.failure', details.attributes))
  }
}
