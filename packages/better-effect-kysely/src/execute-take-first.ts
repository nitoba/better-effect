import { Result } from 'better-result'
import type { AbortableQueryOptions } from 'kysely'

import { fromKyselyPromise } from './internal/from-kysely-promise'
import type { KyselyExecutionOptions } from './options'
import type { KyselyOperation } from './operation'
import type { KyselyQueryError } from './errors'

/** A Kysely-compatible first-row query boundary. */
export interface KyselyTakeFirstExecutable<A> {
  executeTakeFirst(options?: AbortableQueryOptions): PromiseLike<A>
}

/** Execute a Kysely builder and preserve its first-row output, including undefined. */
export function executeTakeFirst<A>(
  executable: KyselyTakeFirstExecutable<A>
): KyselyOperation<Awaited<A>, KyselyQueryError> {
  return fromKyselyPromise('executeTakeFirst', (options) => executable.executeTakeFirst(options))
}

/** Create a lazy first-row terminal with explicit Kysely cancellation settings. */
export function executeTakeFirstWith(
  options: KyselyExecutionOptions
): <A>(executable: KyselyTakeFirstExecutable<A>) => KyselyOperation<Awaited<A>, KyselyQueryError> {
  return <A>(executable: KyselyTakeFirstExecutable<A>) =>
    fromKyselyPromise(
      'executeTakeFirst',
      (queryOptions) => executable.executeTakeFirst(queryOptions),
      options
    )
}

/** Execute a first-row boundary and map only strict undefined to the caller's error. */
export function executeTakeFirstOrFail<E>(
  makeError: () => E
): <A>(
  executable: KyselyTakeFirstExecutable<A>
) => KyselyOperation<Exclude<Awaited<A>, undefined>, E | KyselyQueryError> {
  return <A>(executable: KyselyTakeFirstExecutable<A>) =>
    executeTakeFirstOrFailWithOptions(undefined, makeError, executable)
}

/** Create a first-row-or-fail terminal with explicit Kysely cancellation settings. */
export function executeTakeFirstOrFailWith<E>(
  options: KyselyExecutionOptions,
  makeError: () => E
): <A>(
  executable: KyselyTakeFirstExecutable<A>
) => KyselyOperation<Exclude<Awaited<A>, undefined>, E | KyselyQueryError> {
  return <A>(executable: KyselyTakeFirstExecutable<A>) =>
    executeTakeFirstOrFailWithOptions(options, makeError, executable)
}

const executeTakeFirstOrFailWithOptions = <A, E>(
  options: KyselyExecutionOptions | undefined,
  makeError: () => E,
  executable: KyselyTakeFirstExecutable<A>
): KyselyOperation<Exclude<Awaited<A>, undefined>, E | KyselyQueryError> =>
  (async function* () {
    const value = yield* fromKyselyPromise(
      'executeTakeFirst',
      (queryOptions) => executable.executeTakeFirst(queryOptions),
      options
    )

    if (value !== undefined) {
      // SAFETY: The branch excludes the only value removed by Exclude<..., undefined>.
      return value as Exclude<Awaited<A>, undefined>
    }

    return yield* Result.await(Promise.resolve(Result.err(makeError())))
  })()
