import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { TaggedErrorInstance } from 'better-result'

import type { SchemaEffect } from '../schema-effect.js'
import type { GenericClassDefinition, GenericSchemaClass } from './generic-class.js'

export type TaggedField = StandardSchemaV1
export type TaggedFieldMap = Readonly<Record<string, TaggedField>>

export type TaggedShape<Tag extends string, Fields extends TaggedFieldMap> = {
  readonly _tag: StandardSchemaV1<unknown, Tag>
} & Fields

export type TaglessFields<Fields extends TaggedFieldMap = TaggedFieldMap> = Fields & {
  readonly _tag?: never
}

export type TaggedErrorReservedField = '_tag' | 'name' | 'stack' | 'cause' | 'match' | 'toJSON'

export type ErrorTaglessFields<Fields extends TaggedFieldMap = TaggedFieldMap> = Fields & {
  readonly [Key in TaggedErrorReservedField]?: never
}

type FieldOutput<Field extends TaggedField> = StandardSchemaV1.InferOutput<Field>
type FieldInput<Field extends TaggedField> = StandardSchemaV1.InferInput<Field>

export type TaggedProps<Fields extends TaggedFieldMap> = {
  readonly [Key in keyof Fields]: FieldOutput<Fields[Key]>
}

export type TaggedInput<Fields extends TaggedFieldMap> = {
  readonly [Key in keyof Fields]: FieldInput<Fields[Key]>
}

export type TaggedInstance<Self, Tag extends string, Fields extends TaggedFieldMap> = Self &
  Readonly<TaggedProps<Fields>> & { readonly _tag: Tag }

export type TaggedEncoded<Tag extends string, Fields extends TaggedFieldMap> = {
  readonly _tag: Tag
} & Readonly<TaggedInput<Fields>>

export type TaggedConstructionFailure =
  | import('../failure.js').SchemaAsyncRequired
  | import('../failure.js').SchemaConstructionFailure
  | import('../failure.js').SchemaDefinitionFailure
  | import('../failure.js').SchemaExecutionFailure

export type TaggedAnnotations = Readonly<Record<string, unknown>>

type TaggedDefinition<Tag extends string, Fields extends TaggedFieldMap> = GenericClassDefinition<
  TaggedEncoded<Tag, Fields>,
  TaggedProps<Fields>,
  TaggedProps<Fields>,
  TaggedEncoded<Tag, Fields>
> & {
  readonly fields: TaggedShape<Tag, Fields>
}

type TaggedResult<Value> = SchemaEffect<Value, TaggedConstructionFailure>

export type TaggedClassType<Self, Tag extends string, Fields extends TaggedFieldMap> = Omit<
  GenericSchemaClass<Self, TaggedDefinition<Tag, Fields>>,
  'kind' | 'fields' | 'encodedSchema' | 'make' | 'makeAsync' | 'unsafeMake' | 'is'
> & {
  new (props?: TaggedProps<Fields>): Readonly<TaggedProps<Fields>> & { readonly _tag: Tag }
  readonly identifier: Tag
  readonly kind: 'tagged-class'
  readonly fields: TaggedShape<Tag, Fields>
  readonly encodedSchema: StandardSchemaV1<TaggedEncoded<Tag, Fields>, TaggedEncoded<Tag, Fields>>
  make(props?: TaggedProps<Fields>): TaggedResult<TaggedInstance<Self, Tag, Fields>>
  makeAsync(props?: TaggedProps<Fields>): Promise<TaggedResult<TaggedInstance<Self, Tag, Fields>>>
  unsafeMake(props?: TaggedProps<Fields>): TaggedResult<TaggedInstance<Self, Tag, Fields>>
  is(value: unknown): value is TaggedInstance<Self, Tag, Fields>
}

type TaggedErrorValue<Tag extends string, Fields extends TaggedFieldMap> = TaggedErrorInstance<
  Tag,
  TaggedProps<Fields>
> &
  Readonly<TaggedProps<Fields>>

export type TaggedErrorType<Self, Tag extends string, Fields extends TaggedFieldMap> = Omit<
  GenericSchemaClass<
    Self & TaggedErrorValue<Tag, Fields>,
    TaggedDefinition<Tag, Fields>
  >,
  'kind' | 'fields' | 'encodedSchema' | 'make' | 'makeAsync' | 'unsafeMake' | 'is'
> & {
  new (props?: TaggedProps<Fields>): TaggedErrorValue<Tag, Fields> & Readonly<TaggedProps<Fields>>
  readonly identifier: Tag
  readonly kind: 'tagged-error'
  readonly fields: TaggedShape<Tag, Fields>
  readonly encodedSchema: StandardSchemaV1<TaggedEncoded<Tag, Fields>, TaggedEncoded<Tag, Fields>>
  make(props?: TaggedProps<Fields>): TaggedResult<Self & TaggedErrorValue<Tag, Fields>>
  makeAsync(
    props?: TaggedProps<Fields>
  ): Promise<TaggedResult<Self & TaggedErrorValue<Tag, Fields>>>
  unsafeMake(props?: TaggedProps<Fields>): TaggedResult<Self & TaggedErrorValue<Tag, Fields>>
  is(value: unknown): value is Self & TaggedErrorValue<Tag, Fields>
}

export type TaggedClassBuilder<Self> = {
  <const Tag extends string, const Fields extends TaggedFieldMap>(
    tag: Tag,
    fields: TaglessFields<Fields>,
    annotations?: TaggedAnnotations
  ): TaggedClassType<Self, Tag, Fields>
}

export type TaggedErrorBuilder<Self> = {
  <const Tag extends string, const Fields extends TaggedFieldMap>(
    tag: Tag,
    fields: ErrorTaglessFields<Fields>,
    annotations?: TaggedAnnotations
  ): TaggedErrorType<Self, Tag, Fields>
}

type MissingSelfGeneric<Factory extends string> =
  `Missing \`Self\` generic - use \`class Self extends Schema.${Factory}<Self>()(...)\``

export interface TaggedClassFactory {
  <Self = never>(): [Self] extends [never]
    ? MissingSelfGeneric<'TaggedClass'>
    : TaggedClassBuilder<Self>
}

export interface TaggedErrorFactory {
  <Self = never>(): [Self] extends [never]
    ? MissingSelfGeneric<'TaggedError'>
    : TaggedErrorBuilder<Self>
}
