import { Schema as CoreSchema } from './schema.js'
import { ZodAdapter } from './adapters/zod/index.js'

/** Preconfigured Zod-backed schema facade. */
export const Schema = CoreSchema.with(ZodAdapter)

/** Optional Zod-backed adapter entrypoint. */
export {
  bridgeZodSchema,
  isZodCodec,
  isZodObject,
  isZodSchema,
  toZodSchema,
  ZodAdapter,
  type ZodSchema
} from './adapters/zod/index.js'
