// oxlint-disable anti-slop/no-unknown-parameters -- type fixtures model untyped Standard Schema callbacks.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions are the subject of these type contracts.

import { expectTypeOf } from 'bun:test'
import { Result, type StandardSchemaV1 } from 'better-result'

import { Effect, Service } from 'better-effect'

import { Codec, JobDecodeFailure, JobEncodeFailure, type JsonValue } from '../../src'

type InputOutput<Input, Output> = {
  input: Input
  output: Output
}

type User = {
  readonly id: string
  readonly active: boolean
}

const jsonCodec = Codec.json<User>()
const plainResult = Result.ok('plain')
expectTypeOf<Effect.Requirements<typeof plainResult>>().toBeNever()
expectTypeOf<Codec.Input<typeof jsonCodec>>().toEqualTypeOf<User>()
expectTypeOf<Codec.Value<typeof jsonCodec>>().toEqualTypeOf<User>()
expectTypeOf<Effect.Success<ReturnType<typeof jsonCodec.encode>>>().toEqualTypeOf<JsonValue>()
expectTypeOf<Effect.Success<ReturnType<typeof jsonCodec.decode>>>().toEqualTypeOf<User>()
expectTypeOf<Effect.Error<ReturnType<typeof jsonCodec.encode>>>().toEqualTypeOf<JobEncodeFailure>()
expectTypeOf<Effect.Error<ReturnType<typeof jsonCodec.decode>>>().toEqualTypeOf<JobDecodeFailure>()
expectTypeOf<Effect.Requirements<ReturnType<typeof jsonCodec.encode>>>().toBeNever()
expectTypeOf<Effect.Requirements<ReturnType<typeof jsonCodec.decode>>>().toBeNever()

const custom = Codec.make<User>({
  encode: (value) => Result.ok({ id: value.id, active: value.active }),
  decode: (value) => Result.ok(value as User)
})

const invalidCustom = Codec.make<Date>({
  // @ts-expect-error Custom encoders must produce JSON-safe values.
  encode: () => Result.ok(new Date()),
  decode: (value) => Result.ok(new Date(String(value)))
})
void invalidCustom
expectTypeOf<Codec.Input<typeof custom>>().toEqualTypeOf<User>()
expectTypeOf<Codec.Value<typeof custom>>().toEqualTypeOf<User>()
expectTypeOf<Effect.Success<ReturnType<typeof custom.encode>>>().toEqualTypeOf<JsonValue>()
expectTypeOf<Effect.Success<ReturnType<typeof custom.decode>>>().toEqualTypeOf<User>()
expectTypeOf<Effect.Requirements<ReturnType<typeof custom.encode>>>().toBeNever()
expectTypeOf<Effect.Requirements<ReturnType<typeof custom.decode>>>().toBeNever()

const resultCallbacks = Codec.make<User>({
  encode: (value) => Result.ok({ id: value.id, active: value.active }),
  decode: (value) => Result.ok({ id: String(value), active: true })
})
expectTypeOf<Effect.Success<ReturnType<typeof resultCallbacks.encode>>>().toEqualTypeOf<JsonValue>()
expectTypeOf<Effect.Success<ReturnType<typeof resultCallbacks.decode>>>().toEqualTypeOf<User>()

const asyncCallbacks = Codec.make<User>({
  encode: async (value) => Result.ok({ id: value.id, active: value.active }),
  decode: async (value) => Result.ok({ id: String(value), active: false })
})
expectTypeOf<Effect.Success<ReturnType<typeof asyncCallbacks.encode>>>().toEqualTypeOf<JsonValue>()
expectTypeOf<Effect.Success<ReturnType<typeof asyncCallbacks.decode>>>().toEqualTypeOf<User>()

const requirementFreeEffect = Effect.gen(function* () {
  yield* Result.ok(undefined)
  return Result.ok('free')
})
const requirementFreeObjectEffect = Effect.gen(function* () {
  yield* Result.ok(undefined)
  return Result.ok({ decoded: true })
})

const resultUnknown = Codec.make<unknown>({
  encode: () => Result.ok({ encoded: true }),
  decode: () => Result.ok('decoded')
})
const resultObject = Codec.make<object>({
  encode: () => Result.ok({ encoded: true }),
  decode: () => Result.ok({ decoded: true })
})
const resultUnion = Codec.make<string | Date>({
  encode: () => Result.ok('encoded'),
  decode: () => Result.ok('decoded')
})
const effectUnknown = Codec.make<unknown>({
  encode: () => requirementFreeEffect,
  decode: () => requirementFreeEffect
})
const effectObject = Codec.make<object>({
  encode: () => requirementFreeObjectEffect,
  decode: () => requirementFreeObjectEffect
})
const promiseResult = Codec.make<unknown>({
  encode: () => Promise.resolve(Result.ok('encoded')),
  decode: () => Promise.resolve(Result.ok('decoded'))
})
const promiseEffect = Codec.make<unknown>({
  encode: () => Promise.resolve(requirementFreeEffect),
  decode: () => Promise.resolve(requirementFreeEffect)
})
expectTypeOf<Effect.Requirements<ReturnType<typeof resultUnknown.encode>>>().toBeNever()
expectTypeOf<Effect.Requirements<ReturnType<typeof resultObject.decode>>>().toBeNever()
expectTypeOf<Effect.Requirements<ReturnType<typeof resultUnion.encode>>>().toBeNever()
expectTypeOf<Effect.Requirements<ReturnType<typeof effectUnknown.encode>>>().toBeNever()
expectTypeOf<Effect.Requirements<ReturnType<typeof promiseResult.decode>>>().toBeNever()
expectTypeOf<Effect.Requirements<ReturnType<typeof promiseEffect.encode>>>().toBeNever()

