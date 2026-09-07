/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-returns, anti-slop/no-object-parameters, anti-slop/no-known-value-widening, typescript/no-redundant-type-constituents, eslint(require-yield) -- Auth deliberately bridges erased Result/Program values and opaque session keys at the HTTP middleware boundary. */
import { Effect } from 'better-effect'
import { Result } from 'better-result'
import type { AnyService, Program } from 'better-effect'
import type { Result as ResultType } from 'better-result'
import { HttpAuthRefreshError, HttpStatusError } from './errors'
import type { HttpError } from './errors'
import { HttpInterceptor } from './interceptors'
import type { HttpInterceptor as HttpInterceptorType } from './interceptors'
import { HttpMiddleware } from './middleware'
import type { HttpMiddleware as HttpMiddlewareType } from './middleware'
import { HttpRequest } from './request'
import type { HttpRequest as HttpRequestType } from './request'
import type { HttpResponse } from './operation'

/**
 * A session key is deliberately opaque. It is used only as an in-memory Map
 * key and is never stringified, logged, or placed in an error diagnostic.
 */
export type HttpAuthSessionKey = string | number | symbol | object

export type HttpAuthValue<A, E = unknown, R extends AnyService = never> =
  | A
  | ResultType<A, E>
  | Program<A, E, R>
  | Promise<A | ResultType<A, E>>

export type HttpAuthFactory<A, E = unknown, R extends AnyService = never> =
  | HttpAuthValue<A, E, R>
  | (() => HttpAuthValue<A, E, R>)

export type HttpAuthRefreshOptions<E = never, R extends AnyService = never> = Readonly<{
  readonly maxReplays?: number
  readonly key: HttpAuthFactory<HttpAuthSessionKey, E, R>
  readonly refresh: HttpAuthFactory<string, E, R>
}>

export type HttpAuthAuthenticationOptions<E = never, R extends AnyService = never> = Readonly<{
  readonly credential: HttpAuthFactory<string, E, R>
  readonly name?: string
}>

export type HttpAuthMiddleware<E = never, R extends AnyService = never> = HttpMiddlewareType<
  HttpResponse,
  HttpError | E | HttpAuthRefreshError,
  R
> & {
  readonly _kind: 'auth-refresh'
  readonly maxReplays: number
}

type AnyResult = ResultType<unknown, unknown>
const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  'then' in value &&
  typeof value.then === 'function'

const isFactory = (value: unknown): value is () => unknown => typeof value === 'function'

const resolveValue = async <A, E, R extends AnyService>(
  value: HttpAuthFactory<A, E, R>
): Promise<A> => {
  const produced = isFactory(value) ? value() : value
  const resolved = isPromiseLike(produced) ? await produced : produced
  if (Result.isError(resolved as AnyResult))
    throw (resolved as AnyResult & { readonly error: unknown }).error
  if (Result.isOk(resolved as AnyResult))
    return (resolved as AnyResult & { readonly value: A }).value
  return resolved as A
}

const invoke = async <A, E, R extends AnyService>(
  program: Program<A, E, R> | ResultType<A, E> | Promise<ResultType<A, E>>
): Promise<ResultType<A, E>> => {
  const effect = typeof program === 'function' ? program() : program
  return (isPromiseLike(effect) ? await effect : effect) as ResultType<A, E>
}

