import * as z from 'zod'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type {
  GenericClassAnnotations,
  GenericClassDefinition,
  GenericSchemaClass
} from '../../types/generic-class.js'
import type {
  TaggedClassBuilder,
  TaggedClassType,
  TaggedErrorBuilder,
  TaggedErrorType
} from '../../types/tagged.js'
import { createGenericClass } from '../../internal/generic-factory.js'
import { createTaggedClass, createTaggedError } from '../../internal/tagged.js'
import { Result } from 'better-result'
import {
  asStandardSchema,
  isZodCodec,
  isZodObject,
  isZodSchema,
  toZodSchema,
  zodFieldMap
} from './support.js'

type ZodShape = z.core.$ZodShape
type ZodNative = z.ZodType

type NativeOf<Definition> = Definition extends ZodNative
  ? Definition
  : Definition extends ZodShape
    ? z.ZodObject<Definition>
    : never

type NativeFields<Native extends ZodNative> = z.output<Native> extends infer Output extends object
  ? { readonly [Key in keyof Output]: StandardSchemaV1 }
  : never

type DefinitionOf<Native extends ZodNative> = GenericClassDefinition<
  z.input<Native>,
  z.output<Native>,
  z.output<Native>,
  z.input<Native>
> & {
  readonly fields: NativeFields<Native>
  readonly struct: Native
  readonly codec: Native
}

type ObjectParts<Native extends ZodNative> = Native extends z.ZodObject<infer Shape, infer Config>
  ? { readonly shape: Shape; readonly config: Config }
  : never

type ObjectShape<Native extends ZodNative> = ObjectParts<Native>['shape']
type ObjectConfig<Native extends ZodNative> = ObjectParts<Native>['config']
type ObjectResult<Native extends ZodNative, Shape extends z.core.$ZodShape> = z.ZodObject<
  Shape,
  ObjectConfig<Native>
>
type ObjectMask<Shape extends z.core.$ZodShape> = { readonly [Key in keyof Shape]?: true }
type OptionalShape<Shape extends z.core.$ZodShape> = {
  -readonly [Key in keyof Shape]: z.ZodOptional<Shape[Key]>
}
type ExactOptionalShape<Shape extends z.core.$ZodShape> = {
  -readonly [Key in keyof Shape]: z.ZodExactOptional<Shape[Key]>
}
type RequiredShape<Shape extends z.core.$ZodShape> = {
  -readonly [Key in keyof Shape]: z.ZodNonOptional<Shape[Key]>
}

type ZodClassDerivations<Self, Native extends ZodNative> = Native extends z.ZodObject<
  infer Shape,
  infer Config
