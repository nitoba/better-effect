import type { Tracer, TracerProvider } from '@opentelemetry/api'
import type { RuntimeExecutionAttributes, RuntimeObserver } from 'better-effect'
import {
  OpenTelemetryRuntimeObserver,
  type OpenTelemetryAttributes,
  type OpenTelemetryFailure,
  type ServiceTelemetryMode
} from 'better-effect/opentelemetry'

declare const tracer: Tracer
declare const provider: TracerProvider
declare const attributes: RuntimeExecutionAttributes

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Expect<Value extends true> = Value

const modes: readonly ServiceTelemetryMode[] = ['off', 'events', 'spans']
const safeAttributes: OpenTelemetryAttributes = {
  requestId: 'request-1',
  retry: 2
}
const safeFailure: OpenTelemetryFailure = {
  message: 'safe failure',
  attributes: safeAttributes
}
const direct = OpenTelemetryRuntimeObserver.make({
  tracer,
  serviceResolution: modes[0],
  executionAttributeAllowlist: ['requestId'],
  sanitizeExecutionAttributes: (input) => {
    const requestId = input.requestId
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Narrow the unknown Runtime attribute before the OTel boundary.
    return typeof requestId === 'string' ? { requestId } : undefined
  },
  sanitizeFailure: () => safeFailure
})
const fromProvider = OpenTelemetryRuntimeObserver.make({
  provider,
  tracerName: 'consumer-fixture',
  tracerVersion: '0.0.0',
  recordFailures: true
})

const _directObserver: RuntimeObserver = direct
const providerObserver: RuntimeObserver = fromProvider

export type DirectObserver = Expect<Equal<typeof direct, OpenTelemetryRuntimeObserver>>
export type ProviderObserver = typeof providerObserver
export type AttributesInput = Expect<Equal<typeof attributes, RuntimeExecutionAttributes>>
