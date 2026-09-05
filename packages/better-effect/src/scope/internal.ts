import { ScopeCloseError } from './errors'

import { ScopeRuntime } from './runtime'

import type { CloseableScope, Scope } from './scope'

import {
  runRuntimeContext,
  type CompleteRuntimeContext,
  type RuntimeContextStorage
} from '../runtime/context'

import type { CleanupFailureDiagnostic, MaybePromise, ScopeOutcome } from './types'

type ScopePreFinalizer = (outcome: ScopeOutcome) => MaybePromise<void>

type ScopeImplementation = {
  readonly addPreFinalizer: (finalizer: ScopePreFinalizer) => void
}

const scopeImplementations = new WeakMap<object, ScopeImplementation>()

/** Register the private implementation hook used by lifecycle primitives. */
export const registerScopeImplementation = (
  scope: CloseableScope,
  implementation: ScopeImplementation
): void => {
  scopeImplementations.set(scope, implementation)
}

/** Register work that must run before attached child Scopes close. */
export const addScopePreFinalizer = (scope: Scope, finalizer: ScopePreFinalizer): void => {
  const implementation = scopeImplementations.get(scope)

  if (!implementation) {
    throw new TypeError('Scope does not support internal pre-finalizers')
  }

  implementation.addPreFinalizer(finalizer)
}

export type OutcomeClassifier<A> = (value: A) => ScopeOutcome

export type RunScopedOptions<A> = {
  readonly classify: OutcomeClassifier<A>
  readonly onOutcome?: (outcome: ScopeOutcome) => void
  readonly onCleanupFailure?: (diagnostic: CleanupFailureDiagnostic) => MaybePromise<void>
  readonly contextStorage?: RuntimeContextStorage
  readonly context?: CompleteRuntimeContext
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
    const run = () => ScopeRuntime.run(scope, program, options.contextStorage)

    value = await (options.context && options.contextStorage
      ? runRuntimeContext(options.contextStorage, options.context, run)
      : run())
  } catch (cause) {
    programFailed = true
    programFailure = cause
  }

  let outcome: ScopeOutcome
  let outcomeStatus: ScopeOutcome['status']

  if (programFailed) {
    outcome = {
      status: 'failure',
      cause: programFailure
    }
    outcomeStatus = 'failure'
  } else {
    try {
      outcome = options.classify(value)
      // Read the discriminant before cleanup so a throwing classifier or proxy is a program failure.
      outcomeStatus = outcome.status
    } catch (cause) {
      programFailed = true
      programFailure = cause
      outcome = {
        status: 'failure',
        cause
      }
      outcomeStatus = 'failure'
    }
  }

  options.onOutcome?.(outcome)

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

  if (outcomeStatus === 'failure') {
    return value
  }

  if (cleanupFailed) {
    throw cleanupFailure
  }

  return value
}
