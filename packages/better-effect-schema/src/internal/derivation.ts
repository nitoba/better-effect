import * as z from "zod"

import { BetterEffectZodError } from "../errors.js"
import type {
  AnyObjectSchema,
  FieldMask,
  RawShape
} from "../types.js"

export const validateClassIdentifier = (identifier: string): void => {
  if (identifier.trim().length > 0) return
  throw new BetterEffectZodError(
    "INVALID_IDENTIFIER",
    "Schema class identifiers must contain at least one non-whitespace character."
  )
}

const includesKey = (
  keys: readonly PropertyKey[],
  candidate: PropertyKey
): boolean => keys.some((key) => Object.is(key, candidate))

const ensureMask = (
  fields: RawShape,
  mask: Readonly<Record<PropertyKey, unknown>>,
  protectedKeys: readonly PropertyKey[]
): void => {
  for (const key of Reflect.ownKeys(mask)) {
    if (Reflect.get(mask, key) !== true) {
      throw new BetterEffectZodError(
        "INVALID_DERIVATION",
        `The mask value for ${String(key)} must be true.`
      )
    }

    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new BetterEffectZodError(
        "INVALID_DERIVATION",
        `Unknown schema class field: ${String(key)}.`
      )
    }

    if (includesKey(protectedKeys, key)) {
      throw new BetterEffectZodError(
        "INVALID_TAG",
        `The protected schema class field ${String(key)} cannot be transformed.`
      )
    }
  }
}

const ensureAugmentation = (
  augmentation: RawShape,
  protectedKeys: readonly PropertyKey[]
): void => {
  for (const key of protectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(augmentation, key)) continue

    throw new BetterEffectZodError(
      "INVALID_TAG",
      `The protected schema class field ${String(key)} cannot be overwritten.`
    )
  }
}

const addProtectedFields = (
  fields: RawShape,
  mask: FieldMask<RawShape>,
  protectedKeys: readonly PropertyKey[]
): FieldMask<RawShape> => {
  const result: Record<PropertyKey, true> = {}
  for (const key of Reflect.ownKeys(mask)) result[key] = true
  for (const key of protectedKeys) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) result[key] = true
  }
  return result
}

const transformableMask = (
  fields: RawShape,
  protectedKeys: readonly PropertyKey[]
): FieldMask<RawShape> => {
  const result: Record<PropertyKey, true> = {}
  for (const key of Reflect.ownKeys(fields)) {
    if (!includesKey(protectedKeys, key)) result[key] = true
  }
  return result
}

const callObjectMethod = (
  struct: AnyObjectSchema,
  method: "loose" | "passthrough"
): AnyObjectSchema | undefined => {
  const candidate = Reflect.get(struct, method) as unknown
  if (typeof candidate !== "function") return undefined
  return Reflect.apply(candidate, struct, []) as AnyObjectSchema
}

export const isFieldMask = (
  fields: RawShape,
  candidate: unknown
): candidate is FieldMask<RawShape> => {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return false
  }

  const keys = Reflect.ownKeys(candidate)
  return keys.every((key) =>
    Object.prototype.hasOwnProperty.call(fields, key)
      && Reflect.get(candidate, key) === true
  )
}


export const extendObjectSchema = (
  struct: AnyObjectSchema,
  augmentation: RawShape,
  protectedKeys: readonly PropertyKey[] = []
): AnyObjectSchema => {
  ensureAugmentation(augmentation, protectedKeys)

  const safeExtend = Reflect.get(struct, "safeExtend") as unknown
  if (typeof safeExtend === "function") {
    return Reflect.apply(safeExtend, struct, [augmentation]) as AnyObjectSchema
  }

  return struct.extend(augmentation) as AnyObjectSchema
}

