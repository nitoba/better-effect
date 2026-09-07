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
import type { HttpAdmission } from '../limits'

type StreamLimiter = Readonly<{
  readonly admit: (signal?: AbortSignal) => Promise<HttpAdmission>
}>

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
  options: TransportRequestOptions = {},
  limiter?: StreamLimiter
): HttpStream<Uint8Array, unknown, never> => {
  const request = Object.freeze({ method: 'GET', path, options: { ...options } })
  const open = async () => {
    const admission = limiter === undefined ? undefined : await limiter.admit(options.signal)
    try {
      return { session: await StreamSession.make(await executeRequest(config, request)), admission }
    } catch (cause) {
      admission?.release()
      throw cause
    }
  }
  return Object.freeze({
    request,
    results: async function* () {
      const opened = await open()
      try {
        yield* opened.session.results()
      } finally {
        opened.admission?.release()
      }
    },
    use: (callback: StreamUseCallback<Uint8Array, unknown>) =>
      (async function* () {
        const opened = await open()
        try {
          return yield* use(opened.session, callback)
        } finally {
          opened.admission?.release()
        }
      })(),
    forEach: (callback: (value: Uint8Array, index: number) => unknown) =>
      (async function* () {
        const opened = await open()
        try {
          return yield* forEach(opened.session, callback)
        } finally {
          opened.admission?.release()
        }
      })(),
    takeUntil: (
      predicate: (value: Uint8Array) => boolean | Promise<boolean>,
      opts?: { readonly requireMatch?: boolean }
    ) =>
      (async function* () {
        const opened = await open()
        try {
          return yield* takeUntil(opened.session, predicate, opts)
        } finally {
          opened.admission?.release()
        }
      })(),
    pipeTo: (destination: WritableStream<Uint8Array>, opts?: { readonly preventClose?: boolean }) =>
      (async function* () {
        const opened = await open()
        try {
          return yield* pipeTo(opened.session, destination, opts)
        } finally {
          opened.admission?.release()
        }
      })()
  })
}

export const openStream = async (
  config: TransportOptions,
  description: HttpStream<Uint8Array, unknown, never>
): Promise<StreamSession> => StreamSession.make(await executeRequest(config, description.request))
