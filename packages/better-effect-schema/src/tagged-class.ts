import { createClass } from './internal/factory.js'
import { createTaggedShape, TAG_FIELD } from './internal/tag.js'
import {
  createPortableTaggedClass,
  isLegacyTaggedShape,
  installLegacySafeFactories,
  portableDefinitionFailure,
  validateTaggedDefinition
} from './internal/tagged-runtime.js'
import type { TaggedAnnotations, TaggedClassFactory } from './types/tagged.js'
import type { TaggedFieldMap } from './internal/tagged-runtime.js'

const makeTaggedClass =
  () => (tag: string, fields: TaggedFieldMap, annotations?: TaggedAnnotations) => {
    const definitionFailure = validateTaggedDefinition({
      tag,
      fields,
      kind: 'tagged-class'
    })

    if (definitionFailure !== undefined || !isLegacyTaggedShape(fields as unknown as object)) {
      return createPortableTaggedClass({
        tag,
        fields,
        kind: 'tagged-class',
        ...(definitionFailure === undefined ? {} : { definitionFailure })
      })
    }

    try {
      const schemaClass = createClass({
        identifier: tag,
        definition: createTaggedShape(
          tag,
          fields as unknown as Parameters<typeof createTaggedShape>[1]
        ),
        kind: 'tagged-class',
        tag,
        protectedKeys: [TAG_FIELD],
        ...(annotations === undefined ? {} : { annotations })
      })
      installLegacySafeFactories(schemaClass, tag)
      return schemaClass
    } catch (cause) {
      return createPortableTaggedClass({
        tag,
        fields,
        kind: 'tagged-class',
        definitionFailure: portableDefinitionFailure(tag, 'definition', cause)
      })
    }
  }

/** Creates a schema class with an injected and protected literal `_tag`. */
export const TaggedClass = makeTaggedClass as unknown as TaggedClassFactory
