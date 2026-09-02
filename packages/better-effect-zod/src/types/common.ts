import type * as z from "zod"

/**
 * @deprecated Construction options were removed. Normal constructors always
 * validate; use the explicit static `unsafeMake` escape when required.
 */
export type MakeOptions = never

export type ClassKind = "class" | "tagged-class" | "tagged-error"
export type ClassAnnotations = z.core.GlobalMeta
export type ToJSONSchemaParams = NonNullable<Parameters<typeof z.toJSONSchema>[1]>
export type RawShape = z.core.$ZodShape
export type AnyObjectSchema = z.ZodObject<z.core.$ZodShape, z.core.$ZodObjectConfig>
export type AnyObjectCodec = z.ZodCodec<AnyObjectSchema, AnyObjectSchema>
export type ClassDefinition = AnyObjectSchema | AnyObjectCodec
export type ShapeOf<Schema extends AnyObjectSchema> = Schema["shape"]
export type ConfigOf<Schema extends AnyObjectSchema> =
  Schema extends z.ZodObject<z.core.$ZodShape, infer Config>
    ? Config
    : z.core.$ZodObjectConfig

export type DefinitionFields<Definition extends ClassDefinition> =
  Definition extends AnyObjectSchema
    ? ShapeOf<Definition>
    : Definition extends z.ZodCodec<
        AnyObjectSchema,
        infer PropsSchema extends AnyObjectSchema
      >
      ? ShapeOf<PropsSchema>
      : never

export type Simplify<Value> = Value extends object
  ? { readonly [Key in keyof Value]: Value[Key] }
  : Value

export type ConstructorArgs<Props> = keyof Props extends never
  ? readonly [props?: Props]
  : {} extends Props
    ? readonly [props?: Props]
    : readonly [props: Props]

export type FieldMask<
  Shape extends RawShape,
  ProtectedKeys extends PropertyKey = never
> = {
  readonly [Key in Exclude<keyof Shape, ProtectedKeys>]?: true
}

export type ClassAugmentation<ProtectedKeys extends PropertyKey = never> =
  RawShape & {
    readonly [Key in ProtectedKeys]?: never
  }

export type ConstructionProps<
  Definition extends z.ZodType,
  ProtectedKeys extends PropertyKey = never
> = Simplify<
  Omit<
    z.output<Definition>,
    Extract<ProtectedKeys, keyof z.output<Definition>>
  >
>

export type InheritedClassMembers<
  Self,
  Definition extends z.ZodType
> = Omit<Self, keyof z.output<Definition>>
