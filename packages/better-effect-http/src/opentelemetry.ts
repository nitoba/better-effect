/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread -- OpenTelemetry's SDK contracts are intentionally narrowed at this optional integration boundary; arbitrary provider values never enter telemetry attributes. */
import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer
} from '@opentelemetry/api'
import type { HttpError } from './errors'
import type { HttpObserver } from './interceptors'
import type { HttpResponse } from './operation'

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

export type HttpTelemetryRequest = Readonly<{
  readonly method: string
  readonly url: string
  /** A low-cardinality endpoint template such as `/users/:id`. */
  readonly template?: string
  readonly headers?: Headers
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

export type HttpTelemetryLifecycle = Readonly<{
  start(request: HttpTelemetryRequest): string
  phase(
    operationId: string,
    phase: HttpTelemetryPhase,
    attributes?: Readonly<Record<string, string | number | boolean>>,
    attempt?: number
  ): void
  attemptStart(operationId: string, attempt: number): void
  attemptEnd(operationId: string, attempt: number, failed?: boolean): void
  retry(
    operationId: string,
    context: Readonly<{ attempt: number; nextAttempt: number; delayMs: number }>
  ): void
  propagate(operationId: string, url: string, headers: Headers): Headers
  success(operationId: string, response: HttpResponse): void
  error(operationId: string, error: HttpError): void
  cancel(operationId: string): void
}>

export type HttpTelemetryObserver = HttpObserver &
  Readonly<{
    readonly lifecycle: HttpTelemetryLifecycle
  }>

const safeHeaderNames = new Set([
  'accept',
  'cache-control',
  'content-length',
  'content-type',
  'etag',
  'last-modified',
  'retry-after'
])

const redactedHeaders = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-auth-token'
])

const safeString = (value: string, limit = 256): string => value.slice(0, limit)

const safePath = (value: string): string => {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value
  try {
    const parsed = new URL(withoutQuery)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return withoutQuery || '/'
  }
}

const operationName = (method: string, path: string, custom?: HttpTelemetryOptions['spanName']) => {
  try {
    const name = custom?.(method, path)
    if (name) return safeString(name)
  } catch {
    // A naming callback is diagnostic-only and must not affect the HTTP result.
  }
  return `${method.toUpperCase()} ${path.startsWith('/') ? path : 'http.request'}`
}

const safeErrorAttributes = (
  error: HttpError
): Readonly<Record<string, string | number | boolean>> => {
  const attributes: Record<string, string | number | boolean> = {
    'http.error.type': error._tag,
    'http.error.phase': error.phase
  }
  if ('status' in error && typeof error.status === 'number')
    attributes['http.status_code'] = error.status
  return attributes
}

const callSafely = (callback: () => void): void => {
  try {
    callback()
  } catch {
    // Telemetry is best-effort and never changes the request outcome.
  }
}

