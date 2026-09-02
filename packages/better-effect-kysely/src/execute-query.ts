import type {
  Compilable,
  CompiledQuery,
  Kysely,
  QueryResult,
  RawBuilder,
  Transaction
} from 'kysely'

import { fromKyselyPromise } from './internal/from-kysely-promise'
import type { KyselyExecutionOptions } from './options'
import type { KyselyOperation } from './operation'
import type { KyselyQueryError } from './errors'

/** Execute a raw or compiled query through the supplied Kysely instance. */
export function executeQuery<DB, O>(
  database: Transaction<DB>,
  query: RawBuilder<O> | Compilable<O> | CompiledQuery<O>,
  options?: KyselyExecutionOptions
): KyselyOperation<QueryResult<O>, KyselyQueryError>

export function executeQuery<DB, O>(
  database: Kysely<DB>,
  query: RawBuilder<O> | Compilable<O> | CompiledQuery<O>,
  options?: KyselyExecutionOptions
): KyselyOperation<QueryResult<O>, KyselyQueryError>

export function executeQuery<DB, O>(
  database: Kysely<DB>,
  query: RawBuilder<O> | Compilable<O> | CompiledQuery<O>,
  options?: KyselyExecutionOptions
): KyselyOperation<QueryResult<O>, KyselyQueryError> {
  return fromKyselyPromise(
    'executeQuery',
    (queryOptions) =>
      isRawBuilder(query)
        ? query.execute(database, queryOptions)
        : database.executeQuery(query, queryOptions),
    options
  )
}

const isRawBuilder = <O>(
  query: RawBuilder<O> | Compilable<O> | CompiledQuery<O>
): query is RawBuilder<O> =>
  query !== null &&
  'isRawBuilder' in query &&
  query.isRawBuilder === true &&
  'execute' in query &&
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- RawBuilder is identified by its callable native terminal.
  typeof query.execute === 'function'
