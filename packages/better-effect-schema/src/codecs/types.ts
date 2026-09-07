import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { AsyncCapabilityResult, CapabilityResult } from '../capabilities/types.js'

/** A synchronous, explicit encoder result for a schema codec. */
export type CodecResult<Value, Failure> = CapabilityResult<Value, Failure>

/** A codec result that may be produced asynchronously by an encoder. */
export type AsyncCodecResult<Value, Failure> = AsyncCapabilityResult<Value, Failure>

/**
 * Provider-neutral description of a bidirectional schema boundary.
 *
 * `schema` is the read/decode side. `propsSchema` is an optional construction
 * projection and `encodedSchema` validates the representation produced by the
 * explicit encoder. None of these fields are derived from another one.
 */
export interface SchemaCodec<
  Input,
  Output,
  Props = Output,
  Encoded = Input,
  EncodeFailure = never
> {
  readonly schema: StandardSchemaV1<Input, Output>
  readonly propsSchema?: StandardSchemaV1<Props, Props>
  readonly encodedSchema: StandardSchemaV1<Encoded, Encoded>
  readonly encode: (value: Output) => CodecResult<Encoded, EncodeFailure>
  readonly encodeAsync?: (value: Output) => AsyncCodecResult<Encoded, EncodeFailure>
  readonly identifier?: string
}

type CodecResultLike =
  | { readonly status: 'ok'; readonly value: unknown }
  | { readonly status: 'error'; readonly error: unknown }

/** Structural runtime view used at the erased codec boundary. */
export type AnySchemaCodec = {
  readonly schema: StandardSchemaV1
  readonly encodedSchema: StandardSchemaV1
  readonly encode: (...args: never[]) => CodecResultLike | PromiseLike<CodecResultLike>
}

/** The input accepted by a schema or by the decode side of a codec. */
export type CodecInput<Codec> = Codec extends {
  readonly schema: infer Schema extends StandardSchemaV1
}
  ? StandardSchemaV1.InferInput<Schema>
  : never

/** The decoded output produced by a schema or by the decode side of a codec. */
export type CodecOutput<Codec> = Codec extends {
  readonly schema: infer Schema extends StandardSchemaV1
}
  ? StandardSchemaV1.InferOutput<Schema>
  : never

/** The normalized properties accepted by a codec's construction projection. */
export type CodecProps<Codec> = Codec extends {
  readonly propsSchema: infer Schema extends StandardSchemaV1
}
  ? StandardSchemaV1.InferOutput<Schema>
  : CodecOutput<Codec>

/** The validated representation returned by a codec's encoded projection. */
export type CodecEncoded<Codec> = Codec extends {
  readonly encodedSchema: infer Schema extends StandardSchemaV1
}
  ? StandardSchemaV1.InferOutput<Schema>
  : never

type ResultFailure<Value> = Value extends {
  readonly status: 'ok' | 'error'
}
  ? Value extends { readonly status: 'error'; readonly error: infer Failure }
    ? Failure
    : never
  : never

type EncoderReturn<Codec> = Codec extends {
  readonly encode: (...args: never[]) => infer Result
}
  ? Awaited<Result>
  : never

/** Errors explicitly returned by a codec encoder. */
export type CodecEncodeFailure<Codec> = ResultFailure<EncoderReturn<Codec>>

type AsyncEncoderReturn<Codec> = Codec extends {
  readonly encodeAsync: (...args: never[]) => infer Result
}
  ? Awaited<Result>
  : EncoderReturn<Codec>

/** Errors explicitly returned by the encoder selected by `encodeAsync`. */
export type CodecAsyncEncodeFailure<Codec> = ResultFailure<AsyncEncoderReturn<Codec>>
