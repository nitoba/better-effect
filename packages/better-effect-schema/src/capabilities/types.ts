import type { Result } from 'better-result'
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'

import type { SchemaEffect } from '../schema-effect.js'
import type {
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation,
  SchemaAsyncRequired
} from '../failure.js'

/** A provider-neutral Standard Schema contract. */
export type StandardSchema = StandardSchemaV1

export type SchemaInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>
export type SchemaOutput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>

/** Result accepted from an adapter capability. `SchemaEffect` remains valid for core adapters. */
export type CapabilityResult<Value, Failure> = Result<Value, Failure> | SchemaEffect<Value, Failure>
export type AsyncCapabilityResult<Value, Failure> =
  | CapabilityResult<Value, Failure>
  | PromiseLike<CapabilityResult<Value, Failure>>

export type SchemaCapabilityFailure =
  | SchemaDefinitionFailure
  | SchemaExecutionFailure
  | SchemaUnsupportedOperation
  | SchemaAsyncRequired

/** The portable relationship between wire input, decoded output, props, and a class instance. */
export interface SchemaDescriptor<Input, Output, Props, Self> {
  readonly schema: StandardSchemaV1<Input, Output>
  readonly props: StandardSchemaV1<Props, Props>
  readonly construct: (props: Props) => Self
}

/** A specific derivation operation supported by an adapter. */
export type SchemaDerivationOperation =
  | 'extend'
  | 'pick'
  | 'omit'
  | 'partial'
  | 'exactPartial'
  | 'deepPartial'
  | 'required'

export type SchemaObjectPolicy = 'strict' | 'loose' | 'strip' | 'catchall'

export interface SchemaReadCapability {
  readonly read: <Schema extends StandardSchemaV1>(
    schema: Schema
  ) => CapabilityResult<Schema, SchemaCapabilityFailure>
}

export interface SchemaPropsCapability {
  readonly props: <Input, Output, Props, Self>(
    descriptor: SchemaDescriptor<Input, Output, Props, Self>
  ) => CapabilityResult<StandardSchemaV1<Props, Props>, SchemaCapabilityFailure>
  readonly make: <Input, Output, Props, Self>(
    descriptor: SchemaDescriptor<Input, Output, Props, Self>,
    props: Props
  ) => CapabilityResult<Self, SchemaCapabilityFailure>
}

export interface SchemaEncodedCapability {
  readonly encoded: <Input, Output>(
    schema: StandardSchemaV1<Input, Output>
  ) => CapabilityResult<StandardSchemaV1<Input, Input>, SchemaCapabilityFailure>
}

export interface SchemaEncodingCapability {
  readonly encode: <Input, Output>(
    schema: StandardSchemaV1<Input, Output>,
    value: Output
  ) => CapabilityResult<Input, SchemaCapabilityFailure>
  readonly encodeAsync?: <Input, Output>(
    schema: StandardSchemaV1<Input, Output>,
    value: Output
  ) => AsyncCapabilityResult<Input, SchemaCapabilityFailure>
}

export type SchemaFieldMap = Readonly<Record<string, StandardSchemaV1>>

export interface SchemaStructureCapability {
  readonly fields: <Input, Output>(
    schema: StandardSchemaV1<Input, Output>
  ) => CapabilityResult<SchemaFieldMap, SchemaCapabilityFailure>
  readonly struct?: <Input, Output>(
    schema: StandardSchemaV1<Input, Output>,
    fields: SchemaFieldMap
  ) => CapabilityResult<StandardSchemaV1, SchemaCapabilityFailure>
  readonly policy?: <Input, Output>(
    schema: StandardSchemaV1<Input, Output>,
    policy: SchemaObjectPolicy
  ) => CapabilityResult<StandardSchemaV1, SchemaCapabilityFailure>
}

export interface SchemaDerivationCapability {
  readonly derive: <Input, Output>(
    schema: StandardSchemaV1<Input, Output>,
    operation: SchemaDerivationOperation,
    config?: unknown
  ) => CapabilityResult<StandardSchemaV1, SchemaCapabilityFailure>
}

export interface SchemaJSONSchemaCapability {
  readonly toJSONSchema: <Input, Output>(
    schema: StandardSchemaV1<Input, Output>,
    options: StandardJSONSchemaV1.Options
  ) => CapabilityResult<Record<string, unknown>, SchemaCapabilityFailure>
}

export interface SchemaNativeBridgeCapability {
  readonly bridge: <Native, Input, Output>(
    native: Native
  ) => CapabilityResult<StandardSchemaV1<Input, Output>, SchemaCapabilityFailure>
}

/** Optional, compositional capabilities an adapter can provide. */
export interface SchemaCapabilities {
  readonly read?: SchemaReadCapability
  readonly props?: SchemaPropsCapability
  readonly encoded?: SchemaEncodedCapability
  readonly encoding?: SchemaEncodingCapability
  readonly structure?: SchemaStructureCapability
  readonly derivation?: SchemaDerivationCapability
  readonly jsonSchema?: SchemaJSONSchemaCapability
  readonly bridge?: SchemaNativeBridgeCapability
}

/** Public adapter contract; capabilities can be direct or grouped under `capabilities`. */
export interface SchemaAdapter extends SchemaCapabilities {
  readonly name?: string
  readonly capabilities?: SchemaCapabilities
}
