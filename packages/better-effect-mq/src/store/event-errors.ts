// oxlint-disable anti-slop/no-unknown-parameters -- tagged-error guards accept arbitrary cross-package values.

import { TaggedError } from 'better-result'

import { hasTaggedError } from '../internal/tagged'
import type { JobEventCursor } from './event-store'

type TaggedErrorConstructor = abstract new (...args: never[]) => object

/** An infrastructure or validation failure from a durable event store. */
export class JobEventStoreFailure extends TaggedError('JobEventStoreFailure')<{
  readonly operation: string
  readonly message: string
}> {
  constructor(input: { readonly operation: string; readonly message: string }) {
    super(input)
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobEventStoreFailure')
  }
}

/** Returned when retention has removed the requested position. */
export class JobEventCursorExpiredError extends TaggedError('JobEventCursorExpiredError')<{
  readonly cursor: JobEventCursor
  readonly oldestAvailableCursor: JobEventCursor
  readonly message: string
}> {
  constructor(input: {
    readonly cursor: JobEventCursor
    readonly oldestAvailableCursor: JobEventCursor
  }) {
    super({
      ...input,
      message: `Job event cursor has expired; resume at ${input.oldestAvailableCursor}`
    })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobEventCursorExpiredError')
  }
}

/** A long-lived event consumer stopped because its caller or Runtime aborted it. */
export class JobEventConsumerAbortedError extends TaggedError('JobEventConsumerAbortedError')<{
  readonly message: string
}> {
  constructor() {
    super({ message: 'Job event consumer was aborted' })
  }

  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobEventConsumerAbortedError')
  }
}

export type JobEventStoreError = JobEventStoreFailure | JobEventCursorExpiredError
