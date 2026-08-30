import { isAPIError } from 'better-auth/api'
import { Result, UnhandledException } from 'better-result'

import { BetterAuthApiError } from '../errors'

/**
 * Convert one Better Auth Promise boundary into a yieldable Result operation.
 * This helper deliberately performs no retry and does not interpret Response status codes.
 */
export const fromBetterAuthPromise = <A, Code extends string = string>(
  operation: () => PromiseLike<A>
) =>
  Result.await(
    Result.tryPromise({
      try: async () => await operation(),
      catch: (cause) =>
        isAPIError(cause) ? BetterAuthApiError.from<Code>(cause) : new UnhandledException({ cause })
    })
  )
