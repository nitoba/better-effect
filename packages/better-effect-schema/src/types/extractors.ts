import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { CLASS_TYPE_ID } from '../internal/symbols.js'
import type { GenericClassDefinition, GenericSchemaClass } from './generic-class.js'

type ClassMetadata<Class> = Class extends {
  readonly [CLASS_TYPE_ID]: infer Metadata
}
  ? Metadata
  : never

type Simplify<Value> = { [Key in keyof Value]: Value[Key] }

type ClassProps<Class> = Class extends {
  readonly propsSchema: infer Schema extends StandardSchemaV1
}
  ? StandardSchemaV1.InferOutput<Schema>
  : never

type ClassFields<Class> = Class extends { readonly fields: infer Fields }
  ? NonNullable<Fields>
  : never

type ClassStruct<Class> = Class extends { readonly struct: infer Struct }
  ? NonNullable<Struct>
  : never

type ClassEncoded<Class> = Class extends { readonly encodedSchema: infer Schema }
  ? NonNullable<Schema> extends StandardSchemaV1
    ? Simplify<StandardSchemaV1.InferInput<NonNullable<Schema>>>
    : never
  : Class extends { readonly schema: infer Source extends StandardSchemaV1 }
    ? Simplify<StandardSchemaV1.InferInput<Source>>
    : never

export type Input<Schema> = Schema extends {
  readonly schema: infer Definition extends StandardSchemaV1
}
  ? StandardSchemaV1.InferInput<Definition>
  : Schema extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<Schema>
    : never

export type Output<Schema> = Schema extends {
  readonly schema: infer Definition extends StandardSchemaV1
}
  ? StandardSchemaV1.InferOutput<Definition>
  : Schema extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<Schema>
    : never

export type Props<Class> = ClassProps<Class>
export type Fields<Class> = ClassFields<Class>
export type Struct<Class> = ClassStruct<Class>
export type Encoded<Class> = ClassEncoded<Class>
export type Instance<Class> = Class extends {
  readonly make: (...args: never[]) => import('better-result').Result<infer Self, unknown>
}
  ? Self
  : Class extends GenericSchemaClass<infer Self, GenericClassDefinition>
    ? Self
  : ClassMetadata<Class> extends { readonly self: infer Self }
    ? Self
    : Class extends { new (...args: never[]): infer Value }
      ? Value
      : never
