// oxlint-disable anti-slop/no-runtime-typeof -- validate the public associated-token boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- token guards inspect untyped callers.
// oxlint-disable anti-slop/no-chained-type-assertions -- Service's erased instance is restored at one token boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- token casts are justified by the structural contract below.

import { Service } from 'better-effect'

import type { ServiceClass, ServiceRequirement } from 'better-effect'

import { JobStore, isJobStoreToken } from './store'
import type { AnyJobStoreToken, DefaultJobStoreToken, JobStoreToken } from './store'
import type {
  FlowStoreV2,
  FlowStoreV2Descriptor,
  FlowStoreV2Error,
  FlowStoreV2Operation
} from './flow-v2'

export const flowStoreTag = '@better-effect/mq/FlowStore' as const
const flowStoreTypeId = Symbol.for('better-effect-mq/FlowStore')

export type FlowStoreTag<Store extends AnyJobStoreToken = DefaultJobStoreToken> =
  Store extends DefaultJobStoreToken
    ? typeof flowStoreTag
    : Store extends JobStoreToken<infer Name>
      ? `${typeof flowStoreTag}/${Extract<Name, string>}`
      : `${typeof flowStoreTag}/${string}`

export type FlowStoreInstance<Store extends AnyJobStoreToken = DefaultJobStoreToken> = FlowStoreV2 &
  Service.Identity<FlowStoreTag<Store>>

export type FlowStoreToken<Store extends AnyJobStoreToken = DefaultJobStoreToken> = ServiceClass<
  FlowStoreTag<Store>,
  FlowStoreInstance<Store>
> &
  (new () => FlowStoreInstance<Store>) & {
    readonly jobStore: Store
    readonly store: Store
    readonly [Symbol.asyncIterator]: () => AsyncGenerator<
      ServiceRequirement<FlowStoreInstance<Store>>,
      FlowStoreInstance<Store>,
      unknown
    >
  }

export type DefaultFlowStoreToken = FlowStoreToken<DefaultJobStoreToken> & {
  readonly for: <Store extends AnyJobStoreToken>(store: Store) => FlowStoreToken<Store>
}

export type AnyFlowStoreToken = DefaultFlowStoreToken | FlowStoreToken<AnyJobStoreToken>

const makeToken = <Store extends AnyJobStoreToken>(store: Store): FlowStoreToken<Store> => {
  const tag = (
    store.serviceTag === JobStore.serviceTag
      ? flowStoreTag
      : `${flowStoreTag}/${store.serviceTag.slice(`${JobStore.serviceTag}/`.length)}`
  ) as FlowStoreTag<Store>
  const token = Service<FlowStoreInstance<Store>>()(tag as never)

  Object.defineProperties(token, {
    [flowStoreTypeId]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false
    },
    jobStore: {
      configurable: false,
      enumerable: true,
      value: store,
      writable: false
    },
    store: {
      configurable: false,
      enumerable: true,
      value: store,
      writable: false
    }
  })

  // SAFETY: the token is extended only with the validated associated JobStore metadata.
  return token as unknown as FlowStoreToken<Store>
}

const forJobStore = <Store extends AnyJobStoreToken>(store: Store): FlowStoreToken<Store> => {
  if (!isJobStoreToken(store)) {
    throw new TypeError('FlowStore.for requires a JobStore token')
  }
  return makeToken(store)
}

const defaultFlowStoreToken = makeToken(JobStore)

Object.defineProperty(defaultFlowStoreToken, 'for', {
  configurable: false,
  enumerable: true,
  value: forJobStore,
  writable: false
})

export interface FlowStore<
  Store extends AnyJobStoreToken = DefaultJobStoreToken
> extends FlowStoreInstance<Store> {}

export declare namespace FlowStore {
  export type Any = FlowStoreInstance<AnyJobStoreToken>
  export type Contract = FlowStoreV2
  export type Descriptor = FlowStoreV2Descriptor
  export type Error = FlowStoreV2Error
  export type Instance<Store extends AnyJobStoreToken = DefaultJobStoreToken> =
    FlowStoreInstance<Store>
  export type Operation<Success> = FlowStoreV2Operation<Success>
  export type Token<Store extends AnyJobStoreToken = DefaultJobStoreToken> =
    Store extends DefaultJobStoreToken ? DefaultFlowStoreToken : FlowStoreToken<Store>
}

export const FlowStore = defaultFlowStoreToken as DefaultFlowStoreToken

export const isFlowStoreToken = (value: unknown): value is AnyFlowStoreToken => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false

  try {
    const marker = Object.getOwnPropertyDescriptor(value, flowStoreTypeId)
    const candidate = value as {
      readonly serviceTag?: unknown
      readonly jobStore?: unknown
      readonly [Symbol.asyncIterator]?: unknown
    }
    return (
      marker !== undefined &&
      'value' in marker &&
      marker.value === true &&
      typeof candidate.serviceTag === 'string' &&
      (candidate.serviceTag === flowStoreTag ||
        candidate.serviceTag.startsWith(`${flowStoreTag}/`)) &&
      isJobStoreToken(candidate.jobStore) &&
      typeof candidate[Symbol.asyncIterator] === 'function'
    )
  } catch {
    return false
  }
}
