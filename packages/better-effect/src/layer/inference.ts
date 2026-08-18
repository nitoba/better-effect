import type { EffectRequirements } from '../effect/types'
import type { MissingDependencies } from '../internal/missing-dependencies'
import type {
  AnyService,
  AnyServiceToken,
  ServiceContract,
  ServiceToken,
  ServiceTokenOf
} from '../service'
import type { ServiceTagOf } from '../service/types'

import type { Layer } from './layer'
import type { ErasedProvenance, LayerProvenance, ProviderEntry } from './metadata'

type IsAny<T> = 0 extends 1 & T ? true : false
type IsNever<T> = [T] extends [never] ? true : false

type IsUnion<T, Candidate = T> = T extends unknown
  ? [Candidate] extends [T]
    ? false
    : true
  : never

/** Any Layer shape accepted by type-level inference helpers. */
export type LayerInput = Layer<any, any> | Layer<never, any>

/** Extract the public Service environment channels from a Layer. */
export type ProvidedEnvironment<L extends LayerInput> =
  L extends Layer<infer Provided, infer _Required> ? Provided : never

export type RequiredEnvironment<L extends LayerInput> =
  L extends Layer<infer _Provided, infer Required> ? Required : never

type HasWidenedTag<Services> =
  IsAny<Services> extends true
    ? false
    : Services extends AnyService
      ? string extends ServiceTagOf<Services>
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

/** Shared tag-and-contract comparison used by Layer and Runtime matching. */
export type ServiceMatches<Left extends AnyService, Right extends AnyService> = SameService<
  Left,
  Right
>

type RequirementProvided<
  Requirement extends AnyService,
  Provided extends AnyService
> = Provided extends AnyService ? SameService<Requirement, Provided> : false

type MissingRequirement<Requirement extends AnyService, Provided> =
  true extends RequirementProvided<Requirement, Extract<Provided, AnyService>> ? never : Requirement

/**
 * Existing Runtime matching semantics. Widened Service environments are an
 * explicit execution erasure and therefore satisfy every concrete requirement.
 */
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

/** Layer matching that keeps widened Service.Any as an external requirement. */
export type LayerExternalRequirements<RawRequired extends AnyService, Provided extends AnyService> =
  true extends HasWidenedTag<Extract<RawRequired | Provided, AnyService>>
    ? Extract<RawRequired, AnyService>
    : MissingServices<RawRequired, Provided>

type AnyProviderEntry = ProviderEntry<AnyService, AnyService>
type AnyErasedProvenance = ErasedProvenance<AnyService, AnyService>

type EntryProvided<Entries> = Entries extends ProviderEntry<infer Provided, any> ? Provided : never

type EntryRequired<Entries> = Entries extends ProviderEntry<any, infer Required> ? Required : never

type ErasedProvided<Erased> =
  Erased extends ErasedProvenance<infer Provided, any> ? Provided : never

type ErasedRequired<Erased> =
  Erased extends ErasedProvenance<any, infer Required> ? Required : never

/** Extract precise provider entries carried by an inferred Layer. */
export type PreciseEntries<L extends LayerInput> =
  L extends LayerProvenance<infer Entries, any> ? Entries : never

/**
 * Extract erased provenance, falling back to the public channels for an
 * explicitly annotated Layer.
 */
export type ErasedEntries<L extends LayerInput> =
  L extends LayerProvenance<any, infer Erased>
    ? Erased
    : [ProvidedEnvironment<L> | RequiredEnvironment<L>] extends [never]
      ? never
      : ErasedProvenance<ProvidedEnvironment<L>, RequiredEnvironment<L>>

type LayerMetadata<Entries extends AnyProviderEntry, Erased extends AnyErasedProvenance> = [
  Entries | Erased
] extends [never]
  ? unknown
  : LayerProvenance<Entries, Erased>

/** Opaque internal result type used by Layer constructors and combinators. */
export type LayerResult<
  Entries extends AnyProviderEntry,
  Erased extends AnyErasedProvenance = never
> = Layer<
  EntryProvided<Entries> | ErasedProvided<Erased>,
  LayerExternalRequirements<
    EntryRequired<Entries> | ErasedRequired<Erased>,
    EntryProvided<Entries> | ErasedProvided<Erased>
  >
> &
  LayerMetadata<Entries, Erased>

type LayerChannelPair<L> =
  L extends Layer<infer Provided, infer Required> ? [Provided, Required] : never

type ExactUncheckedArm<L> =
  LayerChannelPair<L> extends [infer Provided extends AnyService, infer Required extends AnyService]
    ? IsAny<Provided> extends true
      ? IsAny<Required> extends true
        ? true
        : false
      : IsNever<Provided> extends true
        ? IsAny<Required> extends true
          ? true
          : false
        : false
    : false

type HasUncheckedProvidedArm<L> = L extends unknown
  ? LayerChannelPair<L> extends [infer Provided, infer Required]
    ? IsAny<Provided> extends true
      ? IsAny<Required> extends true
        ? true
        : false
      : false
    : false
  : never

