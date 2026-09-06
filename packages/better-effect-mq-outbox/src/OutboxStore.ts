// oxlint-disable anti-slop/no-runtime-typeof -- named-token validation is an untyped public boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- named-token guards inspect untyped callers.
// oxlint-disable anti-slop/no-chained-type-assertions -- the Service factory's erased instance is restored at token boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- token assertions are guarded by validated tags and contracts.

import { Service } from 'better-effect'
import type { Effect, ServiceClass, ServiceRequirement } from 'better-effect'

import type {
  OutboxRecord,
  OutboxRecordInput,
  OutboxState,
  SerializedOutboxFailure
} from './OutboxRecord'
import type {
  OutboxDefinitionError,
  OutboxLeaseLostError,
  OutboxNotFoundError,
  OutboxProtocolMismatchError,
  OutboxStoreError,
  OutboxStoreFailure,
  OutboxConflictError
} from './errors'
import type { OutboxId, OutboxLeaseToken, OutboxWorkerId } from './identity'

export const outboxStoreTag = '@better-effect/mq/outbox/OutboxStore' as const
const outboxStoreTypeId = Symbol.for('better-effect-mq-outbox/OutboxStore')

/** A non-empty literal accepted by `OutboxStore.named`. */
export type OutboxStoreNameLiteral<Name extends string> = string extends Name
  ? never
  : Name extends ''
    ? never
    : Name

/** The stable Service tag used by the default and named outboxes. */
export type OutboxStoreTag<Name extends string | undefined = undefined> = [Name] extends [undefined]
  ? typeof outboxStoreTag
  : `${typeof outboxStoreTag}/${Extract<Name, string>}`

export type OutboxEffect<Success, Failure extends OutboxStoreError = OutboxStoreError> = Effect<
  Success,
  Failure,
  never
>

export type OutboxOperation<Success, Failure extends OutboxStoreError = OutboxStoreError> =
  | OutboxEffect<Success, Failure>
  | PromiseLike<OutboxEffect<Success, Failure>>

export interface OutboxStoreDescriptor {
  readonly protocolVersion: 1
  readonly adapter: string
  readonly adapterVersion: string
}

export interface OutboxClaimOptions {
  readonly owner: OutboxWorkerId
  readonly limit: number
  readonly leaseDurationMs: number
  readonly nowMs: number
}

export type LeasedOutboxRecord = OutboxRecord & {
  readonly state: 'active'
  readonly leaseOwner: OutboxWorkerId
  readonly leaseToken: OutboxLeaseToken
  readonly leaseExpiresAtMs: number
}

export interface OutboxLeaseRequest {
  readonly id: OutboxId
  readonly leaseToken: OutboxLeaseToken
  readonly nowMs: number
}

export interface OutboxHeartbeatRequest extends OutboxLeaseRequest {
  readonly leaseDurationMs: number
}

export interface OutboxRetryRequest extends OutboxLeaseRequest {
  readonly runAtMs: number
  readonly failure: SerializedOutboxFailure
}

export interface OutboxFailureRequest extends OutboxLeaseRequest {
  readonly failure: SerializedOutboxFailure
}

export interface OutboxRecoveryOptions {
  readonly maxCount: number
  readonly nowMs: number
}

export interface OutboxListOptions {
  readonly state?: OutboxState | readonly OutboxState[]
  readonly target?: string
  readonly limit?: number
}

export interface OutboxCounts {
  readonly pending: number
  readonly active: number
  readonly published: number
  readonly failed: number
  readonly total: number
}

export interface OutboxAppendResult {
  readonly record: OutboxRecord
  readonly duplicate: boolean
}

export interface OutboxSettlementResult {
  readonly record: OutboxRecord
  readonly status: 'applied' | 'already-applied'
}

export type OutboxAppendError = OutboxDefinitionError | OutboxConflictError | OutboxStoreFailure
export type OutboxClaimError = OutboxDefinitionError | OutboxStoreFailure
export type OutboxReadError = OutboxDefinitionError | OutboxNotFoundError | OutboxStoreFailure
export type OutboxLeaseError =
  | OutboxDefinitionError
  | OutboxNotFoundError
  | OutboxLeaseLostError
  | OutboxStoreFailure
export type OutboxSettlementError = OutboxLeaseError
export type OutboxRecoveryError = OutboxDefinitionError | OutboxStoreFailure
export type OutboxStoreProtocolError = OutboxProtocolMismatchError | OutboxDefinitionError

