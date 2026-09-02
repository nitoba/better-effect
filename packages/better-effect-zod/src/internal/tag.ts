import * as z from "zod"

import { BetterEffectZodError } from "../errors.js"
import type { RawShape } from "../types.js"

export const TAG_FIELD = "_tag" as const
export const ERROR_RESERVED_FIELDS = ["name", "stack", "match", "toJSON"] as const
export type ErrorReservedField = typeof ERROR_RESERVED_FIELDS[number]

export const assertReservedFields = (
  fields: RawShape,
  reservedFields: readonly PropertyKey[]
): void => {
  for (const field of reservedFields) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) continue

    throw new BetterEffectZodError(
      "INVALID_TAG",
      `The ${String(field)} field is reserved by Schema.TaggedError.`
    )
  }
}

export const assertTagFields = (fields: RawShape): void => {
  if (!Object.prototype.hasOwnProperty.call(fields, TAG_FIELD)) return

  throw new BetterEffectZodError(
    "INVALID_TAG",
    `The ${TAG_FIELD} field is managed by Schema.TaggedClass and Schema.TaggedError.`
  )
}

export const createTaggedShape = (
  tag: string,
  fields: RawShape
): RawShape => {
  assertTagFields(fields)
  return {
    [TAG_FIELD]: z.literal(tag),
    ...fields
  }
}
