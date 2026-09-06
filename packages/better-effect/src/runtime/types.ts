import type { Layer } from '../layer/layer'
import type { LayerInput } from '../layer/inference'

import type { Runtime } from './runtime'
import type { RuntimeTaskMetadata } from './observer'
import type { RuntimeShutdownReason } from './outcome'

export type RuntimeState =
  | 'active'
  | 'quiescing'
  | 'draining'
  | 'aborting'
  | 'releasing'
  | 'disposed'

/** A detached diagnostic view of one active Runtime execution. */
export type RuntimeExecutionInspection = {
  readonly executionId: string
  readonly name?: string
  readonly startedAt: number
}

/** A detached diagnostic view of one active Scope-owned task. */
export type RuntimeTaskInspection = RuntimeTaskMetadata & {
  readonly state: 'running'
}

/**
 * A detached, immutable diagnostic view of a Runtime.
 *
 * Inspection never exposes Service instances, providers, Scopes or arbitrary
 * execution attributes. It is informational only and is not a synchronization
 * primitive or readiness guarantee.
 */
export type RuntimeInspection = {
  readonly state: RuntimeState
  readonly warmup: 'idle' | 'running' | 'completed' | 'failed'
  readonly activeExecutions: number
  readonly executions: readonly RuntimeExecutionInspection[]
  readonly activeTasks: number
  readonly tasks: readonly RuntimeTaskInspection[]
  readonly services: readonly string[]
  readonly shutdownSignalAborted: boolean
}

/** Public shutdown phase names emitted by Runtime observers. */
export type RuntimeShutdownPhase =
  | 'shutdown-requested'
  | 'quiesce-start'
  | 'quiesce-end'
  | 'drain-start'
  | 'drain-end'
  | 'abort-active'
  | 'release-start'
  | 'release-end'
  | 'shutdown-complete'
  | 'shutdown-failure'

/** Detached lifecycle event that contains no Service or resource instances. */
export type RuntimeShutdownPhaseEvent = {
  readonly phase: RuntimeShutdownPhase
  readonly reason: RuntimeShutdownReason
  readonly durationMs?: number
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
