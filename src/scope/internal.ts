import { ScopeRuntime } from './runtime'

import type { Scope } from './scope'

export const runScoped = async <A>(
  scope: Scope,
  program: () => A | PromiseLike<A>
): Promise<Awaited<A>> => {
  let value!: Awaited<A>

  let programFailed = false
  let programFailure: unknown

  try {
    value = await ScopeRuntime.run(scope, program)
  } catch (cause) {
    programFailed = true
    programFailure = cause
  }

  let closeFailed = false
  let closeFailure: unknown

  try {
    await scope.close()
  } catch (cause) {
    closeFailed = true
    closeFailure = cause
  }

  if (programFailed && closeFailed) {
    throw new AggregateError(
      [programFailure, closeFailure],
      'Scope program and cleanup both failed'
    )
  }

  if (programFailed) {
    throw programFailure
  }

  if (closeFailed) {
    throw closeFailure
  }

  return value
}
