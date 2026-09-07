import type { SchemaAdapter } from '../../capabilities/types.js'
import { bridgeZodSchema, ZodCodecCapabilities } from './codec.js'
import { ZodObjectCapabilities } from './object.js'

/** Optional Zod 4.5 adapter. It is not installed by the provider-neutral entrypoint. */
export const ZodAdapter = Object.freeze({
  name: 'zod',
  bridge: { bridge: bridgeZodSchema },
  derivation: ZodObjectCapabilities.derivation,
  encoded: ZodCodecCapabilities.encoded,
  encoding: ZodCodecCapabilities.encoding,
  props: ZodCodecCapabilities.props,
  read: ZodCodecCapabilities.read,
  structure: ZodObjectCapabilities.structure
}) satisfies SchemaAdapter

export { isZodCodec, isZodObject, isZodSchema, toZodSchema, type ZodSchema } from './support.js'

export { bridgeZodSchema } from './codec.js'
