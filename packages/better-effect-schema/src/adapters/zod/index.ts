import type { SchemaAdapter } from '../../capabilities/types.js'
import { bridgeZodSchema, ZodCodecCapabilities } from './codec.js'
import { ZodObjectCapabilities } from './object.js'
import { ZodClassCapabilities, type ZodClassCapabilities as ZodClassCapabilitiesType } from './classes.js'

/** Optional Zod 4.5 adapter. It is not installed by the provider-neutral entrypoint. */
const zodAdapter = {
  name: 'zod',
  classes: ZodClassCapabilities,
  bridge: { bridge: bridgeZodSchema },
  derivation: ZodObjectCapabilities.derivation,
  encoded: ZodCodecCapabilities.encoded,
  encoding: ZodCodecCapabilities.encoding,
  props: ZodCodecCapabilities.props,
  read: ZodCodecCapabilities.read,
  structure: ZodObjectCapabilities.structure
}

/** The bridge keeps Zod's inferred input/output pair for callers of Schema.with. */
export const ZodAdapter = Object.freeze(zodAdapter) as typeof zodAdapter &
  SchemaAdapter<ZodClassCapabilitiesType>

export { isZodCodec, isZodObject, isZodSchema, toZodSchema, type ZodSchema } from './support.js'

export { bridgeZodSchema } from './codec.js'
export {
  ZodClassCapabilities,
  type ZodClassBuilder,
  type ZodClassFactory,
  type ZodClassType,
  type ZodClassCapabilities as ZodClassCapabilitiesType
} from './classes.js'
