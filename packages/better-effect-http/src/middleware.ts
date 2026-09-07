import type { EffectRequirements, Program } from 'better-effect'
import type { Result } from 'better-result'
import type { HttpResponse } from './operation'
import type { HttpRequest } from './request'

export type HttpMiddlewareNext<A, E, R extends any> = (request: HttpRequest) => Program<HttpResponse<A>, E, R>
export type HttpMiddleware<A = unknown, E = unknown, R extends any = never> = Readonly<{
  readonly name?: string
  readonly handle: (request: HttpRequest, next: HttpMiddlewareNext<A, E, R>) => Program<HttpResponse<A>, E, R> | Result<HttpResponse<A>, E>
  readonly requirements?: EffectRequirements<R>
}>

const make = <A, E, R extends any>(handle: HttpMiddleware<A, E, R>['handle'], name?: string): HttpMiddleware<A, E, R> =>
  name === undefined ? { handle } : { handle, name }

export const HttpMiddleware = { make } as const
