import type { AnyServiceToken, ServiceTag } from '../service'

import type { EffectRequirements } from '../effect/types'

import type { Layer } from './layer'

import type { AnyLayerSpec, LayerSpec } from './types'

/** Any Layer shape accepted by type-level inference helpers. */
export type AnyLayer = Layer<any, any>

/** Extract the provider specification union from a Layer. */
export type LayerSpecs<L extends AnyLayer> = L extends Layer<infer Specs, any> ? Specs : never

/** Extract the Service constructor union provided by a Layer. */
export type LayerProvided<L extends AnyLayer> =
  LayerSpecs<L> extends LayerSpec<infer Provided, any> ? Provided : never

/** Extract all raw Service requirements declared by a Layer's providers. */
export type LayerRawRequired<L extends AnyLayer> =
  LayerSpecs<L> extends LayerSpec<any, infer Required> ? Required : never

type LayerSpecProvided<Specs extends AnyLayerSpec> =
  Specs extends LayerSpec<infer Provided, any> ? Provided : never

type SameServiceTag<Left extends AnyServiceToken, Right extends AnyServiceToken> =
  string extends ServiceTag<Left>
    ? true
    : string extends ServiceTag<Right>
      ? true
      : [ServiceTag<Left>] extends [ServiceTag<Right>]
        ? [ServiceTag<Right>] extends [ServiceTag<Left>]
          ? true
          : false
        : false

type SameServiceContract<Left extends AnyServiceToken, Right extends AnyServiceToken> = [
  InstanceType<Left>
] extends [InstanceType<Right>]
  ? [InstanceType<Right>] extends [InstanceType<Left>]
    ? true
    : false
  : false

type SameServiceToken<Left extends AnyServiceToken, Right extends AnyServiceToken> =
  SameServiceTag<Left, Right> extends true ? SameServiceContract<Left, Right> : false

type IsOverridden<
  Provided extends AnyServiceToken,
  Replacements extends AnyServiceToken
> = Replacements extends AnyServiceToken ? SameServiceToken<Provided, Replacements> : false

type RemoveOverriddenSpecs<Specs extends AnyLayerSpec, Replacements extends AnyServiceToken> =
  Specs extends LayerSpec<infer Provided, any>
    ? true extends IsOverridden<Provided, Replacements>
      ? never
      : Specs
    : never

type ReplaceLayerSpecs<Current extends AnyLayerSpec, Replacement extends AnyLayerSpec> =
  | RemoveOverriddenSpecs<Current, LayerSpecProvided<Replacement>>
  | Replacement

export type OverrideLayerSpecs<
  Current extends AnyLayerSpec,
  Overrides extends readonly AnyLayer[]
> = Overrides extends readonly [
  infer Head extends AnyLayer,
  ...infer Tail extends readonly AnyLayer[]
]
  ? OverrideLayerSpecs<ReplaceLayerSpecs<Current, LayerSpecs<Head>>, Tail>
  : Current

type IncompatibleServicePair<Left extends AnyServiceToken, Right extends AnyServiceToken> =
  SameServiceTag<Left, Right> extends true
    ? SameServiceContract<Left, Right> extends true
      ? never
      : Right
    : never

type IncompatibleServicePairs<Left, Right> = Left extends AnyServiceToken
  ? Right extends AnyServiceToken
    ? IncompatibleServicePair<Left, Right>
    : never
  : never

type IncompatibleLayerSpecs<
  Current extends AnyLayerSpec,
  Replacement extends AnyLayerSpec
> = IncompatibleServicePairs<LayerSpecProvided<Current>, LayerSpecProvided<Replacement>>

/** Same-tag replacements with incompatible instance contracts. */
export type OverrideLayerCollisions<
  Current extends AnyLayerSpec,
  Overrides extends readonly AnyLayer[]
