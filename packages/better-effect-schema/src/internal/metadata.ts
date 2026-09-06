import * as z from "zod"

import type { ClassAnnotations } from "../types.js"
import { getCachedClassCodec } from "./codec-cache.js"

interface RegistryLike<Metadata> {
  add(schema: object, metadata?: Metadata): unknown
}

const metadataByClass = new WeakMap<Function, ClassAnnotations>()

const asSchema = (value: Function): z.ZodType =>
  value as unknown as z.ZodType

const findMetadata = (
  constructor: Function
): ClassAnnotations | undefined => {
  let current: object | null = constructor

  while (typeof current === "function") {
    const own = metadataByClass.get(current)
      ?? z.globalRegistry.get(asSchema(current)) as ClassAnnotations | undefined
    if (own !== undefined) return own
    current = Object.getPrototypeOf(current) as object | null
  }

  return undefined
}

/**
 * Uses `title` rather than a registry `id` by default. Zod requires registry
 * ids to be globally unique, while a schema class identifier is intentionally
 * reusable across HMR and module reloads.
 */
export const defaultMetadata = (
  identifier: string,
  annotations?: ClassAnnotations
): ClassAnnotations => ({
  title: identifier,
  ...(annotations ?? {})
})

const metadataForCodec = (
  metadata: ClassAnnotations
): ClassAnnotations => {
  const { id: _id, ...rest } = metadata
  return rest
}

export const getMetadata = (
  constructor: Function
): ClassAnnotations | undefined => findMetadata(constructor)

/**
 * Seeds metadata on the generated superclass without claiming an explicit
 * registry id. The concrete user class becomes the id owner when its codec is
 * first materialized or when its metadata is updated explicitly.
 */
export const initializeMetadata = (
  constructor: Function,
  metadata: ClassAnnotations
): void => {
  metadataByClass.set(constructor, metadata)
  z.globalRegistry.add(asSchema(constructor), metadataForCodec(metadata))
}

export const registerMetadata = (
  constructor: Function,
  metadata: ClassAnnotations
): void => {
  metadataByClass.set(constructor, metadata)
  z.globalRegistry.add(asSchema(constructor), metadata)

  const codec = getCachedClassCodec(constructor)
  if (codec !== undefined) z.globalRegistry.add(codec, metadataForCodec(metadata))
}

export const attachMetadataToCodec = (
  constructor: Function,
  codec: z.ZodType
): void => {
  const metadata = findMetadata(constructor)
  if (metadata === undefined) return

  const isGeneratedBase = metadataByClass.has(constructor)
  metadataByClass.set(constructor, metadata)
  z.globalRegistry.add(
    asSchema(constructor),
    isGeneratedBase ? metadataForCodec(metadata) : metadata
  )
  z.globalRegistry.add(codec, metadataForCodec(metadata))
}

export const describeClass = (
  constructor: Function,
  description: string
): void => {
  registerMetadata(constructor, {
    ...(findMetadata(constructor) ?? {}),
    description
  })
}

export const registerWith = <Metadata>(
  constructor: Function,
  registry: RegistryLike<Metadata>,
  metadata?: Metadata
): void => {
  registry.add(constructor as unknown as object, metadata)
}
