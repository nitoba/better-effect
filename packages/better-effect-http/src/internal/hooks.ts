/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening, eslint(require-yield) -- Hook execution is the erased runtime boundary between heterogeneous HTTP callbacks and the typed transport operation. */
import { Result } from 'better-result'
import type { Result as ResultType } from 'better-result'
import { HttpHookError } from '../errors'
import type { HttpError } from '../errors'
import type { HttpInterceptor, HttpObserver } from '../interceptors'
import type { HttpMiddleware } from '../middleware'
import type { HttpOperation, HttpOperationRequest, HttpResponse } from '../operation'
import { operation } from '../operation'
import { HttpRequest } from '../request'
import type { HttpRequest as HttpRequestType } from '../request'
import type { HttpSchema, HttpResponseSchemas } from '../schema'
import type { HttpAdmission } from '../limits'
import type { TransportOptions } from './ofetch-transport'

type AnyResult = ResultType<unknown, unknown>
type HttpHook = HttpInterceptor<any, any> | HttpObserver<any> | HttpMiddleware<any, any, any>
type HttpLimiter = { readonly admit: (signal?: AbortSignal) => Promise<HttpAdmission> }
type HookRequest = HttpOperationRequest<HttpSchema, HttpResponseSchemas>

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  'then' in value &&
  typeof value.then === 'function'

const resolveValue = async (value: unknown): Promise<unknown> => {
  const produced = typeof value === 'function' ? (value as () => unknown)() : value
  return isPromiseLike(produced) ? await produced : produced
}

const isMiddleware = (hook: HttpHook): hook is HttpMiddleware<any, any, any> => 'handle' in hook

const isInterceptor = (hook: HttpHook): hook is HttpInterceptor<any, any> =>
  '_kind' in hook && hook._kind === 'transform'

const isObserver = (hook: HttpHook): hook is HttpObserver<any> =>
  '_kind' in hook && hook._kind === 'observe'

const isHttpRequest = (value: unknown): value is HttpRequestType =>
  value !== null &&
  typeof value === 'object' &&
  'url' in value &&
  'method' in value &&
  'headers' in value

const requestFor = (input: HookRequest): HttpRequestType => {
  const source = 'options' in input ? input.options : input
  const options = {
    method: input.method,
    headers: source.headers === undefined ? undefined : new Headers(source.headers),
    // SAFETY: HTTP hook requests use the same JSON/BodyInit input accepted by the transport.
    body: source.body as object | HttpRequestType['body'],
    query: source.query
  }
  // SAFETY: The options preserve the transport request's method, query, headers, and body fields.
  return HttpRequest.make(input.path, options as Parameters<typeof HttpRequest.make>[1])
}

const replaceRequest = (
  input: HookRequest,
  request: HttpRequestType,
  disableRetry: boolean
): HookRequest => {
  const changes = {
    headers: request.headers,
    body: request.body
  }
  if ('options' in input) {
    if (disableRetry)
      return { ...input, options: { ...input.options, ...changes, retry: false } } as HookRequest
    return { ...input, options: { ...input.options, ...changes } } as HookRequest
  }
  if (disableRetry) return { ...input, ...changes, retry: false } as HookRequest
  return { ...input, ...changes } as HookRequest
}

const collect = async <A>(
  source: HttpOperation<A>
): Promise<ResultType<HttpResponse<A>, HttpError>> => {
  const step = await source.next()
  if (step.done) return Result.ok(step.value)
  return step.value as ResultType<HttpResponse<A>, HttpError>
}

const invokeProgram = async (value: unknown): Promise<AnyResult> => {
  const resolved = await resolveValue(value)
  return resolved as AnyResult
}

const hookFailure = (cause: unknown): ResultType<never, HttpError> =>
  Result.err(new HttpHookError({ phase: 'hook', cause }))

const applyInterceptors = async (
  hooks: readonly HttpHook[],
  initial: HttpRequestType
): Promise<ResultType<HttpRequestType, HttpError>> => {
  let request = initial
  for (const hook of hooks) {
    if (!isInterceptor(hook) || hook.onRequest === undefined) continue
    try {
      const output = await resolveValue(await hook.onRequest({ request }))
      const resolved = output as AnyResult
      if (Result.isError(resolved)) return hookFailure(resolved.error)
      const next = Result.isOk(resolved) ? resolved.value : output
      if (!isHttpRequest(next))
        return hookFailure(new TypeError('onRequest must return HttpRequest'))
      request = next
    } catch (cause) {
      return hookFailure(cause)
    }
  }
  return Result.ok(request)
}

const notifyObservers = async (
  hooks: readonly HttpHook[],
  result: ResultType<HttpResponse, HttpError>
): Promise<void> => {
  for (const hook of hooks) {
    if (!isObserver(hook)) continue
    try {
      const output = Result.isError(result)
        ? hook.onError?.({ error: result.error })
        : hook.onSuccess?.({ response: result.value })
      if (output !== undefined) await resolveValue(output)
    } catch {
      // Observers are best-effort and must not alter the logical HTTP result.
    }
  }
}

const runWithHooks = async (
  config: TransportOptions,
  input: HookRequest,
  limiter: HttpLimiter | undefined,
  hooks: readonly HttpHook[]
): Promise<ResultType<HttpResponse, HttpError>> => {
  const middleware = hooks.filter(isMiddleware)
  const base = requestFor(input)
  let nextCalls = 0

  const runBase = async (request: HttpRequestType): Promise<AnyResult> => {
    const transformed = await applyInterceptors(hooks, request)
    if (Result.isError(transformed)) return transformed
    const current = replaceRequest(input, transformed.value, nextCalls > 0)
    nextCalls++
    return await collect(operation(config, current, limiter))
  }

  const runMiddleware = async (index: number, request: HttpRequestType): Promise<AnyResult> => {
    const current = middleware[index]
    if (current === undefined) return await runBase(request)
    const next = (nextRequest: HttpRequestType) => async () =>
      await runMiddleware(index + 1, nextRequest)
    try {
      return await invokeProgram(current.handle(request, next as never))
    } catch (cause) {
      return hookFailure(cause)
    }
  }

  const result = (await runMiddleware(0, base)) as ResultType<HttpResponse, HttpError>
  await notifyObservers(hooks, result)
  return result
}

export const operationWithHooks = (
  config: TransportOptions,
  request: HookRequest,
  limiter?: HttpLimiter,
  hooks: readonly unknown[] = []
): HttpOperation =>
  // oxlint-disable-next-line require-yield -- The returned generator preserves the lazy HTTP operation contract.
  (async function* () {
    const result = await runWithHooks(config, request, limiter, hooks as readonly HttpHook[])
    if (Result.isError(result)) return yield* Result.err(result.error)
    return result.value
  })()
