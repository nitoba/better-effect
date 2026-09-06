import type * as z from "zod"

import { BetterEffectZodError } from "../errors.js"
import type {
  AnyObjectSchema,
  ClassAnnotations,
  FieldMask,
  RawShape
} from "../types.js"
import type {
  CreateClassOptions,
  RuntimeClassCreator,
  RuntimeSchemaClass
} from "./class-types.js"
import {
  catchallObjectSchema,
  deepPartialObjectSchema,
  exactPartialObjectSchema,
  extendObjectSchema,
  isFieldMask,
  looseObjectSchema,
  omitObjectSchema,
  partialObjectSchema,
  pickObjectSchema,
  requiredObjectSchema,
  strictObjectSchema,
  stripObjectSchema,
  validateClassIdentifier
} from "./derivation.js"
import { getDescriptor, type ClassDescriptor } from "./descriptor.js"

const derivationStruct = (descriptor: ClassDescriptor): AnyObjectSchema => {
  if (descriptor.derivationStruct !== undefined) return descriptor.derivationStruct

  throw new BetterEffectZodError(
    "INVALID_DERIVATION",
    "Structural class derivations are unavailable for classes backed by whole-object codecs."
  )
}

const derivedOptions = (
  inherited: ClassDescriptor,
  parent: Function,
  identifier: string,
  definition: AnyObjectSchema,
  annotations?: ClassAnnotations
): CreateClassOptions => ({
  identifier,
  definition,
  parent,
  kind: inherited.kind,
  tag: inherited.tag,
  protectedKeys: inherited.protectedKeys,
  ...(annotations === undefined ? {} : { annotations })
})

const defineMethod = (
  constructor: RuntimeSchemaClass,
  name: PropertyKey,
  value: Function
): void => {
  Object.defineProperty(constructor, name, {
    configurable: true,
    enumerable: false,
    writable: true,
    value
  })
}

const deriveObjectMode = (
  current: RuntimeSchemaClass,
  create: RuntimeClassCreator,
  identifier: string,
  transform: (struct: AnyObjectSchema) => AnyObjectSchema,
  annotations?: ClassAnnotations
): RuntimeSchemaClass => {
  validateClassIdentifier(identifier)
  const inherited = getDescriptor(current)
  return create(derivedOptions(
    inherited,
    current,
    identifier,
    transform(derivationStruct(inherited)),
    annotations
  ))
}