export const pickObjectSchema = (
  struct: AnyObjectSchema,
  mask: FieldMask<RawShape>,
  protectedKeys: readonly PropertyKey[] = []
): AnyObjectSchema => {
  ensureMask(struct.shape, mask, protectedKeys)
  return struct.pick(
    addProtectedFields(struct.shape, mask, protectedKeys)
  ) as AnyObjectSchema
}

export const omitObjectSchema = (
  struct: AnyObjectSchema,
  mask: FieldMask<RawShape>,
  protectedKeys: readonly PropertyKey[] = []
): AnyObjectSchema => {
  ensureMask(struct.shape, mask, protectedKeys)
  return struct.omit(mask) as AnyObjectSchema
}

export const partialObjectSchema = (
  struct: AnyObjectSchema,
  mask?: FieldMask<RawShape>,
  protectedKeys: readonly PropertyKey[] = []
): AnyObjectSchema => {
  if (mask !== undefined) {
    ensureMask(struct.shape, mask, protectedKeys)
    return struct.partial(mask) as AnyObjectSchema
  }

  if (protectedKeys.length === 0) return struct.partial() as AnyObjectSchema
  return struct.partial(
    transformableMask(struct.shape, protectedKeys)
  ) as AnyObjectSchema
}


export const exactPartialObjectSchema = (
  struct: AnyObjectSchema,
  mask?: FieldMask<RawShape>,
  protectedKeys: readonly PropertyKey[] = []
): AnyObjectSchema => {
  if (mask !== undefined) {
    ensureMask(struct.shape, mask, protectedKeys)
    return struct.exactPartial(mask) as AnyObjectSchema
  }

  if (protectedKeys.length === 0) return struct.exactPartial() as AnyObjectSchema
  return struct.exactPartial(
    transformableMask(struct.shape, protectedKeys)
  ) as AnyObjectSchema
}

export const deepPartialObjectSchema = (
  struct: AnyObjectSchema,
  protectedKeys: readonly PropertyKey[] = []
): AnyObjectSchema => {
  const partial = z.deepPartial(struct) as AnyObjectSchema
  if (protectedKeys.length === 0) return partial

  const protectedFields: RawShape = {}
  for (const key of protectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(struct.shape, key)) continue
    Object.defineProperty(protectedFields, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: Reflect.get(struct.shape, key)
    })
  }
  return extendObjectSchema(partial, protectedFields)
}

export const requiredObjectSchema = (
  struct: AnyObjectSchema,
  mask?: FieldMask<RawShape>,
  protectedKeys: readonly PropertyKey[] = []
): AnyObjectSchema => {
  if (mask !== undefined) {
    ensureMask(struct.shape, mask, protectedKeys)
    return struct.required(mask) as AnyObjectSchema
  }

  if (protectedKeys.length === 0) return struct.required() as AnyObjectSchema
  return struct.required(
    transformableMask(struct.shape, protectedKeys)
  ) as AnyObjectSchema
}

export const strictObjectSchema = (
  struct: AnyObjectSchema
): AnyObjectSchema => struct.strict() as AnyObjectSchema

export const looseObjectSchema = (
  struct: AnyObjectSchema
): AnyObjectSchema => callObjectMethod(struct, "loose")
  ?? callObjectMethod(struct, "passthrough")
  ?? (() => {
    throw new BetterEffectZodError(
      "INVALID_DERIVATION",
      "The installed Zod version does not expose loose object schemas."
    )
  })()

export const stripObjectSchema = (
  struct: AnyObjectSchema
): AnyObjectSchema => struct.strip() as AnyObjectSchema

export const catchallObjectSchema = (
  struct: AnyObjectSchema,
  schema: z.ZodType
): AnyObjectSchema => {
  const catchall = Reflect.get(struct, "catchall") as unknown
  if (typeof catchall !== "function") {
    throw new BetterEffectZodError(
      "INVALID_DERIVATION",
      "The installed Zod version does not expose object catchall schemas."
    )
  }

  return Reflect.apply(catchall, struct, [schema]) as AnyObjectSchema
}
