import { CurrentAbortSignal } from 'better-effect'
import { Result } from 'better-result'

import type { AbortableQueryOptions } from 'kysely'

import { KyselyQueryError, type KyselyQueryOperation } from '../errors'
import type { KyselyExecutionOptions } from '../options'
import type { KyselyOperation } from '../operation'

import { makeQueryOptions } from './query-options'

/**
 * Convert one Kysely Promise boundary into the package's yieldable operation.
 *
 * The current Runtime signal is read only when the returned operation is
 * iterated. Failures before the external Promise boundary remain defects;
 * throws and rejections from the supplied operation are normalized once.
 */
export const fromKyselyPromise = <A>(
  operation: KyselyQueryOperation,
  execute: (options: AbortableQueryOptions) => PromiseLike<A>,
  options?: KyselyExecutionOptions
): KyselyOperation<Awaited<A>, KyselyQueryError> =>
  (async function* () {
    const signal = yield* CurrentAbortSignal
    const queryOptions = makeQueryOptions(signal, options)

    return yield* Result.await(
      Result.tryPromise({
        try: async () => await execute(queryOptions),
        catch: (cause) => new KyselyQueryError({ cause, operation })
      })
    )
  })()
