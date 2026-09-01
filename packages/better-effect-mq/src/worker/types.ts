import type { Effect, Service } from 'better-effect'

import type { AnyService, ServiceContract } from 'better-effect'
import type { AnyJobDefinition, Job } from '../job'
import type { JobContext } from './context'
import type { WorkerId } from '../protocol'

/** Optional concurrency override for one registered handler. */
export interface WorkerHandlerOptions {
  readonly concurrency?: number
}

/** A typed Job callback retained by a Worker supervisor. */
export interface WorkerHandler<
  Definition extends AnyJobDefinition = AnyJobDefinition,
  Requirements extends AnyService = AnyService
> {
  readonly job: Definition
  readonly definition: Definition
  readonly handler: (
    payload: Job.Payload<Definition>
  ) => Effect.Program<Job.Success<Definition>, Job.Failure<Definition>, Requirements>
  readonly run: (
    payload: Job.Payload<Definition>
  ) => Effect.Program<Job.Success<Definition>, Job.Failure<Definition>, Requirements>
  readonly concurrency: number | undefined
}

export type AnyWorkerHandler = WorkerHandler<any, any>

/** A source of epoch milliseconds used by store requests. */
export type WorkerClock = (() => number | Date) | { readonly now: () => number | Date }

/** Basic supervisor shutdown controls. */
export interface WorkerStopOptions {
  /** Cooperatively abort attempts already executing before waiting for them. */
  readonly abortActive?: boolean
}

/** Controls for waiting until all currently claimable work has settled. */
export interface WorkerAwaitIdleOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** Runtime failures observed by the supervisor without stopping other groups. */
export type WorkerErrorHandler = (cause: unknown) => void | PromiseLike<void>

/** Options shared by the Worker start and use entrypoints. */
export interface WorkerOptions<
  Handlers extends readonly AnyWorkerHandler[] = readonly AnyWorkerHandler[]
> {
  readonly handlers: Handlers
  readonly concurrency?: number
  /** Optional per-queue cap; the most restrictive global, queue, and handler cap wins. */
  readonly queueConcurrency?: number | Readonly<Record<string, number>>
  readonly leaseDurationMs?: number
  readonly pollIntervalMs?: number
  readonly workerId?: WorkerId
  readonly id?: WorkerId
  readonly now?: WorkerClock
  readonly onError?: WorkerErrorHandler
}

/** Public lifecycle handle returned by Worker.start. */
export interface WorkerHandle extends AsyncDisposable {
  readonly id: WorkerId
  readonly state: 'running' | 'stopping' | 'stopped'
  readonly activeCount: number
  stop(options?: WorkerStopOptions): Promise<void>
  awaitIdle(options?: WorkerAwaitIdleOptions): Promise<void>
}

type IsAny<Value> = 0 extends 1 & Value ? true : false

type SameTag<Left extends AnyService, Right extends AnyService> = [Service.Tag<Left>] extends [
  Service.Tag<Right>
]
  ? [Service.Tag<Right>] extends [Service.Tag<Left>]
    ? true
    : false
  : false

type SameContract<Left extends AnyService, Right extends AnyService> = [
  ServiceContract<Left>
] extends [ServiceContract<Right>]
  ? [ServiceContract<Right>] extends [ServiceContract<Left>]
    ? true
    : false
  : false

type SameService<Left extends AnyService, Right extends AnyService> =
  SameTag<Left, Right> extends true ? SameContract<Left, Right> : false

type HasWidenedTag<Services> = Services extends AnyService
  ? string extends Service.Tag<Services>
    ? true
    : false
  : false

type Matches<Required extends AnyService, Provided extends AnyService> = true extends (
  Provided extends AnyService ? SameService<Required, Provided> : false
)
  ? true
  : false

type MissingOne<Required extends AnyService, Provided extends AnyService> =
  Matches<Required, Provided> extends true ? never : Required

type MissingServices<Required extends AnyService, Provided extends AnyService> =
  IsAny<Required> extends true
    ? never
    : IsAny<Provided> extends true
      ? never
      : true extends HasWidenedTag<Required | Provided>
        ? never
        : Required extends AnyService
          ? MissingOne<Required, Provided>
          : never

type WithoutJobContext<Requirements extends AnyService> = Requirements extends AnyService
  ? SameService<Requirements, JobContext> extends true
    ? never
    : Requirements
  : never

type HandlerRequirement<Handler extends AnyWorkerHandler> =
  Handler extends WorkerHandler<infer Definition, infer Requirements>
    ? WithoutJobContext<Requirements> | Job.Requirements<Definition>
    : never

/** All external Services needed by the handlers and their bound stores. */
export type WorkerRequirements<Handlers extends readonly AnyWorkerHandler[]> = HandlerRequirement<
  Handlers[number]
>

/** Diagnostic attached to Worker options when a Runtime is incomplete. */
type MissingDependencies<Missing extends AnyService> = {
  readonly missingServices: Missing
}

type CompleteWorkerOptionsConstraint<
  Provided extends AnyService,
  Handlers extends readonly AnyWorkerHandler[]
> = [MissingServices<WorkerRequirements<Handlers>, Provided>] extends [never]
  ? unknown
  : MissingDependencies<
      Extract<MissingServices<WorkerRequirements<Handlers>, Provided>, AnyService>
    >

/** Start options after checking every handler and store requirement. */
export type CompleteWorkerOptions<
  Provided extends AnyService,
  Handlers extends readonly AnyWorkerHandler[]
> = WorkerOptions<Handlers> & CompleteWorkerOptionsConstraint<Provided, Handlers>
