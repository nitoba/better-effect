import { Result } from 'better-result'
import { HttpSinkError, HttpStreamUnexpectedEndError } from '../errors'
import type { StreamSession } from '../session'
export type TerminalResult<A, E> = AsyncGenerator<never, Result<A, E>, unknown>
export type StreamCallback<A, B, E = unknown> = (
  value: A,
  index: number
) => Result<B, E> | Promise<Result<B, E>>
export const forEach = async function* <A, B, E>(
  session: StreamSession,
  callback: StreamCallback<A, B, E>
): TerminalResult<void, E> {
  let index = 0
  try {
    for await (const item of session.results()) {
      if (Result.isError(item)) return Result.err(item.error as E)
      const outcome = await callback(item.value as A, index++)
      if (Result.isError(outcome)) return Result.err(outcome.error)
    }
    return Result.ok(undefined)
  } finally {
    await session.close().catch(() => undefined)
  }
}
export const takeUntil = async function* <A>(
  session: StreamSession,
  predicate: (value: A) => boolean | Promise<boolean>,
  options?: { readonly requireMatch?: boolean }
): TerminalResult<A, unknown> {
  try {
    for await (const item of session.results()) {
      if (Result.isError(item)) return Result.err(item.error)
      const value = item.value as A
      if (await predicate(value)) return Result.ok(value)
    }
    return options?.requireMatch
      ? Result.err(new HttpStreamUnexpectedEndError({ phase: 'takeUntil' }))
      : Result.ok(undefined as never)
  } finally {
    await session.close().catch(() => undefined)
  }
}
export const pipeTo = async function* (
  session: StreamSession,
  destination: WritableStream<Uint8Array>,
  options?: { readonly preventClose?: boolean }
): TerminalResult<void, unknown> {
  const writer = destination.getWriter()
  try {
    for await (const item of session.results()) {
      if (Result.isError(item)) return Result.err(item.error)
      await writer.write(item.value)
    }
    if (!options?.preventClose) await writer.close()
    else writer.releaseLock()
    return Result.ok(undefined)
  } catch (cause) {
    await writer.abort(cause).catch(() => undefined)
    return Result.err(new HttpSinkError({ phase: 'sink', cause }))
  } finally {
    await session.close().catch(() => undefined)
  }
}
