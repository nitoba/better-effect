/** Portable annotations that can be carried by a schema without a provider registry. */
export interface SchemaAnnotations {
  readonly id?: string
  readonly title?: string
  readonly description?: string
  readonly default?: unknown
  readonly deprecated?: boolean
  readonly examples?: readonly unknown[]
  readonly readOnly?: boolean
  readonly writeOnly?: boolean
}

/** Stable model metadata. The identifier is local to the model, not a global registry key. */
export interface SchemaMetadata {
  readonly identifier: string
  readonly annotations?: SchemaAnnotations
}

const copyExamples = (examples: readonly unknown[]): readonly unknown[] =>
  Object.freeze([...examples])

/** Copy and freeze annotations so derivation never mutates the caller's object. */
export const freezeSchemaAnnotations = (annotations: SchemaAnnotations = {}): SchemaAnnotations => {
  const copy: SchemaAnnotations = { ...annotations }
  if (annotations.examples !== undefined) {
    return Object.freeze({
      ...copy,
      examples: copyExamples(annotations.examples)
    })
  }

  return Object.freeze(copy)
}

/** Create immutable local metadata for a model. */
export const createSchemaMetadata = (
  identifier: string,
  annotations?: SchemaAnnotations
): SchemaMetadata => {
  const frozenAnnotations = freezeSchemaAnnotations(annotations)
  return Object.freeze({
    identifier,
    ...(Object.keys(frozenAnnotations).length === 0 ? {} : { annotations: frozenAnnotations })
  })
}

/** Merge annotations without changing either source object. */
export const mergeSchemaAnnotations = (
  base: SchemaAnnotations | undefined,
  override: SchemaAnnotations | undefined
): SchemaAnnotations =>
  freezeSchemaAnnotations({
    ...(base ?? {}),
    ...(override ?? {})
  })
