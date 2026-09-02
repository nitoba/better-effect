import * as z from "zod"

import { BetterEffectZodError } from "../errors.js"
import type {
  AnyObjectCodec,
  AnyObjectSchema,
  ClassDefinition,
  RawShape
} from "../types.js"
import {
  getEncodedProjection,
  getPropsProjection
} from "./projections.js"

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const schemaInternals = (
  value: unknown
): Record<PropertyKey, unknown> | undefined => {
  if (!isRecord(value)) return undefined
  const internals = value["_zod"]
  return isRecord(internals) ? internals : undefined
}

export const isObjectSchema = (value: unknown): value is AnyObjectSchema => {
  const internals = schemaInternals(value)
  if (internals === undefined) return false

  const definition = internals["def"]
  return isRecord(definition) && definition["type"] === "object"
}

export const isCodecSchema = (value: unknown): value is AnyObjectCodec => {
  const internals = schemaInternals(value)
  if (internals === undefined) return false

  const traits = internals["traits"]
  return traits instanceof Set && traits.has("$ZodCodec")
}

const asObjectProjection = (
  projection: z.ZodType,
  side: "encoded" | "props"
): AnyObjectSchema => {
  if (isObjectSchema(projection)) return projection

  throw new BetterEffectZodError(
    "INVALID_DEFINITION",
    `Schema.Class whole-object codecs require an object ${side} projection.`
  )
}

export interface ResolvedClassDefinition {
  readonly definition: ClassDefinition
  readonly derivationStruct: AnyObjectSchema | undefined
  readonly encodedSchema: AnyObjectSchema
  readonly propsSchema: AnyObjectSchema
  readonly fields: RawShape
}

const fromObjectSchema = (
  schema: AnyObjectSchema
): ResolvedClassDefinition => ({
  definition: schema,
  derivationStruct: schema,
  encodedSchema: asObjectProjection(getEncodedProjection(schema), "encoded"),
  propsSchema: asObjectProjection(getPropsProjection(schema), "props"),
  fields: schema.shape
})

const fromCodec = (
  schema: AnyObjectCodec
): ResolvedClassDefinition => {
  const encodedSchema = asObjectProjection(
    getEncodedProjection(schema),
    "encoded"
  )
  const propsSchema = asObjectProjection(
    getPropsProjection(schema),
    "props"
  )

  return {
    definition: schema,
    derivationStruct: undefined,
    encodedSchema,
    propsSchema,
    fields: propsSchema.shape
  }
}

export const resolveClassDefinition = (
  definition: RawShape | ClassDefinition
): ResolvedClassDefinition => {
  if (isObjectSchema(definition)) return fromObjectSchema(definition)
  if (isCodecSchema(definition)) return fromCodec(definition)

  if (schemaInternals(definition) !== undefined) {
    throw new BetterEffectZodError(
      "INVALID_DEFINITION",
      "Schema.Class accepts Zod object schemas or bidirectional Zod codecs whose encoded and decoded projections are objects."
    )
  }

  if (isRecord(definition)) {
    return fromObjectSchema(z.object(definition as RawShape))
  }

  throw new BetterEffectZodError(
    "INVALID_DEFINITION",
    "Schema.Class expects a raw Zod shape, a Zod object schema, or a bidirectional object codec."
  )
}
