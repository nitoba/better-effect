import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { AnyTaggedError, TaggedErrorInstance } from 'better-result'

import type { CLASS_TYPE_ID } from '../internal/symbols.js'
import type { SchemaEffect } from '../schema-effect.js'
import type {
  SchemaAsyncRequired,
  SchemaConstructionFailure,
  SchemaDefinitionFailure,
  SchemaExecutionFailure
} from '../failure.js'
import type { ClassDefinition } from './common.js'
import type { ClassTypeMetadata } from './class-metadata.js'
import type { MissingClassSelfGeneric } from './factories.js'

/** Type-only carrier used by the generic `Encoded` extractor. */
export declare const TAGGED_ENCODED: unique symbol

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
  | SchemaAsyncRequired
  | SchemaConstructionFailure
  | SchemaDefinitionFailure
  | SchemaExecutionFailure

type TaggedResult<Self, Tag extends string, Fields extends TaggedFieldMap> = SchemaEffect<
  TaggedInstance<Self, Tag, Fields>,
  TaggedConstructionFailure
>

export type TaggedAnnotations = Readonly<Record<string, unknown>>

type FieldMask<Fields extends TaggedFieldMap> = {
  readonly [Key in Exclude<keyof Fields, '_tag'>]?: true
}

type PickFields<Fields extends TaggedFieldMap, Mask extends FieldMask<Fields>> = Pick<
  Fields,
  Extract<keyof Mask, keyof Fields>
>

type TaggedClassType<Self, Tag extends string, Fields extends TaggedFieldMap> = {
  new (props?: TaggedProps<Fields>): TaggedProps<Fields> & { readonly _tag: Tag }
  readonly [CLASS_TYPE_ID]: ClassTypeMetadata<
    Self,
    ClassDefinition,
    TaggedProps<Fields>,
    TaggedProps<Fields> & { readonly _tag: Tag },
    object,
    '_tag',
    never
  >
  readonly [TAGGED_ENCODED]: TaggedEncoded<Tag, Fields>
  readonly identifier: Tag
  readonly kind: 'tagged-class'
  readonly fields: TaggedShape<Tag, Fields>
  readonly struct: StandardSchemaV1
  readonly schema: StandardSchemaV1<TaggedEncoded<Tag, Fields>, TaggedInstance<Self, Tag, Fields>>
  readonly codec: StandardSchemaV1<TaggedEncoded<Tag, Fields>, TaggedInstance<Self, Tag, Fields>>
  readonly encodedSchema: StandardSchemaV1<TaggedEncoded<Tag, Fields>, TaggedEncoded<Tag, Fields>>
  readonly propsSchema: StandardSchemaV1<TaggedProps<Fields>, TaggedProps<Fields>>
  readonly '~standard': StandardSchemaV1<
    TaggedEncoded<Tag, Fields>,
    TaggedInstance<Self, Tag, Fields>
  >['~standard']

  make(props?: TaggedProps<Fields>): TaggedResult<Self, Tag, Fields>
  makeAsync(props?: TaggedProps<Fields>): Promise<TaggedResult<Self, Tag, Fields>>
  unsafeMake(props?: TaggedProps<Fields>): TaggedResult<Self, Tag, Fields>
  decode(input: TaggedEncoded<Tag, Fields>): TaggedResult<Self, Tag, Fields>
  decodeAsync(input: TaggedEncoded<Tag, Fields>): Promise<TaggedResult<Self, Tag, Fields>>
  parse(input: TaggedEncoded<Tag, Fields>): TaggedInstance<Self, Tag, Fields>
  encode(input: TaggedInstance<Self, Tag, Fields>): TaggedEncoded<Tag, Fields>
  is(input: unknown): input is TaggedInstance<Self, Tag, Fields>

  pick<DerivedSelf>(
    identifier: string,
    annotations?: TaggedAnnotations
  ): <const Mask extends FieldMask<Fields>>(
    mask: Mask
  ) => TaggedClassType<DerivedSelf, Tag, PickFields<Fields, Mask>>

  extend<DerivedSelf, const Added extends TaglessFields<Fields>>(
    identifier: string,
    annotations?: TaggedAnnotations
  ): (fields: Added) => TaggedClassType<DerivedSelf, Tag, Fields & Added>
}

type TaggedErrorProps<Tag extends string, Fields extends TaggedFieldMap> = TaggedErrorInstance<
  Tag,
  TaggedProps<Fields>
> &
  Readonly<TaggedProps<Fields>>

type TaggedErrorType<Self, Tag extends string, Fields extends TaggedFieldMap> = {
  new (props?: TaggedProps<Fields>): TaggedErrorProps<Tag, Fields>
  readonly [CLASS_TYPE_ID]: ClassTypeMetadata<
    Self,
    ClassDefinition,
    TaggedProps<Fields>,
    TaggedProps<Fields> & { readonly _tag: Tag },
    AnyTaggedError,
    TaggedErrorReservedField,
    never
  >
  readonly [TAGGED_ENCODED]: TaggedEncoded<Tag, Fields>
  readonly identifier: Tag
  readonly kind: 'tagged-error'
  readonly fields: TaggedShape<Tag, Fields>
  readonly struct: StandardSchemaV1
  readonly schema: StandardSchemaV1<TaggedEncoded<Tag, Fields>, TaggedErrorProps<Tag, Fields>>
  readonly codec: StandardSchemaV1<TaggedEncoded<Tag, Fields>, TaggedErrorProps<Tag, Fields>>
  readonly encodedSchema: StandardSchemaV1<TaggedEncoded<Tag, Fields>, TaggedEncoded<Tag, Fields>>
  readonly propsSchema: StandardSchemaV1<TaggedProps<Fields>, TaggedProps<Fields>>
  readonly '~standard': StandardSchemaV1<
    TaggedEncoded<Tag, Fields>,
    TaggedErrorProps<Tag, Fields>
  >['~standard']

  make(props?: TaggedProps<Fields>): TaggedResult<Self, Tag, Fields>
  makeAsync(props?: TaggedProps<Fields>): Promise<TaggedResult<Self, Tag, Fields>>
  unsafeMake(props?: TaggedProps<Fields>): TaggedResult<Self, Tag, Fields>
  decode(input: TaggedEncoded<Tag, Fields>): TaggedResult<Self, Tag, Fields>
  decodeAsync(input: TaggedEncoded<Tag, Fields>): Promise<TaggedResult<Self, Tag, Fields>>
  parse(input: TaggedEncoded<Tag, Fields>): Self & TaggedErrorProps<Tag, Fields>
  encode(input: Self & TaggedErrorProps<Tag, Fields>): TaggedEncoded<Tag, Fields>
  is(input: unknown): input is Self & TaggedErrorProps<Tag, Fields>

  pick<DerivedSelf>(
    identifier: string,
    annotations?: TaggedAnnotations
  ): <const Mask extends FieldMask<Fields>>(
    mask: Mask
  ) => TaggedErrorType<DerivedSelf, Tag, PickFields<Fields, Mask>>
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

export interface TaggedClassFactory {
  <Self = never>(): [Self] extends [never]
    ? MissingClassSelfGeneric<'TaggedClass', '()'>
    : TaggedClassBuilder<Self>
}

export interface TaggedErrorFactory {
  <Self = never>(): [Self] extends [never]
    ? MissingClassSelfGeneric<'TaggedError', '()'>
    : TaggedErrorBuilder<Self>
}
