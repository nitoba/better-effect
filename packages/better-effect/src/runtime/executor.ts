import { RuntimeContextNotConfiguredError, RuntimeExecutorNotConfiguredError } from './errors'

import { currentRuntimeContext } from './context'

import type { ServiceRequirement } from '../effect/types'
import type { AnyService } from '../service'
import type {
  CompleteExecution,
  CompleteExecutionLayer,
  LayerInput,
  ProvidedEnvironment
} from '../layer/inference'
import type { RuntimeRunOptions } from './outcome'

/* oxlint-disable anti-slop/no-unknown-parameters -- managed cancellation preserves caller-defined reasons. */

/** The value published by one managed execution before its work completes. */
export type RuntimeManagedPlan<A> = {
  readonly readiness: A | PromiseLike<A>
  readonly completion: PromiseLike<void>
  readonly cancel?: (reason?: unknown) => PromiseLike<void>
}

/** A non-owning handle for an execution whose readiness is separate from completion. */
export type RuntimeManagedExecution<A> = {
  readonly readiness: Promise<Awaited<A>>
  readonly completion: Promise<void>
  readonly signal: AbortSignal
  readonly run: <B>(program: () => B | PromiseLike<B>) => Promise<Awaited<B>>
  readonly cancel: (reason?: unknown) => Promise<void>
}

/**
 * A non-owning view of a Runtime that can start isolated executions.
 *
 * The view deliberately contains only execution operations. Runtime disposal,
 * warmup, inspection, backend access and Scope ownership stay on `Runtime`.
 */
export interface RuntimeExecutor<in out Provided extends AnyService = any> {
  readonly run: <A>(
    program: CompleteExecution<Provided, A>,
    options?: RuntimeRunOptions
  ) => Promise<Awaited<A>>

  readonly runWith: <Request extends LayerInput, A>(
    layer: Request & CompleteExecutionLayer<Provided, Request>,
    program: CompleteExecution<Provided | ProvidedEnvironment<Request>, A>,
    options?: RuntimeRunOptions
  ) => Promise<Awaited<A>>

  readonly runWithManaged: <Request extends LayerInput, A>(
    layer: Request & CompleteExecutionLayer<Provided, Request>,
    program: CompleteExecution<Provided | ProvidedEnvironment<Request>, RuntimeManagedPlan<A>>,
    options?: RuntimeRunOptions
  ) => RuntimeManagedExecution<A>
}

/** Yieldable request for the executor active in the current Runtime context. */
export interface RuntimeExecutorRequest<Provided extends AnyService> {
  [Symbol.iterator](): Generator<ServiceRequirement<Provided>, RuntimeExecutor<Provided>, unknown>
  [Symbol.asyncIterator](): AsyncGenerator<
    ServiceRequirement<Provided>,
    RuntimeExecutor<Provided>,
    unknown
  >
}

const castRuntimeExecutor = <Provided extends AnyService>(
  value: RuntimeExecutor<any>
): RuntimeExecutor<Provided> => {
  // SAFETY: RuntimeExecutor views are stable references to one Runtime root;
  // this helper only changes the compile-time environment selected by a caller.
  return value as RuntimeExecutor<Provided>
}

const currentExecutor = <Provided extends AnyService>(): RuntimeExecutor<Provided> => {
  let context

  try {
    context = currentRuntimeContext()
  } catch (cause) {
    if (cause instanceof RuntimeContextNotConfiguredError) {
      throw new RuntimeExecutorNotConfiguredError()
    }

    throw cause
  }

  if (context.executor === undefined) {
    throw new RuntimeExecutorNotConfiguredError()
  }

  return castRuntimeExecutor<Provided>(context.executor)
}

/** Erase a Runtime executor's concrete environment for contextual storage. */
export const eraseRuntimeExecutor = <Provided extends AnyService>(
  executor: RuntimeExecutor<Provided>
): RuntimeExecutor<AnyService> => castRuntimeExecutor<AnyService>(executor)

/** Create one stable executor view from an existing Runtime execution handle. */
export const createRuntimeExecutor = <Provided extends AnyService>(
  executor: RuntimeExecutor<Provided>
): RuntimeExecutor<Provided> => Object.freeze({ ...executor })

/** Build the yieldable contextual executor request used by `Runtime.executor()`. */
export const makeRuntimeExecutorRequest = <
  Provided extends AnyService
>(): RuntimeExecutorRequest<Provided> => {
  const request: RuntimeExecutorRequest<Provided> = {
    // oxlint-disable-next-line require-yield
    *[Symbol.iterator](): Generator<
      ServiceRequirement<Provided>,
      RuntimeExecutor<Provided>,
      unknown
    > {
      return currentExecutor<Provided>()
    },
    // oxlint-disable-next-line require-yield
    async *[Symbol.asyncIterator](): AsyncGenerator<
      ServiceRequirement<Provided>,
      RuntimeExecutor<Provided>,
      unknown
    > {
      return currentExecutor<Provided>()
    }
  }

  return request
}