export const HttpTelemetry = {
  safeUrl(url: string): string {
    return safePath(url)
  },

  safeHeaders(headers: Headers): Readonly<Record<string, string>> {
    const result: Record<string, string> = {}
    for (const [name, value] of headers) {
      const normalized = name.toLowerCase()
      if (safeHeaderNames.has(normalized) && !redactedHeaders.has(normalized))
        result[normalized] = safeString(value)
    }
    return result
  },

  observe(options: HttpTelemetryOptions): HttpTelemetryObserver {
    let sequence = 0
    const operations = new Map<
      string,
      {
        readonly span: Span
        readonly request: HttpTelemetryRequest
        readonly attempts: Map<number, Span>
      }
    >()

    const emit = (event: HttpTelemetryEvent): void => {
      if (options.recordEvents === false || !options.onEvent) return
      callSafely(() => options.onEvent?.(event))
    }

    const setAttributes = (
      span: Span,
      attributes: Readonly<Record<string, string | number | boolean>> | undefined
    ): void => {
      if (!attributes) return
      callSafely(() => span.setAttributes(attributes))
    }

    const finishAttempt = (operationId: string, attempt: number, failed = false): void => {
      const operation = operations.get(operationId)
      const span = operation?.attempts.get(attempt)
      if (!span) return
      operation?.attempts.delete(attempt)
      callSafely(() => {
        if (failed) span.setStatus({ code: SpanStatusCode.ERROR })
        span.end()
      })
    }

    const finish = (
      operationId: string,
      outcome: 'success' | 'error' | 'cancel',
      error?: HttpError
    ): void => {
      const operation = operations.get(operationId)
      if (!operation) return
      for (const attempt of operation.attempts.keys())
        finishAttempt(operationId, attempt, outcome !== 'success')
      operations.delete(operationId)
      callSafely(() => {
        if (outcome === 'error') {
          setAttributes(operation.span, safeErrorAttributes(error as HttpError))
          operation.span.recordException({ name: error?._tag ?? 'HttpError' })
          operation.span.setStatus({ code: SpanStatusCode.ERROR })
        } else if (outcome === 'cancel') {
          operation.span.setAttribute('http.cancelled', true)
          operation.span.setStatus({ code: SpanStatusCode.ERROR })
        } else operation.span.setStatus({ code: SpanStatusCode.OK })
        operation.span.end()
      })
    }

    const lifecycle: HttpTelemetryLifecycle = {
      start(request) {
        const operationId = `http-${++sequence}`
        let span: Span | undefined
        callSafely(() => {
          span = options.tracer.startSpan(
            operationName(
              request.method,
              request.template ?? safePath(request.url),
              options.spanName
            ),
            undefined,
            context.active()
          )
          span.setAttributes({
            'http.request.method': request.method.toUpperCase(),
            'http.operation_id': operationId,
            'http.url': safePath(request.url)
          })
          if (request.template) span.setAttribute('http.route', safeString(request.template))
        })
        if (span) operations.set(operationId, { span, request, attempts: new Map() })
        emit({ phase: 'admission', operationId })
        return operationId
      },

      phase(operationId, phase, attributes, attempt) {
        const operation = operations.get(operationId)
        if (!operation) return
        setAttributes(operation.span, attributes)
        emit({
          phase,
          operationId,
          ...(attempt === undefined ? {} : { attempt }),
          ...(attributes === undefined ? {} : { attributes })
        })
      },

      attemptStart(operationId, attempt) {
        const operation = operations.get(operationId)
        if (!operation || operation.attempts.has(attempt)) return
        let span: Span | undefined
        callSafely(() => {
          span = options.tracer.startSpan(
            `${operation.request.method.toUpperCase()} attempt`,
            undefined,
            trace.setSpan(context.active(), operation.span)
          )
          span.setAttribute('http.attempt', attempt)
        })
        if (span) operation.attempts.set(attempt, span)
        emit({ phase: 'send', operationId, attempt })
      },

      attemptEnd(operationId, attempt, failed = false) {
        finishAttempt(operationId, attempt, failed)
        emit({ phase: failed ? 'error' : 'headers', operationId, attempt })
      },

      retry(operationId, retryContext) {
        const attributes = {
          'http.retry.attempt': retryContext.attempt,
          'http.retry.next_attempt': retryContext.nextAttempt,
          'http.retry.delay_ms': retryContext.delayMs
        }
        lifecycle.phase(operationId, 'retry.wait', attributes, retryContext.nextAttempt)
      },

      propagate(operationId, url, headers) {
        const result = new Headers(headers)
        const operation = operations.get(operationId)
        const allowedOrigins = options.propagation?.allowedOrigins ?? []
        let allowed = false
        try {
          allowed = allowedOrigins.includes(new URL(url).origin)
        } catch {
          allowed = false
        }
        if (!operation || !allowed) return result
        callSafely(() => {
          propagation.inject(trace.setSpan(context.active(), operation.span), result, {
            set(carrier, key, value) {
              carrier.set(key, value)
            }
          })
        })
        return result
      },

      success(operationId, response) {
        const operation = operations.get(operationId)
        if (!operation) return
        setAttributes(operation.span, { 'http.status_code': response.status })
        emit({
          phase: 'complete',
          operationId,
          attributes: { 'http.status_code': response.status }
        })
        finish(operationId, 'success')
      },

      error(operationId, error) {
        emit({ phase: 'error', operationId, attributes: safeErrorAttributes(error) })
        finish(operationId, 'error', error)
      },

      cancel(operationId) {
        emit({ phase: 'cancel', operationId })
        finish(operationId, 'cancel')
      }
    }

    const fallbackOperation = (url: string): string => lifecycle.start({ method: 'HTTP', url })

    return {
      name: 'http.telemetry',
      lifecycle,
      onRetry: (retryContext) => {
        const operationId = retryContext.operationId ?? fallbackOperation('unknown')
        lifecycle.retry(operationId, retryContext)
      },
      onSuccess: <A>(
        responseContext: Readonly<{ response: HttpResponse<A>; operationId?: string }>
      ) => {
        const operationId =
          responseContext.operationId ?? fallbackOperation(responseContext.response.url)
        lifecycle.success(operationId, responseContext.response)
      },
      onError: (errorContext: Readonly<{ error: HttpError; operationId?: string }>) => {
        const operationId = errorContext.operationId ?? fallbackOperation('unknown')
        lifecycle.error(operationId, errorContext.error)
      },
      _kind: 'observe'
    }
  }
} as const
