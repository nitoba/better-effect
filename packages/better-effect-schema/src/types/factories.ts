import type * as z from "zod"

import type {
  AnyObjectCodec,
  AnyObjectSchema,
  ClassAnnotations,
  RawShape
} from "./common.js"
import type { SchemaClass } from "./schema-class.js"

export interface ClassBuilder<Self> {
  <const Shape extends RawShape>(
    shape: Shape
  ): SchemaClass<Self, z.ZodObject<Shape>>

  <Schema extends AnyObjectSchema>(
    schema: Schema
  ): SchemaClass<Self, Schema>

  <Codec extends AnyObjectCodec>(
    codec: Codec
  ): SchemaClass<Self, Codec>
}

type MissingSelfGeneric<Factory extends string, Params extends string = ""> =
  `Missing \`Self\` generic - use \`class Self extends Schema.${Factory}<Self>(${Params}...)\``

export interface ClassFactory {
  <Self = never>(
    identifier: string,
    annotations?: ClassAnnotations
  ): [Self] extends [never]
    ? MissingSelfGeneric<"Class">
    : ClassBuilder<Self>
}

export type MissingClassSelfGeneric<
  Factory extends string,
  Params extends string = ""
> = MissingSelfGeneric<Factory, Params>