type HasUncheckedEmptyArm<L> = L extends unknown
  ? LayerChannelPair<L> extends [infer Provided, infer Required]
    ? IsNever<Provided> extends true
      ? IsAny<Required> extends true
        ? true
        : false
      : false
    : false
  : never

type HasNonUncheckedArm<L> = L extends unknown
  ? ExactUncheckedArm<L> extends true
    ? false
    : true
  : never

/** Recognize only the documented exact unchecked Layer sentinels. */
export type IsExactUncheckedLayer<L> =
  IsUnion<L> extends false
    ? ExactUncheckedArm<L>
    : true extends HasNonUncheckedArm<L>
      ? false
      : true extends HasUncheckedProvidedArm<L>
        ? true extends HasUncheckedEmptyArm<L>
          ? true
          : false
        : false

type PartialAnyArm<L> =
  LayerChannelPair<L> extends [infer Provided extends AnyService, infer Required extends AnyService]
    ? IsAny<Provided> extends true
      ? IsAny<Required> extends true
        ? false
        : true
      : IsAny<Required> extends true
        ? IsNever<Provided> extends true
          ? false
          : true
        : false
    : false

/** Detect any Layer constituent with only one erased generic channel. */
export type HasPartialAnyChannel<L> = true extends (L extends unknown ? PartialAnyArm<L> : never)
  ? true
  : false

/** Detect a concrete union of Layer values, preserving the original shape. */
export type IsConcreteUnion<L> =
  IsAny<L> extends true
    ? false
    : IsUnion<L> extends true
      ? IsExactUncheckedLayer<L> extends true
        ? false
        : true
      : false

export type LayerInputState<L> =
  IsExactUncheckedLayer<L> extends true
    ? 'unchecked'
    : HasPartialAnyChannel<L> extends true
      ? 'invalid-partial-any'
      : IsConcreteUnion<L> extends true
        ? 'invalid-union'
        : 'typed'

type InvalidLayerErasure = {
  readonly __betterEffectInvalidLayerErasure: unique symbol
}

type AmbiguousLayerUnion = {
  readonly __betterEffectAmbiguousLayerUnion: unique symbol
}

/** Validate an original Layer argument without widening it to Layer.Any. */
export type ValidateLayerInput<L extends LayerInput> =
  LayerInputState<L> extends 'invalid-partial-any'
    ? InvalidLayerErasure
    : LayerInputState<L> extends 'invalid-union'
      ? AmbiguousLayerUnion
      : unknown

/** Validate every original element of a merge tuple. */
export type ValidateLayerTuple<Layers extends readonly LayerInput[]> = {
  [Index in keyof Layers]: ValidateLayerInput<Layers[Index]>
}

/** Remove compatible Services from a union while retaining all other identities. */
type RemoveCompatibleServices<
  Provided extends AnyService,
  Replacements extends AnyService
> = Provided extends AnyService
  ? true extends (Replacements extends AnyService ? SameService<Provided, Replacements> : false)
    ? never
    : Provided
  : never

type HasCompatibleService<
  Provided extends AnyService,
  Replacements extends AnyService
> = true extends (Replacements extends AnyService ? SameService<Provided, Replacements> : false)
  ? true
  : false

type RemoveCompatibleEntries<Entries extends AnyProviderEntry, Replacements extends AnyService> =
  Entries extends ProviderEntry<infer Provided, any>
    ? HasCompatibleService<Provided, Replacements> extends true
      ? never
      : Entries
    : never

type ReplacePreciseOne<Entries extends AnyProviderEntry, Replacement extends LayerInput> =
  | RemoveCompatibleEntries<Entries, Extract<ProvidedEnvironment<Replacement>, AnyService>>
  | PreciseEntries<Replacement>

type ReplaceErasedOne<Erased extends AnyErasedProvenance, Replacement extends LayerInput> =
  Erased extends ErasedProvenance<infer Provided, infer StickyRequired>
    ? ErasedProvenance<
        RemoveCompatibleServices<Provided, Extract<ProvidedEnvironment<Replacement>, AnyService>>,
        StickyRequired
      >
    : never

type ApplyPreciseOverrides<
  Entries extends AnyProviderEntry,
  Overrides extends readonly LayerInput[]
> = Overrides extends readonly [
  infer Head extends LayerInput,
  ...infer Tail extends readonly LayerInput[]
]
  ? ApplyPreciseOverrides<ReplacePreciseOne<Entries, Head>, Tail>
  : Entries

type ApplyErasedOverrides<
  Erased extends AnyErasedProvenance,
  Overrides extends readonly LayerInput[]
> = Overrides extends readonly [
  infer Head extends LayerInput,
  ...infer Tail extends readonly LayerInput[]
]
  ? ApplyErasedOverrides<
      ReplaceErasedOne<Erased, Head> | Extract<ErasedEntries<Head>, AnyErasedProvenance>,
      Tail
    >
  : Erased

type HasUncheckedLayerInTuple<Layers extends readonly LayerInput[]> = true extends (
  Layers[number] extends unknown ? IsExactUncheckedLayer<Layers[number]> : never
)
  ? true
  : false

