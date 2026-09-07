import { Class } from './class.js'
import { isClassInstance } from './is-class-instance.js'
import { isSchemaClass } from './is-schema-class.js'
import {
  decode,
  decodeAsync,
  decodeUnknown,
  decodeUnknownAsync,
  encode,
  encodeAsync,
  make,
  makeAsync
} from './operations.js'
import { TaggedClass } from './tagged-class.js'
import { TaggedError } from './tagged-error.js'
import { withAdapter } from './capabilities/with.js'
import type { SchemaEffect as SchemaEffectType } from './schema-effect.js'
import type { SchemaCodec as SchemaCodecType } from './codecs/index.js'
import type {
  Encoded as EncodedType,
  Fields as FieldsType,
  Input as InputType,
  Output as OutputType,
  Instance as InstanceType,
  Props as PropsType,
  Struct as StructType
} from './types.js'

/** Preferred namespace-style facade for schema classes and typed boundaries. */
export const Schema = Object.freeze({
  Class,
  TaggedClass,
  TaggedError,
  with: withAdapter,
  isClassInstance,
  isSchemaClass,
  decodeUnknown,
  decode,
  decodeUnknownAsync,
  decodeAsync,
  encode,
  encodeAsync,
  make,
  makeAsync
})

export namespace Schema {
  export type Codec<
    Input,
    Output,
    Props = Output,
    Encoded = Input,
    EncodeFailure = never
  > = SchemaCodecType<Input, Output, Props, Encoded, EncodeFailure>
  export type Input<Schema> = InputType<Schema>
  export type Output<Schema> = OutputType<Schema>
  export type Props<Class> = PropsType<Class>
  export type Fields<Class> = FieldsType<Class>
  export type Struct<Class> = StructType<Class>
  export type Encoded<Class> = EncodedType<Class>
  export type Instance<Class> = InstanceType<Class>
  export type Effect<Value, Failure> = SchemaEffectType<Value, Failure>
}
