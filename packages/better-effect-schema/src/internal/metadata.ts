import * as z from 'zod'

import { freezeSchemaAnnotations, type SchemaAnnotations } from '../json-schema/metadata.js'
import type { ClassAnnotations } from '../types.js'
import { getCachedClassCodec } from './codec-cache.js'

interface RegistryLike<Metadata> {
  add(schema: object, metadata?: Metadata): unknown
}

const metadataByClass = new WeakMap<Function, ClassAnnotations>()

const asSchema = (value: Function): z.ZodType => value as unknown as z.ZodType

const asZodMetadata = (metadata: SchemaAnnotations): z.core.GlobalMeta =>
  metadata as unknown as z.core.GlobalMeta

const findMetadata = (constructor: Function): ClassAnnotations | undefined => {
  let current: object | null = constructor

  while (typeof current === 'function') {
    const own = metadataByClass.get(current)
    if (own !== undefined) return own
    const registered = z.globalRegistry.get(asSchema(current)) as SchemaAnnotations | undefined
    if (registered !== undefined) return freezeSchemaAnnotations(registered)
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
): ClassAnnotations =>
  freezeSchemaAnnotations({
    title: identifier,
    ...(annotations ?? {})
  })

const metadataForCodec = (metadata: ClassAnnotations): ClassAnnotations => {
  const { id: _id, ...rest } = metadata
  return freezeSchemaAnnotations(rest)
}

export const getMetadata = (constructor: Function): ClassAnnotations | undefined =>
  findMetadata(constructor)

/**
 * Seeds metadata on the generated superclass without claiming an explicit
 * registry id. The concrete user class becomes the id owner when its codec is
 * first materialized or when its metadata is updated explicitly.
 */
export const initializeMetadata = (constructor: Function, metadata: ClassAnnotations): void => {
  const local = freezeSchemaAnnotations(metadata)
  metadataByClass.set(constructor, local)
  z.globalRegistry.add(asSchema(constructor), asZodMetadata(metadataForCodec(local)))
}

export const registerMetadata = (constructor: Function, metadata: ClassAnnotations): void => {
  const local = freezeSchemaAnnotations(metadata)
  metadataByClass.set(constructor, local)
  z.globalRegistry.add(asSchema(constructor), asZodMetadata(local))

  const codec = getCachedClassCodec(constructor)
  if (codec !== undefined) {
    z.globalRegistry.add(codec, asZodMetadata(metadataForCodec(local)))
  }
}

export const attachMetadataToCodec = (constructor: Function, codec: z.ZodType): void => {
  const metadata = findMetadata(constructor)
  if (metadata === undefined) return

  const isGeneratedBase = metadataByClass.has(constructor)
  const local = freezeSchemaAnnotations(metadata)
  metadataByClass.set(constructor, local)
  z.globalRegistry.add(
    asSchema(constructor),
    asZodMetadata(isGeneratedBase ? metadataForCodec(local) : local)
  )
  z.globalRegistry.add(codec, asZodMetadata(metadataForCodec(local)))
}

export const describeClass = (constructor: Function, description: string): void => {
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
