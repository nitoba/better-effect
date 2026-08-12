import { ServiceRuntime } from './runtime'

import type { ServiceRequirement } from '../effect/types'

import type { ServiceToken } from './types'

type ServiceTagLiteral<Tag extends string> = string extends Tag
  ? never
  : Tag extends ''
    ? never
    : Tag

/**
 * Keep the instance self type explicit: TypeScript cannot specialize an
 * inherited static async iterator from a tag-only factory. The curried tag
 * call still infers the identity as a string literal.
 */
export function Service<Self>() {
  return function <const Tag extends string>(tag: ServiceTagLiteral<Tag>) {
    if (tag.length === 0) {
      throw new TypeError('Service tags must not be empty')
    }

    abstract class BaseService {
      static readonly serviceTag: Tag = tag

      // oxlint-disable-next-line require-yield
      static async *[Symbol.asyncIterator](
        this: ServiceToken<Tag, Self>
      ): AsyncGenerator<ServiceRequirement<ServiceToken<Tag, Self>>, Self, unknown> {
        return await ServiceRuntime.resolve(this)
      }
    }

    return BaseService
  }
}
