// oxlint-disable anti-slop/no-unknown-parameters -- tagged-error guards accept arbitrary boundary values.

import { TaggedError } from 'better-result'

import { hasTaggedError } from '../internal/tagged'

type TaggedErrorConstructor = abstract new (...args: never[]) => object

const messageOr = (message: string | undefined, fallback: string): string => message ?? fallback

export class ScheduleStoreFailure extends TaggedError('ScheduleStoreFailure')<{
  readonly operation: string
  readonly retryable: boolean
  readonly message: string
  readonly cause?: unknown
}> {
  constructor(args: {
    readonly operation: string
    readonly retryable?: boolean
    readonly message?: string
    readonly cause?: unknown
  }) {
    super({
      operation: args.operation,
      retryable: args.retryable ?? false,
      message: messageOr(args.message, `Schedule store operation failed: ${args.operation}`),
      cause: args.cause
    })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'ScheduleStoreFailure')
  }
}

export class ScheduleDefinitionError extends TaggedError('ScheduleDefinitionError')<{
  readonly field: string
  readonly message: string
}> {
  constructor(args: { readonly field: string; readonly message: string }) {
    super(args)
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'ScheduleDefinitionError')
  }
}

export class ScheduleNotFoundError extends TaggedError('ScheduleNotFoundError')<{
  readonly group: string | undefined
  readonly key: string
  readonly message: string
}> {
  constructor(args: { readonly key: string; readonly group?: string; readonly message?: string }) {
    super({
      key: args.key,
      group: args.group,
      message: messageOr(
        args.message,
        args.group === undefined
          ? `Schedule "${args.key}" was not found`
          : `Schedule "${args.group}/${args.key}" was not found`
      )
    })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'ScheduleNotFoundError')
  }
}

export class DuplicateScheduleError extends TaggedError('DuplicateScheduleError')<{
  readonly group: string
  readonly key: string
  readonly message: string
}> {
  constructor(args: { readonly group: string; readonly key: string; readonly message?: string }) {
    super({
      group: args.group,
      key: args.key,
      message: messageOr(args.message, `Schedule "${args.group}/${args.key}" already exists`)
    })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'DuplicateScheduleError')
  }
}
