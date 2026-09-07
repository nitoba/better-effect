import { createTaggedError } from './internal/tagged.js'
import type { TaggedErrorFactory } from './types/tagged.js'

/** Creates a schema-backed error using better-result's tagged error protocol. */
export const TaggedError = createTaggedError as unknown as TaggedErrorFactory
