import {
  context,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type AttributeValue,
  type Context,
  type Span,
  type Tracer,
  type TracerProvider
} from '@opentelemetry/api'

import type {
  RuntimeExecutionAttributes,
  RuntimeExecutionEndEvent,
  RuntimeExecutionStartEvent,
  RuntimeObserver,
  RuntimeResourceReleaseEvent,
  RuntimeServiceAcquireEvent,
  RuntimeServiceResolveEvent
} from '../runtime/observer'

/** Controls how Service lifecycle events are represented in telemetry. */
export type ServiceTelemetryMode = 'off' | 'events' | 'spans'

/** Attribute values accepted by the OpenTelemetry adapter. */
export type OpenTelemetryAttributes = Readonly<Record<string, AttributeValue>>

/** A deliberately small, already-sanitized failure representation. */
export type OpenTelemetryFailure =
  | string
  | {
      readonly message?: string
      readonly attributes?: OpenTelemetryAttributes
    }

/** Select safe execution attributes explicitly before they reach a span. */
export type OpenTelemetryExecutionAttributesSanitizer = (
  attributes: RuntimeExecutionAttributes
) => OpenTelemetryAttributes | undefined

/** Select safe failure details explicitly before they reach a span. */
export type OpenTelemetryFailureSanitizer = (cause: unknown) => OpenTelemetryFailure | undefined

type OpenTelemetryRuntimeObserverBaseOptions = {
  /** Use an existing tracer. The adapter never registers a global provider. */
  readonly tracer?: Tracer
  /** Resolve a tracer from an existing provider without registering it globally. */
  readonly provider?: TracerProvider
  /** Tracer name used only when `provider` is supplied. */
  readonly tracerName?: string
  /** Optional instrumentation version used only when `provider` is supplied. */
  readonly tracerVersion?: string
  /** Service resolution policy. Defaults to `off`. */
  readonly serviceResolution?: ServiceTelemetryMode
  /** Record explicitly sanitized failure details in addition to setting status. */
  readonly recordFailures?: boolean
  /** Explicitly sanitize arbitrary execution attributes. */
  readonly sanitizeExecutionAttributes?: OpenTelemetryExecutionAttributesSanitizer
  /** Copy only these execution attribute keys, dropping unsupported values. */
  readonly executionAttributeAllowlist?: readonly string[]
  /** Explicitly sanitize a failure before recording it. */
  readonly sanitizeFailure?: OpenTelemetryFailureSanitizer
  /** Maximum length for attribute keys and string values. Defaults to 256. */
  readonly maxAttributeLength?: number
  /** Maximum number of copied execution or failure attributes. Defaults to 32. */
  readonly maxAttributeCount?: number
  /** Maximum number of Service tags retained in a resolution path. Defaults to 16. */
  readonly maxResolutionPathLength?: number
}

/** Configuration for an observer backed by an existing OpenTelemetry tracer/provider. */
export type OpenTelemetryRuntimeObserverOptions =
  | (OpenTelemetryRuntimeObserverBaseOptions & {
      readonly tracer: Tracer
      readonly provider?: never
    })
  | (OpenTelemetryRuntimeObserverBaseOptions & {
      readonly provider: TracerProvider
      readonly tracer?: never
    })

const DEFAULT_TRACER_NAME = 'better-effect'
const DEFAULT_EXECUTION_SPAN_NAME = 'better-effect.execution'
const DEFAULT_SERVICE_SPAN_NAME = 'better-effect.service'
const DEFAULT_MAX_ATTRIBUTE_LENGTH = 256
const DEFAULT_MAX_ATTRIBUTE_COUNT = 32
const DEFAULT_MAX_RESOLUTION_PATH_LENGTH = 16
const MAX_ATTRIBUTE_LENGTH = 4096
const MAX_ATTRIBUTE_COUNT = 128
const MAX_RESOLUTION_PATH_LENGTH = 128
const MAX_ARRAY_LENGTH = 16

