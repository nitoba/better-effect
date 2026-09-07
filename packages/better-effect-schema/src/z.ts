import { Schema } from "./schema.js"
import type { SchemaEffect as SchemaEffectType } from "./schema-effect.js"
import type {
  Encoded as EncodedType,
  Fields as FieldsType,
  Instance as InstanceType,
  Props as PropsType,
  Struct as StructType
} from "./types.js"

/** @deprecated Use `Schema`. */
export const Z = Schema

/** @deprecated Use the equivalent types from the `Schema` namespace. */
export namespace Z {
  export type Props<Class> = PropsType<Class>
  export type Fields<Class> = FieldsType<Class>
  export type Struct<Class> = StructType<Class>
  export type Encoded<Class> = EncodedType<Class>
  export type Instance<Class> = InstanceType<Class>
  export type Effect<Value, Failure> = SchemaEffectType<Value, Failure>
}
