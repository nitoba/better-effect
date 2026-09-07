import { TaggedError as BetterResultTaggedError } from 'better-result'

import { createClass } from './internal/factory.js'
import type { RuntimeBase } from './internal/class-types.js'
import { createTaggedShape, ERROR_RESERVED_FIELDS, TAG_FIELD } from './internal/tag.js'
import {
  createPortableTaggedClass,
  isLegacyTaggedShape,
  installLegacySafeFactories,
  portableDefinitionFailure,
  validateTaggedDefinition
} from './internal/tagged-runtime.js'
import type { TaggedAnnotations, TaggedErrorFactory } from './types/tagged.js'
import type { TaggedFieldMap } from './internal/tagged-runtime.js'

const makeTaggedError =
  () => (tag: string, fields: TaggedFieldMap, annotations?: TaggedAnnotations) => {
    const definitionFailure = validateTaggedDefinition({
      tag,
      fields,
      kind: 'tagged-error'
    })

    if (definitionFailure !== undefined || !isLegacyTaggedShape(fields as unknown as object)) {
      return createPortableTaggedClass({
        tag,
        fields,
        kind: 'tagged-error',
        ...(definitionFailure === undefined ? {} : { definitionFailure })
      })
    }

    try {
      const runtimeBase = BetterResultTaggedError(tag) as unknown as RuntimeBase
      const schemaClass = createClass({
        identifier: tag,
        definition: createTaggedShape(
          tag,
          fields as unknown as Parameters<typeof createTaggedShape>[1]
        ),
        kind: 'tagged-error',
        tag,
        runtimeBase,
        protectedKeys: [TAG_FIELD, ...ERROR_RESERVED_FIELDS],
        ...(annotations === undefined ? {} : { annotations })
      })
      installLegacySafeFactories(schemaClass, tag)
      return schemaClass
    } catch (cause) {
      return createPortableTaggedClass({
        tag,
        fields,
        kind: 'tagged-error',
        definitionFailure: portableDefinitionFailure(tag, 'definition', cause)
      })
    }
  }

/** Creates a schema-backed tagged error using the better-result runtime protocol. */
export const TaggedError = makeTaggedError as unknown as TaggedErrorFactory
