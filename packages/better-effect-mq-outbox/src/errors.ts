// oxlint-disable anti-slop/no-unknown-parameters -- tagged error guards accept arbitrary boundary values.
// oxlint-disable anti-slop/no-runtime-typeof -- tagged error guards inspect untrusted values.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the guard checks the shape before reading the tag.

import { TaggedError } from 'better-result'

type TaggedErrorConstructor = abstract new (...args: never[]) => object

const hasTag = (value: unknown, tag: string): boolean => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false

  try {
    return (value as { readonly _tag?: unknown })._tag === tag
  } catch {
    return false
  }
}

const messageOr = (message: string | undefined, fallback: string): string => message ?? fallback

export class OutboxDefinitionError extends TaggedError('OutboxDefinitionError')<{
  readonly field: string
  readonly message: string
}> {
  constructor(args: { readonly field: string; readonly message?: string }) {
    super({
      field: args.field,
      message: messageOr(args.message, `Invalid outbox value: ${args.field}`)
    })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTag(value, 'OutboxDefinitionError')
  }
}

export class OutboxConflictError extends TaggedError('OutboxConflictError')<{
  readonly id: string
  readonly existingDigest: string
  readonly incomingDigest: string
  readonly message: string
}> {
  constructor(args: {
    readonly id: string
    readonly existingDigest: string
    readonly incomingDigest: string
    readonly message?: string
  }) {
    super({
      id: args.id,
      existingDigest: args.existingDigest,
      incomingDigest: args.incomingDigest,
      message: messageOr(
        args.message,
        `Outbox record "${args.id}" conflicts with an existing request`
      )
    })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTag(value, 'OutboxConflictError')
  }
}

export class OutboxStoreFailure extends TaggedError('OutboxStoreFailure')<{
  readonly operation: string
  readonly retryable: boolean
  readonly message: string
  readonly cause?: unknown
}> {
  constructor(args: {
    readonly operation: string
    readonly retryable: boolean
    readonly message?: string
    readonly cause?: unknown
  }) {
    const payload = {
      operation: args.operation,
      retryable: args.retryable,
      message: messageOr(args.message, `Outbox store operation failed: ${args.operation}`),
      cause: args.cause
    }
    super(payload)
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTag(value, 'OutboxStoreFailure')
  }
}

export class OutboxNotFoundError extends TaggedError('OutboxNotFoundError')<{
  readonly id: string
  readonly message: string
}> {
  constructor(args: { readonly id: string; readonly message?: string }) {
    super({
      id: args.id,
      message: messageOr(args.message, `Outbox record "${args.id}" was not found`)
    })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTag(value, 'OutboxNotFoundError')
  }
}

export type OutboxLeaseLossReason =
  | 'missing-token'
  | 'mismatched-token'
  | 'expired-lease'
  | 'not-active'

export class OutboxLeaseLostError extends TaggedError('OutboxLeaseLostError')<{
  readonly id: string
  readonly leaseToken: string | undefined
  readonly reason: OutboxLeaseLossReason
  readonly message: string
}> {
  constructor(args: {
    readonly id: string
    readonly leaseToken?: string
    readonly reason: OutboxLeaseLossReason
    readonly message?: string
  }) {
    super({
      id: args.id,
      leaseToken: args.leaseToken,
      reason: args.reason,
      message: messageOr(args.message, `Outbox lease for "${args.id}" is no longer owned`)
    })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTag(value, 'OutboxLeaseLostError')
  }
}

export class OutboxProtocolMismatchError extends TaggedError('OutboxProtocolMismatchError')<{
  readonly expected: number
  readonly actual: number | string | undefined
  readonly message: string
}> {
  constructor(args: { readonly actual: number | string | undefined; readonly message?: string }) {
    super({
      expected: 1,
      actual: args.actual,
      message: messageOr(
        args.message,
        `Outbox protocol mismatch: expected v1, received ${String(args.actual)}`
      )
    })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTag(value, 'OutboxProtocolMismatchError')
  }
}

export type OutboxStoreError =
  | OutboxDefinitionError
  | OutboxConflictError
  | OutboxStoreFailure
  | OutboxNotFoundError
  | OutboxLeaseLostError
  | OutboxProtocolMismatchError
