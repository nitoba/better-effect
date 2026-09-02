import { TaggedError as BetterResultTaggedError } from "better-result"

import { createClass } from "./internal/factory.js"
import type { RuntimeBase } from "./internal/class-types.js"
import {
  assertReservedFields,
  createTaggedShape,
  ERROR_RESERVED_FIELDS,
  TAG_FIELD
} from "./internal/tag.js"
import type {
  ClassAnnotations,
  RawShape,
  TaggedErrorFactory
} from "./types.js"

const makeTaggedError = () => (
  tag: string,
  fields: RawShape,
  annotations?: ClassAnnotations
) => {
  assertReservedFields(fields, ERROR_RESERVED_FIELDS)

  const runtimeBase = BetterResultTaggedError(tag) as unknown as RuntimeBase

  return createClass({
    identifier: tag,
    definition: createTaggedShape(tag, fields),
    kind: "tagged-error",
    tag,
    runtimeBase,
    protectedKeys: [TAG_FIELD, ...ERROR_RESERVED_FIELDS],
    ...(annotations === undefined ? {} : { annotations })
  })
}

/** Creates a schema-backed tagged error using the better-result runtime protocol. */
export const TaggedError = makeTaggedError as unknown as TaggedErrorFactory
