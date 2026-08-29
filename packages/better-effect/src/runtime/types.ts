import type { Layer } from '../layer/layer'
import type { LayerInput } from '../layer/inference'

import type { Runtime } from './runtime'

/** A detached diagnostic view of one active Runtime execution. */
export type RuntimeExecutionInspection = {
  readonly executionId: string
  readonly name?: string
  readonly startedAt: number
}

/**
 * A detached, immutable diagnostic view of a Runtime.
 *
 * Inspection never exposes Service instances, providers, Scopes or arbitrary
 * execution attributes. It is informational only and is not a synchronization
 * primitive or readiness guarantee.
 */
export type RuntimeInspection = {
  readonly state: 'active' | 'disposing' | 'disposed'
  readonly warmup: 'idle' | 'running' | 'completed' | 'failed'
  readonly activeExecutions: number
  readonly executions: readonly RuntimeExecutionInspection[]
  readonly services: readonly string[]
  readonly shutdownSignalAborted: boolean
}

/**
 * Name a Runtime type from a concrete Layer without repeating its provided
 * branded Service instance union.
 *
 * @example
 * ```ts
 * type AppRuntime = RuntimeFor<typeof AppLive>
 * ```
 */
export type RuntimeFor<L extends LayerInput> = Runtime<Layer.Provided<L>>
