import type { AnyServiceToken } from '../service'

import type { Layer } from './layer'

import type { LayerSpec } from './types'

export type AnyLayer = Layer<any>

export type LayerSpecs<L extends AnyLayer> = L extends Layer<infer Specs> ? Specs : never

export type LayerProvided<L extends AnyLayer> =
  LayerSpecs<L> extends LayerSpec<infer Provided, any> ? Provided : never

export type LayerRawRequired<L extends AnyLayer> =
  LayerSpecs<L> extends LayerSpec<any, infer Required> ? Required : never

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

declare const MissingLayerServicesTypeId: unique symbol

export type CompleteLayer<L extends AnyLayer> = [LayerMissing<L>] extends [never]
  ? L
  : L & {
      readonly [MissingLayerServicesTypeId]: LayerMissing<L>
    }
