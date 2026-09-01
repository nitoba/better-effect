import type { Err } from 'better-result'
import type { Service, ServiceRequirement } from 'better-effect'

type KyselyOperationRequirement<R extends Service.Any> = [R] extends [never]
  ? never
  : ServiceRequirement<R>

/**
 * A yieldable asynchronous Kysely operation.
 *
 * Query operations default to no Service requirements. Transaction bodies can
 * use the third parameter to retain the Services required by their Program.
 */
export type KyselyOperation<A, E, R extends Service.Any = never> = AsyncGenerator<
  Err<never, E> | KyselyOperationRequirement<R>,
  A,
  unknown
>
