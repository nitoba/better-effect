// oxlint-disable anti-slop/no-runtime-typeof -- Queue guards validate untrusted cross-package values.
// oxlint-disable anti-slop/no-unknown-parameters -- Queue definitions receive JavaScript boundary values.
// oxlint-disable anti-slop/no-chained-type-assertions -- the private declaration-only brand is restored after validation.

import { makeQueueName } from '../protocol'
import type { CodecLike, JobDefinition, JobDefinitionOptions, NonEmptyStringLiteral } from './job'
import { createJob } from './job'
import {
  isCallable,
  isFrozenSafely,
  markDescriptor,
  queueTypeId,
  readOwnDataProperty
} from './internal'

declare const QueueDefinitionTypeId: unique symbol

/** An immutable queue namespace used to define versioned Job descriptors. */
export interface QueueDefinition<Name extends string = string> {
  readonly [QueueDefinitionTypeId]: 'QueueDefinition'
  readonly queue: Name
  readonly name: Name
  readonly job: <
    const JobName extends string,
    const Version extends number,
    const PayloadCodec extends CodecLike,
    const ResultCodec extends CodecLike | undefined = undefined,
    const FailureCodec extends CodecLike | undefined = undefined
  >(
    name: NonEmptyStringLiteral<JobName>,
    options: JobDefinitionOptions<Version, PayloadCodec, ResultCodec, FailureCodec>
  ) => JobDefinition<Name, JobName, Version, PayloadCodec, ResultCodec, FailureCodec>
}

export type AnyQueueDefinition = QueueDefinition<string>

const isQueueDefinition = (value: unknown): value is AnyQueueDefinition => {
  const marker = readOwnDataProperty(value, queueTypeId)
  const queue = readOwnDataProperty(value, 'queue')
  const name = readOwnDataProperty(value, 'name')
  const job = readOwnDataProperty(value, 'job')

  return (
    marker.present &&
    marker.value === true &&
    queue.present &&
    typeof queue.value === 'string' &&
    queue.value.length > 0 &&
    name.present &&
    name.value === queue.value &&
    job.present &&
    isCallable(job.value) &&
    isFrozenSafely(value)
  )
}

export { isQueueDefinition }

const defineQueue = <const Name extends string>(
  name: NonEmptyStringLiteral<Name>
): QueueDefinition<Name> => {
  const checkedName = makeQueueName(name)

  if (checkedName.status === 'error') {
    throw checkedName.error
  }

  const descriptor = Object.freeze(
    markDescriptor(
      {
        queue: name,
        name,
        job: <
          const JobName extends string,
          const Version extends number,
          const PayloadCodec extends CodecLike,
          const ResultCodec extends CodecLike | undefined = undefined,
          const FailureCodec extends CodecLike | undefined = undefined
        >(
          jobName: NonEmptyStringLiteral<JobName>,
          options: JobDefinitionOptions<Version, PayloadCodec, ResultCodec, FailureCodec>
        ): JobDefinition<Name, JobName, Version, PayloadCodec, ResultCodec, FailureCodec> =>
          createJob(name, jobName, options)
      },
      queueTypeId
    )
  )

  // SAFETY: `name` was validated before the frozen Queue descriptor was built; the private brand is declaration-only.
  return descriptor as unknown as QueueDefinition<Name>
}

/** Type-level aliases for Queue definitions and their literal name. */
export declare namespace Queue {
  export type Any = AnyQueueDefinition
  export type Definition<Name extends string = string> = QueueDefinition<Name>
  export type Name<Current extends Any = Any> =
    Current extends QueueDefinition<infer Name> ? Name : never
}

export const Queue = {
  TypeId: queueTypeId,
  define: defineQueue,
  is: isQueueDefinition
} as const
