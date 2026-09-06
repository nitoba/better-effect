// oxlint-disable anti-slop/no-runtime-typeof -- route input is a public JavaScript boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- route validation inspects untyped callers.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts follow token validation.

import { JobStore } from 'better-effect-mq'
import type { AnyJobStoreToken } from 'better-effect-mq'

import { OutboxDefinitionError } from './errors'

export interface OutboxRouteEntry<Store extends AnyJobStoreToken = AnyJobStoreToken> {
  readonly target: string
  readonly store: Store
}

type RouteMap = Readonly<Record<string, AnyJobStoreToken>>

export type OutboxRouteMap = RouteMap

type RouteMapFromEntries<Entries extends readonly OutboxRouteEntry[]> = {
  readonly [Entry in Entries[number] as Entry['target']]: Entry['store']
}

export type OutboxRouteStores<Routes extends OutboxRouteMap> = Routes[keyof Routes]

export class OutboxRoutes<Routes extends OutboxRouteMap = OutboxRouteMap> {
  readonly entries: readonly OutboxRouteEntry<OutboxRouteStores<Routes>>[]
  private readonly stores: ReadonlyMap<string, AnyJobStoreToken>

  private constructor(
    entries: readonly OutboxRouteEntry[],
    stores: ReadonlyMap<string, AnyJobStoreToken>
  ) {
    this.entries = entries as readonly OutboxRouteEntry<OutboxRouteStores<Routes>>[]
    this.stores = stores
  }

  static make<const Routes extends OutboxRouteMap>(routes: Routes): OutboxRoutes<Routes>
  static make<const Entries extends readonly OutboxRouteEntry[]>(
    routes: Entries
  ): OutboxRoutes<RouteMapFromEntries<Entries>>
  static make(routes: OutboxRouteMap | readonly OutboxRouteEntry[]): OutboxRoutes<OutboxRouteMap> {
    const entries = Array.isArray(routes)
      ? routes.map((entry, index) => {
          if (!isRouteEntry(entry)) {
            throw new OutboxDefinitionError({
              field: `routes[${index}]`,
              message: 'must contain a target and JobStore token'
            })
          }
          return entry
        })
      : Object.entries(routes).map(([target, store]) => ({ target, store }))

    const stores = new Map<string, AnyJobStoreToken>()
    for (const [index, entry] of entries.entries()) {
      validateTarget(entry.target, `routes[${index}].target`)
      if (!isJobStoreTokenLike(entry.store)) {
        throw new OutboxDefinitionError({
          field: `routes[${index}].store`,
          message: 'must be a better-effect-mq JobStore token'
        })
      }
      if (stores.has(entry.target)) {
        throw new OutboxDefinitionError({
          field: `routes[${index}].target`,
          message: `duplicate outbox route target "${entry.target}"`
        })
      }
      stores.set(entry.target, entry.store)
    }

    return new OutboxRoutes(Object.freeze(entries.slice()), stores)
  }

  get<Target extends keyof Routes & string>(target: Target): Routes[Target] | undefined
  get(target: string): OutboxRouteStores<Routes> | undefined
  get(target: string): AnyJobStoreToken | undefined {
    return this.stores.get(target)
  }
}

const isRouteEntry = (value: unknown): value is OutboxRouteEntry => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as { readonly target?: unknown; readonly store?: unknown }
  return typeof entry.target === 'string' && isJobStoreTokenLike(entry.store)
}

const isJobStoreTokenLike = (value: unknown): value is AnyJobStoreToken => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  const candidate = value as {
    readonly serviceTag?: unknown
    readonly [Symbol.iterator]?: unknown
  }
  const tag = candidate.serviceTag
  return (
    typeof tag === 'string' &&
    (tag === JobStore.serviceTag || tag.startsWith(`${JobStore.serviceTag}/`)) &&
    typeof candidate[Symbol.iterator] === 'function'
  )
}

const validateTarget = (target: string, field: string): void => {
  if (target.length === 0 || target.includes('\u0000')) {
    throw new OutboxDefinitionError({ field, message: 'must be a non-empty string without NUL' })
  }
}
