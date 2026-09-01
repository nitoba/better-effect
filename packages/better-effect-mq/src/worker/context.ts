// oxlint-disable anti-slop/no-runtime-typeof -- JobContext validates untyped metadata at its public constructor boundary.

import { Layer, Service } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

import {
  JobDefinitionError,
  JobId as JobIdFactory,
  JobName as JobNameFactory,
  QueueName as QueueNameFactory,
  WorkerId as WorkerIdFactory
} from '../protocol'
import type { JobId, QueueName, WorkerId } from '../protocol'

/** The immutable execution-local information supplied to one Job attempt. */
export interface JobContextInput {
  readonly jobId: JobId
  readonly queue: QueueName
  readonly name: string
  readonly version: number
  readonly attempt: number
  readonly attemptsMax: number
  readonly delivery: number
  readonly workerId: WorkerId
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Services exposed only while one Worker attempt is executing.
 *
 * The lease token intentionally is not part of this context. Settlement is a
 * supervisor concern; handlers receive cancellation through CurrentAbortSignal.
 */
export class JobContext extends Service<JobContext>()('@better-effect/mq/JobContext') {
  readonly jobId: JobId
  readonly queue: QueueName
  readonly name: string
  readonly version: number
  readonly attempt: number
  readonly attemptsMax: number
  readonly delivery: number
  readonly workerId: WorkerId
  readonly metadata: Readonly<Record<string, string>>

  constructor(input: JobContextInput) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new JobDefinitionError({ field: 'context', message: 'must be an object' })
    }

    super()
    this.jobId = requireIdentity(JobIdFactory.make(input.jobId), 'jobId')
    this.queue = requireIdentity(QueueNameFactory.make(input.queue), 'queue')
    this.name = requireIdentity(JobNameFactory.make(input.name), 'name')
    this.version = positiveInteger(input.version, 'version')
    this.attempt = positiveInteger(input.attempt, 'attempt')
    this.attemptsMax = positiveInteger(input.attemptsMax, 'attemptsMax')
    this.delivery = positiveInteger(input.delivery, 'delivery')
    this.workerId = requireIdentity(WorkerIdFactory.make(input.workerId), 'workerId')
    this.metadata = freezeMetadata(input.metadata)
    Object.freeze(this)
  }

  /** Provide a context to one Runtime execution without retaining it globally. */
  static layer(context: JobContext | JobContextInput): Layer<JobContext, never> {
    return Layer.succeed(
      JobContext,
      context instanceof JobContext ? context : new JobContext(context)
    )
  }
}

const requireIdentity = <Value>(
  result: ResultType<Value, JobDefinitionError>,
  field: string
): Value => {
  if (Result.isError(result)) {
    throw new JobDefinitionError({ field, message: 'must be a valid identity' })
  }

  return result.value
}

const positiveInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new JobDefinitionError({ field, message: 'must be a positive safe integer' })
  }

  return value
}

const freezeMetadata = (
  metadata: Readonly<Record<string, string>>
): Readonly<Record<string, string>> => {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('JobContext metadata must be a plain object')
  }

  const prototype = Object.getPrototypeOf(metadata)

  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('JobContext metadata must be a plain object')
  }

  const copied: Record<string, string> = {}

  for (const key of Reflect.ownKeys(metadata)) {
    if (typeof key !== 'string') {
      throw new TypeError('JobContext metadata keys must be strings')
    }

    const descriptor = Object.getOwnPropertyDescriptor(metadata, key)

    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string'
    ) {
      throw new TypeError(`JobContext metadata value for ${key} must be a string`)
    }

    Object.defineProperty(copied, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: false
    })
  }

  return Object.freeze(copied)
}
