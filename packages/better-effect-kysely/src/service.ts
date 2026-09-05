// oxlint-disable anti-slop/no-chained-type-assertions -- the generated token crosses one intentional Service/Layer erasure boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below are confined to checked Service/Layer boundaries.

import { Layer, Service } from 'better-effect'

import type { ServiceRequirement } from 'better-effect'

import { execute, executeWith } from './execute'
import { executeQuery } from './execute-query'
import {
  executeTakeFirst,
  executeTakeFirstOrFail,
  executeTakeFirstOrFailWith,
  executeTakeFirstWith
} from './execute-take-first'
import type { KyselyExecutionOptions } from './options'
import type { KyselyOperation } from './operation'
import { transaction } from './transaction'
import type { KyselyTransactionOptions } from './transaction-options'

import type {
  KyselyService,
  KyselyServiceInstance,
  KyselyServiceTag,
  KyselyServiceToken
} from './types'
import { layerTokenFor } from './internal/layer-token'

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

type KyselyServiceFactoryInput<DB, Yield extends ServiceRequirement<unknown>> =
  | KyselyServiceValueFactory<DB>
  | KyselyServiceGenerator<DB, Yield>

type KyselyGeneratorResult<DB> =
  | Generator<ServiceRequirement<unknown>, KyselyService<DB>, unknown>
  | AsyncGenerator<ServiceRequirement<unknown>, KyselyService<DB>, unknown>

const isGeneratorResult = <DB>(
  value: KyselyService<DB> | PromiseLike<KyselyService<DB>> | KyselyGeneratorResult<DB>
): value is KyselyGeneratorResult<DB> =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This boundary distinguishes a lazy generator object from a Kysely value or Promise without invoking either.
  typeof value === 'object' &&
  value !== null &&
  'next' in value &&
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Generator objects expose a callable next protocol.
  typeof value.next === 'function'

const normalizeFactory = <DB, Yield extends ServiceRequirement<unknown>>(
  factory: KyselyServiceFactoryInput<DB, Yield>
): (() => AsyncGenerator<Yield, KyselyService<DB>, unknown>) =>
  async function* () {
    const result = factory()

    if (isGeneratorResult(result)) {
      return yield* result
    }

    return await result
  }

/** Type of the curried Kysely Service factory. */
export type KyselyServiceFactory<DB> = <const Tag extends string>(
  tag: KyselyServiceTag<Tag>
) => KyselyServiceToken<Tag, DB>

/**
 * Create a yieldable Service token for a Kysely database schema.
 *
 * The returned token is intentionally not constructible. Use `token.scoped` for
 * a Runtime-owned database, or `token.borrowed`/`token.succeed` for caller-owned
 * databases.
 */
