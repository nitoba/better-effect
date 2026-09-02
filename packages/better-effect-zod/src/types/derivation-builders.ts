import type * as z from "zod"

import type {
  AnyObjectSchema,
  ClassAugmentation,
  ConstructionProps,
  FieldMask,
  ShapeOf
} from "./common.js"
import type {
  CatchallObject,
  MergeShapes,
  OmitShape,
  PickShape,
  RebuildObject
} from "./shapes.js"
import type { SchemaClass } from "./schema-class.js"

export interface ExtendBuilder<
  Self,
  Schema extends AnyObjectSchema,
  Inherited,
  ProtectedKeys extends PropertyKey
> {
  <const Augmentation extends ClassAugmentation<ProtectedKeys>>(
    augmentation: Augmentation
  ): SchemaClass<
    Self,
    RebuildObject<Schema, MergeShapes<ShapeOf<Schema>, Augmentation>>,
    ConstructionProps<
      RebuildObject<Schema, MergeShapes<ShapeOf<Schema>, Augmentation>>,
      ProtectedKeys
    >,
    z.output<RebuildObject<Schema, MergeShapes<ShapeOf<Schema>, Augmentation>>>,
    Inherited,
    ProtectedKeys
  >
}

export interface PickBuilder<
  Self,
  Schema extends AnyObjectSchema,
  Inherited,
  ProtectedKeys extends PropertyKey
> {
  <const Mask extends FieldMask<ShapeOf<Schema>, ProtectedKeys>>(
    mask: Mask
  ): SchemaClass<
    Self,
    RebuildObject<Schema, PickShape<ShapeOf<Schema>, Mask, ProtectedKeys>>,
    ConstructionProps<
      RebuildObject<Schema, PickShape<ShapeOf<Schema>, Mask, ProtectedKeys>>,
      ProtectedKeys
    >,
    z.output<RebuildObject<
      Schema,
      PickShape<ShapeOf<Schema>, Mask, ProtectedKeys>
    >>,
    Inherited,
    ProtectedKeys
  >
}

export interface OmitBuilder<
  Self,
  Schema extends AnyObjectSchema,
  Inherited,
  ProtectedKeys extends PropertyKey
> {
  <const Mask extends FieldMask<ShapeOf<Schema>, ProtectedKeys>>(
    mask: Mask
  ): SchemaClass<
    Self,
    RebuildObject<Schema, OmitShape<ShapeOf<Schema>, Mask, ProtectedKeys>>,
    ConstructionProps<
      RebuildObject<Schema, OmitShape<ShapeOf<Schema>, Mask, ProtectedKeys>>,
      ProtectedKeys
    >,
    z.output<RebuildObject<
      Schema,
      OmitShape<ShapeOf<Schema>, Mask, ProtectedKeys>
    >>,
    Inherited,
    ProtectedKeys
  >
}

export interface CatchallBuilder<
  Self,
  Schema extends AnyObjectSchema,
  Inherited,
  ProtectedKeys extends PropertyKey
> {
  <Catchall extends z.core.SomeType>(
    schema: Catchall
  ): SchemaClass<
    Self,
    CatchallObject<Schema, Catchall>,
    ConstructionProps<CatchallObject<Schema, Catchall>, ProtectedKeys>,
    z.output<CatchallObject<Schema, Catchall>>,
    Inherited,
    ProtectedKeys
  >
}