class CodecDependency extends Service<CodecDependency>()('CodecDependency') {}

const dependent = Effect.gen(async function* () {
  yield* CodecDependency
  return Result.ok('dependent')
})
const dependentObject = Effect.gen(async function* () {
  yield* CodecDependency
  return Result.ok({ dependent: true })
})

expectTypeOf<Effect.Requirements<typeof dependent>>().toEqualTypeOf<CodecDependency>()

const dependentCodec: Codec<User> = {
  // @ts-expect-error Codec v0.1 effects cannot require Services.
  encode: (_value) => dependent,
  decode: (value) => Codec.json<User>().decode(value)
}
void dependentCodec

const dependentUnknown = Codec.make<unknown>({
  // @ts-expect-error Service requirements must not be swallowed by unknown Value.
  encode: (_value) => dependent,
  // @ts-expect-error Service requirements must not be swallowed by unknown Value.
  decode: (_value) => dependent
})
const dependentObjectCodec = Codec.make<object>({
  // @ts-expect-error Service requirements must not be swallowed by object Value.
  encode: (_value) => dependentObject,
  // @ts-expect-error Service requirements must not be swallowed by object Value.
  decode: (_value) => dependentObject
})
const dependentUnion = Codec.make<string | Date>({
  // @ts-expect-error Service requirements must not be swallowed by union Value.
  encode: (_value) => dependent,
  // @ts-expect-error Service requirements must not be swallowed by union Value.
  decode: (_value) => dependent
})
const dependentInferred = Codec.make({
  // @ts-expect-error Inference must not widen Value to accept a dependent Effect.
  encode: (_value) => dependent,
  // @ts-expect-error Inference must not widen Value to accept a dependent Effect.
  decode: (_value) => dependent
})
const dependentPromise = Codec.make<unknown>({
  // @ts-expect-error Promise callbacks cannot carry Service requirements either.
  encode: () => Promise.resolve(dependent),
  // @ts-expect-error Promise callbacks cannot carry Service requirements either.
  decode: () => Promise.resolve(dependent)
})
void dependentUnknown
void dependentObjectCodec
void dependentUnion
void dependentInferred
void dependentPromise

const syncSchema = {
  '~standard': {
    version: 1,
    vendor: 'codec-types',
    types: {} as InputOutput<string, User>,
    validate: (value: unknown): StandardSchemaV1.Result<User> => ({
      value: { id: String(value), active: true }
    })
  }
} satisfies StandardSchemaV1<string, User>

const syncCodec = Codec.standardSchema({ schema: syncSchema })
expectTypeOf<Codec.Input<typeof syncCodec>>().toEqualTypeOf<string>()
expectTypeOf<Codec.Value<typeof syncCodec>>().toEqualTypeOf<User>()
expectTypeOf<Effect.Success<ReturnType<typeof syncCodec.decode>>>().toEqualTypeOf<User>()
expectTypeOf<Effect.Error<ReturnType<typeof syncCodec.decode>>>().toEqualTypeOf<JobDecodeFailure>()
expectTypeOf<Effect.Requirements<ReturnType<typeof syncCodec.decode>>>().toBeNever()

const dateSchema = {
  '~standard': {
    version: 1,
    vendor: 'codec-types-date',
    types: {} as InputOutput<string, Date>,
    validate: async (value: unknown): Promise<StandardSchemaV1.Result<Date>> => ({
      value: new Date(String(value))
    })
  }
} satisfies StandardSchemaV1<string, Date>

const asyncCodec = Codec.standardSchema({
  schema: dateSchema,
  encode: async (value) => Result.ok(value.toISOString())
})
expectTypeOf<Codec.Input<typeof asyncCodec>>().toEqualTypeOf<string>()
expectTypeOf<Codec.Value<typeof asyncCodec>>().toEqualTypeOf<Date>()
expectTypeOf<Effect.Success<ReturnType<typeof asyncCodec.decode>>>().toEqualTypeOf<Date>()
expectTypeOf<Effect.Error<ReturnType<typeof asyncCodec.decode>>>().toEqualTypeOf<JobDecodeFailure>()
expectTypeOf<Effect.Success<ReturnType<typeof asyncCodec.encode>>>().toEqualTypeOf<JsonValue>()
expectTypeOf<Effect.Requirements<ReturnType<typeof asyncCodec.decode>>>().toBeNever()
expectTypeOf<Effect.Requirements<ReturnType<typeof asyncCodec.encode>>>().toBeNever()

const dependentSchemaCodec = Codec.standardSchema({
  schema: dateSchema,
  // @ts-expect-error Standard Schema encoders cannot carry Service requirements.
  encode: (_value) => dependent
})
void dependentSchemaCodec

// @ts-expect-error A transformed non-JSON output requires an explicit encoder.
const missingDateEncoder = Codec.standardSchema({ schema: dateSchema })
void missingDateEncoder

const explicitJsonSchema = {
  '~standard': {
    version: 1,
    vendor: 'codec-types-json',
    types: {} as InputOutput<unknown, User>,
    validate: (value: unknown): StandardSchemaV1.Result<User> => ({
      value: { id: String(value), active: false }
    })
  }
} satisfies StandardSchemaV1<unknown, User>

const explicitJsonCodec = Codec.standardSchema({ schema: explicitJsonSchema })
expectTypeOf<Codec.Value<typeof explicitJsonCodec>>().toEqualTypeOf<User>()

void custom
void effectObject
void syncCodec
void asyncCodec
void explicitJsonCodec