const isReplayable = (request: HttpRequestType): boolean =>
  request.body === undefined && ['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())

const isUnauthorized = (error: unknown): error is HttpStatusError =>
  error instanceof HttpStatusError && error.status === 401

const validateMaxReplays = (maxReplays: number | undefined): number => {
  const value = maxReplays ?? 1
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError('maxReplays must be a non-negative integer')
  return value
}

const refreshError = (cause: unknown): HttpAuthRefreshError =>
  new HttpAuthRefreshError({ phase: 'auth', reason: 'refresh-failed', cause })

const authProgram = <A, E, R extends AnyService>(
  run: () => Promise<ResultType<A, E | HttpAuthRefreshError>>
): Program<A, E | HttpAuthRefreshError, R> =>
  // oxlint-disable-next-line require-yield -- The helper preserves the generator-shaped Program API while delegating to an already-composed Result.
  Effect.fn(async function* () {
    return await run()
  }) as Program<A, E | HttpAuthRefreshError, R>

/**
 * Build an interceptor that reads the current credential for every physical
 * send. It intentionally keeps no credential state of its own.
 */
function authentication(
  options: HttpAuthAuthenticationOptions<never, never>
): HttpInterceptorType<never, never>
function authentication<E, R extends AnyService>(
  options: HttpAuthAuthenticationOptions<E, R>
): HttpInterceptorType<R, E>
function authentication<E, R extends AnyService>(
  options: HttpAuthAuthenticationOptions<E, R>
): HttpInterceptorType<R, E> {
  return HttpInterceptor.make({
    name: options.name ?? 'http-authentication',
    onRequest: async ({ request }) =>
      HttpRequest.bearerToken(request, await resolveValue(options.credential))
  })
}

/**
 * Build an opt-in refresh middleware.
 *
 * The middleware performs at most one bounded replay for a logical call. The
 * refresh promise is shared only by calls resolving to the same opaque key,
 * and is removed as soon as it settles. A raw body or unsafe method is never
 * replayed merely because credentials changed.
 */
function refresh(options: HttpAuthRefreshOptions<never, never>): HttpAuthMiddleware<never, never>
function refresh<E, R extends AnyService>(
  options: HttpAuthRefreshOptions<E, R>
): HttpAuthMiddleware<E, R>
function refresh(options: HttpAuthRefreshOptions<any, AnyService>): unknown {
  type E = any
  type R = AnyService
  const maxReplays = validateMaxReplays(options.maxReplays)
  const flights = new Map<HttpAuthSessionKey, Promise<string>>()

  const runRefresh = (key: HttpAuthSessionKey): Promise<string> => {
    const existing = flights.get(key)
    if (existing) return existing
    const flight = resolveValue(options.refresh).catch((cause) => {
      throw refreshError(cause)
    })
    flights.set(key, flight)
    void flight.finally(() => {
      if (flights.get(key) === flight) flights.delete(key)
    })
    return flight
  }

  const handle = <A>(
    request: HttpRequestType,
    next: (request: HttpRequestType) => Program<HttpResponse<A>, HttpError | E, R>
  ): Program<HttpResponse<A>, E | HttpAuthRefreshError, R> =>
    authProgram(async () => {
      const first = await invoke(next(request))
      if (!Result.isError(first) || !isUnauthorized(first.error) || maxReplays === 0)
        return first as ResultType<HttpResponse<A>, E | HttpAuthRefreshError>
      if (!isReplayable(request))
        return Result.err(
          new HttpAuthRefreshError({ phase: 'auth', reason: 'not-replayable' })
        ) as ResultType<HttpResponse<A>, E | HttpAuthRefreshError>

      let key: HttpAuthSessionKey
      try {
        key = await resolveValue(options.key)
      } catch (cause) {
        return Result.err(refreshError(cause)) as ResultType<
          HttpResponse<A>,
          E | HttpAuthRefreshError
        >
      }

      try {
        const credential = await runRefresh(key)
        const replay = await invoke(next(HttpRequest.bearerToken(request, credential)))
        return replay as ResultType<HttpResponse<A>, E | HttpAuthRefreshError>
      } catch (cause) {
        return Result.err(
          cause instanceof HttpAuthRefreshError ? cause : refreshError(cause)
        ) as ResultType<HttpResponse<A>, E | HttpAuthRefreshError>
      }
    })

  return {
    ...HttpMiddleware.make<HttpResponse, HttpError | E | HttpAuthRefreshError, R>(
      handle as HttpMiddlewareType<HttpResponse, HttpError | E | HttpAuthRefreshError, R>['handle'],
      'http-auth-refresh'
    ),
    _kind: 'auth-refresh',
    maxReplays
  } as unknown
}

export const HttpAuth = { authentication, refresh } as const
