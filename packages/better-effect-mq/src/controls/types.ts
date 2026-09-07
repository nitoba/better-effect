import type {
  Effect,
  Service,
  ServiceContract,
  ServiceRequirement,
  ServiceToken
} from 'better-effect'
import type { Err, Result as ResultType } from 'better-result'

import type { QueueDefinition } from '../job'
import type { QueueName } from '../protocol'
import type {
  ControlledClaimRequest,
  ControlledClaimResult,
  ControlledCancelRequest,
  ControlledRecoverStalledRequest,
  ControlledReleaseRequest,
  ControlledSettleRequest,
  ControlledSettlementResult,
  ControlledJobStoreContract,
  QueueControlsRecord
} from '../store/controlled'
import type { JobStoreError } from '../store/errors'

export const controlsExtension = 'better-effect-mq/controls' as const
export const controlsProtocolVersion = 3 as const

export type DispatchKey = string & { readonly __dispatchKey: unique symbol }

export interface RateLimitOptions {
  readonly max: number
  readonly durationMs: number
}

export interface ConcurrencyKeyOptions<Payload = unknown> {
  readonly derive: (payload: Payload) => string | undefined
  readonly max: number
}

export interface QueueControlsOptions<Payload = unknown> {
  readonly globalConcurrency?: number
  readonly perKeyConcurrency?: number
  readonly concurrencyKey?: ConcurrencyKeyOptions<Payload>
  readonly rateLimit?: RateLimitOptions
}

export interface QueueControlDefinition<
  Queue extends QueueDefinition<string> = QueueDefinition<string>,
  Payload = unknown
> {
  readonly queue: Queue['queue']
  readonly options: QueueControlsOptions<Payload>
}

export type AnyQueueControlDefinition = QueueControlDefinition<QueueDefinition<string>, never>

export interface QueueControlsRegistry<
  Definitions extends readonly AnyQueueControlDefinition[] = readonly AnyQueueControlDefinition[]
> {
  readonly group: string
  readonly controls: Readonly<Definitions>
}

export type AnyQueueControlsRegistry = QueueControlsRegistry

export type ControlsReconcileRemoval = 'ignore' | 'warn' | 'disable'

export interface ControlsReconcileOptions {
  readonly removal?: ControlsReconcileRemoval
}

export interface ControlsReconcileReport {
  readonly created: readonly QueueControlsRecord[]
  readonly updated: readonly QueueControlsRecord[]
  readonly unchanged: readonly QueueControlsRecord[]
  readonly disabled: readonly QueueControlsRecord[]
  readonly warnings: readonly string[]
  readonly records: readonly QueueControlsRecord[]
}

export interface QueueControlsContract {
  readonly descriptor: {
    readonly extension: typeof controlsExtension
    readonly extensionVersion: typeof controlsProtocolVersion
    readonly jobStoreProtocolVersion: 1
  }
  reconcile(
    registry: AnyQueueControlsRegistry,
    options?: ControlsReconcileOptions
  ): Effect<ControlsReconcileReport, JobStoreError>
  get(queue: QueueName): Effect<QueueControlsRecord | undefined, JobStoreError>
  claimControlled(request: ControlledClaimRequest): Effect<ControlledClaimResult, JobStoreError>
  settleControlled(
    request: ControlledSettleRequest
  ): Effect<ControlledSettlementResult, JobStoreError>
  releaseControlled(request: ControlledReleaseRequest): Effect<unknown, JobStoreError>
  recoverStalledControlled(request: ControlledRecoverStalledRequest): Effect<unknown, JobStoreError>
  cancelControlled(request: ControlledCancelRequest): Effect<unknown, JobStoreError>
}

export type QueueControlsInstance<Tag extends string = '@better-effect/mq/QueueControls'> =
  QueueControlsContract & Service.Identity<Tag>

export type QueueControlsToken<Tag extends string = '@better-effect/mq/QueueControls'> =
  ServiceToken<Tag, QueueControlsInstance<Tag>> & {
    readonly layer: (
      factory: () => ServiceContract<QueueControlsInstance<Tag>> | ControlledJobStoreContract
    ) => import('better-effect').Layer<QueueControlsInstance<Tag>, never>
  }

export type QueueControlsEffect<Success, Failure = Error> = AsyncGenerator<
  Err<never, Failure> | ServiceRequirement<QueueControlsInstance>,
  Success,
  unknown
>

export type QueueControlsOperation<Success, Failure = Error> = QueueControlsEffect<Success, Failure>

export type ControlledEffect<Success, Failure = Error> = ResultType<Success, Failure>
