import { ServiceRuntime } from './runtime'

import type { ServiceRequirement } from '../effect/types'

import type {
  AnyService,
  AnyServiceToken,
  ServiceClass,
  ServiceContract,
  ServiceIdentity,
  ServiceIdentityTypeId,
  ServiceInstance,
  ServiceRequirements,
  ServiceTag,
  ServiceToken,
  ServiceTokenOf
} from './types'

type ServiceTagLiteral<Tag extends string> = string extends Tag
  ? never
  : Tag extends ''
    ? never
    : Tag

interface ServiceFactory<Self> {
  <const Tag extends string>(
    tag: ServiceTagLiteral<Tag>
  ): (abstract new () => ServiceIdentity<Tag>) & {
    readonly name: string
    readonly serviceTag: Tag
  } & {
    readonly of: Service.FactoryOf<Self, Tag>
    readonly [Symbol.asyncIterator]: (
      this: ServiceToken<Tag, Self & ServiceIdentity<Tag>>
    ) => AsyncGenerator<ServiceRequirement<Self>, Self, unknown>
  }
}

/**
 * Declare a class-backed Service with a stable string-literal identity.
 *
 * The returned class is simultaneously the implementation type, the runtime
 * dependency token, and the value yielded by `yield*` in an Effect generator.
 * The explicit self type preserves exact instance inference, while the second
 * call captures the tag as a literal for Layer composition and diagnostics.
 *
 * @example
 * ```ts
 * class Database extends Service<Database>()('Database') {
 *   query(): string {
 *     return 'ok'
 *   }
 * }
 *
 * const database = yield* Database
 * database.query()
 * ```
 *
 * @typeParam Self The instance type implemented by the declared Service.
 */
export function Service<Self>(): ServiceFactory<Self> {
  return function <const Tag extends string>(tag: ServiceTagLiteral<Tag>) {
    if (tag.length === 0) {
      throw new TypeError('Service tags must not be empty')
    }

    abstract class BaseService implements ServiceIdentity<Tag> {
      /** The stable logical identity used by Layers and resolver backends. */
      static readonly serviceTag: Tag = tag
      declare readonly [ServiceIdentityTypeId]: Tag

      /**
       * Type-check a structural implementation of this Service.
       *
       * This is an identity helper. It returns the supplied value unchanged
       * and does not invoke a constructor or modify its prototype.
       *
       * @example
       * ```ts
       * class Database extends Service<Database>()('Database') {
       *   query(sql: string): string {
       *     return sql
       *   }
       * }
       *
       * const database = Database.of({
       *   query: (sql) => `Result: ${sql}`
       * })
       *
       * database.query('SELECT 1')
       * // 'Result: SELECT 1'
       * // database is the original object, not an instance of Database
       * ```
       */
      static of(this: void, implementation: ServiceContract<Self & ServiceIdentity<Tag>>): Self {
        // SAFETY: ServiceContract removes only the phantom marker; this boundary restores Self.
        return implementation as Self
      }

      /** Resolve this Service from the resolver active in the current runtime. */
      // oxlint-disable-next-line require-yield
      static async *[Symbol.asyncIterator](
        this: ServiceToken<Tag, Self & ServiceIdentity<Tag>>
      ): AsyncGenerator<ServiceRequirement<Self>, Self, unknown> {
        return await ServiceRuntime.resolve(this)
      }
    }

    return BaseService
  }
}

/** Type-level aliases for Service tokens and their instance contracts. */
export declare namespace Service {
  /** The widened Service instance constraint. */
  export type Any = AnyService

  /** A class-backed Service token with a stable tag and instance contract. */
  export type Token<Tag extends string = string, Instance extends AnyService = any> = ServiceToken<
    Tag,
    Instance
  >

  /** A constructible Service class with a stable tag and instance contract. */
  export type Class<
    Tag extends string = string,
    Instance extends AnyService = AnyService
  > = ServiceClass<Tag, Instance>

  /** Extract the instance represented by a Service token. */
  export type Instance<T extends AnyServiceToken> = ServiceInstance<T>

  /** Extract the stable tag represented by a Service instance. */
  export type Tag<S extends AnyService> = ServiceTag<S>

  /** A branded Service instance identity with a stable tag. */
  export type Identity<Tag extends string = string> = ServiceIdentity<Tag>

  /** Remove the internal identity marker from a Service implementation contract. */
  export type Contract<S extends AnyService> = ServiceContract<S>

  /** Extract the Service token represented by a branded Service instance. */
  export type TokenOf<S extends AnyService> = ServiceTokenOf<S>

  /** Declaration bridge for the recursive structural `Service.of` signature. */
  export type FactoryOf<Self, Tag extends string> = (
    this: void,
    implementation: ServiceContract<Self & ServiceIdentity<Tag>>
  ) => Self

  /** Extract Effect Service requirements from a Service instance. */
  export type Requirements<S extends AnyService> = ServiceRequirements<S>
}
