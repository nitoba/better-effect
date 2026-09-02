import { createClass } from "./internal/factory.js"
import { createTaggedShape, TAG_FIELD } from "./internal/tag.js"
import type {
  ClassAnnotations,
  RawShape,
  TaggedClassFactory
} from "./types.js"

const makeTaggedClass = () => (
  tag: string,
  fields: RawShape,
  annotations?: ClassAnnotations
) => createClass({
  identifier: tag,
  definition: createTaggedShape(tag, fields),
  kind: "tagged-class",
  tag,
  protectedKeys: [TAG_FIELD],
  ...(annotations === undefined ? {} : { annotations })
})

/** Creates a schema class with an injected and protected literal `_tag`. */
export const TaggedClass = makeTaggedClass as unknown as TaggedClassFactory
