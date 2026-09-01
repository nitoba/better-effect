import type { AbortableQueryOptions } from 'kysely'

/** Kysely query options controlled by the Runtime rather than the caller. */
export type KyselyExecutionOptions = Omit<AbortableQueryOptions, 'signal'>
