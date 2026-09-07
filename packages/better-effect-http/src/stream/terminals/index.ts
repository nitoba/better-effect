/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion -- Stream terminals intentionally narrow callback/stream protocol values at the public consumption boundary. */
import { Result } from 'better-result'
import type { Err } from 'better-result'
import type {
  AnyService,
  EffectError,
  EffectRequirements,
  EffectSuccess,
  ServiceRequirement
} from 'better-effect'
import { HttpHookError } from '../../errors'
import { HttpSinkError, HttpStreamUnexpectedEndError } from '../errors'

type TerminalYield<E, R extends AnyService> = [R] extends [never]
  ? Err<never, E>
  : Err<never, E> | ServiceRequirement<R>

export type TerminalResult<A, E, R extends AnyService = never> = AsyncGenerator<
  TerminalYield<E, R>,
  Result<A, E>,
  unknown
>
export type StreamCallback<A, B, E = unknown, C = Result<B, E>> = (value: A, index: number) => C
export type StreamSessionView<A = Uint8Array> = Readonly<{
  readonly body: ReadableStream<A>
  readonly cancel: (reason?: unknown) => Promise<void>
}>
export type StreamUseCallback<A, C> = (session: StreamSessionView<A>) => C

type TerminalSession<A, E> = Readonly<{
  readonly bodyStream: ReadableStream<A>
  readonly results: () => AsyncIterable<Result<A, E>>
  readonly close: () => Promise<void>
}>

const callbackValue = async <C>(value: C): Promise<Awaited<C>> =>
  (typeof value === 'function'
    ? await Promise.resolve((value as () => Awaited<C>)())
    : await Promise.resolve(value)) as Awaited<C>

export const forEach = async function* <A, E, C>(
  session: TerminalSession<A, E>,
  callback: (value: A, index: number) => C
): TerminalResult<
  void,
  E | EffectError<C> | HttpHookError,
  Extract<EffectRequirements<C>, AnyService>
> {
  let index = 0
  try {
    for await (const item of session.results()) {
      if (Result.isError(item)) return yield* Result.err(item.error as E)
      let outcome: Awaited<C>
      try {
        outcome = await callbackValue(callback(item.value as A, index++))
      } catch (cause) {
        return yield* Result.err(new HttpHookError({ phase: 'hook', cause }))
      }
      const result = outcome as Result<unknown, unknown>
      if (Result.isError(result)) return yield* Result.err(result.error as EffectError<C>)
    }
    return Result.ok(undefined)
  } finally {
    await session.close().catch(() => undefined)
  }
}

export const takeUntil = async function* <A>(
  session: TerminalSession<A, unknown>,
  predicate: (value: A) => boolean | Promise<boolean>,
  options?: { readonly requireMatch?: boolean }
): TerminalResult<A, unknown> {
  try {
    for await (const item of session.results()) {
      if (Result.isError(item)) return yield* Result.err(item.error)
      const value = item.value as A
      try {
        if (await predicate(value)) return Result.ok(value)
      } catch (cause) {
        return yield* Result.err(new HttpHookError({ phase: 'hook', cause }))
      }
    }
    return options?.requireMatch
      ? yield* Result.err(new HttpStreamUnexpectedEndError({ phase: 'takeUntil' }))
      : Result.ok(undefined as never)
  } finally {
    await session.close().catch(() => undefined)
  }
}

export const use = async function* <A, C>(
  session: TerminalSession<A, unknown>,
  callback: StreamUseCallback<A, C>
): TerminalResult<
  EffectSuccess<C>,
  EffectError<C> | HttpHookError,
  Extract<EffectRequirements<C>, AnyService>
> {
  try {
    const value = await callbackValue(
      callback({
        body: session.bodyStream,
        cancel: async () => session.close()
      })
    )
    const result = value as Result<unknown, unknown>
    if (Result.isError(result)) return yield* Result.err(result.error as EffectError<C>)
    return value as Result<EffectSuccess<C>, EffectError<C>>
  } catch (cause) {
    return yield* Result.err(new HttpHookError({ phase: 'hook', cause }))
  } finally {
    await session.close().catch(() => undefined)
  }
}

export const pipeTo = async function* (
  session: TerminalSession<Uint8Array, unknown>,
  destination: WritableStream<Uint8Array>,
  options?: { readonly preventClose?: boolean }
): TerminalResult<void, unknown> {
  const writer = destination.getWriter()
  try {
    for await (const item of session.results()) {
      if (Result.isError(item)) return yield* Result.err(item.error)
      await writer.write(item.value)
    }
    if (!options?.preventClose) await writer.close()
    else writer.releaseLock()
    return Result.ok(undefined)
  } catch (cause) {
    await writer.abort(cause).catch(() => undefined)
    return yield* Result.err(new HttpSinkError({ phase: 'sink', cause }))
  } finally {
    await session.close().catch(() => undefined)
  }
}
