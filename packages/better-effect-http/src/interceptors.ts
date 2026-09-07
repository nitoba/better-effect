import type { AnyService, EffectRequirements, Program } from 'better-effect'
import type { Result } from 'better-result'
import type { HttpError } from './errors'
import type { HttpRequest } from './request'
import type { HttpResponse } from './operation'

export type HookValue<A, E = HttpError, R extends AnyService = never> =
  | A
  | Result<A, E>
  | Program<A, E, R>
  | Promise<A | Result<A, E>>

export type HttpRequestHookContext = Readonly<{ request: HttpRequest }>
export type HttpResponseHookContext<A = unknown> = Readonly<{ response: HttpResponse<A> }>

export type HttpInterceptor<R extends AnyService = never, E = HttpError> = Readonly<{
  readonly name: string
  readonly onRequest?: (context: HttpRequestHookContext) => HookValue<HttpRequest, E, R>
  readonly onResponse?: <A>(context: HttpResponseHookContext<A>) => HookValue<HttpResponse<A>, E, R>
  readonly requirements?: EffectRequirements<R>
  readonly _kind: 'transform'
}>

export type HttpObserver<R extends AnyService = never> = Readonly<{
  readonly name: string
  readonly onRetry?: (
    context: Readonly<{ attempt: number; nextAttempt: number; delayMs: number }>
  ) => HookValue<void, never, R>
  readonly onSuccess?: <A>(
    context: Readonly<{ response: HttpResponse<A> }>
  ) => HookValue<void, never, R>
  readonly onError?: (context: Readonly<{ error: HttpError }>) => HookValue<void, never, R>
  readonly requirements?: EffectRequirements<R>
  readonly _kind: 'observe'
}>

const make = <R extends AnyService, E>(
  config: Omit<HttpInterceptor<R, E>, '_kind'>
): HttpInterceptor<R, E> => ({ ...config, _kind: 'transform' })
const observe = <R extends AnyService>(
  config: Omit<HttpObserver<R>, '_kind'>
): HttpObserver<R> => ({ ...config, _kind: 'observe' })

export const HttpInterceptor = { make, observe } as const