type MergeLayerResult<Layers extends readonly LayerInput[]> =
  HasUncheckedLayerInTuple<Layers> extends true
    ? Layer<any, any>
    : LayerResult<PreciseEntries<Layers[number]>, ErasedEntries<Layers[number]>>

/** Internal result type for Layer.merge. */
export type MergeResult<Layers extends readonly LayerInput[]> = MergeLayerResult<Layers>

type OverrideLayerResultUnchecked<
  Base extends LayerInput,
  Overrides extends readonly LayerInput[]
> =
  HasUncheckedLayerInTuple<[Base, ...Overrides]> extends true
    ? Layer<any, any>
    : LayerResult<
        ApplyPreciseOverrides<PreciseEntries<Base>, Overrides>,
        ApplyErasedOverrides<ErasedEntries<Base>, Overrides>
      >

/** Internal result type for Layer.override. */
export type OverrideResult<
  Base extends LayerInput,
  Replacement extends LayerInput
> = OverrideLayerResultUnchecked<Base, readonly [Replacement]>

/** Internal result type for an ordered override tuple. */
export type OverrideLayerResult<
  Base extends LayerInput,
  Overrides extends readonly LayerInput[]
> = OverrideLayerResultUnchecked<Base, Overrides>

type IncompatibleOverridePair<Current extends AnyService, Replacement extends AnyService> =
  SameServiceTag<Current, Replacement> extends true
    ? SameServiceContract<Current, Replacement> extends true
      ? never
      : ServiceTokenOf<Replacement>
    : never

/** Fully distributive same-tag incompatible override comparison. */
export type IncompatibleOverridePairs<
  CurrentProvided extends AnyService,
  ReplacementProvided extends AnyService
> = CurrentProvided extends AnyService
  ? ReplacementProvided extends AnyService
    ? IncompatibleOverridePair<CurrentProvided, ReplacementProvided>
    : never
  : never

type IncompatibleLayerOverride<Tokens extends AnyServiceToken> = {
  readonly __betterEffectIncompatibleLayerOverride: Tokens
}

type InvalidWidenedProvidedEnvironment = {
  readonly __betterEffectWidenedProvidedEnvironment: unique symbol
}

type ValidateOverrideLayerInput<L extends LayerInput> =
  IsExactUncheckedLayer<L> extends true
    ? unknown
    : ValidateLayerInput<L> &
        (true extends HasWidenedTag<Extract<ProvidedEnvironment<L>, AnyService>>
          ? InvalidWidenedProvidedEnvironment
          : unknown)

/** Validate one override against the currently accumulated Layer state. */
export type ValidateOneOverride<
  Current extends LayerInput,
  Replacement extends LayerInput
> = ValidateOverrideLayerInput<Current> &
  ValidateOverrideLayerInput<Replacement> &
  (IsExactUncheckedLayer<Current> extends true
    ? unknown
    : IsExactUncheckedLayer<Replacement> extends true
      ? unknown
      : [
            IncompatibleOverridePairs<
              Extract<ProvidedEnvironment<Current>, AnyService>,
              Extract<ProvidedEnvironment<Replacement>, AnyService>
            >
          ] extends [never]
        ? unknown
        : IncompatibleLayerOverride<
            IncompatibleOverridePairs<
              Extract<ProvidedEnvironment<Current>, AnyService>,
              Extract<ProvidedEnvironment<Replacement>, AnyService>
            >
          >)

/** Validate ordered overrides against the state produced by earlier overrides. */
export type ValidateOverrides<
  Base extends LayerInput,
  Overrides extends readonly LayerInput[]
> = Overrides extends readonly [
  infer Head extends LayerInput,
  ...infer Tail extends readonly LayerInput[]
]
  ? ValidateOneOverride<Base, Head> & ValidateOverrides<OverrideResult<Base, Head>, Tail>
  : unknown

/** A Layer accepted by Runtime boundaries after completeness validation. */
export type CompleteInput<L extends LayerInput> = ValidateLayerInput<L> &
  (LayerInputState<L> extends 'unchecked'
    ? L
    : LayerInputState<L> extends 'typed'
      ? [RequiredEnvironment<L>] extends [never]
        ? L
        : L & MissingDependencies<Extract<RequiredEnvironment<L>, AnyService>>
      : L)

type ExecutionRequirementsMissing<
  RootProvided extends AnyService,
  Request extends LayerInput
> = MissingServices<
  Extract<RequiredEnvironment<Request>, AnyService>,
  Extract<RootProvided, AnyService>
>

/** Validate a per-execution Layer against the Runtime root environment. */
export type CompleteExecutionLayer<
  RootProvided extends AnyService,
  Request extends LayerInput
> = ValidateLayerInput<Request> &
  (LayerInputState<Request> extends 'unchecked'
    ? Request
    : LayerInputState<Request> extends 'typed'
      ? [ExecutionRequirementsMissing<RootProvided, Request>] extends [never]
        ? Request
        : Request & MissingDependencies<ExecutionRequirementsMissing<RootProvided, Request>>
      : Request)

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
