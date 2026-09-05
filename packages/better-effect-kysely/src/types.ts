import type { Layer, Service, ServiceRequirement, ServiceToken } from 'better-effect'

import type { Kysely } from 'kysely'

/** The marker-free Kysely contract represented by a Kysely Service. */
export type KyselyService<DB> = Kysely<DB>

/** A Kysely instance branded with the Service tag captured by its token. */
export type KyselyServiceInstance<Tag extends string, DB> = KyselyService<DB> &
  Service.Identity<Tag>

/** A non-empty literal accepted by `KyselyEffect.service`. */
export type KyselyServiceTag<Tag extends string> = string extends Tag
  ? never
  : Tag extends ''
    ? never
    : Tag

type KyselyServiceValueFactory<DB> = () => KyselyService<DB> | PromiseLike<KyselyService<DB>>

type KyselyServiceGenerator<DB, Yield extends ServiceRequirement<unknown>> = () =>
  | Generator<Yield, KyselyService<DB>, unknown>
  | AsyncGenerator<Yield, KyselyService<DB>, unknown>

type KyselyYieldRequirements<Yield> =
  Yield extends ServiceRequirement<infer Requirement>
    ? Requirement extends Service.Any
      ? Requirement
      : never
    : never

type KyselyLayerMethod<Tag extends string, DB> = {
  <Yield extends ServiceRequirement<unknown>>(
    factory: KyselyServiceGenerator<DB, Yield>
  ): Layer<KyselyServiceInstance<Tag, DB>, KyselyYieldRequirements<Yield>>
  (factory: KyselyServiceValueFactory<DB>): Layer<KyselyServiceInstance<Tag, DB>, never>
}

/**
 * A non-constructible, yieldable Kysely Service token.
 *
 * The token exposes factory helpers for the two explicit ownership modes:
 * `scoped` owns and destroys an acquired database, while `borrowed` and
 * `succeed` borrow databases without registering a finalizer.
 */
export type KyselyServiceToken<Tag extends string, DB> = ServiceToken<
  Tag,
  KyselyServiceInstance<Tag, DB>
> & {
  readonly [Symbol.iterator]: () => Generator<
    ServiceRequirement<KyselyServiceInstance<Tag, DB>>,
    KyselyServiceInstance<Tag, DB>,
    unknown
  >
  readonly [Symbol.asyncIterator]: () => AsyncGenerator<
    ServiceRequirement<KyselyServiceInstance<Tag, DB>>,
    KyselyServiceInstance<Tag, DB>,
    unknown
  >
  readonly scoped: KyselyLayerMethod<Tag, DB>
  readonly borrowed: KyselyLayerMethod<Tag, DB>
  /** @deprecated Use scoped(factory) for Runtime-owned Kysely or borrowed(factory)/succeed(value) for caller-owned resources. */
  readonly layer: KyselyLayerMethod<Tag, DB>
  readonly succeed: (database: KyselyService<DB>) => Layer<KyselyServiceInstance<Tag, DB>, never>
}
