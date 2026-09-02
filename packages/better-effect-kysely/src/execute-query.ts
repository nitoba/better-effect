import type { Kysely, CompiledQuery, QueryResult } from 'kysely'
import type { Compilable } from 'kysely'

import { fromKyselyPromise } from './internal/from-kysely-promise'
import type { KyselyExecutionOptions } from './options'
import type { KyselyOperation } from './operation'
import type { KyselyQueryError } from './errors'

/** Execute a raw or compiled query through the supplied Kysely instance. */
export function executeQuery<DB, O>(
  database: Kysely<DB>,
  query: Compilable<O> | CompiledQuery<O>,
  options?: KyselyExecutionOptions
): KyselyOperation<QueryResult<O>, KyselyQueryError> {
  return fromKyselyPromise(
    'executeQuery',
    (queryOptions) => database.executeQuery(query, queryOptions),
    options
  )
}
