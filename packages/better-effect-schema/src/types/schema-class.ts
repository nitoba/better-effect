import type * as z from "zod"

import type { CLASS_TYPE_ID } from "../internal/symbols.js"
import type { ClassTypeMetadata } from "./class-metadata.js"
import type {
  AnyObjectSchema,
  ClassAnnotations,
  ClassDefinition,
  ClassKind,
  ConstructionProps,
  ConstructorArgs,
  DefinitionFields,
  FieldMask,
  InheritedClassMembers,
  RawShape,
  ShapeOf
} from "./common.js"
import type {
  CatchallBuilder,
  ExtendBuilder,
  OmitBuilder,
  PickBuilder
} from "./derivation-builders.js"
import type {
  ClassDeepPartialObject,
  ExactPartialShape,
  LooseObject,
  PartialShape,
  RebuildObject,
  RequiredShape,
  StrictObject,
  StripObject
} from "./shapes.js"

type DerivedSchemaClass<
  Self,
  DerivedSelf,
  Schema extends AnyObjectSchema,
  DerivedSchema extends AnyObjectSchema,
  ProtectedKeys extends PropertyKey
> = SchemaClass<
  DerivedSelf,
  DerivedSchema,
  ConstructionProps<DerivedSchema, ProtectedKeys>,
  z.output<DerivedSchema>,
  InheritedClassMembers<Self, Schema>,
  ProtectedKeys
>

interface SchemaClassBase<
  Self,
  Definition extends ClassDefinition,
  ConstructorProps = ConstructionProps<Definition>,
  InstanceProps = z.output<Definition>,
  Inherited = object,
  ProtectedKeys extends PropertyKey = never,
  ClassFields extends RawShape = DefinitionFields<Definition>
> extends z.ZodType<Self, z.input<Definition>> {
  new (
    ...args: ConstructorArgs<ConstructorProps>
  ): Readonly<InstanceProps> & Inherited

  readonly [CLASS_TYPE_ID]: ClassTypeMetadata<
    Self,
    Definition,
    ConstructorProps,
    InstanceProps,
    Inherited,
    ProtectedKeys,
    ClassFields
  >

  readonly identifier: string
  readonly fields: ClassFields
  readonly struct: Definition
  readonly schema: this
  readonly codec: z.ZodType<Self, z.input<Definition>>
  readonly encodedSchema: z.ZodType<z.input<Definition>, z.input<Definition>>
  readonly propsSchema: z.ZodType<z.output<Definition>, z.output<Definition>>
  readonly kind: ClassKind

  make(
    ...args: ConstructorArgs<ConstructorProps>
  ): Self & Readonly<InstanceProps>

  unsafeMake(
    ...args: ConstructorArgs<ConstructorProps>
  ): Self & Readonly<InstanceProps>

  makeAsync(
    ...args: ConstructorArgs<ConstructorProps>
  ): Promise<Self & Readonly<InstanceProps>>

  safeMake(
    ...args: ConstructorArgs<ConstructorProps>
  ): z.ZodSafeParseResult<Self & Readonly<InstanceProps>>

  safeMakeAsync(
    ...args: ConstructorArgs<ConstructorProps>
  ): Promise<z.ZodSafeParseResult<Self & Readonly<InstanceProps>>>

  is(value: unknown): value is Self
}

interface ObjectClassDerivations<
  Self,
  Schema extends AnyObjectSchema,
  ProtectedKeys extends PropertyKey
