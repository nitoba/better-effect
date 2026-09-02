import * as z from "zod"

import {
  clearCachedClassCodec,
  getCachedClassCodec,
  setCachedClassCodec
} from "./codec-cache.js"
import { withPrevalidatedConstruction } from "./construction-context.js"
import { getDescriptor } from "./descriptor.js"
import { extractProps, hasClassIdentity } from "./instance.js"
import { attachMetadataToCodec } from "./metadata.js"

const constructFromDecoded = (
  constructor: Function,
  props: Record<PropertyKey, unknown>
): object => withPrevalidatedConstruction(
  constructor,
  props,
  () => Reflect.construct(
    constructor as new (...args: readonly unknown[]) => object,
    [props]
  )
)

/** Returns the concrete codec for a class constructor. */
export const getClassCodec = (constructor: Function): z.ZodType => {
  const cached = getCachedClassCodec(constructor)
  if (cached !== undefined) return cached

  const descriptor = getDescriptor(constructor)
  const outputSchema = z.custom<object>(
    (value) => hasClassIdentity(
      value,
      descriptor.identifier,
      descriptor.kind
    ),
    { error: `Expected an instance of ${descriptor.identifier}` }
  )

  const codec = z.codec(
    descriptor.definition,
    outputSchema,
    {
      decode: (props) => constructFromDecoded(
        constructor,
        props as Record<PropertyKey, unknown>
      ),
      encode: (instance) => extractProps(instance)
    }
  )

  setCachedClassCodec(constructor, codec)
  attachMetadataToCodec(constructor, codec)
  return codec
}

export const clearClassCodec = (constructor: Function): void => {
  clearCachedClassCodec(constructor)
}
