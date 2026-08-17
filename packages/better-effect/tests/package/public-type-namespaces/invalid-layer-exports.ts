import type {
  AnyLayer,
  AnyLayerSpec,
  CompleteLayer,
  LayerMissing,
  LayerProvided,
  LayerRawRequired,
  LayerSpec,
  LayerSpecs
} from 'better-effect'

declare const anyLayer: AnyLayer
declare const anyLayerSpec: AnyLayerSpec
declare const completeLayer: CompleteLayer<never>
declare const layerMissing: LayerMissing<never>
declare const layerProvided: LayerProvided<never>
declare const layerRawRequired: LayerRawRequired<never>
declare const layerSpec: LayerSpec<never>
declare const layerSpecs: LayerSpecs<never>

void anyLayer
void anyLayerSpec
void completeLayer
void layerMissing
void layerProvided
void layerRawRequired
void layerSpec
void layerSpecs
