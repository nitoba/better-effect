import type { EffectRequirements } from '../effect/types'
import type { MissingDependencies } from '../internal/missing-dependencies'
import type { AnyService, AnyServiceToken, ServiceContract, ServiceToken } from '../service'
import type { ServiceTagOf } from '../service/types'

import type { Layer } from './layer'
import type { AnyLayerSpec, LayerSpec } from './types'

type IsAny<T> = 0 extends 1 & T ? true : false

/** Any Layer shape accepted by type-level inference helpers. */
export type AnyLayer = Layer<any, any> | Layer<never, any>

/** Extract the provider specification union from a Layer. */
export type LayerSpecs<L extends AnyLayer> =
  L extends Layer<never, any> ? never : L extends Layer<infer Specs, any> ? Specs : never

type LayerSpecProvided<Specs extends AnyLayerSpec> =
  IsAny<Specs> extends true
    ? any
    : Specs extends LayerSpec<infer Provided, any, any>
      ? Provided
      : never

type LayerSpecRequired<Specs extends AnyLayerSpec> =
  IsAny<Specs> extends true
    ? any
    : Specs extends LayerSpec<any, infer Required, any>
      ? Required
      : never

/** Extract the branded Service instance union provided by a Layer. */
export type LayerProvided<L extends AnyLayer> = LayerSpecProvided<LayerSpecs<L>>

/** Extract all raw Service instance requirements declared by a Layer's providers. */
export type LayerRawRequired<L extends AnyLayer> = LayerSpecRequired<LayerSpecs<L>>

type HasWidenedTag<Service> = Service extends AnyService
  ? string extends ServiceTagOf<Service>
    ? true
    : false
  : false

type SameServiceTag<Left extends AnyService, Right extends AnyService> = [
  ServiceTagOf<Left>
] extends [ServiceTagOf<Right>]
  ? [ServiceTagOf<Right>] extends [ServiceTagOf<Left>]
    ? true
    : false
  : false

type SameServiceContract<Left extends AnyService, Right extends AnyService> = [
  ServiceContract<Left>
] extends [ServiceContract<Right>]
  ? [ServiceContract<Right>] extends [ServiceContract<Left>]
    ? true
    : false
  : false

type SameService<Left extends AnyService, Right extends AnyService> =
  SameServiceTag<Left, Right> extends true ? SameServiceContract<Left, Right> : false

type IsOverridden<Provided extends AnyService, Replacements extends AnyLayerSpec> =
  Replacements extends LayerSpec<infer Replacement, any, any>
    ? SameService<Provided, Replacement>
    : false

type RemoveOverriddenSpecs<Specs extends AnyLayerSpec, Replacements extends AnyLayerSpec> =
  Specs extends LayerSpec<infer Provided, any, any>
    ? true extends IsOverridden<Provided, Replacements>
      ? never
      : Specs
    : never

type ReplaceLayerSpecs<Current extends AnyLayerSpec, Replacement extends AnyLayerSpec> =
  | RemoveOverriddenSpecs<Current, Replacement>
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

type IncompatibleLayerSpecPair<Current extends AnyLayerSpec, Replacement extends AnyLayerSpec> =
  Current extends LayerSpec<infer Left, any, any>
    ? Replacement extends LayerSpec<infer Right, any, infer Token>
      ? SameServiceTag<Left, Right> extends true
        ? SameServiceContract<Left, Right> extends true
          ? never
          : Token
        : never
      : never
    : never

type IncompatibleLayerSpecs<
  Current extends AnyLayerSpec,
  Replacement extends AnyLayerSpec
> = Current extends AnyLayerSpec
  ? Replacement extends AnyLayerSpec
    ? IncompatibleLayerSpecPair<Current, Replacement>
    : never
  : never

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
  Requirement extends AnyService,
  Provided extends AnyService
> = Provided extends AnyService ? SameService<Requirement, Provided> : false

type MissingRequirement<Requirement extends AnyService, Provided> =
  true extends RequirementProvided<Requirement, Extract<Provided, AnyService>> ? never : Requirement

/** Branded Services from `Required` that are not supplied by `Provided`. */
export type MissingServices<Required extends AnyService, Provided extends AnyService> =
  ServiceToken<string, Required> extends ServiceToken<string, Provided>
    ? never
    : IsAny<Required> extends true
      ? never
      : IsAny<Provided> extends true
        ? never
        : true extends HasWidenedTag<Required | Provided>
          ? never
          : Required extends AnyService
            ? MissingRequirement<Required, Provided>
            : never

/** Extract the requirements missing from a Layer's provided environment. */
export type LayerMissing<L extends AnyLayer> = MissingServices<
  LayerRawRequired<L>,
  LayerProvided<L>
>

/** Extract incompatible same-tag override constructor contracts from a Layer. */
export type LayerCollisions<L extends AnyLayer> =
  L extends Layer<never, infer Collisions>
    ? Collisions
    : L extends Layer<any, infer Collisions>
      ? Collisions
      : never

type LayerCollisionServices<Collisions extends AnyServiceToken> = {
  readonly __betterEffectLayerOverrideCollisions: Collisions
}

/** A Layer accepted by Runtime boundaries after completeness validation. */
export type CompleteLayer<L extends AnyLayer> = [LayerMissing<L>] extends [never]
  ? [LayerCollisions<L>] extends [never]
    ? L
    : L & LayerCollisionServices<LayerCollisions<L>>
  : L &
      MissingDependencies<LayerMissing<L>> &
      ([LayerCollisions<L>] extends [never] ? unknown : LayerCollisionServices<LayerCollisions<L>>)

/** Services required by an execution result that are not in its environment. */
export type ExecutionMissing<Provided extends AnyService, ProgramResult> = MissingServices<
  EffectRequirements<ProgramResult>,
  Provided
>

type ExecutionProgram<A> = () => A | PromiseLike<A>

type CompleteExecutionWithRequirements<
  Provided extends AnyService,
  A,
  Required extends AnyService
> = [MissingServices<Required, Provided>] extends [never]
  ? ExecutionProgram<A>
  : ExecutionProgram<A> & MissingDependencies<MissingServices<Required, Provided>>

/** Keep execution callbacks unchanged when their Effect requirements are met. */
export type CompleteExecution<Provided extends AnyService, A> = CompleteExecutionWithRequirements<
  Provided,
  A,
  EffectRequirements<A>
>
