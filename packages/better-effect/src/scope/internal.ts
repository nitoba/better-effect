import { ScopeCloseError } from './errors'

import { ScopeRuntime } from './runtime'

import type { CloseableScope } from './scope'

import type { CleanupFailureDiagnostic, MaybePromise, ScopeOutcome } from './types'

export type OutcomeClassifier<A> = (value: A) => ScopeOutcome

export type RunScopedOptions<A> = {
  readonly classify: OutcomeClassifier<A>
  readonly onCleanupFailure?: (diagnostic: CleanupFailureDiagnostic) => MaybePromise<void>
}

const notifyCleanupFailure = async (
  observer: ((diagnostic: CleanupFailureDiagnostic) => MaybePromise<void>) | undefined,
  diagnostic: CleanupFailureDiagnostic
): Promise<void> => {
  if (!observer) {
    return
  }

  try {
    await observer(diagnostic)
  } catch {
    // Cleanup diagnostics are best effort and never affect the primary result.
  }
}

export const runScoped = async <A>(
  scope: CloseableScope,
  program: () => A | PromiseLike<A>,
  options: RunScopedOptions<Awaited<A>>
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

  const outcome: ScopeOutcome = programFailed
    ? {
        status: 'failure',
        cause: programFailure
      }
    : options.classify(value)

  let cleanupFailed = false
  let cleanupFailure: unknown

  try {
    await scope.close(outcome)
  } catch (cause) {
    cleanupFailed = true
    cleanupFailure = cause
  }

  if (cleanupFailed) {
    const error =
      cleanupFailure instanceof ScopeCloseError
        ? cleanupFailure
        : new ScopeCloseError([cleanupFailure])

    await notifyCleanupFailure(options.onCleanupFailure, {
      outcome,
      error
    })

    cleanupFailure = error
  }

  if (programFailed) {
    throw programFailure
  }

  if (outcome.status === 'failure') {
    return value
  }

  if (cleanupFailed) {
    throw cleanupFailure
  }

  return value
}