export function service<DB>(): KyselyServiceFactory<DB> {
  return function <const Tag extends string>(tag: KyselyServiceTag<Tag>) {
    type Instance = KyselyServiceInstance<Tag, DB>

    // SAFETY: Service's public factory creates the exact identity and iterator behavior needed here.
    const baseToken = Service<Instance>()(tag)
    // SAFETY: The internal token is used only as a resolver identity; construction is rejected before an invalid Service value can escape.
    const token = class extends (baseToken as unknown as new () => Service.Identity<Tag>) {
      constructor() {
        super()
        throw new TypeError(
          'Kysely Service tokens are not constructible; use scoped, borrowed or succeed'
        )
      }
    }
    // SAFETY: This is the single internal Service/Layer erasure boundary for the non-constructible token.
    const layerToken = layerTokenFor(token as unknown as KyselyServiceToken<Tag, DB>)

    const makeScopedLayer = <Yield extends ServiceRequirement<unknown>>(
      factory: KyselyServiceFactoryInput<DB, Yield>
    ): Layer<Instance, KyselyYieldRequirements<Yield>> => {
      const layer = Layer.scopedGen(layerToken, normalizeFactory(factory), (database) =>
        database.destroy()
      )

      // SAFETY: Kysely's generic builder methods can look like unresolved Effect metadata to Layer's conditional type; Kysely itself has no better-effect requirements.
      return layer as Layer<Instance, KyselyYieldRequirements<Yield>>
    }

    const makeBorrowedLayer = <Yield extends ServiceRequirement<unknown>>(
      factory: KyselyServiceFactoryInput<DB, Yield>
    ): Layer<Instance, KyselyYieldRequirements<Yield>> => {
      const layer = Layer.gen(layerToken, normalizeFactory(factory))

      // SAFETY: Kysely's generic builder methods can look like unresolved Effect metadata to Layer's conditional type; Kysely itself has no better-effect requirements.
      return layer as Layer<Instance, KyselyYieldRequirements<Yield>>
    }

    function scoped<Yield extends ServiceRequirement<unknown>>(
      factory: KyselyServiceGenerator<DB, Yield>
    ): Layer<Instance, KyselyYieldRequirements<Yield>>
    function scoped(factory: KyselyServiceValueFactory<DB>): Layer<Instance, never>
    function scoped(
      factory: KyselyServiceFactoryInput<DB, ServiceRequirement<unknown>>
    ): Layer<Instance, Service.Any> {
      return makeScopedLayer(factory)
    }

    function borrowed<Yield extends ServiceRequirement<unknown>>(
      factory: KyselyServiceGenerator<DB, Yield>
    ): Layer<Instance, KyselyYieldRequirements<Yield>>
    function borrowed(factory: KyselyServiceValueFactory<DB>): Layer<Instance, never>
    function borrowed(
      factory: KyselyServiceFactoryInput<DB, ServiceRequirement<unknown>>
    ): Layer<Instance, Service.Any> {
      return makeBorrowedLayer(factory)
    }

    /**
     * @deprecated Use scoped(factory) for Runtime-owned Kysely or
     * borrowed(factory)/succeed(value) for caller-owned resources.
     */
    function layer<Yield extends ServiceRequirement<unknown>>(
      factory: KyselyServiceGenerator<DB, Yield>
    ): Layer<Instance, KyselyYieldRequirements<Yield>>
    function layer(factory: KyselyServiceValueFactory<DB>): Layer<Instance, never>
    function layer(
      factory: KyselyServiceFactoryInput<DB, ServiceRequirement<unknown>>
    ): Layer<Instance, Service.Any> {
      return makeScopedLayer(factory)
    }

    const succeed = (database: KyselyService<DB>): Layer<Instance, never> => {
      const layer = Layer.succeed(layerToken, database)

      // SAFETY: Kysely's generic builder methods can look like unresolved Effect metadata to Layer's conditional type; Kysely itself has no better-effect requirements.
      return layer as Layer<Instance, never>
    }

    Object.defineProperties(token, {
      borrowed: {
        configurable: false,
        enumerable: true,
        value: borrowed,
        writable: false
      },
      layer: {
        configurable: false,
        enumerable: true,
        value: layer,
        writable: false
      },
      scoped: {
        configurable: false,
        enumerable: true,
        value: scoped,
        writable: false
      },
      succeed: {
        configurable: false,
        enumerable: true,
        value: succeed,
        writable: false
      }
    })

    // SAFETY: The helpers are attached with locked descriptors and the token's instance type is the Kysely contract branded with the literal tag.
    return token as unknown as KyselyServiceToken<Tag, DB>
  }
}

/** Kysely integration namespace value. */
export const KyselyEffect = Object.freeze({
  service,
  execute,
  executeWith,
  executeTakeFirst,
  executeTakeFirstWith,
  executeTakeFirstOrFail,
  executeTakeFirstOrFailWith,
  executeQuery,
  transaction
})

/** Type aliases colocated with the `KyselyEffect` namespace value. */
export declare namespace KyselyEffect {
  export type Service<DB> = KyselyService<DB>
  export type ServiceInstance<Tag extends string, DB> = KyselyServiceInstance<Tag, DB>
  export type ServiceToken<Tag extends string, DB> = KyselyServiceToken<Tag, DB>
  export type Operation<A, E, R extends Service.Any = never> = KyselyOperation<A, E, R>
  export type ExecutionOptions = KyselyExecutionOptions
  export type TransactionOptions = KyselyTransactionOptions
}