const EXECUTION_ID_ATTRIBUTE = 'better_effect.execution_id'
const PROGRAM_NAME_ATTRIBUTE = 'better_effect.program_name'
const OUTCOME_ATTRIBUTE = 'better_effect.outcome'
const SERVICE_TAG_ATTRIBUTE = 'better_effect.service_tag'
const RESOLUTION_PATH_ATTRIBUTE = 'better_effect.resolution_path'
const RESOLUTION_PATH_TRUNCATED_ATTRIBUTE = 'better_effect.resolution_path_truncated'
const LIBRARY_ATTRIBUTE = 'better_effect.library'
const FAILURE_EVENT_NAME = 'better-effect.failure'

type AttributeMap = Record<string, AttributeValue>

type Limits = {
  readonly maxAttributeLength: number
  readonly maxAttributeCount: number
  readonly maxResolutionPathLength: number
}

type FailureDetails = {
  message?: string
  readonly attributes: AttributeMap
}

type ExecutionSpan = {
  readonly executionId: string
  span?: Span
  executionContext?: Context
  pendingEnd?: RuntimeExecutionEndEvent
  ended: boolean
}

type StartedExecutionSpan = ExecutionSpan & {
  readonly span: Span
}

type ActiveExecutionSpan = StartedExecutionSpan & {
  readonly executionContext: Context
}

type ServiceEvent =
  | RuntimeServiceResolveEvent
  | RuntimeServiceAcquireEvent
  | RuntimeResourceReleaseEvent

type ServiceEventStatus = 'success' | 'failure'

type ExecutionEventStatus = 'success' | 'failure'

const serviceEventStatus = (event: ServiceEvent): ServiceEventStatus =>
  'error' in event && event.error !== undefined ? 'failure' : event.outcome.status

const executionEventStatus = (event: RuntimeExecutionEndEvent): ExecutionEventStatus =>
  event.cleanupFailure !== undefined ? 'failure' : event.outcome.status

const isStartedExecutionSpan = (execution: ExecutionSpan): execution is StartedExecutionSpan =>
  execution.span !== undefined

const isActiveExecutionSpan = (execution: ExecutionSpan): execution is ActiveExecutionSpan =>
  isStartedExecutionSpan(execution) && execution.executionContext !== undefined

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- This private guard validates untrusted values before scalar validation.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the external value before reading it.
  typeof value === 'object' && value !== null && !Array.isArray(value)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- OTel is an optional runtime peer and must be checked defensively.
const isSpan = (value: unknown): value is Span =>
  isRecord(value) &&
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- OTel is an optional runtime peer and must be checked defensively.
  typeof value.end === 'function'

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- OTel is an optional runtime peer and must be checked defensively.
const isTracer = (value: unknown): value is Tracer =>
  isRecord(value) &&
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- OTel is an optional runtime peer and must be checked defensively.
  typeof value.startSpan === 'function'

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Sanitizers and observer events are external diagnostic boundaries.
const boundedString = (value: unknown, limit: number): string | undefined =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Only primitive strings are copied into OTel attributes.
  typeof value === 'string' ? value.slice(0, limit) : undefined

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Event names and Service tags are validated at this boundary.
const boundedNonEmptyString = (value: unknown, limit: number): string | undefined => {
  const text = boundedString(value, limit)
  return text === undefined || text.length === 0 ? undefined : text
}

