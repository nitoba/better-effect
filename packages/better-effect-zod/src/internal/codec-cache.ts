import type * as z from "zod"

const codecs = new WeakMap<Function, z.ZodType>()

export const getCachedClassCodec = (
  constructor: Function
): z.ZodType | undefined => codecs.get(constructor)

export const setCachedClassCodec = (
  constructor: Function,
  codec: z.ZodType
): void => {
  codecs.set(constructor, codec)
}

export const clearCachedClassCodec = (constructor: Function): void => {
  codecs.delete(constructor)
}
