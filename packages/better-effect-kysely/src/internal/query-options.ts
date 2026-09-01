import type { AbortableQueryOptions } from 'kysely'

import type { KyselyExecutionOptions } from '../options'

/** Add the Runtime-owned signal without mutating caller options. */
export const makeQueryOptions = (
  signal: AbortSignal,
  options: KyselyExecutionOptions | undefined
): AbortableQueryOptions => {
  if (options?.inflightQueryAbortStrategy === undefined) {
    return { signal }
  }

  return {
    inflightQueryAbortStrategy: options.inflightQueryAbortStrategy,
    signal
  }
}
