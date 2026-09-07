/* oxlint-disable anti-slop/no-unknown-returns -- the binary stream implementation erases the callback boundary before restoring its public generic contract. */
import type { TransportOptions, TransportRequestOptions } from '../internal/ofetch-transport'
import { executeRequest } from '../internal/ofetch-transport'
import { StreamSession } from './session'
import { forEach, pipeTo, takeUntil, use } from './terminals'
import type { TerminalResult, StreamUseCallback } from './terminals'
import type { Result } from 'better-result'
import type { AnyService, EffectError, EffectRequirements, EffectSuccess } from 'better-effect'
import type { HttpHookError } from '../errors'
import type { HttpSinkError } from './errors'

export type HttpStream<A = Uint8Array, E = unknown, R extends AnyService = never> = Readonly<{
  readonly _A?: A
  readonly _E?: E
  readonly _R?: R
  readonly request: Readonly<{
    readonly method: string
    readonly path: string
    readonly options: TransportRequestOptions
  }>
  readonly results: () => AsyncIterable<Result<A, E>>
  readonly use: <C>(
    callback: StreamUseCallback<A, C>
  ) => TerminalResult<
    EffectSuccess<C>,
    E | EffectError<C> | HttpHookError,
    R | Extract<EffectRequirements<C>, AnyService>
  >
  readonly forEach: <C>(
    callback: (value: A, index: number) => C
  ) => TerminalResult<
    void,
    E | EffectError<C> | HttpHookError,
    R | Extract<EffectRequirements<C>, AnyService>
  >
  readonly takeUntil: (
    predicate: (value: A) => boolean | Promise<boolean>,
    options?: { readonly requireMatch?: boolean }
  ) => TerminalResult<A, E | HttpHookError, R>
  readonly pipeTo: A extends Uint8Array
    ? (
        destination: WritableStream<Uint8Array>,
        options?: { readonly preventClose?: boolean }
      ) => TerminalResult<void, E | HttpSinkError, R>
    : never
}>

export const stream = (
  config: TransportOptions,
  path: string,
  options: TransportRequestOptions = {}
): HttpStream<Uint8Array, unknown, never> => {
  const request = Object.freeze({ method: 'GET', path, options: { ...options } })
  const open = async () => StreamSession.make(await executeRequest(config, request))
  return Object.freeze({
    request,
    results: async function* () {
      yield* (await open()).results()
    },
    use: (callback: StreamUseCallback<Uint8Array, unknown>) =>
      (async function* () {
        return yield* use(await open(), callback)
      })(),
    forEach: (callback: (value: Uint8Array, index: number) => unknown) =>
      (async function* () {
        return yield* forEach(await open(), callback)
      })(),
    takeUntil: (
      predicate: (value: Uint8Array) => boolean | Promise<boolean>,
      opts?: { readonly requireMatch?: boolean }
    ) =>
      (async function* () {
        return yield* takeUntil(await open(), predicate, opts)
      })(),
    pipeTo: (destination: WritableStream<Uint8Array>, opts?: { readonly preventClose?: boolean }) =>
      (async function* () {
        return yield* pipeTo(await open(), destination, opts)
      })()
  })
}

export const openStream = async (
  config: TransportOptions,
  description: HttpStream<Uint8Array, unknown, never>
): Promise<StreamSession> => StreamSession.make(await executeRequest(config, description.request))