const normalizeLimit = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string
): number => {
  if (value === undefined) {
    return fallback
  }

  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`)
  }

  return value
}

const normalizeLimits = (options: OpenTelemetryRuntimeObserverBaseOptions): Limits => ({
  maxAttributeLength: normalizeLimit(
    options.maxAttributeLength,
    DEFAULT_MAX_ATTRIBUTE_LENGTH,
    MAX_ATTRIBUTE_LENGTH,
    'maxAttributeLength'
  ),
  maxAttributeCount: normalizeLimit(
    options.maxAttributeCount,
    DEFAULT_MAX_ATTRIBUTE_COUNT,
    MAX_ATTRIBUTE_COUNT,
    'maxAttributeCount'
  ),
  maxResolutionPathLength: normalizeLimit(
    options.maxResolutionPathLength,
    DEFAULT_MAX_RESOLUTION_PATH_LENGTH,
    MAX_RESOLUTION_PATH_LENGTH,
    'maxResolutionPathLength'
  )
})

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Normalize callback output before it reaches the OTel API.
const normalizeStringArray = (values: readonly unknown[], limit: number): string[] | undefined => {
  const normalized: string[] = []
  const length = Math.min(values.length, MAX_ARRAY_LENGTH)

  for (let index = 0; index < length; index += 1) {
    const value = values[index]

    if (value === undefined || value === null) {
      continue
    }

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Accept only OTel string-array values.
    if (typeof value !== 'string') {
      return undefined
    }

    normalized.push(value.slice(0, limit))
  }

  return normalized
}

const normalizeNumberArray = (values: readonly unknown[]): number[] | undefined => {
  const normalized: number[] = []
  const length = Math.min(values.length, MAX_ARRAY_LENGTH)
  normalized.length = length

  for (let index = 0; index < length; index += 1) {
    if (!(index in values)) {
      continue
    }

    const value = values[index]

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Accept only finite OTel number-array values.
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined
    }

    normalized[index] = value
  }

  return normalized
}

const normalizeBooleanArray = (values: readonly unknown[]): boolean[] | undefined => {
  const normalized: boolean[] = []
  const length = Math.min(values.length, MAX_ARRAY_LENGTH)
  normalized.length = length

  for (let index = 0; index < length; index += 1) {
    if (!(index in values)) {
      continue
    }

    const value = values[index]

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Accept only OTel boolean-array values.
    if (typeof value !== 'boolean') {
      return undefined
    }

    normalized[index] = value
  }

  return normalized
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Normalize explicit sanitizer and allowlist output.
const normalizeAttributeValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Normalize explicit sanitizer and allowlist output.
  value: unknown,
  maxAttributeLength: number
): AttributeValue | undefined => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Copy only OTel scalar strings.
  if (typeof value === 'string') {
    return value.slice(0, maxAttributeLength)
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Copy only finite OTel scalar numbers.
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Copy only OTel scalar booleans.
  if (typeof value === 'boolean') {
    return value
  }

  if (!Array.isArray(value) || value.length === 0) {
    return undefined
  }

  return (
    normalizeStringArray(value, maxAttributeLength) ??
    normalizeNumberArray(value) ??
    normalizeBooleanArray(value)
  )
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-known-value-widening -- Validate sanitizer output into the private OTel attribute owner.
const normalizeAttributes = (value: unknown, limits: Limits): AttributeMap => {
  const result: AttributeMap = {}
  let inspected = 0
  let normalizedCount = 0

  if (!isRecord(value)) {
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- Return the private validated OTel attribute owner.
    return result
  }

  for (const key in value) {
    if (inspected >= limits.maxAttributeCount) {
      break
    }

    inspected += 1

    if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
      continue
    }

    if (key.length === 0 || key.length > limits.maxAttributeLength) {
      continue
    }

    let normalized: AttributeValue | undefined

    try {
      normalized = normalizeAttributeValue(value[key], limits.maxAttributeLength)
    } catch {
      continue
    }

    if (normalized !== undefined) {
      result[key] = normalized
      normalizedCount += 1

      if (normalizedCount >= limits.maxAttributeCount) {
        break
      }
    }
  }

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Return the private validated OTel attribute owner.
  return result
}

const selectAllowlistedAttributes = (
  source: RuntimeExecutionAttributes | undefined,
  allowlist: readonly string[] | undefined,
  limits: Limits
): AttributeMap => {
  if (source === undefined || allowlist === undefined) {
    return {}
  }

  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Values are parsed immediately by normalizeAttributes.
  const selected: Record<string, unknown> = {}
  const length = Math.min(allowlist.length, limits.maxAttributeCount)
  let selectedCount = 0

  for (let index = 0; index < length; index += 1) {
    const key = allowlist[index]

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject malformed JavaScript allowlist entries before reading source attributes.
    if (typeof key !== 'string' || key.length === 0 || key.length > limits.maxAttributeLength) {
      continue
    }

    try {
      if (!(key in selected)) {
        selectedCount += 1
      }

      selected[key] = source[key]
    } catch {
      // A hostile getter is an unusable optional attribute, not a Runtime failure.
    }

    if (selectedCount >= limits.maxAttributeCount) {
      break
    }
  }

  return normalizeAttributes(selected, limits)
}

const makeExecutionAttributes = (
  event: RuntimeExecutionStartEvent,
  options: OpenTelemetryRuntimeObserverBaseOptions,
  limits: Limits
): AttributeMap => {
  const result = selectAllowlistedAttributes(
    event.attributes,
    options.executionAttributeAllowlist,
    limits
  )

  if (event.attributes !== undefined && options.sanitizeExecutionAttributes !== undefined) {
    try {
      const sanitized = options.sanitizeExecutionAttributes(event.attributes)
      ignoreRejection(sanitized)
      Object.assign(result, normalizeAttributes(sanitized, limits))
    } catch {
      // Sanitizers are optional diagnostics and cannot affect execution telemetry.
    }
  }

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Return the private validated OTel attribute owner.
  return result
}

const makeFailureDetails = (
  cause: unknown,
  sanitizer: OpenTelemetryFailureSanitizer | undefined,
  limits: Limits
): FailureDetails | undefined => {
  if (sanitizer === undefined) {
    return undefined
  }

  let sanitized: OpenTelemetryFailure | undefined

  try {
    sanitized = sanitizer(cause)
    ignoreRejection(sanitized)
  } catch {
    return undefined
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- A sanitizer may explicitly return a safe string message.
  if (typeof sanitized === 'string') {
    return {
      message: sanitized.slice(0, limits.maxAttributeLength),
      attributes: {}
    }
  }

  if (!isRecord(sanitized)) {
    return undefined
  }

  let message: string | undefined
  let attributes: unknown

  try {
    message = boundedString(sanitized.message, limits.maxAttributeLength)
    attributes = sanitized.attributes
  } catch {
    return undefined
  }

  let normalizedAttributes: AttributeMap

  try {
    normalizedAttributes = normalizeAttributes(attributes, limits)
  } catch {
    return undefined
  }

  const details: FailureDetails = {
    attributes: normalizedAttributes
  }

  if (message !== undefined) {
    details.message = message
  }

  return details
}

const mergeAdditionalAttributes = (
  target: AttributeMap,
  additional: AttributeMap,
  limit: number
): void => {
  for (const [key, value] of Object.entries(additional)) {
    if (Object.keys(target).length >= limit) {
      break
    }

    if (!(key in target)) {
      target[key] = value
    }
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Suppress rejected thenables from optional tracer and sanitizer boundaries.
const ignoreRejection = (value: unknown): void => {
  try {
    void Promise.resolve(value).catch(() => {})
  } catch {
    // A malformed thenable is still outside Runtime control flow.
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- Optional OTel methods are typed void but hostile implementations may return thenables.
const callSpan = (operation: () => unknown): void => {
  try {
    ignoreRejection(operation())
  } catch {
    // A tracer is an optional boundary and must never affect Runtime control flow.
  }
}

const addFailureDetails = (span: Span, details: FailureDetails): void => {
  const message = details.message

  if (message !== undefined) {
    callSpan(() => span.recordException(message))
  }

  if (Object.keys(details.attributes).length > 0) {
    callSpan(() => span.addEvent(FAILURE_EVENT_NAME, details.attributes))
  }
}

const addAttribute = (
  target: AttributeMap,
  key: string,
  value: AttributeValue,
  limit: number
): void => {
  if (key in target || Object.keys(target).length < limit) {
    target[key] = value
  }
}

const makeExecutionSpanAttributes = (
  event: RuntimeExecutionStartEvent,
  options: OpenTelemetryRuntimeObserverBaseOptions,
  limits: Limits
) => {
  const attributes: AttributeMap = {}
  const executionId = boundedNonEmptyString(event.executionId, limits.maxAttributeLength)
  const name = boundedNonEmptyString(event.name, limits.maxAttributeLength)

  if (executionId !== undefined) {
    addAttribute(attributes, EXECUTION_ID_ATTRIBUTE, executionId, limits.maxAttributeCount)
  }

  if (name !== undefined) {
    addAttribute(attributes, PROGRAM_NAME_ATTRIBUTE, name, limits.maxAttributeCount)
  }

  addAttribute(attributes, LIBRARY_ATTRIBUTE, 'better-effect', limits.maxAttributeCount)
  mergeAdditionalAttributes(
    attributes,
    makeExecutionAttributes(event, options, limits),
    limits.maxAttributeCount
  )

  return attributes
}

const makeResolutionPathAttributes = (
  path: readonly { readonly serviceTag: string }[],
  limits: Limits
): AttributeMap => {
  const tags: string[] = []

  for (const service of path.slice(0, limits.maxResolutionPathLength)) {
    const tag = boundedNonEmptyString(service.serviceTag, limits.maxAttributeLength)

    if (tag !== undefined) {
      tags.push(tag)
    }
  }

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- This map owns validated Service path attributes.
  const result: AttributeMap = {}

  if (tags.length > 0) {
    result[RESOLUTION_PATH_ATTRIBUTE] = tags
  }

  if (path.length > limits.maxResolutionPathLength) {
    result[RESOLUTION_PATH_TRUNCATED_ATTRIBUTE] = true
  }

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Return the private validated Service path attribute owner.
  return result
}

const makeServiceEventAttributes = (
  event: ServiceEvent,
  limits: Limits,
  executionId: string | undefined
): AttributeMap => {
  const serviceTag = boundedNonEmptyString(event.service.serviceTag, limits.maxAttributeLength)
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- This map owns validated Service event attributes.
  const attributes: AttributeMap = {}

  if (serviceTag !== undefined) {
    addAttribute(attributes, SERVICE_TAG_ATTRIBUTE, serviceTag, limits.maxAttributeCount)
  }

  addAttribute(attributes, OUTCOME_ATTRIBUTE, serviceEventStatus(event), limits.maxAttributeCount)

  if ('resolutionPath' in event) {
    mergeAdditionalAttributes(
      attributes,
      makeResolutionPathAttributes(event.resolutionPath, limits),
      limits.maxAttributeCount
    )
  }

  if (executionId !== undefined) {
    addAttribute(attributes, EXECUTION_ID_ATTRIBUTE, executionId, limits.maxAttributeCount)
  }

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Return the private validated Service event attribute owner.
  return attributes
}

const readActiveContext = (): Context | undefined => {
  try {
    return context.active()
  } catch {
    return undefined
  }
}

const setSpanInContext = (parent: Context, span: Span): Context | undefined => {
  try {
    return trace.setSpan(parent, span)
  } catch {
    return undefined
  }
}

const resolveTracer = (options: OpenTelemetryRuntimeObserverOptions): Tracer => {
  const hasTracer = options.tracer !== undefined
  const hasProvider = options.provider !== undefined

  if (hasTracer === hasProvider) {
    throw new TypeError('OpenTelemetryRuntimeObserver requires exactly one tracer or provider')
  }

  if (hasTracer) {
    if (!isTracer(options.tracer)) {
      throw new TypeError('OpenTelemetryRuntimeObserver requires a tracer with startSpan')
    }

    return options.tracer
  }

  if (hasProvider) {
    const tracerName = options.tracerName ?? DEFAULT_TRACER_NAME
    const tracer = options.provider.getTracer(tracerName, options.tracerVersion)

    if (!isTracer(tracer)) {
      throw new TypeError('OpenTelemetry provider did not return a tracer with startSpan')
    }

    return tracer
  }

  throw new TypeError('OpenTelemetryRuntimeObserver requires an existing tracer or provider')
}

/**
 * Best-effort RuntimeObserver adapter for an existing OpenTelemetry tracer.
 *
 * The adapter never installs a global provider, SDK, context manager, or
 * exporter. All observer hooks are synchronous and isolate tracer failures.
 */
export class OpenTelemetryRuntimeObserver implements RuntimeObserver {
  private readonly tracer: Tracer

  private readonly options: OpenTelemetryRuntimeObserverBaseOptions

  private readonly limits: Limits

  private readonly executionSpans = new Map<string, ExecutionSpan>()

  private readonly serviceResolution: ServiceTelemetryMode

  private readonly recordFailures: boolean

  private disposed = false

  constructor(options: OpenTelemetryRuntimeObserverOptions) {
    this.tracer = resolveTracer(options)
    this.options = options
    this.limits = normalizeLimits(options)
    this.serviceResolution = options.serviceResolution ?? 'off'
    this.recordFailures = options.recordFailures === true

    if (!['off', 'events', 'spans'].includes(this.serviceResolution)) {
      throw new TypeError('serviceResolution must be off, events, or spans')
    }
  }

  static make(options: OpenTelemetryRuntimeObserverOptions): OpenTelemetryRuntimeObserver {
    return new OpenTelemetryRuntimeObserver(options)
  }

  readonly onExecutionStart = (event: RuntimeExecutionStartEvent): void => {
    this.safely(() => this.startExecution(event))
  }

  readonly onExecutionEnd = (event: RuntimeExecutionEndEvent): void => {
    this.safely(() => this.endExecution(event))
  }

  readonly onServiceResolve = (event: RuntimeServiceResolveEvent): void => {
    this.safely(() => this.observeService('better-effect.service.resolve', event))
  }

  readonly onServiceAcquire = (event: RuntimeServiceAcquireEvent): void => {
    this.safely(() => this.observeService('better-effect.service.acquire', event))
  }

  readonly onResourceRelease = (event: RuntimeResourceReleaseEvent): void => {
    this.safely(() => this.observeService('better-effect.service.release', event))
  }

  /** End any spans whose malformed or missing end event left them pending. */
  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    const pending = [...this.executionSpans.values()]
    this.executionSpans.clear()

    for (const execution of pending) {
      const span = execution.span

      if (span !== undefined) {
        callSpan(() => span.end())
      }
    }
  }

  [Symbol.dispose](): void {
    this.dispose()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.dispose()
  }

  private safely(operation: () => void): void {
    if (this.disposed) {
      return
    }

    try {
      operation()
    } catch {
      // Keep malformed events and tracer implementations outside Runtime results.
    }
  }

  private startSpan(
    name: string,
    attributes: AttributeMap,
    parentContext: Context | undefined
  ): Span | undefined {
    try {
      const span =
        parentContext === undefined
          ? this.tracer.startSpan(name, { attributes })
          : this.tracer.startSpan(name, { attributes }, parentContext)

      if (!isSpan(span)) {
        ignoreRejection(span)
        return undefined
      }

      return span
    } catch {
      return undefined
    }
  }

  private removeExecution(execution: ExecutionSpan): void {
    if (this.executionSpans.get(execution.executionId) === execution) {
      this.executionSpans.delete(execution.executionId)
    }
  }

  private finishPendingExecution(execution: ExecutionSpan): void {
    if (execution.pendingEnd !== undefined && isActiveExecutionSpan(execution)) {
      this.finishExecution(execution, execution.pendingEnd)
    }
  }

  private startExecution(event: RuntimeExecutionStartEvent): void {
    if (this.executionSpans.has(event.executionId)) {
      return
    }

    // Reserve the ID before calling user tracer code: startSpan may synchronously re-enter this observer.
    const execution: ExecutionSpan = { executionId: event.executionId, ended: false }
    this.executionSpans.set(event.executionId, execution)
    const parentContext = readActiveContext() ?? ROOT_CONTEXT
    let span: Span | undefined

    try {
      span = this.startSpan(
        boundedNonEmptyString(event.name, this.limits.maxAttributeLength) ??
          DEFAULT_EXECUTION_SPAN_NAME,
        makeExecutionSpanAttributes(event, this.options, this.limits),
        parentContext
      )
    } catch {
      this.removeExecution(execution)
      return
    }

    if (span === undefined) {
      this.removeExecution(execution)
      return
    }

    if (this.disposed || this.executionSpans.get(event.executionId) !== execution) {
      callSpan(() => span.end())
      return
    }

    execution.span = span
    const executionContext = setSpanInContext(parentContext, span)

    if (executionContext === undefined) {
      const pendingEnd = execution.pendingEnd
      this.removeExecution(execution)

      if (pendingEnd !== undefined && isStartedExecutionSpan(execution)) {
        this.finishExecution(execution, pendingEnd)
      } else {
        callSpan(() => span.end())
      }

      return
    }

    execution.executionContext = executionContext
    this.finishPendingExecution(execution)
  }

  private endExecution(event: RuntimeExecutionEndEvent): void {
    const execution = this.executionSpans.get(event.executionId)

    if (execution === undefined || execution.ended) {
      return
    }

    execution.ended = true

    if (!isActiveExecutionSpan(execution)) {
      execution.pendingEnd = event
      return
    }

    this.finishExecution(execution, event)
  }

  private finishExecution(execution: StartedExecutionSpan, event: RuntimeExecutionEndEvent): void {
    try {
      const status = executionEventStatus(event)
      callSpan(() => execution.span.setAttribute(OUTCOME_ATTRIBUTE, status))
      callSpan(() =>
        execution.span.setStatus({
          code: status === 'failure' ? SpanStatusCode.ERROR : SpanStatusCode.OK
        })
      )

      if (status === 'failure' && this.recordFailures) {
        const cause =
          event.outcome.status === 'failure' ? event.outcome.cause : event.cleanupFailure
        const details = makeFailureDetails(cause, this.options.sanitizeFailure, this.limits)

        if (details !== undefined) {
          addFailureDetails(execution.span, details)
        }
      }
    } finally {
      callSpan(() => execution.span.end())
      this.executionSpans.delete(execution.executionId)
    }
  }

  private findCorrelatedExecution(event: ServiceEvent): ActiveExecutionSpan | undefined {
    if (event.executionId === undefined) {
      return undefined
    }

    const execution = this.executionSpans.get(event.executionId)
    return execution !== undefined && isActiveExecutionSpan(execution) ? execution : undefined
  }

  private observeService(name: string, event: ServiceEvent): void {
    if (this.serviceResolution === 'off') {
      return
    }

    const execution = this.findCorrelatedExecution(event)
    const executionId = execution === undefined ? undefined : this.findExecutionId(execution)
    const attributes = makeServiceEventAttributes(event, this.limits, executionId)
    let failureCause: unknown

    if ('error' in event && event.error !== undefined) {
      failureCause = event.error
    } else if (event.outcome.status === 'failure') {
      failureCause = event.outcome.cause
    }

    const details =
      serviceEventStatus(event) === 'failure' && this.recordFailures
        ? makeFailureDetails(failureCause, this.options.sanitizeFailure, this.limits)
        : undefined

    if (details?.attributes !== undefined) {
      mergeAdditionalAttributes(attributes, details.attributes, this.limits.maxAttributeCount)
    }

    if (execution !== undefined) {
      this.observeCorrelatedService(name, event, execution, attributes, details)
      return
    }

    this.observeStandaloneService(name, event, attributes, details)
  }

  private findExecutionId(execution: ExecutionSpan): string | undefined {
    return boundedNonEmptyString(execution.executionId, this.limits.maxAttributeLength)
  }

  private observeCorrelatedService(
    name: string,
    event: ServiceEvent,
    execution: ActiveExecutionSpan,
    attributes: AttributeMap,
    details: FailureDetails | undefined
  ): void {
    if (this.serviceResolution === 'events') {
      callSpan(() => execution.span.addEvent(name, attributes))

      if (details !== undefined) {
        addFailureDetails(execution.span, details)
      }

      return
    }

    const span = this.startSpan(name, attributes, execution.executionContext)

    if (span === undefined) {
      return
    }

    this.finishServiceSpan(span, event, details)
  }

  private observeStandaloneService(
    name: string,
    event: ServiceEvent,
    attributes: AttributeMap,
    details: FailureDetails | undefined
  ): void {
    const span = this.startSpan(
      this.serviceResolution === 'events' ? DEFAULT_SERVICE_SPAN_NAME : name,
      attributes,
      ROOT_CONTEXT
    )

    if (span === undefined) {
      return
    }

    if (this.serviceResolution === 'events') {
      callSpan(() => span.addEvent(name, attributes))
    }

    this.finishServiceSpan(span, event, details)
  }

  private finishServiceSpan(
    span: Span,
    event: ServiceEvent,
    details: FailureDetails | undefined
  ): void {
    callSpan(() =>
      span.setStatus({
        code: serviceEventStatus(event) === 'failure' ? SpanStatusCode.ERROR : SpanStatusCode.OK
      })
    )

    if (details !== undefined) {
      addFailureDetails(span, details)
    }

    callSpan(() => span.end())
  }
}