>
  ? {
      readonly extend: <DerivedSelf>(
        identifier: string,
        annotations?: GenericClassAnnotations
      ) => (
        <Augmentation extends z.core.$ZodLooseShape>(
          augmentation: Augmentation
        ) => ZodClassType<
          DerivedSelf,
          z.ZodObject<z.util.Extend<Shape, z.util.Writeable<Augmentation>>, Config>,
          Self
        >
      )
      readonly pick: <DerivedSelf>(
        identifier: string,
        annotations?: GenericClassAnnotations
      ) => (
        <Mask extends ObjectMask<Shape>>(
          mask: Mask & Record<Exclude<keyof Mask, keyof Shape>, never>
        ) => ZodClassType<
          DerivedSelf,
          ObjectResult<Native, z.util.Flatten<Pick<Shape, Extract<keyof Shape, keyof Mask>>>>,
          Self
        >
      )
      readonly omit: <DerivedSelf>(
        identifier: string,
        annotations?: GenericClassAnnotations
      ) => (
        <Mask extends ObjectMask<Shape>>(
          mask: Mask & Record<Exclude<keyof Mask, keyof Shape>, never>
        ) => ZodClassType<
          DerivedSelf,
          ObjectResult<Native, z.util.Flatten<Omit<Shape, Extract<keyof Shape, keyof Mask>>>>,
          Self
        >
      )
      readonly partial: <DerivedSelf, Mask extends ObjectMask<Shape> = ObjectMask<Shape>>(
        identifier: string,
        mask?: Mask
      ) => ZodClassType<
        DerivedSelf,
        ObjectResult<
          Native,
          Mask extends ObjectMask<Shape>
            ? { -readonly [Key in keyof Shape]: Key extends keyof Mask ? z.ZodOptional<Shape[Key]> : Shape[Key] }
            : OptionalShape<Shape>
        >,
        Self
      >
      readonly exactPartial: <DerivedSelf, Mask extends ObjectMask<Shape> = ObjectMask<Shape>>(
        identifier: string,
        mask?: Mask
      ) => ZodClassType<
        DerivedSelf,
        ObjectResult<
          Native,
          Mask extends ObjectMask<Shape>
            ? { -readonly [Key in keyof Shape]: Key extends keyof Mask ? z.ZodExactOptional<Shape[Key]> : Shape[Key] }
            : ExactOptionalShape<Shape>
        >,
        Self
      >
      readonly required: <DerivedSelf, Mask extends ObjectMask<Shape> = ObjectMask<Shape>>(
        identifier: string,
        mask?: Mask
      ) => ZodClassType<
        DerivedSelf,
        ObjectResult<
          Native,
          Mask extends ObjectMask<Shape>
            ? { -readonly [Key in keyof Shape]: Key extends keyof Mask ? z.ZodNonOptional<Shape[Key]> : Shape[Key] }
            : RequiredShape<Shape>
        >,
        Self
      >
      readonly deepPartial: <DerivedSelf>(
        identifier: string,
        annotations?: GenericClassAnnotations
      ) => ZodClassType<DerivedSelf, z.ZodType, Self>
      readonly strict: <DerivedSelf>(
        identifier: string,
        annotations?: GenericClassAnnotations
      ) => ZodClassType<DerivedSelf, ObjectResult<Native, Shape>, Self>
      readonly loose: <DerivedSelf>(
        identifier: string,
        annotations?: GenericClassAnnotations
      ) => ZodClassType<DerivedSelf, ObjectResult<Native, Shape>, Self>
      readonly strip: <DerivedSelf>(
        identifier: string,
        annotations?: GenericClassAnnotations
      ) => ZodClassType<DerivedSelf, ObjectResult<Native, Shape>, Self>
      readonly catchall: <DerivedSelf>(
        identifier: string,
        annotations?: GenericClassAnnotations
      ) => (field: z.core.SomeType) => ZodClassType<DerivedSelf, ObjectResult<Native, Shape>, Self>
    }
  : object

export type ZodClassType<Self, Native extends ZodNative, Inherited = object> =
  GenericSchemaClass<Self, DefinitionOf<Native>, Inherited> & {
    readonly encodedSchema: StandardSchemaV1<z.input<Native>, z.input<Native>>
    readonly fields: NativeFields<Native>
    readonly struct: Native
    readonly codec: Native
  } & ZodClassDerivations<Self, Native>

export interface ZodClassBuilder<Self> {
  <const Definition extends ZodNative | ZodShape>(
    definition: Definition
  ): ZodClassType<Self, NativeOf<Definition>>
}

export interface ZodClassFactory {
  <Self = never>(
    identifier: string,
    annotations?: GenericClassAnnotations
  ): [Self] extends [never]
    ? 'Missing `Self` generic - use `class Self extends Schema.Class<Self>(...)`'
    : ZodClassBuilder<Self>
}

type StandardZodField<Field> = Field extends ZodNative
  ? StandardSchemaV1<z.input<Field>, z.output<Field>>
  : StandardSchemaV1

type StandardZodFields<Fields extends ZodShape> = {
  readonly [Key in keyof Fields]: StandardZodField<Fields[Key]>
}

type ZodTaggedClassBuilder<Self> = {
  <const Tag extends string, const Fields extends ZodShape>(
    tag: Tag,
    fields: Fields,
    annotations?: GenericClassAnnotations
  ): TaggedClassType<Self, Tag, StandardZodFields<Fields>>
}

