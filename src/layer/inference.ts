import type { AnyServiceToken } from '../service'

import type { Layer } from './layer'

import type { AnyLayerSpec, LayerSpec } from './types'

export type AnyLayer = Layer<any>

export type LayerSpecs<L extends AnyLayer> = L extends Layer<infer Specs> ? Specs : never

export type LayerProvided<L extends AnyLayer> =
  LayerSpecs<L> extends LayerSpec<infer Provided, any> ? Provided : never

export type LayerRawRequired<L extends AnyLayer> =
  LayerSpecs<L> extends LayerSpec<any, infer Required> ? Required : never

type LayerSpecProvided<Specs extends AnyLayerSpec> =
  Specs extends LayerSpec<infer Provided, any> ? Provided : never

type SameServiceToken<Left extends AnyServiceToken, Right extends AnyServiceToken> = [
  Left
] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false

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

type RequirementProvided<
  Requirement extends AnyServiceToken,
  Provided extends AnyServiceToken
> = Provided extends AnyServiceToken
  ? Provided extends { new (...args: any[]): InstanceType<Requirement> }
    ? true
    : false
  : false

type MissingRequirement<Requirement extends AnyServiceToken, Provided extends AnyServiceToken> =
  true extends RequirementProvided<Requirement, Provided> ? never : Requirement

type MissingRequirements<
  Required extends AnyServiceToken,
  Provided extends AnyServiceToken
> = Required extends AnyServiceToken ? MissingRequirement<Required, Provided> : never

export type LayerMissing<L extends AnyLayer> = MissingRequirements<
  LayerRawRequired<L>,
  LayerProvided<L>
>

type MissingLayerServices<Missing extends AnyServiceToken> = {
  readonly __betterEffectMissingServices: Missing
}

export type CompleteLayer<L extends AnyLayer> = [LayerMissing<L>] extends [never]
  ? L
  : L & MissingLayerServices<LayerMissing<L>>
