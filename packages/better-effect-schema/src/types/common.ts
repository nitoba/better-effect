import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { SchemaAnnotations } from '../json-schema/metadata.js'

/** Provider-neutral class categories used by runtime diagnostics. */
export type ClassKind = 'class' | 'tagged-class' | 'tagged-error'
export type ClassAnnotations = SchemaAnnotations
export type RawShape = Readonly<Record<string, StandardSchemaV1>>
export type AnyObjectSchema = StandardSchemaV1
export type AnyObjectCodec = StandardSchemaV1
export type ClassDefinition = StandardSchemaV1
export type ShapeOf<Schema extends AnyObjectSchema> = Readonly<Record<string, StandardSchemaV1>>
export type ConfigOf<Schema extends AnyObjectSchema> = unknown
export type DefinitionFields<Definition extends ClassDefinition> = ShapeOf<Definition>
export type Simplify<Value> = Value extends object
  ? { readonly [Key in keyof Value]: Value[Key] }
  : Value
export type ConstructorArgs<Props> = keyof Props extends never
  ? readonly [props?: Props]
  : {} extends Props
    ? readonly [props?: Props]
    : readonly [props: Props]
export type FieldMask<Shape extends object, ProtectedKeys extends PropertyKey = never> = {
  readonly [Key in Exclude<keyof Shape, ProtectedKeys>]?: true
}
export type ClassAugmentation<ProtectedKeys extends PropertyKey = never> = Record<
  string,
  StandardSchemaV1
> & { readonly [Key in ProtectedKeys]?: never }
export type ConstructionProps<Definition extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Definition>
export type InheritedClassMembers<Self, Definition extends StandardSchemaV1> = Omit<
  Self,
  keyof StandardSchemaV1.InferOutput<Definition>
>
export type MakeOptions = never
export type ToJSONSchemaParams = Record<string, unknown>