> {
  extend<DerivedSelf>(
    identifier: string,
    annotations?: ClassAnnotations
  ): ExtendBuilder<
    DerivedSelf,
    Schema,
    InheritedClassMembers<Self, Schema>,
    ProtectedKeys
  >

  pick<DerivedSelf>(
    identifier: string,
    annotations?: ClassAnnotations
  ): PickBuilder<
    DerivedSelf,
    Schema,
    InheritedClassMembers<Self, Schema>,
    ProtectedKeys
  >

  omit<DerivedSelf>(
    identifier: string,
    annotations?: ClassAnnotations
  ): OmitBuilder<
    DerivedSelf,
    Schema,
    InheritedClassMembers<Self, Schema>,
    ProtectedKeys
  >

  partial<
    DerivedSelf,
    const Mask extends FieldMask<ShapeOf<Schema>, ProtectedKeys>
  >(
    identifier: string,
    mask: Mask,
    annotations?: ClassAnnotations
  ): DerivedSchemaClass<
    Self,
    DerivedSelf,
    Schema,
    RebuildObject<Schema, PartialShape<ShapeOf<Schema>, Mask, ProtectedKeys>>,
    ProtectedKeys
  >

  partial<DerivedSelf>(
    identifier: string,
    annotations?: ClassAnnotations
  ): DerivedSchemaClass<
    Self,
    DerivedSelf,
    Schema,
    RebuildObject<
      Schema,
      PartialShape<ShapeOf<Schema>, undefined, ProtectedKeys>
    >,
    ProtectedKeys
  >

  exactPartial<
    DerivedSelf,
    const Mask extends FieldMask<ShapeOf<Schema>, ProtectedKeys>
  >(
    identifier: string,
    mask: Mask,
    annotations?: ClassAnnotations
  ): DerivedSchemaClass<
    Self,
    DerivedSelf,
    Schema,
    RebuildObject<
      Schema,
      ExactPartialShape<ShapeOf<Schema>, Mask, ProtectedKeys>
    >,
    ProtectedKeys
  >

  exactPartial<DerivedSelf>(
    identifier: string,
    annotations?: ClassAnnotations
  ): DerivedSchemaClass<
    Self,
    DerivedSelf,
    Schema,
    RebuildObject<
      Schema,
      ExactPartialShape<ShapeOf<Schema>, undefined, ProtectedKeys>
    >,
    ProtectedKeys
  >

  deepPartial<DerivedSelf>(
    identifier: string,
    annotations?: ClassAnnotations
  ): DerivedSchemaClass<
    Self,
    DerivedSelf,
    Schema,
    ClassDeepPartialObject<Schema, ProtectedKeys>,
    ProtectedKeys
  >

  required<
    DerivedSelf,
    const Mask extends FieldMask<ShapeOf<Schema>, ProtectedKeys>
  >(
    identifier: string,
    mask: Mask,
    annotations?: ClassAnnotations
  ): DerivedSchemaClass<
    Self,
    DerivedSelf,
    Schema,
    RebuildObject<Schema, RequiredShape<ShapeOf<Schema>, Mask, ProtectedKeys>>,
    ProtectedKeys
  >

  required<DerivedSelf>(
    identifier: string,
    annotations?: ClassAnnotations
  ): DerivedSchemaClass<
    Self,
    DerivedSelf,
    Schema,
    RebuildObject<
      Schema,
      RequiredShape<ShapeOf<Schema>, undefined, ProtectedKeys>
    >,
    ProtectedKeys
  >

  strict<DerivedSelf>(
    identifier: string,
    annotations?: ClassAnnotations
  ): DerivedSchemaClass<
    Self,
    DerivedSelf,
    Schema,
    StrictObject<Schema>,
    ProtectedKeys
  >

  loose<DerivedSelf>(
    identifier: string,
    annotations?: ClassAnnotations
  ): DerivedSchemaClass<
    Self,
    DerivedSelf,
    Schema,
    LooseObject<Schema>,
    ProtectedKeys
  >

  strip<DerivedSelf>(
    identifier: string,
    annotations?: ClassAnnotations
  ): DerivedSchemaClass<
    Self,
    DerivedSelf,
    Schema,
    StripObject<Schema>,
    ProtectedKeys
  >

  catchall<DerivedSelf>(
    identifier: string,
    annotations?: ClassAnnotations
  ): CatchallBuilder<
    DerivedSelf,
    Schema,
    InheritedClassMembers<Self, Schema>,
    ProtectedKeys
  >
}

export type SchemaClass<
  Self,
  Definition extends ClassDefinition,
  ConstructorProps = ConstructionProps<Definition>,
  InstanceProps = z.output<Definition>,
  Inherited = object,
  ProtectedKeys extends PropertyKey = never,
  ClassFields extends RawShape = DefinitionFields<Definition>
> = SchemaClassBase<
  Self,
  Definition,
  ConstructorProps,
  InstanceProps,
  Inherited,
  ProtectedKeys,
  ClassFields
> & (
  Definition extends AnyObjectSchema
    ? ObjectClassDerivations<Self, Definition, ProtectedKeys>
    : object
)