export const installDerivationApi = (
  constructor: RuntimeSchemaClass,
  create: RuntimeClassCreator
): void => {
  defineMethod(constructor, "extend", function extend(
    this: RuntimeSchemaClass,
    identifier: string,
    annotations?: ClassAnnotations
  ): (augmentation: RawShape) => RuntimeSchemaClass {
    validateClassIdentifier(identifier)
    const parent = this

    return (augmentation) => {
      const inherited = getDescriptor(parent)
      return create(derivedOptions(
        inherited,
        parent,
        identifier,
        extendObjectSchema(
          derivationStruct(inherited),
          augmentation,
          inherited.protectedKeys
        ),
        annotations
      ))
    }
  })

  defineMethod(constructor, "pick", function pick(
    this: RuntimeSchemaClass,
    identifier: string,
    annotations?: ClassAnnotations
  ): (mask: FieldMask<RawShape>) => RuntimeSchemaClass {
    validateClassIdentifier(identifier)
    const parent = this

    return (mask) => {
      const inherited = getDescriptor(parent)
      return create(derivedOptions(
        inherited,
        parent,
        identifier,
        pickObjectSchema(
          derivationStruct(inherited),
          mask,
          inherited.protectedKeys
        ),
        annotations
      ))
    }
  })

  defineMethod(constructor, "omit", function omit(
    this: RuntimeSchemaClass,
    identifier: string,
    annotations?: ClassAnnotations
  ): (mask: FieldMask<RawShape>) => RuntimeSchemaClass {
    validateClassIdentifier(identifier)
    const parent = this

    return (mask) => {
      const inherited = getDescriptor(parent)
      return create(derivedOptions(
        inherited,
        parent,
        identifier,
        omitObjectSchema(
          derivationStruct(inherited),
          mask,
          inherited.protectedKeys
        ),
        annotations
      ))
    }
  })

  defineMethod(constructor, "partial", function partial(
    this: RuntimeSchemaClass,
    identifier: string,
    maskOrAnnotations?: FieldMask<RawShape> | ClassAnnotations,
    annotations?: ClassAnnotations
  ): RuntimeSchemaClass {
    validateClassIdentifier(identifier)
    const inherited = getDescriptor(this)
    const mask = isFieldMask(inherited.fields, maskOrAnnotations)
      ? maskOrAnnotations
      : undefined
    const metadata = mask === undefined
      ? maskOrAnnotations as ClassAnnotations | undefined
      : annotations

    return create(derivedOptions(
      inherited,
      this,
      identifier,
      partialObjectSchema(
        derivationStruct(inherited),
        mask,
        inherited.protectedKeys
      ),
      metadata
    ))
  })

  defineMethod(constructor, "exactPartial", function exactPartial(
    this: RuntimeSchemaClass,
    identifier: string,
    maskOrAnnotations?: FieldMask<RawShape> | ClassAnnotations,
    annotations?: ClassAnnotations
  ): RuntimeSchemaClass {
    validateClassIdentifier(identifier)
    const inherited = getDescriptor(this)
    const mask = isFieldMask(inherited.fields, maskOrAnnotations)
      ? maskOrAnnotations
      : undefined
    const metadata = mask === undefined
      ? maskOrAnnotations as ClassAnnotations | undefined
      : annotations

    return create(derivedOptions(
      inherited,
      this,
      identifier,
      exactPartialObjectSchema(
        derivationStruct(inherited),
        mask,
        inherited.protectedKeys
      ),
      metadata
    ))
  })

  defineMethod(constructor, "deepPartial", function deepPartial(
    this: RuntimeSchemaClass,
    identifier: string,
    annotations?: ClassAnnotations
  ): RuntimeSchemaClass {
    validateClassIdentifier(identifier)
    const inherited = getDescriptor(this)

    return create(derivedOptions(
      inherited,
      this,
      identifier,
      deepPartialObjectSchema(
        derivationStruct(inherited),
        inherited.protectedKeys
      ),
      annotations
    ))
  })

  defineMethod(constructor, "required", function required(
    this: RuntimeSchemaClass,
    identifier: string,
    maskOrAnnotations?: FieldMask<RawShape> | ClassAnnotations,
    annotations?: ClassAnnotations
  ): RuntimeSchemaClass {
    validateClassIdentifier(identifier)
    const inherited = getDescriptor(this)
    const mask = isFieldMask(inherited.fields, maskOrAnnotations)
      ? maskOrAnnotations
      : undefined
    const metadata = mask === undefined
      ? maskOrAnnotations as ClassAnnotations | undefined
      : annotations

    return create(derivedOptions(
      inherited,
      this,
      identifier,
      requiredObjectSchema(
        derivationStruct(inherited),
        mask,
        inherited.protectedKeys
      ),
      metadata
    ))
  })

  defineMethod(constructor, "strict", function strict(
    this: RuntimeSchemaClass,
    identifier: string,
    annotations?: ClassAnnotations
  ): RuntimeSchemaClass {
    return deriveObjectMode(this, create, identifier, strictObjectSchema, annotations)
  })

  defineMethod(constructor, "loose", function loose(
    this: RuntimeSchemaClass,
    identifier: string,
    annotations?: ClassAnnotations
  ): RuntimeSchemaClass {
    return deriveObjectMode(this, create, identifier, looseObjectSchema, annotations)
  })

  defineMethod(constructor, "strip", function strip(
    this: RuntimeSchemaClass,
    identifier: string,
    annotations?: ClassAnnotations
  ): RuntimeSchemaClass {
    return deriveObjectMode(this, create, identifier, stripObjectSchema, annotations)
  })

  defineMethod(constructor, "catchall", function catchall(
    this: RuntimeSchemaClass,
    identifier: string,
    annotations?: ClassAnnotations
  ): (schema: z.ZodType) => RuntimeSchemaClass {
    validateClassIdentifier(identifier)
    const parent = this

    return (schema) => {
      const inherited = getDescriptor(parent)
      return create(derivedOptions(
        inherited,
        parent,
        identifier,
        catchallObjectSchema(derivationStruct(inherited), schema),
        annotations
      ))
    }
  })
}
