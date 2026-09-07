import { createTaggedClass } from './internal/tagged.js'
import type { TaggedClassFactory } from './types/tagged.js'

/** Creates a schema-backed class with an injected, protected literal `_tag`. */
export const TaggedClass = createTaggedClass as unknown as TaggedClassFactory