> = Overrides extends readonly [
  infer Head extends AnyLayer,
  ...infer Tail extends readonly AnyLayer[]
]
  ?
      | IncompatibleLayerSpecs<Current, LayerSpecs<Head>>
      | OverrideLayerCollisions<ReplaceLayerSpecs<Current, LayerSpecs<Head>>, Tail>
  : never

type RequirementProvided<
  Requirement extends AnyServiceToken,
  Provided extends AnyServiceToken
> = Provided extends AnyServiceToken
  ? SameServiceTag<Requirement, Provided> extends true
    ? SameServiceContract<Requirement, Provided>
    : false
  : false

type MissingRequirement<Requirement extends AnyServiceToken, Provided extends AnyServiceToken> =
  true extends RequirementProvided<Requirement, Provided> ? never : Requirement

/** Service tokens from `Required` that are not supplied by `Provided`. */
export type MissingServices<
  Required,
  Provided extends AnyServiceToken
> = Required extends AnyServiceToken ? MissingRequirement<Required, Provided> : never

/** Extract the requirements missing from a Layer's provided environment. */
export type LayerMissing<L extends AnyLayer> = MissingServices<
  LayerRawRequired<L>,
  LayerProvided<L>
>

/** Extract incompatible same-tag override contracts from a Layer. */
export type LayerCollisions<L extends AnyLayer> =
  L extends Layer<any, infer Collisions> ? Collisions : never

type MissingLayerServices<Missing extends AnyServiceToken> = {
  readonly __betterEffectMissingServices: Missing
}

/**
 * Put the missing Service tags in the required property name itself. This is
 * intentionally separate from the stable marker above so TypeScript reports a
 * useful diagnostic while existing type-level consumers can still inspect the
 * missing-token union.
 */
type MissingLayerServiceDiagnostic<Missing extends AnyServiceToken> = {
  readonly [K in `__betterEffectMissingService__${ServiceTag<Missing>}`]: never
}

type LayerCollisionServices<Collisions extends AnyServiceToken> = {
  readonly __betterEffectLayerOverrideCollisions: Collisions
}

/**
 * A Layer accepted by Runtime boundaries after completeness validation.
 *
 * Incomplete Layers retain readable per-tag diagnostic properties so compiler
 * errors identify the missing Services directly.
 */
export type CompleteLayer<L extends AnyLayer> = [LayerMissing<L>] extends [never]
  ? [LayerCollisions<L>] extends [never]
    ? L
    : L & LayerCollisionServices<LayerCollisions<L>>
  : L &
      MissingLayerServiceDiagnostic<LayerMissing<L>> &
      MissingLayerServices<LayerMissing<L>> &
      ([LayerCollisions<L>] extends [never] ? unknown : LayerCollisionServices<LayerCollisions<L>>)

/** Services required by an execution result that are not in its environment. */
export type ExecutionMissing<Provided extends AnyServiceToken, ProgramResult> = MissingServices<
  EffectRequirements<ProgramResult>,
  Provided
>

/** Named diagnostic contract for an execution with unavailable Services. */
export type MissingRuntimeServices<Missing extends AnyServiceToken> = {
  readonly __betterEffectMissingRuntimeServices: Missing
}

/** Readable per-tag diagnostics for execution boundaries. */
type MissingRuntimeServiceDiagnostic<Missing extends AnyServiceToken> = {
  readonly [K in `__betterEffectMissingRuntimeService__${ServiceTag<Missing>}`]: never
}

type ExecutionProgram<A> = () => A | PromiseLike<A>

/** Keep execution callbacks unchanged when their Effect requirements are met. */
export type CompleteExecution<Provided extends AnyServiceToken, A> = [
  ExecutionMissing<Provided, A>
] extends [never]
  ? ExecutionProgram<A>
  : ExecutionProgram<A> &
      MissingRuntimeServiceDiagnostic<ExecutionMissing<Provided, A>> &
      MissingRuntimeServices<ExecutionMissing<Provided, A>>
