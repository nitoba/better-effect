import { Result } from 'better-result'

import type { Result as ResultType } from 'better-result'

import { RuntimeContextNotConfiguredError } from '../runtime/errors'
import { currentRuntimeContext } from '../runtime/context'
import { getRuntimeTaskSupervisor } from '../runtime/task'
import type { AnyService } from '../service'
import type { ScopeCloseError } from '../scope'

import type {
  Effect as EffectType,
  EffectError,
  EffectRequirements,
  EffectSuccess,
  Program
} from './types'

type AnyProgram = Program<any, any, AnyService>

/** The live state of a Scope-owned task. */
export type ScopedTaskState = 'running' | 'succeeded' | 'failed' | 'defected' | 'interrupted'

/** The terminal observation of a Scope-owned task. */
export type ScopedTaskExit<A, E> =
  | {
      readonly status: 'succeeded'
      readonly value: A
      readonly cleanupFailure?: ScopeCloseError
    }
  | {
      readonly status: 'failed'
      readonly error: E
      readonly cleanupFailure?: ScopeCloseError
    }
  | {
      readonly status: 'defected'
      readonly cause: unknown
      readonly cleanupFailure?: ScopeCloseError
    }
  | {
      readonly status: 'interrupted'
      readonly reason: unknown
      readonly cleanupFailure?: ScopeCloseError
    }

/** A small, immutable handle for a task owned by the current Scope. */
export type ScopedTask<out A, out E> = {
  readonly state: ScopedTaskState
  await(): Promise<ResultType<A, E>>
  awaitExit(): Promise<ScopedTaskExit<A, E>>
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Task interruption preserves arbitrary caller-defined reasons.
  interrupt(reason?: unknown): Promise<void>
}

/** Start a nominal Program as a child task supervised by the current Scope. */
export function forkScoped<Input extends AnyProgram>(
  program: Input
): EffectType<
  ScopedTask<EffectSuccess<Input>, EffectError<Input>>,
  never,
  EffectRequirements<Input>
> {
  const context = currentRuntimeContext()
  const resolver = context.resolver
  const scope = context.scope

  if (!resolver || !scope) {
    throw new RuntimeContextNotConfiguredError()
  }

  const supervisor = getRuntimeTaskSupervisor(scope)

  if (!supervisor) {
    throw new RuntimeContextNotConfiguredError()
  }

  // SAFETY: Result.ok supplies the runtime Result value; the Effect requirement channel is declaration-only and restored by this cast.
  return Result.ok(supervisor.forkScoped(program, { ...context, resolver, scope })) as EffectType<
    ScopedTask<EffectSuccess<Input>, EffectError<Input>>,
    never,
    EffectRequirements<Input>
  >
}
