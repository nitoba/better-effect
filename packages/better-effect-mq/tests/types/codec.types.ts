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

const rawCallbacks = Codec.make<User>({
  encode: (value) => ({ id: value.id, active: value.active }),
  decode: (value) => ({ id: String(value), active: true })
})
expectTypeOf<Effect.Success<ReturnType<typeof rawCallbacks.encode>>>().toEqualTypeOf<JsonValue>()
expectTypeOf<Effect.Success<ReturnType<typeof rawCallbacks.decode>>>().toEqualTypeOf<User>()

const asyncCallbacks = Codec.make<User>({
  encode: async (value) => Result.ok({ id: value.id, active: value.active }),
  decode: async (value) => ({ id: String(value), active: false })
})
expectTypeOf<Effect.Success<ReturnType<typeof asyncCallbacks.encode>>>().toEqualTypeOf<JsonValue>()
expectTypeOf<Effect.Success<ReturnType<typeof asyncCallbacks.decode>>>().toEqualTypeOf<User>()

class CodecDependency extends Service<CodecDependency>()('CodecDependency') {}

const dependent = Effect.gen(async function* () {
  yield* CodecDependency
  return Result.ok('dependent')
})

expectTypeOf<Effect.Requirements<typeof dependent>>().toEqualTypeOf<CodecDependency>()

const dependentCodec: Codec<User> = {
  // @ts-expect-error Codec v0.1 effects cannot require Services.
  encode: (_value) => dependent,
  decode: (value) => Codec.json<User>().decode(value)
}
void dependentCodec

const dependentCodecFromMake = Codec.make({
  // @ts-expect-error Codec v0.1 callbacks cannot require Services.
  encode: (_value) => dependent,
  decode: (value) => Codec.json<User>().decode(value)
})

const dependentCodecWithExplicitValue = Codec.make<User>({
  // @ts-expect-error Codec v0.1 callbacks cannot require Services, even when Value is explicit.
  encode: (_value) => dependent,
  decode: (value) => Codec.json<User>().decode(value)
})

const dependentCodecPromise = Codec.make<User>({
  // @ts-expect-error Promise callbacks cannot carry Service requirements either.
  encode: async (_value) => dependent,
  decode: (value) => Codec.json<User>().decode(value)
})
void dependentCodecFromMake
void dependentCodecWithExplicitValue
void dependentCodecPromise

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
void syncCodec
void asyncCodec
void explicitJsonCodec