type ZodTaggedErrorBuilder<Self> = {
  <const Tag extends string, const Fields extends ZodShape>(
    tag: Tag,
    fields: Fields,
    annotations?: GenericClassAnnotations
  ): TaggedErrorType<Self, Tag, StandardZodFields<Fields>>
}

export interface ZodClassCapabilities {
  readonly Class: ZodClassFactory
  readonly TaggedClass: <Self = never>() => [Self] extends [never]
    ? 'Missing `Self` generic - use `class Self extends Schema.TaggedClass<Self>()(...)`'
    : ZodTaggedClassBuilder<Self>
  readonly TaggedError: <Self = never>() => [Self] extends [never]
    ? 'Missing `Self` generic - use `class Self extends Schema.TaggedError<Self>()(...)`'
    : ZodTaggedErrorBuilder<Self>
}

const invalidSchema = (message: string): StandardSchemaV1 => ({
  '~standard': {
    version: 1,
    vendor: 'better-effect-schema/zod',
    validate: () => ({ issues: [{ message }] })
  }
})

const fieldMapOf = (native: ZodNative): Readonly<Record<string, StandardSchemaV1>> | undefined => {
  if (!isZodObject(native)) return undefined
  const fields = zodFieldMap(native.shape)
  return Result.isOk(fields) ? fields.value : undefined
}

const hasCodec = (native: ZodNative, seen = new Set<unknown>()): boolean => {
  if (seen.has(native)) return false
  seen.add(native)
  if (isZodCodec(native)) return true
  if (!isZodObject(native)) return false

  try {
    return Object.values(native.shape).some((field) => isZodSchema(field) && hasCodec(field, seen))
  } catch {
    return false
  }
}

const zodDefinition = (value: unknown): GenericClassDefinition => {
  const native = toZodSchema(value)
  if (native === undefined) {
    const invalid = invalidSchema('Expected a Zod schema or raw Zod shape.')
    return { schema: invalid, propsSchema: invalid, encodedSchema: invalid }
  }

  const props = z.output(native)
  const encoded = z.input(native)
  const fields = fieldMapOf(native)
  const definition: GenericClassDefinition = {
    schema: asStandardSchema(native),
    propsSchema: asStandardSchema(props),
    encodedSchema: asStandardSchema(encoded),
    struct: native,
    codec: native,
    ...(fields === undefined ? {} : { fields })
  }

  if (hasCodec(native)) {
    return {
      ...definition,
      encode(value: unknown) {
        return Reflect.apply(Reflect.get(native, 'encode') as (...args: unknown[]) => unknown, native, [value])
      }
    }
  }

  return definition
}

const callZod = (native: ZodNative, method: string, args: readonly unknown[]): ZodNative => {
  const candidate = Reflect.get(native, method)
  if (typeof candidate !== 'function') throw new TypeError(`Zod schema does not support ${method}.`)
  return Reflect.apply(candidate, native, args) as ZodNative
}

