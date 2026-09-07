import type * as z from "zod"
import type { TaggedErrorInstance } from "better-result"

import type {
  ClassAnnotations,
  ConstructionProps,
  RawShape
} from "./common.js"
import type { MissingClassSelfGeneric } from "./factories.js"
import type { SchemaClass } from "./schema-class.js"

export type TaggedShape<
  Tag extends string,
  Fields extends RawShape
> = {
  readonly _tag: z.ZodLiteral<Tag>
} & Fields

export type TaglessFields<Fields extends RawShape> = Fields & {
  readonly _tag?: never
}

export type TaggedErrorReservedField =
  | "_tag"
  | "name"
  | "stack"
  | "match"
  | "toJSON"

export type ErrorTaglessFields<Fields extends RawShape> = Fields & {
  readonly _tag?: never
  readonly name?: never
  readonly stack?: never
  readonly match?: never
  readonly toJSON?: never
}

export interface TaggedClassBuilder<
  Self,
  Inherited = object
> {
  <const Tag extends string, const Fields extends RawShape>(
    tag: Tag,
    fields: TaglessFields<Fields>,
    annotations?: ClassAnnotations
  ): SchemaClass<
    Self,
    z.ZodObject<TaggedShape<Tag, Fields>>,
    ConstructionProps<z.ZodObject<TaggedShape<Tag, Fields>>, "_tag">,
    z.output<z.ZodObject<TaggedShape<Tag, Fields>>>,
    Inherited,
    "_tag"
  >
}

export interface TaggedErrorBuilder<Self> {
  <const Tag extends string, const Fields extends RawShape>(
    tag: Tag,
    fields: ErrorTaglessFields<Fields>,
    annotations?: ClassAnnotations
  ): SchemaClass<
    Self,
    z.ZodObject<TaggedShape<Tag, Fields>>,
    ConstructionProps<
      z.ZodObject<TaggedShape<Tag, Fields>>,
      TaggedErrorReservedField
    >,
    z.output<z.ZodObject<TaggedShape<Tag, Fields>>>,
    TaggedErrorInstance<Tag, Record<never, never>>,
    TaggedErrorReservedField
  >
}

export interface TaggedClassFactory {
  <Self = never>(): [Self] extends [never]
    ? MissingClassSelfGeneric<"TaggedClass", "()">
    : TaggedClassBuilder<Self>
}

export interface TaggedErrorFactory {
  <Self = never>(): [Self] extends [never]
    ? MissingClassSelfGeneric<"TaggedError", "()">
    : TaggedErrorBuilder<Self>
}
