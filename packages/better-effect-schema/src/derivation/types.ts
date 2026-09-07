import type { Result as ResultType } from 'better-result'

import type {
  AsyncCapabilityResult,
  CapabilityResult,
  SchemaCapabilityFailure,
  SchemaDerivationOperation,
  SchemaObjectPolicy
} from '../capabilities/types.js'

/** A structural mask accepted by the portable derivation engine. */
export type DerivationMask = Readonly<Record<PropertyKey, true>>

/** A provider-owned map of fields. Keys may be strings or symbols. */
export type DerivationFieldMap<Field> = Readonly<Record<PropertyKey, Field>>

export type DerivationFailure = SchemaCapabilityFailure

export type DerivationPartialMode = 'optional' | 'exactOptional'

/** Identity cache supplied to a provider while recursively deriving schemas. */
export interface DerivationMemo<Schema> {
  readonly has: (schema: Schema) => boolean
  readonly get: (schema: Schema) => Schema | undefined
  readonly set: (schema: Schema, derived: Schema) => void
}

export interface DerivationOptions<Schema> {
  /** Optional class/model identifier validated before dispatch. */
  readonly identifier?: string
  /** Fields that a structural operation must preserve verbatim. */
  readonly protectedKeys?: readonly PropertyKey[]
  /** Reusable identity cache. A fresh cache is created when omitted. */
  readonly memo?: DerivationMemo<Schema>
}

export interface DerivationContext<Schema, Field> {
  readonly memo: DerivationMemo<Schema>
  readonly derive: (
    schema: Schema,
    operation: SchemaDerivationOperation
  ) => ResultType<Schema, DerivationFailure>
  readonly field?: (schema: Schema) => CapabilityResult<Field, DerivationFailure>
}

export interface SchemaDerivationConfig<Schema, Field> {
  /** Optional identifier requested for the derived schema. */
  readonly identifier: string | undefined
  /** The user mask, when the operation has a selective form. */
  readonly mask?: DerivationMask
  /** The fields selected for the operation, including protected fields for pick. */
  readonly keys: readonly PropertyKey[]
  /** Protected fields the provider must preserve without rewriting. */
  readonly protectedKeys: readonly PropertyKey[]
  /** A read-only snapshot of the source field map when it was required. */
  readonly fields?: DerivationFieldMap<Field>
  /** A read-only snapshot of fields supplied by extend. */
  readonly augmentation?: DerivationFieldMap<Field>
  /** Distinguishes missing from explicit undefined for partial operations. */
  readonly partialMode?: DerivationPartialMode
  /** Shared recursive state for deepPartial implementations. */
  readonly memo: DerivationMemo<Schema>
  /** Recursive dispatch; providers must use this rather than walking values. */
  readonly context: DerivationContext<Schema, Field>
}

export interface DerivationStructureCapabilities<Schema, Field> {
  readonly fields?: (
    schema: Schema
  ) => AsyncCapabilityResult<DerivationFieldMap<Field>, DerivationFailure>
  readonly policy?: (
    schema: Schema,
    policy: SchemaObjectPolicy,
    catchall?: Field,
    options?: {
      readonly identifier: string | undefined
      readonly protectedKeys: readonly PropertyKey[]
    }
  ) => AsyncCapabilityResult<Schema, DerivationFailure>
}

export interface DerivationCapabilities<Schema, Field> {
  readonly structure?: DerivationStructureCapabilities<Schema, Field>
  readonly derivation?: {
    readonly derive?: (
      schema: Schema,
      operation: SchemaDerivationOperation,
      config: SchemaDerivationConfig<Schema, Field>
    ) => AsyncCapabilityResult<Schema, DerivationFailure>
  }
}

export interface DerivationEngine<Schema, Field> {
  readonly extend: (
    schema: Schema,
    augmentation: DerivationFieldMap<Field>,
    options?: DerivationOptions<Schema>
  ) => ResultType<Schema, DerivationFailure>
  readonly pick: (
    schema: Schema,
    mask: DerivationMask,
    options?: DerivationOptions<Schema>
  ) => ResultType<Schema, DerivationFailure>
  readonly omit: (
    schema: Schema,
    mask: DerivationMask,
    options?: DerivationOptions<Schema>
  ) => ResultType<Schema, DerivationFailure>
  readonly partial: (
    schema: Schema,
    mask?: DerivationMask,
    options?: DerivationOptions<Schema>
  ) => ResultType<Schema, DerivationFailure>
  readonly exactPartial: (
    schema: Schema,
    mask?: DerivationMask,
    options?: DerivationOptions<Schema>
  ) => ResultType<Schema, DerivationFailure>
  readonly deepPartial: (
    schema: Schema,
    options?: DerivationOptions<Schema>
  ) => ResultType<Schema, DerivationFailure>
  readonly required: (
    schema: Schema,
    mask?: DerivationMask,
    options?: DerivationOptions<Schema>
  ) => ResultType<Schema, DerivationFailure>
  readonly policy: (
    schema: Schema,
    policy: SchemaObjectPolicy,
    catchall?: Field,
    options?: DerivationOptions<Schema>
  ) => ResultType<Schema, DerivationFailure>
  readonly strict: (
    schema: Schema,
    options?: DerivationOptions<Schema>
  ) => ResultType<Schema, DerivationFailure>
  readonly loose: (
    schema: Schema,
    options?: DerivationOptions<Schema>
  ) => ResultType<Schema, DerivationFailure>
  readonly strip: (
    schema: Schema,
    options?: DerivationOptions<Schema>
  ) => ResultType<Schema, DerivationFailure>
  readonly catchall: (
    schema: Schema,
    catchall: Field,
    options?: DerivationOptions<Schema>
  ) => ResultType<Schema, DerivationFailure>
}
