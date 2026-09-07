import { SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api'
import type { HttpError } from './errors'
import type { HttpObserver } from './interceptors'
import type { HttpResponse } from './operation'

/** The stable phases emitted by HTTP instrumentation. */
export type HttpTelemetryPhase =
  | 'admission'
  | 'prepare'
  | 'send'
  | 'headers'
  | 'read'
  | 'validate'
  | 'retry.wait'
  | 'complete'
  | 'error'
  | 'cancel'

export type HttpTelemetryEvent = Readonly<{
  readonly phase: HttpTelemetryPhase
  readonly operationId: string
  readonly attempt?: number
  readonly attributes?: Readonly<Record<string, string | number | boolean>>
}>

export type HttpTelemetryPropagation = Readonly<{
  readonly allowedOrigins?: readonly string[]
}>

export type HttpTelemetryOptions = Readonly<{
  readonly tracer: Tracer
  readonly propagation?: HttpTelemetryPropagation
  readonly spanName?: (method: string, path: string) => string
  readonly recordEvents?: boolean
  readonly onEvent?: (event: HttpTelemetryEvent) => void
}>

const redactedHeaders = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization'])

/** Return only safe, low-cardinality request metadata. */
export const HttpTelemetry = {
  safeUrl(url: string): string {
    try {
      const parsed = new URL(url)
      parsed.username = ''
      parsed.password = ''
      parsed.search = ''
      parsed.hash = ''
      return parsed.toString()
    } catch {
      return '[invalid-url]'
    }
  },
  safeHeaders(headers: Headers): Readonly<Record<string, string>> {
    const result: Record<string, string> = {}
    for (const [name, value] of headers) {
      if (!redactedHeaders.has(name.toLowerCase())) result[name.toLowerCase()] = value.slice(0, 256)
    }
    return result
  },
  observe(options: HttpTelemetryOptions): HttpObserver {
    let sequence = 0
    const spans = new Map<string, Span>()
    const emit = (event: HttpTelemetryEvent): void => {
      if (options.recordEvents !== false) options.onEvent?.(event)
    }
    const end = (operationId: string, error?: HttpError): void => {
      const span = spans.get(operationId)
      if (!span) return
      spans.delete(operationId)
      if (error) {
        span.recordException(error.message)
        span.setStatus({ code: SpanStatusCode.ERROR })
      } else span.setStatus({ code: SpanStatusCode.OK })
      span.end()
    }
    return {
      name: 'http.telemetry',
      onSuccess: <A>(context: Readonly<{ response: HttpResponse<A> }>) => {
        const operationId = `http-${++sequence}`
        const span = options.tracer.startSpan(options.spanName?.('HTTP', context.response.url) ?? 'http.request')
        spans.set(operationId, span)
        emit({ phase: 'complete', operationId, attributes: { 'http.status_code': context.response.status } })
        end(operationId)
      },
      onError: (context: Readonly<{ error: HttpError }>) => {
        const operationId = `http-${++sequence}`
        const span = options.tracer.startSpan(options.spanName?.('HTTP', 'unknown') ?? 'http.request')
        spans.set(operationId, span)
        emit({ phase: 'error', operationId })
        end(operationId, context.error)
      },
      _kind: 'observe'
    }
  }
} as const
