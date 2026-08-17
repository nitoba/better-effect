import type { AnyService } from '../service'

import type { Layer } from './layer'

/** Package-private declaration-only carrier for inferred Layer provenance. */
export declare const LayerProvenanceTypeId: unique symbol

export interface ProviderEntry<
  out Provided extends AnyService,
  out RawRequired extends AnyService = never
> {
  readonly provided: Provided
  readonly required: RawRequired
}

export interface ErasedProvenance<
  out Provided extends AnyService,
  out StickyRequired extends AnyService
> {
  readonly provided: Provided
  readonly stickyRequired: StickyRequired
}

export interface LayerProvenance<
  out Entries extends ProviderEntry<AnyService, AnyService> = never,
  out Erased extends ErasedProvenance<AnyService, AnyService> = never
> {
  readonly [LayerProvenanceTypeId]: {
    readonly entries: Entries
    readonly erased: Erased
  }
}

/** Internal Layer constraint used by type-level metadata helpers. */
export type InternalLayer = Layer<any, any> | Layer<never, any>
