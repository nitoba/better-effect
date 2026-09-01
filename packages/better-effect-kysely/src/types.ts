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

/**
 * A non-constructible, yieldable Kysely Service token.
 *
 * The token exposes factory helpers for the two explicit ownership modes:
 * `layer` owns and destroys an acquired database, while `succeed` borrows an
 * already-created database without registering a finalizer.
 */
export type KyselyServiceToken<Tag extends string, DB> = ServiceToken<
  Tag,
  KyselyServiceInstance<Tag, DB>
> & {
  readonly [Symbol.asyncIterator]: () => AsyncGenerator<
    ServiceRequirement<KyselyServiceInstance<Tag, DB>>,
    KyselyServiceInstance<Tag, DB>,
    unknown
  >
  readonly layer: (
    acquire: () => KyselyService<DB> | PromiseLike<KyselyService<DB>>
  ) => Layer<KyselyServiceInstance<Tag, DB>, never>
  readonly succeed: (database: KyselyService<DB>) => Layer<KyselyServiceInstance<Tag, DB>, never>
}