const attachDerivations = <Self, Native extends ZodNative>(
  schemaClass: GenericSchemaClass<Self, DefinitionOf<Native>>,
  native: Native,
  annotations: GenericClassAnnotations | undefined
): GenericSchemaClass<Self, DefinitionOf<Native>> => {
  const derive = (
    baseClass: Function,
    identifier: string,
    method: string,
    args: readonly unknown[]
  ) => createZodClass(identifier, callZod(native, method, args), annotations, baseClass)

  Object.defineProperties(schemaClass, {
    extend: {
      configurable: true,
      value: function (this: Function, identifier: string, _next?: GenericClassAnnotations) {
        return (fields: unknown) => derive(this, identifier, 'extend', [fields])
      }
    },
    pick: {
      configurable: true,
      value: function (this: Function, identifier: string, _next?: GenericClassAnnotations) {
        return (mask: unknown) => derive(this, identifier, 'pick', [mask])
      }
    },
    omit: {
      configurable: true,
      value: function (this: Function, identifier: string, _next?: GenericClassAnnotations) {
        return (mask: unknown) => derive(this, identifier, 'omit', [mask])
      }
    },
    partial: {
      configurable: true,
      value: function (this: Function, identifier: string, mask?: unknown) {
        return derive(this, identifier, 'partial', mask === undefined ? [] : [mask])
      }
    },
    exactPartial: {
      configurable: true,
      value: function (this: Function, identifier: string, mask?: unknown) {
        return derive(this, identifier, 'exactPartial', mask === undefined ? [] : [mask])
      }
    },
    required: {
      configurable: true,
      value: function (this: Function, identifier: string, mask?: unknown) {
        return derive(this, identifier, 'required', mask === undefined ? [] : [mask])
      }
    },
    deepPartial: {
      configurable: true,
      value: function (this: Function, identifier: string) {
        return createZodClass(identifier, z.deepPartial(native), annotations, this)
      }
    },
    strict: {
      configurable: true,
      value: function (this: Function, identifier: string) {
        return derive(this, identifier, 'strict', [])
      }
    },
    loose: {
      configurable: true,
      value: function (this: Function, identifier: string) {
        return derive(this, identifier, 'loose', [])
      }
    },
    strip: {
      configurable: true,
      value: function (this: Function, identifier: string) {
        return derive(this, identifier, 'strip', [])
      }
    },
    catchall: {
      configurable: true,
      value: function (this: Function, identifier: string) {
        return (field: unknown) => derive(this, identifier, 'catchall', [field])
      }
    }
  })
  return schemaClass
}

const createZodClass = <Self, Native extends ZodNative>(
  identifier: string,
  native: Native,
  annotations?: GenericClassAnnotations,
  baseClass?: Function
): ZodClassType<Self, Native> =>
  attachDerivations(
    createGenericClass<Self, DefinitionOf<Native>>(
      identifier,
      zodDefinition(native) as DefinitionOf<Native>,
      annotations,
      baseClass === undefined ? undefined : { baseClass }
    ),
    native,
    annotations
  ) as ZodClassType<Self, Native>

const makeClass = <Self>(identifier: string, annotations?: GenericClassAnnotations): ZodClassBuilder<Self> =>
  ((definition: ZodNative | ZodShape) =>
    createZodClass<Self, NativeOf<typeof definition>>(
      identifier,
      toZodSchema(definition) as NativeOf<typeof definition>,
      annotations
    )) as ZodClassBuilder<Self>

const toStandardFields = (fields: unknown): Readonly<Record<string, StandardSchemaV1>> => {
  if ((typeof fields !== 'object' || fields === null) && typeof fields !== 'function') return {}
  const result: Record<string, StandardSchemaV1> = {}
  for (const key of Object.keys(fields)) {
    const field = Reflect.get(fields, key)
    result[key] = isZodSchema(field) ? asStandardSchema(field) : invalidSchema(`Invalid Zod field: ${key}`)
  }
  return result
}

const makeTagged = <Self>(
  factory: typeof createTaggedClass | typeof createTaggedError
) => (tag: string, fields: ZodShape, annotations?: GenericClassAnnotations) =>
  (factory as unknown as () => (
    tag: string,
    fields: Readonly<Record<string, StandardSchemaV1>>,
    annotations?: GenericClassAnnotations,
    encode?: (value: unknown) => unknown
  ) => unknown)()(tag, toStandardFields(fields), annotations, (value) => {
    const native = z.object({ ...fields, _tag: z.literal(tag) })
    return native.encode(value as z.input<typeof native>)
  })

export const ZodClassCapabilities: ZodClassCapabilities = Object.freeze({
  Class: makeClass as ZodClassFactory,
  TaggedClass: (() => makeTagged(createTaggedClass)) as unknown as ZodClassCapabilities['TaggedClass'],
  TaggedError: (() => makeTagged(createTaggedError)) as unknown as ZodClassCapabilities['TaggedError']
})
