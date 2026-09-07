import type * as z from "zod"

import type {
  AnyObjectSchema,
  ConfigOf,
  FieldMask,
  RawShape,
  ShapeOf
} from "./common.js"

type TrueKeys<Mask> = {
  [Key in keyof Mask]-?: Mask[Key] extends true ? Key : never
}[keyof Mask]

type ProtectedShapeKeys<
  Shape extends RawShape,
  ProtectedKeys extends PropertyKey
> = Extract<ProtectedKeys, keyof Shape>

export type MergeShapes<
  Base extends RawShape,
  Augmentation extends RawShape
> = Omit<Base, keyof Augmentation> & Augmentation

export type PickShape<
  Shape extends RawShape,
  Mask extends FieldMask<Shape, ProtectedKeys>,
  ProtectedKeys extends PropertyKey = never
> = Pick<
  Shape,
  | Extract<TrueKeys<Mask>, keyof Shape>
  | ProtectedShapeKeys<Shape, ProtectedKeys>
>

export type OmitShape<
  Shape extends RawShape,
  Mask extends FieldMask<Shape, ProtectedKeys>,
  ProtectedKeys extends PropertyKey = never
> = Omit<Shape, Extract<TrueKeys<Mask>, keyof Shape>>

export type PartialShape<
  Shape extends RawShape,
  Mask extends FieldMask<Shape, ProtectedKeys> | undefined = undefined,
  ProtectedKeys extends PropertyKey = never
> = {
  readonly [Key in keyof Shape]: Key extends ProtectedShapeKeys<
    Shape,
    ProtectedKeys
  >
    ? Shape[Key]
    : [Mask] extends [undefined]
      ? z.ZodOptional<Shape[Key]>
      : Key extends TrueKeys<Mask>
        ? z.ZodOptional<Shape[Key]>
        : Shape[Key]
}

export type ExactPartialShape<
  Shape extends RawShape,
  Mask extends FieldMask<Shape, ProtectedKeys> | undefined = undefined,
  ProtectedKeys extends PropertyKey = never
> = {
  readonly [Key in keyof Shape]: Key extends ProtectedShapeKeys<
    Shape,
    ProtectedKeys
  >
    ? Shape[Key]
    : [Mask] extends [undefined]
      ? z.ZodExactOptional<Shape[Key]>
      : Key extends TrueKeys<Mask>
        ? z.ZodExactOptional<Shape[Key]>
        : Shape[Key]
}

export type RequiredShape<
  Shape extends RawShape,
  Mask extends FieldMask<Shape, ProtectedKeys> | undefined = undefined,
  ProtectedKeys extends PropertyKey = never
> = {
  readonly [Key in keyof Shape]: Key extends ProtectedShapeKeys<
    Shape,
    ProtectedKeys
  >
    ? Shape[Key]
    : [Mask] extends [undefined]
      ? z.ZodNonOptional<Shape[Key]>
      : Key extends TrueKeys<Mask>
        ? z.ZodNonOptional<Shape[Key]>
        : Shape[Key]
}

export type RebuildObject<
  Schema extends AnyObjectSchema,
  Shape extends RawShape
> = z.ZodObject<Shape, ConfigOf<Schema>>

export type DeepPartialObject<Schema extends AnyObjectSchema> = Extract<
  ReturnType<typeof z.deepPartial<Schema>>,
  AnyObjectSchema
>

type DeepPartialShapeOf<Schema extends AnyObjectSchema> =
  ShapeOf<DeepPartialObject<Schema>>

export type ClassDeepPartialShape<
  Schema extends AnyObjectSchema,
  ProtectedKeys extends PropertyKey = never
> = Omit<
  DeepPartialShapeOf<Schema>,
  ProtectedShapeKeys<ShapeOf<Schema>, ProtectedKeys>
> & Pick<
  ShapeOf<Schema>,
  ProtectedShapeKeys<ShapeOf<Schema>, ProtectedKeys>
>

export type ClassDeepPartialObject<
  Schema extends AnyObjectSchema,
  ProtectedKeys extends PropertyKey = never
> = RebuildObject<
  DeepPartialObject<Schema>,
  ClassDeepPartialShape<Schema, ProtectedKeys>
>

export type StrictObject<Schema extends AnyObjectSchema> = z.ZodObject<
  ShapeOf<Schema>,
  z.core.$strict
>

export type LooseObject<Schema extends AnyObjectSchema> = z.ZodObject<
  ShapeOf<Schema>,
  z.core.$loose
>

export type StripObject<Schema extends AnyObjectSchema> = z.ZodObject<
  ShapeOf<Schema>,
  z.core.$strip
>

type CatchallOutput<Shape extends RawShape> =
  z.output<z.ZodObject<Shape>> & Record<string, unknown>

type CatchallInput<Shape extends RawShape> =
  z.input<z.ZodObject<Shape>> & Record<string, unknown>

type CatchallInternals<
  Shape extends RawShape,
  Catchall extends z.core.SomeType
> = Omit<
  z.core.$ZodObjectInternals<Shape, z.core.$catchall<Catchall>>,
  "output" | "input"
> & {
  output: CatchallOutput<Shape>
  input: CatchallInput<Shape>
}

export type CatchallObject<
  Schema extends AnyObjectSchema,
  Catchall extends z.core.SomeType
> = Omit<
  z.ZodObject<ShapeOf<Schema>, z.core.$catchall<Catchall>>,
  "_zod"
> & {
  readonly _zod: CatchallInternals<ShapeOf<Schema>, Catchall>
}

export type SchemaShape<Schema extends AnyObjectSchema> = ShapeOf<Schema>
