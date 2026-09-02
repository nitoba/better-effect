import type * as z from "zod"

import type {
  ClassAnnotations,
  ClassDefinition,
  ClassKind,
  FieldMask,
  RawShape,
  ToJSONSchemaParams
} from "../types.js"

export type RuntimeBase = new (...args: readonly unknown[]) => object

export interface CreateClassOptions {
  readonly identifier: string
  readonly definition: RawShape | ClassDefinition
  readonly annotations?: ClassAnnotations | undefined
  readonly parent?: Function | undefined
  readonly runtimeBase?: RuntimeBase | undefined
  readonly kind?: ClassKind | undefined
  readonly tag?: string | undefined
  readonly protectedKeys?: readonly PropertyKey[] | undefined
}

export interface RegistryLike<Metadata> {
  add(schema: object, metadata?: Metadata): unknown
}

export interface RuntimeSchemaClass {
  new (props?: unknown): object

  readonly identifier: string
  readonly fields: RawShape
  readonly struct: z.ZodType
  readonly schema: RuntimeSchemaClass
  readonly codec: z.ZodType
  readonly encodedSchema: z.ZodType
  readonly propsSchema: z.ZodType
  readonly kind: ClassKind

  make(props?: unknown): object
  unsafeMake(props?: unknown): object
  makeAsync(props?: unknown): Promise<object>
  safeMake(props?: unknown): z.ZodSafeParseResult<object>
  safeMakeAsync(props?: unknown): Promise<z.ZodSafeParseResult<object>>
  is(value: unknown): boolean

  extend(
    identifier: string,
    annotations?: ClassAnnotations
  ): (augmentation: RawShape) => RuntimeSchemaClass

  pick(
    identifier: string,
    annotations?: ClassAnnotations
  ): (mask: FieldMask<RawShape>) => RuntimeSchemaClass

  omit(
    identifier: string,
    annotations?: ClassAnnotations
  ): (mask: FieldMask<RawShape>) => RuntimeSchemaClass

  partial(
    identifier: string,
    maskOrAnnotations?: FieldMask<RawShape> | ClassAnnotations,
    annotations?: ClassAnnotations
  ): RuntimeSchemaClass

  exactPartial(
    identifier: string,
    maskOrAnnotations?: FieldMask<RawShape> | ClassAnnotations,
    annotations?: ClassAnnotations
  ): RuntimeSchemaClass

  deepPartial(
    identifier: string,
    annotations?: ClassAnnotations
  ): RuntimeSchemaClass

  required(
    identifier: string,
    maskOrAnnotations?: FieldMask<RawShape> | ClassAnnotations,
    annotations?: ClassAnnotations
  ): RuntimeSchemaClass

  strict(identifier: string, annotations?: ClassAnnotations): RuntimeSchemaClass
  loose(identifier: string, annotations?: ClassAnnotations): RuntimeSchemaClass
  strip(identifier: string, annotations?: ClassAnnotations): RuntimeSchemaClass
  catchall(
    identifier: string,
    annotations?: ClassAnnotations
  ): (schema: z.ZodType) => RuntimeSchemaClass

  meta(): ClassAnnotations | undefined
  meta(metadata: ClassAnnotations): RuntimeSchemaClass
  describe(description: string): RuntimeSchemaClass
  register<Metadata>(
    registry: RegistryLike<Metadata>,
    metadata?: Metadata
  ): RuntimeSchemaClass
  toJSONSchema(params?: ToJSONSchemaParams): unknown
}

export type RuntimeClassCreator = (
  options: CreateClassOptions
) => RuntimeSchemaClass
