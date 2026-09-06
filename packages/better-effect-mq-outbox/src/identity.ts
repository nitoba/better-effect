// oxlint-disable anti-slop/no-unknown-parameters -- identity constructors validate untrusted persistence values.
// oxlint-disable anti-slop/no-runtime-typeof -- identity validation is the public boundary parser.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- brands are applied only after validation.

import { Result, type Result as ResultType } from 'better-result'

import { OutboxDefinitionError } from './errors'

declare const OutboxIdBrand: unique symbol
declare const OutboxLeaseTokenBrand: unique symbol
declare const OutboxWorkerIdBrand: unique symbol

export type OutboxId = string & { readonly [OutboxIdBrand]: 'OutboxId' }
export type OutboxLeaseToken = string & {
  readonly [OutboxLeaseTokenBrand]: 'OutboxLeaseToken'
}
export type OutboxWorkerId = string & { readonly [OutboxWorkerIdBrand]: 'OutboxWorkerId' }

const makeIdentity = <Brand extends string>(
  value: unknown,
  field: string,
  brand: (value: string) => Brand
): ResultType<Brand, OutboxDefinitionError> => {
  if (typeof value !== 'string' || value.length === 0) {
    return Result.err(new OutboxDefinitionError({ field, message: 'must be a non-empty string' }))
  }
  if (value.includes('\u0000')) {
    return Result.err(new OutboxDefinitionError({ field, message: 'must not contain NUL' }))
  }
  return Result.ok(brand(value))
}

const asOutboxId = (value: string): OutboxId => value as OutboxId
const asOutboxLeaseToken = (value: string): OutboxLeaseToken => value as OutboxLeaseToken
const asOutboxWorkerId = (value: string): OutboxWorkerId => value as OutboxWorkerId

export const makeOutboxId = (value: unknown): ResultType<OutboxId, OutboxDefinitionError> =>
  makeIdentity(value, 'id', asOutboxId)

export const makeOutboxLeaseToken = (
  value: unknown
): ResultType<OutboxLeaseToken, OutboxDefinitionError> =>
  makeIdentity(value, 'leaseToken', asOutboxLeaseToken)

export const makeOutboxWorkerId = (
  value: unknown
): ResultType<OutboxWorkerId, OutboxDefinitionError> =>
  makeIdentity(value, 'owner', asOutboxWorkerId)

export const OutboxId = { make: makeOutboxId } as const
export const OutboxLeaseToken = { make: makeOutboxLeaseToken } as const
export const OutboxWorkerId = { make: makeOutboxWorkerId } as const
