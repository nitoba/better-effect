// oxlint-disable anti-slop/no-runtime-typeof -- named outbox tokens validate an untyped JavaScript boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- named token guards inspect untyped callers.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts restore the declaration-only Service contract.
// oxlint-disable anti-slop/no-chained-type-assertions -- the token factory bridges Service's generic constructor type.

import { Service } from 'better-effect'
import type { ServiceClass, ServiceRequirement } from 'better-effect'
import type { OutboxStore as OutboxStoreContract } from 'better-effect-mq-outbox'

export const outboxStoreTag = '@better-effect/mq/OutboxStore' as const
const outboxStoreTypeId = Symbol.for('better-effect-mq/OutboxStore')

export type OutboxStoreNameLiteral<Name extends string> = string extends Name
  ? never
  : Name extends ''
    ? never
    : Name

export type OutboxStoreTag<Name extends string | undefined = undefined> = [Name] extends [undefined]
  ? typeof outboxStoreTag
  : `${typeof outboxStoreTag}/${Extract<Name, string>}`

export type OutboxStoreInstance<Name extends string | undefined = undefined> = OutboxStoreContract &
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
  readonly named: <const Name extends string>(
    name: OutboxStoreNameLiteral<Name>
  ) => OutboxStoreToken<Name>
}

export type AnyOutboxStoreToken = DefaultOutboxStoreToken | OutboxStoreToken<string>

const validateName = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000'))
    throw new TypeError('OutboxStore.named requires a non-empty string name')
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
): OutboxStoreToken<Name> => {
  const validated = validateName(name)
  // SAFETY: validateName proves the runtime string is a non-empty OutboxStore name.
  return makeToken(validated as Name)
}

const defaultOutboxStore = makeToken(undefined)
Object.defineProperty(defaultOutboxStore, 'named', {
  configurable: false,
  enumerable: true,
  value: namedOutboxStore,
  writable: false
})

export interface OutboxStore extends OutboxStoreInstance<undefined> {}

export declare namespace OutboxStore {
  export type Any = OutboxStoreInstance<undefined> | OutboxStoreInstance<string>
  export type Contract = OutboxStoreContract
  export type Instance<Name extends string | undefined = undefined> = OutboxStoreInstance<Name>
  export type Token<Name extends string | undefined = undefined> = [Name] extends [undefined]
    ? DefaultOutboxStoreToken
    : OutboxStoreToken<Name>
}

export const OutboxStore = defaultOutboxStore as DefaultOutboxStoreToken

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
