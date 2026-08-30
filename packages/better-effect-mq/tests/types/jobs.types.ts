// oxlint-disable anti-slop/no-unknown-parameters -- the fixture models untyped schemas and dependent callbacks.
// oxlint-disable anti-slop/no-known-value-widening -- assertions intentionally model boundary types.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions are the subject of these contracts.

import { expectTypeOf } from 'bun:test'
import { Result, type Result as ResultType, type StandardSchemaV1 } from 'better-result'

import { Effect, Service } from 'better-effect'

import { Codec, Job, JobRegistry, Queue, type JobDefinitionError } from '../../src'

const payload = Codec.json<{
  readonly messageId: string
  readonly tenantId: string
}>()
const result = Codec.string
const failure = Codec.json<{ readonly code: string }>()

const transformedSchema = {
  '~standard': {
    version: 1,
    vendor: 'jobs-types',
    types: {} as { readonly input: string; readonly output: { readonly id: string } },
    validate: (value: unknown): StandardSchemaV1.Result<{ readonly id: string }> => ({
      value: { id: String(value) }
    })
  }
} satisfies StandardSchemaV1<string, { readonly id: string }>
const transformedPayload = Codec.standardSchema({
  schema: transformedSchema,
  encode: (value) => Result.ok(value.id)
})

class Dependency extends Service<Dependency>()('Dependency') {}
const dependentEffect = Effect.gen(async function* () {
  yield* Dependency
  return Result.ok('dependent')
})
const nonPortableCodec = {
  encode: (_value: string) => dependentEffect,
  decode: (_value: unknown) => dependentEffect
}

const emails = Queue.define('emails')
const sendEmailV1 = emails.job('send-email', {
  version: 1,
  payload,
  result,
  failure,
  defaults: {
    attempts: 3,
    timeoutMs: 5_000,
    priority: 2
  },
  idempotencyKey: (value) => value.messageId,
  metadata: (value) => ({ tenantId: value.tenantId }),
  retryable: (value) => value.code !== 'blocked'
})

const sendEmailV2 = Job.define('send-email', {
  queue: emails,
  version: 2,
  payload,
  result,
  failure
})

expectTypeOf<Queue.Name<typeof emails>>().toEqualTypeOf<'emails'>()
expectTypeOf<Job.Queue<typeof sendEmailV1>>().toEqualTypeOf<'emails'>()
expectTypeOf<Job.Name<typeof sendEmailV1>>().toEqualTypeOf<'send-email'>()
expectTypeOf<Job.Version<typeof sendEmailV1>>().toEqualTypeOf<1>()
expectTypeOf<Job.PayloadInput<typeof sendEmailV1>>().toEqualTypeOf<{
  readonly messageId: string
  readonly tenantId: string
}>()
expectTypeOf<Job.Payload<typeof sendEmailV1>>().toEqualTypeOf<{
  readonly messageId: string
  readonly tenantId: string
}>()
expectTypeOf<Job.Success<typeof sendEmailV1>>().toEqualTypeOf<string>()
expectTypeOf<Job.Failure<typeof sendEmailV1>>().toEqualTypeOf<{ readonly code: string }>()
expectTypeOf<Job.Requirements<typeof sendEmailV1>>().toBeNever()
expectTypeOf<Job.Identity<typeof sendEmailV1>>().toEqualTypeOf<{
  readonly queue: 'emails'
  readonly name: 'send-email'
  readonly version: 1
}>()

const transformedJob = emails.job('transformed', {
  version: 1,
  payload: transformedPayload,
  idempotencyKey: ({ id }) => id
})
expectTypeOf<Job.PayloadInput<typeof transformedJob>>().toEqualTypeOf<string>()
expectTypeOf<Job.Payload<typeof transformedJob>>().toEqualTypeOf<{ readonly id: string }>()
expectTypeOf<Job.Requirements<typeof transformedJob>>().toBeNever()

emails.job('invalid-requirements', {
  version: 1,
  // @ts-expect-error Job payload codecs must be portable and requirement-free.
  payload: nonPortableCodec
})

const noOutcomeCodec = emails.job('no-outcome', { version: 1, payload })
expectTypeOf<Job.Success<typeof noOutcomeCodec>>().toBeNever()
expectTypeOf<Job.Failure<typeof noOutcomeCodec>>().toBeNever()

// @ts-expect-error Empty queue literals are rejected before runtime validation.
Queue.define('')
// @ts-expect-error Empty job-name literals are rejected before runtime validation.
emails.job('', { version: 1, payload })
// @ts-expect-error Zero is not a positive Job version.
emails.job('invalid-version', { version: 0, payload })
// @ts-expect-error Fractional versions are not positive integers.
emails.job('invalid-version', { version: 1.5, payload })
// @ts-expect-error A retry predicate needs a typed failure codec.
emails.job('invalid-retry', { version: 1, payload, retryable: () => true })
emails.job('invalid-callback', {
  version: 1,
  payload,
  idempotencyKey: (value) => {
    // @ts-expect-error Idempotency callbacks use the payload output shape.
    return value.missing
  }
})
emails.job('invalid-metadata', {
  version: 1,
  payload,
  // @ts-expect-error Metadata values must be strings.
  metadata: () => ({ tenantId: 1 })
})

const jobs = JobRegistry.make([sendEmailV1, sendEmailV2, noOutcomeCodec] as const)
type JobTuple = [typeof sendEmailV1, typeof sendEmailV2, typeof noOutcomeCodec]
type JobUnion = JobTuple[number]

expectTypeOf<JobRegistry.Definitions<typeof jobs>>().toEqualTypeOf<
  readonly [typeof sendEmailV1, typeof sendEmailV2, typeof noOutcomeCodec]
>()
expectTypeOf<JobRegistry.Jobs<typeof jobs>>().toEqualTypeOf<JobUnion>()
expectTypeOf(jobs.definitions).toEqualTypeOf<
  readonly [typeof sendEmailV1, typeof sendEmailV2, typeof noOutcomeCodec]
>()
expectTypeOf(jobs.accepted).toEqualTypeOf<
  readonly [
    Job.Identity<typeof sendEmailV1>,
    Job.Identity<typeof sendEmailV2>,
    Job.Identity<typeof noOutcomeCodec>
  ]
>()
expectTypeOf(jobs.acceptedClaimIdentities).toEqualTypeOf(jobs.accepted)

const known = jobs.lookup({ queue: 'emails', name: 'send-email', version: 1 })
const knownPositional = jobs.get('emails', 'send-email', 2)
const unknown = jobs.lookup({ queue: 'emails', name: 'send-email', version: 9 })
expectTypeOf(known).toEqualTypeOf<ResultType<typeof sendEmailV1, JobDefinitionError>>()
expectTypeOf(knownPositional).toEqualTypeOf<ResultType<typeof sendEmailV2, JobDefinitionError>>()
expectTypeOf(unknown).toEqualTypeOf<ResultType<never, JobDefinitionError>>()

const direct = Job.define('direct', { queue: emails, version: 1, payload })
expectTypeOf<Job.Queue<typeof direct>>().toEqualTypeOf<'emails'>()
expectTypeOf<Job.Payload<typeof direct>>().toEqualTypeOf<{
  readonly messageId: string
  readonly tenantId: string
}>()

void known
void knownPositional
void unknown
void direct
void jobs
void Result
