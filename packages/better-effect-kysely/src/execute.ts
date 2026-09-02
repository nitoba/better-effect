import type { AbortableQueryOptions } from 'kysely'

import { fromKyselyPromise } from './internal/from-kysely-promise'
import type { KyselyExecutionOptions } from './options'
import type { KyselyOperation } from './operation'
import type { KyselyQueryError } from './errors'

/** A Kysely-compatible executable query boundary. */
export interface KyselyExecutable<A> {
  execute(options?: AbortableQueryOptions): PromiseLike<A>
}

/** Execute any Kysely builder while preserving its native receiver and output. */
export function execute<A>(
  executable: KyselyExecutable<A>
): KyselyOperation<Awaited<A>, KyselyQueryError> {
  return fromKyselyPromise('execute', (options) => executable.execute(options))
}

/** Create a lazy execute terminal with explicit Kysely cancellation settings. */
export function executeWith(
  options: KyselyExecutionOptions
): <A>(executable: KyselyExecutable<A>) => KyselyOperation<Awaited<A>, KyselyQueryError> {
  return <A>(executable: KyselyExecutable<A>) =>
    fromKyselyPromise('execute', (queryOptions) => executable.execute(queryOptions), options)
}
