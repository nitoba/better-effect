// oxlint-disable anti-slop/no-chained-type-assertions -- the generated token crosses one intentional Service/Layer erasure boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below are confined to checked Service/Layer boundaries.

import { Layer, Service } from 'better-effect'

import type { ServiceClass } from 'better-effect'

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

import type {
  KyselyService,
  KyselyServiceInstance,
  KyselyServiceTag,
  KyselyServiceToken
} from './types'

/** Type of the curried Kysely Service factory. */
export type KyselyServiceFactory<DB> = <const Tag extends string>(
  tag: KyselyServiceTag<Tag>
) => KyselyServiceToken<Tag, DB>

/**
 * Create a yieldable Service token for a Kysely database schema.
 *
 * The returned token is intentionally not constructible. Use `token.layer` for
 * a Runtime-owned database or `token.succeed` for a caller-owned database.
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
        throw new TypeError('Kysely Service tokens are not constructible; use layer or succeed')
      }
    }
    // SAFETY: Layer only calls the captured token for identity and resolution; the public token remains abstract and non-constructible.
    const layerToken = token as unknown as ServiceClass<Tag, Instance>

    const ownedLayer = (
      acquire: () => KyselyService<DB> | PromiseLike<KyselyService<DB>>
    ): Layer<Instance, never> => {
      const layer = Layer.scoped(layerToken, acquire, (database) => database.destroy())

      // SAFETY: Kysely's generic builder methods can look like unresolved Effect metadata to Layer's conditional type; Kysely itself has no better-effect requirements.
      return layer as Layer<Instance, never>
    }

    const borrowedLayer = (database: KyselyService<DB>): Layer<Instance, never> => {
      const layer = Layer.succeed(layerToken, database)

      // SAFETY: Kysely's generic builder methods can look like unresolved Effect metadata to Layer's conditional type; Kysely itself has no better-effect requirements.
      return layer as Layer<Instance, never>
    }

    Object.defineProperties(token, {
      layer: {
        configurable: false,
        enumerable: true,
        value: ownedLayer,
        writable: false
      },
      succeed: {
        configurable: false,
        enumerable: true,
        value: borrowedLayer,
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
  executeQuery
})

/** Type aliases colocated with the `KyselyEffect` namespace value. */
export declare namespace KyselyEffect {
  export type Service<DB> = KyselyService<DB>
  export type ServiceInstance<Tag extends string, DB> = KyselyServiceInstance<Tag, DB>
  export type ServiceToken<Tag extends string, DB> = KyselyServiceToken<Tag, DB>
  export type Operation<A, E, R extends Service.Any = never> = KyselyOperation<A, E, R>
  export type ExecutionOptions = KyselyExecutionOptions
}