/** Post-commit operations used by the future publisher and storage adapters. */
export interface OutboxStore {
  readonly descriptor: OutboxStoreDescriptor
  claim(
    options: OutboxClaimOptions
  ): OutboxOperation<readonly LeasedOutboxRecord[], OutboxClaimError>
  heartbeat(request: OutboxHeartbeatRequest): OutboxOperation<LeasedOutboxRecord, OutboxLeaseError>
  markPublished(
    request: OutboxLeaseRequest
  ): OutboxOperation<OutboxSettlementResult, OutboxSettlementError>
  markRetry(request: OutboxRetryRequest): OutboxOperation<OutboxRecord, OutboxSettlementError>
  markFailed(request: OutboxFailureRequest): OutboxOperation<OutboxRecord, OutboxSettlementError>
  release(request: OutboxLeaseRequest): OutboxOperation<OutboxRecord, OutboxSettlementError>
  recoverStalled(
    options: OutboxRecoveryOptions
  ): OutboxOperation<readonly OutboxRecord[], OutboxRecoveryError>
  get(id: OutboxId): OutboxOperation<OutboxRecord | undefined, OutboxReadError>
  list(options?: OutboxListOptions): OutboxOperation<readonly OutboxRecord[], OutboxReadError>
  counts(): OutboxOperation<OutboxCounts, OutboxReadError>
}

/** A constructible, yieldable Service token for a default or named outbox. */
export type OutboxStoreInstance<Name extends string | undefined = undefined> = OutboxStore &
  Service.Identity<OutboxStoreTag<Name>>

export type OutboxStoreToken<Name extends string | undefined = undefined> = ServiceClass<
  OutboxStoreTag<Name>,
  OutboxStoreInstance<Name>
> &
  (new () => OutboxStoreInstance<Name>) & {
    readonly [Symbol.asyncIterator]: () => AsyncGenerator<
      ServiceRequirement<OutboxStoreInstance<Name>>,
      OutboxStoreInstance<Name>,
      unknown
    >
  }

export type DefaultOutboxStoreToken = OutboxStoreToken<undefined> & {
  readonly named: <const Named extends string>(
    name: OutboxStoreNameLiteral<Named>
  ) => OutboxStoreToken<Named>
}

export type AnyOutboxStoreToken = DefaultOutboxStoreToken | OutboxStoreToken<string>

const validateName = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw new TypeError('OutboxStore.named requires a non-empty string without NUL')
  }
  return value
}

const makeToken = <Name extends string | undefined>(name: Name): OutboxStoreToken<Name> => {
  const tag = (
    name === undefined ? outboxStoreTag : `${outboxStoreTag}/${name}`
  ) as OutboxStoreTag<Name>
  const token = Service<OutboxStoreInstance<Name>>()(tag as never)
  Object.defineProperty(token, outboxStoreTypeId, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  })
  return token as unknown as OutboxStoreToken<Name>
}

const namedOutboxStore = <const Name extends string>(
  name: OutboxStoreNameLiteral<Name>
): OutboxStoreToken<Name> => makeToken(validateName(name) as Name)

const defaultOutboxStore = makeToken(undefined)

Object.defineProperty(defaultOutboxStore, 'named', {
  configurable: false,
  enumerable: true,
  value: namedOutboxStore,
  writable: false
})

export declare namespace OutboxStore {
  export type Any = OutboxStoreInstance<undefined> | OutboxStoreInstance<string>
  export type Contract = OutboxStore
  export type Instance<Name extends string | undefined = undefined> = OutboxStoreInstance<Name>
  export type Token<Name extends string | undefined = undefined> = [Name] extends [undefined]
    ? DefaultOutboxStoreToken
    : OutboxStoreToken<Name>
  export type Tag<Name extends string | undefined = undefined> = OutboxStoreTag<Name>
  export type Effect<Success, Failure extends OutboxStoreError = OutboxStoreError> = OutboxEffect<
    Success,
    Failure
  >
  export type Operation<
    Success,
    Failure extends OutboxStoreError = OutboxStoreError
  > = OutboxOperation<Success, Failure>
  export type Error = OutboxStoreError
  export type Failure = OutboxStoreError
}

export const OutboxStore = defaultOutboxStore as DefaultOutboxStoreToken

/** Guard used by adapter and publisher boundaries. */
export const isOutboxStoreToken = (value: unknown): value is AnyOutboxStoreToken => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  try {
    const marker = Object.getOwnPropertyDescriptor(value, outboxStoreTypeId)
    const candidate = value as {
      readonly serviceTag?: unknown
      readonly [Symbol.asyncIterator]?: unknown
    }
    return (
      marker !== undefined &&
      'value' in marker &&
      marker.value === true &&
      typeof candidate.serviceTag === 'string' &&
      (candidate.serviceTag === outboxStoreTag ||
        candidate.serviceTag.startsWith(`${outboxStoreTag}/`)) &&
      typeof candidate[Symbol.asyncIterator] === 'function'
    )
  } catch {
    return false
  }
}

/** Reference-only append capability; database adapters expose `appendIn` with their real tx type. */
export interface OutboxAppendStore {
  append(input: OutboxRecordInput): OutboxOperation<OutboxAppendResult, OutboxAppendError>
}
